import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function harness(desktop = false, fragment = '#token=test-key') {
  const source = readFileSync(new URL('../src/api/transport.ts', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/export /g, '') + '\nglobalThis.api = { invoke, listen, isDesktop, hasRemoteToken, remoteAuthStatus, loginRemote };'
  const stored = new Map()
  const requests = []
  const sockets = []
  // Controllable timers: reconnect backoff timers are captured for tests to
  // fire manually; the 10s first-connect timeout is neutralized.
  const timers = []
  const setTimeout_ = (fn, delay) => {
    if (delay >= 10000) return 0
    timers.push(fn)
    return timers.length
  }
  const clearTimeout_ = (id) => { if (id) timers[id - 1] = null }
  class Socket {
    static OPEN = 1
    readyState = 0
    constructor(url) { this.url = url; sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen() }) }
    close() { this.readyState = 3; this.onclose() }
  }
  const context = vm.createContext({
    URLSearchParams, WebSocket: Socket, queueMicrotask, setTimeout: setTimeout_, clearTimeout: clearTimeout_,
    isTauri: () => desktop,
    desktopInvoke: async () => 'desktop',
    desktopListen: async () => () => {},
    sessionStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) },
    location: { hash: fragment, pathname: '/', search: '', protocol: 'http:', host: 'localhost:1421' },
    history: { replaceState: (...args) => requests.push(args) },
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, status: 200, json: async () => ({ data: 42 }) } },
  })
  vm.runInContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }), context)
  return { api: context.api, stored, requests, sockets, context, runTimers: () => timers.splice(0).forEach(fn => fn?.()) }
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
  await assert.rejects(h.api.invoke('rpc_running'), /访问凭据已失效/)
})

const flush = () => new Promise(resolve => setImmediate(resolve))

test('unexpected drops reconnect with backoff and emit a reconnected event', async () => {
  const h = harness()
  const reconnected = []
  await h.api.listen('pi://reconnected', e => reconnected.push(e.payload))
  await h.api.listen('pi://event', () => {})
  assert.equal(h.sockets.length, 1)

  // Simulate an unexpected transport drop.
  h.sockets[0].onclose()
  h.runTimers()
  await flush()

  // A fresh socket was created and listeners were told to re-sync.
  assert.equal(h.sockets.length, 2)
  assert.equal(h.sockets[1].url.includes('/api/events'), true)
  assert.equal(reconnected.length, 1)

  // A second drop retries; the reconnect attempt reuses the shared socket.
  h.sockets[1].onclose()
  h.runTimers()
  await flush()
  assert.equal(h.sockets.length, 3)
  assert.equal(reconnected.length, 2)
})

test('intentional close after the last listener unsubscribes does not reconnect', async () => {
  const h = harness()
  const off = await h.api.listen('pi://event', () => {})
  off()
  assert.equal(h.sockets[0].readyState, 3)
  h.runTimers()
  await flush()
  assert.equal(h.sockets.length, 1)
})

test('stale socket events cannot clobber a newer connection', async () => {
  const h = harness()
  const reconnected = []
  await h.api.listen('pi://reconnected', () => reconnected.push(true))
  const first = h.sockets[0]
  first.onclose()
  h.runTimers()
  await flush()
  assert.equal(h.sockets.length, 2)
  // Late close of the replaced socket must not trigger another reconnect
  // or dispatch disconnect events for the live connection.
  first.onclose()
  h.runTimers()
  await flush()
  assert.equal(h.sockets.length, 2)
  assert.equal(reconnected.length, 1)
})

test('tokenless access can authenticate with a password without placing the key in the URL', async () => {
  const h = harness(false, '')
  assert.equal(h.api.hasRemoteToken(), false)
  h.context.fetch = async (url, options) => {
    h.requests.push({ url, options })
    if (url === '/api/auth') return { ok: true, json: async () => ({ passwordEnabled: true, authenticated: false }) }
    if (url === '/api/auth/login') return { ok: true, status: 200, json: async () => ({ token: 'session-key' }) }
    return { ok: true, status: 200, json: async () => ({ data: true }) }
  }
  assert.equal((await h.api.remoteAuthStatus()).passwordEnabled, true)
  assert.equal(await h.api.loginRemote('test-password'), 'ok')
  assert.equal(h.api.hasRemoteToken(), true)
  assert.equal(h.stored.get('pi-remote-token'), 'session-key')
  assert.equal(h.requests.find(r => r.url === '/api/auth/login').options.body, JSON.stringify({ password: 'test-password' }))
  await h.api.invoke('rpc_running')
  assert.equal(h.requests.at(-1).options.headers.Authorization, 'Bearer session-key')
  assert.equal(h.requests.some(r => r.url?.includes('test-password')), false)
})

test('invalid and rate-limited password attempts do not store a token', async () => {
  const h = harness(false, '')
  h.context.fetch = async () => ({ status: 401 })
  assert.equal(await h.api.loginRemote('wrong-password'), 'invalid')
  h.context.fetch = async () => ({ status: 429 })
  assert.equal(await h.api.loginRemote('wrong-password'), 'limited')
  assert.equal(h.api.hasRemoteToken(), false)
})
