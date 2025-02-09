import type {
  ContextConfigDefault,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerBase,
  RawServerDefault,
  RequestGenericInterface,
} from 'fastify'
import type { IncomingMessage, Server, ServerResponse } from 'http'
import type { ReactElement } from 'react'
import type { ViteDevServer } from 'vite'
import type { ImperativeRenderable } from './Plugin'

export type ServerRenderer<Props> = (
  this: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  request: FastifyRequest,
  reply: FastifyReply
) => Promise<Props>

export interface FastifyRendererHook {
  name?: string
  tails?: (props?: any) => string
  heads?: (props?: any) => string
  transform?: (app: ReactElement, props?: any) => ReactElement
  postRenderHeads?: (props?: any) => string
}

export interface ViteClientManifest {
  [file: string]: {
    src?: string
    file: string
    css?: string[]
    assets?: string[]
    isEntry?: boolean
    isDynamicEntry?: boolean
    imports?: string[]
    dynamicImports?: string[]
  }
}

export interface ServerEntrypointManifest {
  [file: string]: string
}

declare module 'fastify' {
  // // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface FastifyInstance {
    registerRenderable: (renderable: string) => ImperativeRenderable
  }

  interface RouteShorthandOptions<RawServer extends RawServerBase = RawServerDefault> {
    render?: string
  }

  interface FastifyRequest {
    vite: ViteDevServer
  }
  interface FastifyReply {
    render: <Props>(this: FastifyReply, renderable: ImperativeRenderable, props: Props) => Promise<void>
  }

  interface RouteShorthandMethod<
    RawServer extends RawServerBase = RawServerDefault,
    RawRequest extends RawRequestDefaultExpression<RawServer> = RawRequestDefaultExpression<RawServer>,
    RawReply extends RawReplyDefaultExpression<RawServer> = RawReplyDefaultExpression<RawServer>,
    Props = any
  > {
    <RequestGeneric extends RequestGenericInterface = RequestGenericInterface, ContextConfig = ContextConfigDefault>(
      path: string,
      opts: RouteShorthandOptions<RawServer, RawRequest, RawReply, RequestGeneric, ContextConfig> & {
        render: string
      }, // this creates an overload that only applies these different types if the handler is for rendering
      handler: ServerRenderer<Props>
    ): FastifyInstance<RawServer, RawRequest, RawReply>
  }
}

export interface RenderInput {
  renderBase: string
  destination: string
  bootProps: any
  hooks: string[]
  mode: 'sync' | 'streaming'
}

export interface WorkerRenderInput extends RenderInput {
  modulePath: string
}

export interface StreamWorkerEvent {
  content: string | null
  stack: 'tail' | 'content' | 'head' | 'error'
}
