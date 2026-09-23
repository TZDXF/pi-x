import { invoke as desktopInvoke, isTauri } from "@tauri-apps/api/core"
import { listen as desktopListen } from "@tauri-apps/api/event"
export const isDesktop = isTauri()
let token = sessionStorage.getItem("pi-remote-token") ?? ""
const fragment = new URLSearchParams(location.hash.slice(1))
if (fragment.has("token")) {
  token = fragment.get("token") ?? ""
  sessionStorage.setItem("pi-remote-token", token)
  history.replaceState(null, "", location.pathname + location.search)
}
export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isDesktop) return desktopInvoke<T>(command, args)
  const res = await fetch("/api/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ command, args }),
  })
  if (res.status === 401) throw new Error("访问密钥无效，请从桌面设置重新复制访问链接。")
  const result = await res.json()
  if (!res.ok) throw new Error(result.error ?? `HTTP ${res.status}`)
  return result.data
}

const handlers = new Map<string, Set<(e: { payload: any }) => void>>()
let socket: WebSocket | undefined
let connecting: Promise<void> | undefined
/** Set while WE close the socket deliberately (last listener gone / first-connect timeout). */
let closingIntentionally = false
/** Exponential backoff state for unexpected disconnects (1s → 2s → … → 30s cap). */
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let reconnectAttempts = 0
const MAX_RECONNECT_DELAY = 30_000

/** Emitted once after a dropped connection has been re-established; events
 *  during the gap are lost, so listeners should re-sync state (running
 *  sessions, workspace histories) when they receive it. */
export const RECONNECTED_EVENT = "pi://reconnected"

function dispatch(event: string, payload: unknown) {
  handlers.get(event)?.forEach(h => h({ payload }))
}

function scheduleReconnect() {
  if (closingIntentionally || reconnectTimer || handlers.size === 0) return
  const delay = Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY)
  reconnectAttempts += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined
    connect()
      .then(() => {
        reconnectAttempts = 0
        dispatch(RECONNECTED_EVENT, {})
      })
      .catch(() => scheduleReconnect())
  }, delay)
}

function connect(): Promise<void> {
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve()
  if (connecting) return connecting
  connecting = new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/events?token=${encodeURIComponent(token)}`,
    )
    socket = ws
    const timeout = setTimeout(() => {
      reject(new Error("远程连接超时，请检查桌面端服务与防火墙。"))
      closingIntentionally = true
      ws.close()
    }, 10000)
    ws.onopen = () => {
      clearTimeout(timeout)
      if (socket !== ws) return
      connecting = undefined
      resolve()
    }
    ws.onerror = () => {
      clearTimeout(timeout)
      if (socket !== ws) return
      connecting = undefined
      reject(new Error("无法连接远程服务，请检查访问链接与桌面端开关。"))
    }
    ws.onmessage = (e) => {
      const event = JSON.parse(e.data)
      dispatch(event.event, event.payload)
    }
    ws.onclose = () => {
      clearTimeout(timeout)
      // A newer connection may already exist; never clobber it or treat its
      // stale close as a disconnect of the live socket.
      if (socket !== ws) return
      connecting = undefined
      socket = undefined
      if (closingIntentionally) {
        closingIntentionally = false
        return
      }
      // Unexpected drop: surface the disconnect, then reconnect in the
      // background. Callers awaiting this initial connect still see the error.
      reject(new Error("远程连接已断开"))
      dispatch("pi://stderr", { line: "远程连接已断开，正在自动重连…" })
      dispatch("pi://exit", {})
      scheduleReconnect()
    }
  })
  return connecting
}

export async function listen<T = unknown>(
  event: string,
  handler: (e: { payload: T }) => void,
): Promise<() => void> {
  if (isDesktop) return desktopListen<T>(event, handler)
  const set = handlers.get(event) ?? new Set()
  handlers.set(event, set)
  set.add(handler)
  try {
    await connect()
  } catch (e) {
    set.delete(handler)
    throw e
  }
  return () => {
    set.delete(handler)
    if ([...handlers.values()].every((s) => s.size === 0)) {
      closingIntentionally = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      socket?.close()
    }
  }
}
