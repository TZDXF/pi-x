import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function harness(desktop = false) {
  const source = readFileSync(new URL('../src/api/transport.ts', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/export /g, '') + '\nglobalThis.api = { invoke, listen, isDesktop };'
  const stored = new Map()
  const requests = []
  const sockets = []
  class Socket {
    static OPEN = 1
    readyState = 0
    constructor(url) { this.url = url; sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen() }) }
    close() { this.readyState = 3; this.onclose() }
  }
  const context = vm.createContext({
    URLSearchParams, WebSocket: Socket, queueMicrotask, setTimeout, clearTimeout,
    isTauri: () => desktop,
    desktopInvoke: async () => 'desktop',
    desktopListen: async () => () => {},
    sessionStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    location: { hash: '#token=test-key', pathname: '/', search: '', protocol: 'http:', host: 'localhost:1421' },
    history: { replaceState: (...args) => requests.push(args) },
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, status: 200, json: async () => ({ data: 42 }) } },
  })
  vm.runInContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }), context)
  return { api: context.api, stored, requests, sockets, context }
}

test('browser moves fragment key to session storage and sends bearer-authenticated commands', async () => {
  const h = harness()
  assert.equal(h.stored.get('pi-remote-token'), 'test-key')
  assert.equal(h.requests[0][2], '/')
  assert.equal(await h.api.invoke('rpc_running'), 42)
  assert.equal(h.requests[1].options.headers.Authorization, 'Bearer test-key')
  assert.equal(JSON.parse(h.requests[1].options.body).command, 'rpc_running')
})
test('desktop retains native IPC', async () => {
  const h = harness(true)
  assert.equal(await h.api.invoke('rpc_running'), 'desktop')
  assert.equal(h.requests.filter(r => r.url).length, 0)
})
test('event subscribers share one socket and release their handlers', async () => {
  const h = harness()
  const received = []
  const [offA, offB] = await Promise.all([
    h.api.listen('pi://event', e => received.push(e.payload)),
    h.api.listen('pi://stderr', () => {}),
  ])
  assert.equal(h.sockets.length, 1)
  h.sockets[0].onmessage({ data: JSON.stringify({ event: 'pi://event', payload: 'hello' }) })
  assert.deepEqual(received, ['hello'])
  offA()
  h.sockets[0].onmessage({ data: JSON.stringify({ event: 'pi://event', payload: 'ignored' }) })
  assert.deepEqual(received, ['hello'])
  offB()
  assert.equal(h.sockets[0].readyState, 3)
})
test('invalid access keys produce a useful error', async () => {
  const h = harness()
  h.context.fetch = async () => ({ status: 401 })
  await assert.rejects(h.api.invoke('rpc_running'), /访问密钥无效/)
})
