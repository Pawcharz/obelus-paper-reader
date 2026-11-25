import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultThreads, freePort, servesModel } from '../../src/main/recognition/llamaServer'

// A fake llama-server: healthy, serving a model named "other-model".
let server: Server
let port = 0
beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/health') res.end(JSON.stringify({ status: 'ok' }))
    else if (req.url === '/v1/models') res.end(JSON.stringify({ object: 'list', data: [{ id: 'other-model', aliases: ['other-model', 'second-name'] }] }))
    else { res.statusCode = 404; res.end('{}') }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as AddressInfo).port
})
afterAll(() => { server.close() })

describe('llama-server identity', () => {
  it('uses a running server only when it serves the expected model', async () => {
    expect(await servesModel(port, 'other-model')).toBe(true)
    expect(await servesModel(port, 'second-name')).toBe(true)
    expect(await servesModel(port, 'Uni-MuMER-Qwen3.5-2B-Q8_0')).toBe(false)
  })

  it('sees nothing on a port where nothing listens', async () => {
    expect(await servesModel(await freePort(), 'any')).toBe(false)
  })

  it('picks a free port and at least two threads', async () => {
    const p = await freePort()
    expect(p).toBeGreaterThan(1024)
    expect(p).not.toBe(port)
    expect(defaultThreads()).toBeGreaterThanOrEqual(2)
  })
})
