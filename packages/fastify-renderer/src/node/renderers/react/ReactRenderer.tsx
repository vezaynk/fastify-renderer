import reactRefresh from '@vitejs/plugin-react-refresh'
import os from 'node:os'
import path from 'path'
import querystring from 'querystring'
import { createPool, ResourcePooler } from 'resource-pooler'
import { URL } from 'url'
import { Plugin, ResolvedConfig, ViteDevServer } from 'vite'
import { normalizePath } from 'vite/dist/node'
import { Worker } from 'worker_threads'
import { FastifyRendererPlugin } from '../../Plugin'
import { RenderBus } from '../../RenderBus'
import type { StreamWorkerEvent, WorkerRenderInput } from '../../types'
import { mapFilepathToEntrypointName } from '../../utils'
import { Render, RenderableRegistration, Renderer, scriptTag } from '../Renderer'
import { staticRender } from './ssr'
const CLIENT_ENTRYPOINT_PREFIX = '/@fstr!entrypoint:'
const SERVER_ENTRYPOINT_PREFIX = '/@fstr!server-entrypoint:'
export interface ReactRendererOptions {
  type: 'react'
  mode: 'sync' | 'streaming'
}

export class ReactRenderer implements Renderer {
  static ROUTE_TABLE_ID = '/@fstr!route-table.js'

  viteConfig!: ResolvedConfig
  devServer?: ViteDevServer
  renderables!: RenderableRegistration[]
  tmpdir!: string
  clientModulePath: string
  workerPool: ResourcePooler<Worker, Worker> | null = null
  hookPaths: string[] = []

  constructor(readonly plugin: FastifyRendererPlugin, readonly options: ReactRendererOptions) {
    this.clientModulePath = require.resolve('../../../client/react/index.ts')
  }

  vitePlugins() {
    return [
      reactRefresh(),
      this.routeTableVitePlugin(),
      this.hydrationEntrypointVitePlugin(),
      this.serverEntrypointVitePlugin(),
    ]
  }

  async prepare(renderables: RenderableRegistration[], viteConfig: ResolvedConfig, devServer?: ViteDevServer) {
    this.viteConfig = viteConfig
    this.renderables = renderables
    this.devServer = devServer

    this.hookPaths = this.plugin.hooks

    // in production mode, we eagerly require all the endpoints during server boot, so that the first request to the endpoint isn't slow
    // if the service running fastify-renderer is being gracefully restarted, this will block the fastify server from listening until all the code is required, keeping the old server in service a bit longer while this require is done, which is good for users
    if (!this.plugin.devMode) {
      for (const renderable of renderables) {
        await this.loadModule(this.entrypointRequirePathForServer(renderable))
      }

      const modulePaths = await this.getPreloadPaths()
      const paths = [...modulePaths, ...this.hookPaths]

      this.workerPool = await createPool(
        {
          create() {
            const workerData = {
              paths,
            }

            const worker = new Worker(require.resolve('./StaticWorker.import.js'), {
              workerData,
            })

            return worker
          },
          async dispose(worker) {
            await worker.terminate()
          },
        },
        os.cpus().length
      )
    }
  }

