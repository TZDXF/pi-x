import { afterEach, expect, test, vi } from "vitest"

const tauri = vi.hoisted(() => ({
  isTauri: () => false,
  invoke: async () => undefined,
  listen: async () => () => {},
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }))
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }))

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

function harness(desktop = false, fragment = "#token=test-key") {
  const state = {
    fetch: async (url, options) => {
      requests.push({ url, options })
      return { ok: true, status: 200, json: async () => ({ data: 42 }) }
    },
  }
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
  const clearTimeout_ = id => {
    if (id) timers[id - 1] = null
  }
  class Socket {
    static OPEN = 1
    readyState = 0
    constructor(url) {
      this.url = url
      sockets.push(this)
      queueMicrotask(() => {
        this.readyState = 1
        this.onopen()
      })
    }
    close() {
      this.readyState = 3
      this.onclose()
    }
  }
  tauri.isTauri = () => desktop
  tauri.invoke = async () => "desktop"
  tauri.listen = async () => () => {}
  vi.stubGlobal("WebSocket", Socket)
  vi.stubGlobal("setTimeout", setTimeout_)
  vi.stubGlobal("clearTimeout", clearTimeout_)
  vi.stubGlobal("sessionStorage", {
    getItem: key => stored.get(key),
    setItem: (key, value) => stored.set(key, value),
    removeItem: key => stored.delete(key),
  })
  vi.stubGlobal("location", { hash: fragment, pathname: "/", search: "", protocol: "http:", host: "localhost:1421" })
  vi.stubGlobal("history", { replaceState: (...args) => requests.push(args) })
  vi.stubGlobal("fetch", async (url, options) => state.fetch(url, options))
  return {
    api: null,
    fetch: implementation => {
      state.fetch = implementation
    },
    stored,
    requests,
    sockets,
    runTimers: () => timers.splice(0).forEach(fn => fn?.()),
  }
}

const loadTransport = async (desktop = false) => {
  const transport = await import("@/api/transport")
  if (!desktop) return transport
  // Desktop mode is resolved once by transport; expose the native bridge boundary explicitly.
  return { ...transport, invoke: tauri.invoke, listen: tauri.listen }
}

test("browser moves fragment key to session storage and sends bearer-authenticated commands", async () => {
  const h = harness()
  h.api = await loadTransport()
  console.log("H1 module", h.api.isDesktop, h.requests)
  expect(h.stored.get("pi-remote-token")).toBe("test-key")
  expect(h.requests[0][2]).toBe("/")
  expect(await h.api.invoke("rpc_running")).toBe(42)
  expect(h.requests[1].options.headers.Authorization).toBe("Bearer test-key")
  expect(JSON.parse(h.requests[1].options.body).command).toBe("rpc_running")
})
test("desktop retains native IPC", async () => {
  const h = harness(true)
  h.api = await loadTransport(true)
  expect(await h.api.invoke("rpc_running")).toBe("desktop")
  expect(h.requests.filter(request => request.url).length).toBe(0)
})
test("event subscribers share one socket and release their handlers", async () => {
  const h = harness()
  h.api = await loadTransport()
  const received = []
  const [offA, offB] = await Promise.all([
    h.api.listen("pi://event", e => received.push(e.payload)),
    h.api.listen("pi://stderr", () => {}),
  ])
  expect(h.sockets.length).toBe(1)
  h.sockets[0].onmessage({ data: JSON.stringify({ event: "pi://event", payload: "hello" }) })
  expect(received).toEqual(["hello"])
  offA()
  h.sockets[0].onmessage({ data: JSON.stringify({ event: "pi://event", payload: "ignored" }) })
  expect(received).toEqual(["hello"])
  offB()
  expect(h.sockets[0].readyState).toBe(3)
})
test("invalid access keys produce a useful error", async () => {
  const h = harness()
  h.api = await loadTransport()
  h.fetch(async () => ({ status: 401 }))
  // The error carries the coded payload so the UI can translate it by locale.
  await expect(h.api.invoke("rpc_running")).rejects.toThrow(/PIXERR:.*remoteUnauthorized/)
})

const flush = () => new Promise(resolve => setImmediate(resolve))

test("unexpected drops reconnect with backoff and emit a reconnected event", async () => {
  const h = harness()
  h.api = await loadTransport()
  const reconnected = []
  await h.api.listen("pi://reconnected", e => reconnected.push(e.payload))
  await h.api.listen("pi://event", () => {})
  expect(h.sockets.length).toBe(1)

  // Simulate an unexpected transport drop.
  h.sockets[0].onclose()
  h.runTimers()
  await flush()

  // A fresh socket was created and listeners were told to re-sync.
  expect(h.sockets.length).toBe(2)
  expect(h.sockets[1].url.includes("/api/events")).toBe(true)
  expect(reconnected.length).toBe(1)

  // A second drop retries; the reconnect attempt reuses the shared socket.
  h.sockets[1].onclose()
  h.runTimers()
  await flush()
  expect(h.sockets.length).toBe(3)
  expect(reconnected.length).toBe(2)
})

test("intentional close after the last listener unsubscribes does not reconnect", async () => {
  const h = harness()
  h.api = await loadTransport()
  const off = await h.api.listen("pi://event", () => {})
  off()
  expect(h.sockets[0].readyState).toBe(3)
  h.runTimers()
  await flush()
  expect(h.sockets.length).toBe(1)
})

test("stale socket events cannot clobber a newer connection", async () => {
  const h = harness()
  h.api = await loadTransport()
  const reconnected = []
  await h.api.listen("pi://reconnected", () => reconnected.push(true))
  const first = h.sockets[0]
  first.onclose()
  h.runTimers()
  await flush()
  expect(h.sockets.length).toBe(2)
  // Late close of the replaced socket must not trigger another reconnect
  // or dispatch disconnect events for the live connection.
  first.onclose()
  h.runTimers()
  await flush()
  expect(h.sockets.length).toBe(2)
  expect(reconnected.length).toBe(1)
})

test("tokenless access can authenticate with a password without placing the key in the URL", async () => {
  const h = harness(false, "")
  h.api = await loadTransport()
  expect(h.api.hasRemoteToken()).toBe(false)
  h.fetch(async (url, options) => {
    h.requests.push({ url, options })
    if (url === "/api/auth") return { ok: true, json: async () => ({ passwordEnabled: true, authenticated: false }) }
    if (url === "/api/auth/login") return { ok: true, status: 200, json: async () => ({ token: "session-key" }) }
    return { ok: true, status: 200, json: async () => ({ data: true }) }
  })
  expect((await h.api.remoteAuthStatus()).passwordEnabled).toBe(true)
  expect(await h.api.loginRemote("test-password")).toBe("ok")
  expect(h.api.hasRemoteToken()).toBe(true)
  expect(h.stored.get("pi-remote-token")).toBe("session-key")
  expect(h.requests.find(request => request.url === "/api/auth/login").options.body).toBe(
    JSON.stringify({ password: "test-password" }),
  )
  await h.api.invoke("rpc_running")
  expect(h.requests.at(-1).options.headers.Authorization).toBe("Bearer session-key")
  expect(h.requests.some(request => request.url?.includes("test-password"))).toBe(false)
})

test("invalid and rate-limited password attempts do not store a token", async () => {
  const h = harness(false, "")
  h.api = await loadTransport()
  h.fetch(async () => ({ status: 401 }))
  expect(await h.api.loginRemote("wrong-password")).toBe("invalid")
  h.fetch(async () => ({ status: 429 }))
  expect(await h.api.loginRemote("wrong-password")).toBe("limited")
  expect(h.api.hasRemoteToken()).toBe(false)
})
