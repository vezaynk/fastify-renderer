import { FastifyRendererOptions } from '../node/Plugin'
import FastifyRenderer from '../src/node'
import { newFastify } from './helpers'
import { describe, test, expect, beforeAll, vi } from 'vitest'

const testComponent = require.resolve('./fixtures/test-module.tsx')
const testLayoutComponent = require.resolve('./fixtures/test-layout.tsx')

const options: FastifyRendererOptions = {
  vite: { root: __dirname, logLevel: (process.env.LOG_LEVEL ?? 'info') as any },
  devMode: true,
  renderer: {
    mode: 'sync' as const,
    type: 'react' as const,
  },
  hooks: [
    require.resolve('./hooks/simpleHeadHooks.ts'),
    require.resolve('./hooks/thunkCounterHook.ts'),
    require.resolve('./hooks/simpleTransformHook.ts'),
  ],
}

describe('FastifyRenderer', () => {
  let server: Awaited<ReturnType<typeof newFastify>>
  beforeAll(async () => {
    server = await newFastify()
    await server.register(FastifyRenderer, options)
    server.setRenderConfig({
      base: '',
      layout: testLayoutComponent,
    })

    server.get('/error', { render: testComponent }, async (_request, _reply) => ({ fail: true }))

    server.get('/plain', async (_request, reply) => reply.send('Hello'))
    server.get('/render-test', { render: testComponent }, async (_request, _reply) => ({ a: 1, b: 2 }))
    server.get(
      '/early-hook-reply',
      {
        preValidation: (_request, reply) => {
          void reply.code(201).send('hello')
        },
        render: testComponent,
      },
      async (_request, _reply) => ({ a: 1, b: 2 })
    )
    server.get('/early-handler-reply', { render: testComponent }, async (request, reply) => {
      await reply.code(201).send('hello')
      return { a: 1, b: 2 }
    })
    await server.ready()
    type NodeOSType = typeof import('node:os')
    vi.mock('node:os', async () => ({
      ...(await vi.importActual<NodeOSType>('node:os')),
      cpus: () => [{}],
    }))
  })

  // This test must run first
  test('should unthunk hooks on every render', async () => {
    const firstResponse = await server.inject({
      method: 'GET',
      url: '/render-test',
      headers: { Accept: 'text/html' },
    })

    const secondResponse = await server.inject({
      method: 'GET',
      url: '/render-test',
      headers: { Accept: 'text/html' },
    })

    expect(firstResponse.body).toMatch('<style>#0 {}</style>')
    expect(secondResponse.body).toMatch('<style>#1 {}</style>')
  })
  test('should return the route props if content-type is application/json', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/render-test',
      headers: { Accept: 'application/json' },
    })

    expect(response.body).toEqual(JSON.stringify({ props: { a: 1, b: 2 } }))
  })

  test('should render and return html if content-type is text/html', async () => {
    const response = await server.inject({ method: 'GET', url: '/render-test', headers: { Accept: 'text/html' } })

    expect(response.body).toMatch('<h1>1</h1><p>2</p>')
  })
  test('for unknown content types should set content-type to text/plain and return a message', async () => {
    const response = await server.inject({ method: 'GET', url: '/render-test', headers: { Accept: 'other' } })

    expect(response.body).toEqual('Content type not supported')
  })

  test('should not render anything if a hook replies before the render phase is reached', async () => {
    const response = await server.inject({ method: 'GET', url: '/early-hook-reply', headers: { Accept: 'text/html' } })

    expect(response.statusCode).toEqual(201)
    expect(response.body).toEqual('hello')
  })

  test('should not render anything if the handler replies before its end', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/early-handler-reply',
      headers: { Accept: 'text/html' },
    })

    expect(response.statusCode).toEqual(201)
    expect(response.body).toEqual('hello')
  })

  test('should run transform hooks', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/render-test',
      headers: { Accept: 'text/html' },
    })

    expect(response.body).toContain('Transform Hook')
  })

  test('broken components should not break server', async () => {
    for (let index = 0; index < 10; index++) {
      const response = await server.inject({
        method: 'GET',
        url: '/error',
      })

      expect(response.statusCode).toBe(200)
      const response2 = await server.inject({
        method: 'GET',
        url: '/render-test',
      })

      expect(response2.statusCode).toBe(200)
    }
  })
})