  /** The purpose of adding this function is to allow us to spy on this method, otherwise it isn't available in the class prototype */
  async render<Props>(render: Render<Props>): Promise<void> {
    return await this.wrappedRender(render)
  }
  private workerStreamRender<Props>(bus: RenderBus, render: Render<Props>) {
    const requirePath = this.entrypointRequirePathForServer(render)

    const destination = this.stripBasePath(render.request.url, render.base)
    if (!this.workerPool) throw new Error('WorkerPool not setup')

    const expectedStreamEnds = new Set(['head', 'tail', 'content', 'error'] as const)

    // Do not `await` or else it will not return
    // until the whole stream is completed
    return this.workerPool.use(
      (worker) =>
        new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            expectedStreamEnds.clear()
            worker.off('message', messageHandler)
          }

          const messageHandler = ({ stack, content }: StreamWorkerEvent) => {
            if (stack === 'error' && content) {
              // Reject to inform caller that the response failed
              reject(new Error(content))
            }
            bus.push(stack, content, false)
            if (content === null) {
              expectedStreamEnds.delete(stack)
              if (expectedStreamEnds.size === 0) {
                cleanup()
                resolve()
              }
            }
          }
          worker.on('message', messageHandler)
          worker.postMessage({
            modulePath: path.join(this.plugin.serverOutDir, mapFilepathToEntrypointName(requirePath)),
            renderBase: render.base,
            bootProps: render.props,
            destination,
            hooks: this.hookPaths,
            mode: this.options.mode,
          } satisfies WorkerRenderInput)
        })
    )
  }
  private async getPreloadPaths() {
    return this.renderables.map((renderable) =>
      path.join(this.plugin.serverOutDir, mapFilepathToEntrypointName(this.entrypointRequirePathForServer(renderable)))
    )
  }
  /** Renders a given request and sends the resulting HTML document out with the `reply`. */
  private wrappedRender = <Props,>(render: Render<Props>) => {
    // Prepare render bus
    const bus = this.startRenderBus(render)
    // Send response with pending bus stacks
    // do not wait for response to complete (it is completed below)
    const response = render.reply.send(
      render.document({
        content: bus.stack('content'),
        head: bus.stack('head'),
        tail: bus.stack('tail'),
        reply: render.reply,
        props: render.props,
        request: render.request,
      })
    )

    try {
      const destination = this.stripBasePath(render.request.url, render.base)

      // A dev render calls the React renderer directly in-thread
      // the method writes directly to the bus
      const devRender = () => {
        const requirePath = this.entrypointRequirePathForServer(render)
        return this.devServer!.ssrLoadModule(requirePath).then((module) =>
          staticRender({
            module: module.default,
            renderBase: render.base,
            bootProps: render.props,
            destination,
            hooks: this.hookPaths,
            mode: this.options.mode,
            bus,
          })
        )
      }

      // A prod render processes the rendering off-thread and sends values to push into the bus
      // over postMessage in a way that re-constructs the stream
      const prodRender = () => this.workerStreamRender(bus, render)

      // Do not await or stream is killed
      const startRender = this.plugin.devMode ? devRender : prodRender

      void startRender().catch((e) => {
        console.error('An error occured while rendering', e)
      })
    } catch (error: unknown) {
      this.devServer?.ssrFixStacktrace(error as Error)
      // let fastify's error handling system figure out what to do with this after fixing the stack trace
      throw error
    }

    return response
  }

  /** Given a node-land module id (path), return the build time path to the virtual script to hydrate the render client side */
  public buildVirtualClientEntrypointModuleID(route: RenderableRegistration) {
    const queryParams = {
      layout: route.layout,
      base: route.base,
      ...(route.isImperative && { imperativePathPattern: route.pathPattern, imperativeRenderable: route.renderable }),
    }

    return (
      path.join(CLIENT_ENTRYPOINT_PREFIX, route.renderable, 'hydrate.jsx') + '?' + querystring.stringify(queryParams)
    )
  }

  /** Given a node-land module id (path), return the server run time path to a virtual module to run the server side render */
  public buildVirtualServerEntrypointModuleID(register: RenderableRegistration) {
    return (
      path.join(SERVER_ENTRYPOINT_PREFIX, register.renderable, 'ssr.jsx') +
      '?' +
      querystring.stringify({ layout: register.layout, base: register.base })
    )
  }

  /**
   * Given a concrete, resolvable node-land module id (path), return the client-land path to the script to hydrate the render client side
   * In dev mode, will return a virtual module url that will use use the client side hydration plugin to produce a script around the entrypoint
   * In production, will reference the manifest to find the built module corresponding to the given entrypoint
   */
  public entrypointScriptTagSrcForClient(render: Render) {
    const entrypointName = this.buildVirtualClientEntrypointModuleID(render)
    if (this.plugin.devMode) {
      return path.join(this.plugin.viteBase, entrypointName)
    } else {
      const manifestEntryName = normalizePath(path.relative(this.viteConfig.root, entrypointName))
      const manifestEntry = this.plugin.clientManifest![manifestEntryName]
      if (!manifestEntry) {
        throw new Error(
          `Module id ${render.renderable} was not found in the built assets manifest. Looked for it at ${manifestEntryName} in manifest.json. Was it included in the build?`
        )
      }
      return manifestEntry.file
    }
  }

  /**
   * Given a concrete, resolvable node-land module id (path), return the server-land path to the script to render server side
   * Because we're using vite, we have special server side entrypoints too such that we can't just `require()` an entrypoint, even on the server, we need to a require a file that vite has built where all the copies of React are the same within.
   * In dev mode, will return a virtual module url that will use use the server side render plugin to produce a script around the entrypoint
   */
  public entrypointRequirePathForServer(register: RenderableRegistration) {
    const entrypointName = this.buildVirtualServerEntrypointModuleID(register)
    if (this.plugin.devMode) {
      return entrypointName
    } else {
      const manifestEntry = this.plugin.serverEntrypointManifest![entrypointName]
      if (!manifestEntry) {
        throw new Error(
          `Module id ${register.renderable} was not found in the built server entrypoints manifest. Looked for it at ${entrypointName} in virtual-manifest.json. Was it included in the build?`
        )
      }
      return manifestEntry
    }
  }

  private startRenderBus(render: Render<any>) {
    const styleNonce = (render.reply as any).cspNonce?.style as string | undefined
    const scriptNonce = (render.reply as any).cspNonce?.script as string | undefined

    const bus = new RenderBus()

    // push the script for the react-refresh runtime that vite's plugin normally would
    if (this.plugin.devMode) {
      bus.push('tail', this.reactRefreshScriptTag(scriptNonce))
    }

    // push the props for the entrypoint to use when hydrating client side
    bus.push('tail', scriptTag(`window.__FSTR_PROPS=${JSON.stringify(render.props)};`, { nonce: scriptNonce }))

    // if we're in development, we just source the entrypoint directly from vite and let the browser do its thing importing all the referenced stuff
    if (this.plugin.devMode) {
      bus.push(
        'tail',
        scriptTag(``, {
          src: path.join(this.plugin.assetsHost, this.entrypointScriptTagSrcForClient(render)),
          nonce: scriptNonce,
        })
      )
    } else {
      const entrypointName = this.buildVirtualClientEntrypointModuleID(render)
      const manifestEntryName = normalizePath(path.relative(this.viteConfig.root, entrypointName))
      this.plugin.pushImportTagsFromManifest(bus, manifestEntryName, true, styleNonce, scriptNonce)
    }

    return bus
  }

  /** Given a module ID, load it for use within this node process on the server */
  private async loadModule(id: string) {
    if (this.plugin.devMode) {
      return await this.devServer!.ssrLoadModule(id)
    } else {
      const builtPath = path.join(this.plugin.serverOutDir, mapFilepathToEntrypointName(id))
      return require(builtPath)
    }
  }

  /**
   * A vite/rollup plugin that provides a virtual module to run client side React hydration for a specific route & entrypoint
   * Served to the client to rehydrate the server rendered code
   */
  private hydrationEntrypointVitePlugin(): Plugin {
    return {
      name: 'fastify-renderer:react-client-entrypoints',
      enforce: 'pre',
      resolveId(id) {
        if (id.startsWith(CLIENT_ENTRYPOINT_PREFIX)) {
          return id
        }
      },
      load: (id) => {
        if (id.startsWith(CLIENT_ENTRYPOINT_PREFIX)) {
          const url = new URL('fstr://' + id)
          const entrypoint = id.replace(CLIENT_ENTRYPOINT_PREFIX, '/@fs/').replace(/\/hydrate\.jsx\?.+$/, '')
          const layout = url.searchParams.get('layout')!
          const base = url.searchParams.get('base')!
          const imperativePathPattern = url.searchParams.get('imperativePathPattern')!
          const imperativeRenderable = url.searchParams.get('imperativeRenderable')!
          const queryParams = {
            base,
            lazy: true,
            ...(imperativeRenderable && { imperativePathPattern, imperativeRenderable }),
          }

          return `
          // client side hydration entrypoint for a particular route generated by fastify-renderer
          import React from 'react'
          import ReactDOM from 'react-dom/client'
          import { routes } from ${JSON.stringify(
            ReactRenderer.ROUTE_TABLE_ID + '?' + querystring.stringify(queryParams)
          )}
          import { Root } from ${JSON.stringify(this.clientModulePath)}
          import Layout from ${JSON.stringify(layout)}
          import Entrypoint from ${JSON.stringify(entrypoint)}

          ReactDOM.hydrateRoot(document.getElementById('fstrapp'), <Root
            Layout={Layout}
            Entrypoint={Entrypoint}
            basePath={${JSON.stringify(base)}}
            routes={routes}
            bootProps={window.__FSTR_PROPS}
          />)
        `
        }
      },
    }
  }

  /**
   * A vite/rollup plugin that provides a virtual module to run the server side react render for a specific route & entrypoint
   * Its important that every module that the entrypoint and layout touch are eventually imported by this file so that there is exactly one copy of React referenced by all of the modules.
   */
  private serverEntrypointVitePlugin(): Plugin {
    return {
      name: 'fastify-renderer:react-server-entrypoints',
      enforce: 'pre',
      resolveId(id) {
        if (id.startsWith(SERVER_ENTRYPOINT_PREFIX)) {
          return id
        }
      },
      load: (id) => {
        if (id.startsWith(SERVER_ENTRYPOINT_PREFIX)) {
          const entrypoint = id.replace(SERVER_ENTRYPOINT_PREFIX, '').replace(/\/ssr\.jsx\?.+$/, '')
          const url = new URL('fstr://' + id)
          const layout = url.searchParams.get('layout')!

          const code = `
          // server side processed entrypoint for a particular route generated by fastify-renderer
          import React from 'react'
          import ReactDOMServer from 'react-dom/server'
          import { Router, RenderBusContext } from ${JSON.stringify(this.clientModulePath)}
          import Layout from ${JSON.stringify(layout)}
          import Entrypoint from ${JSON.stringify(entrypoint)}

          export default {
            React,
            ReactDOMServer,
            Router,
            RenderBusContext,
            Layout,
            Entrypoint
          }
          `

          return code
        }
      },
    }
  }

  /**
   * Produces the route table from all the registered routes to serve to the frontend
   */
  private routeTableVitePlugin(): Plugin {
    // Hacky way to approximate find-my-way's segment precedence -- will not scale very well, but means we don't have to ship all of find-my-way to the browser which is good.
    const routeSortScore = (path: string) => {
      if (path.includes('*')) {
        return 2
      } else if (path.includes(':')) {
        return 1
      } else {
        return 0
      }
    }
    // b before a if greater than 0
    // b=2, a=1 if greater than 0

    // Convert find-my-way route paths to path-to-regexp syntax
    const pathToRegexpify = (path: string) => path.replace('*', ':splat*')

    return {
      name: 'fastify-renderer:react-route-table',
      resolveId(id) {
        if (id.startsWith(ReactRenderer.ROUTE_TABLE_ID)) {
          return id
        }
      },
      load: (id) => {
        if (id.startsWith(ReactRenderer.ROUTE_TABLE_ID)) {
          const url = new URL('fstr://' + id)
          const lazy = !!url.searchParams.get('lazy')!
          const base = url.searchParams.get('base')!
          const imperativePathPattern = url.searchParams.get('imperativePathPattern')
          const imperativeRenderable = url.searchParams.get('imperativeRenderable')

          // We filter out the routes the imperatively renderable routes, which don't have a url property
          // There is no point in having them included in the route table
          const routeableRenderables = this.renderables.filter(
            (route) => route.base == base && route.pathPattern !== undefined
          ) as (RenderableRegistration & { pathPattern: string })[]

          if (imperativePathPattern && imperativeRenderable) {
            const routeObject = Object.assign(
              {},
              this.renderables.find((route) => route.renderable == imperativeRenderable),
              { pathPattern: imperativePathPattern }
            )
            routeableRenderables.push(routeObject)
          }

          routeableRenderables.sort((a, b) => routeSortScore(a.pathPattern) - routeSortScore(b.pathPattern))

          const pathsToModules = routeableRenderables.map((route) => [
            pathToRegexpify(this.stripBasePath(route.pathPattern, base)),
            route.renderable,
          ])

          if (lazy) {
            return `
import { lazy } from "react";
// lazy route table generated by fastify-renderer
export const routes = [
  ${pathsToModules
    .map(([url, component]) => `[${JSON.stringify(url)}, lazy(() => import(${JSON.stringify(component)}))]`)
    .join(',\n')}
  ]
          `
          } else {
            return `
// route table generated by fastify-renderer
${pathsToModules.map(([_url, component], index) => `import mod_${index} from ${JSON.stringify(component)}`).join('\n')}

export const routes = [
  ${pathsToModules.map(([url], index) => `[${JSON.stringify(url)}, mod_${index}]`).join(',\n')}
]`
          }
        }
      },
    }
  }

  private stripBasePath(fullyQualifiedPath: string, base: string) {
    if (fullyQualifiedPath.startsWith(base)) {
      const baseless = fullyQualifiedPath.slice(base.length)
      if (baseless == '') {
        return '/'
      } else {
        return baseless
      }
    } else {
      return fullyQualifiedPath
    }
  }

  private reactRefreshScriptTag(nonce?: string) {
    return scriptTag(
      `
      import RefreshRuntime from "${path.join(this.viteConfig.base, '@react-refresh')}"
      RefreshRuntime.injectIntoGlobalHook(window)
      window.$RefreshReg$ = () => {}
      window.$RefreshSig$ = () => (type) => type
      window.__vite_plugin_react_preamble_installed__ = true`,
      { nonce }
    )
  }
}
