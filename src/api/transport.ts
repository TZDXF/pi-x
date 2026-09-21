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
function connect(): Promise<void> {
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve()
  if (connecting) return connecting
  connecting = new Promise<void>((resolve, reject) => {
    socket = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/events?token=${encodeURIComponent(token)}`,
    )
    const timeout = setTimeout(() => {
      reject(new Error("远程连接超时，请检查桌面端服务与防火墙。"))
      socket?.close()
    }, 10000)
    socket.onopen = () => {
      clearTimeout(timeout)
      connecting = undefined
      resolve()
    }
    socket.onerror = () => {
      clearTimeout(timeout)
      connecting = undefined
      reject(new Error("无法连接远程服务，请检查访问链接与桌面端开关。"))
    }
    socket.onmessage = (e) => {
      const event = JSON.parse(e.data)
      handlers.get(event.event)?.forEach((h) => h({ payload: event.payload }))
    }
    socket.onclose = () => {
      clearTimeout(timeout)
      connecting = undefined
      reject(new Error("远程连接已断开"))
      handlers
        .get("pi://stderr")
        ?.forEach((h) => h({ payload: { line: "远程连接已断开，请刷新页面重新连接。" } }))
      handlers.get("pi://exit")?.forEach((h) => h({ payload: {} }))
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
    if ([...handlers.values()].every((s) => s.size === 0)) socket?.close()
  }
}
