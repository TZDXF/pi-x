import { reactive } from "vue"
import { createUuid } from "../lib/uuid"
import { sameSessionIdentity } from "@/lib/sessionIdentity"
import { getActivePinia } from "pinia"
import { createSessionStore } from "./session"
import { isMember } from "./splitView"
import { createUiStore } from "./ui"
import { activeRuntimeId } from "./runtime"

export type { Block, ToolCallBlock, ToolRun, Entry } from "./session"

type SessionStoreFn = ReturnType<typeof createSessionStore>
type Session = ReturnType<SessionStoreFn>
type UiStoreFn = ReturnType<typeof createUiStore>
type Ui = ReturnType<UiStoreFn>
const sessions = reactive(new Map<string, Session>()) as unknown as Map<string, Session>
const interfaces = new Map<string, Ui>()

export function sessionFor(id: string): Session {
  let store = sessions.get(id)
  if (!store) {
    store = createSessionStore(id)()
    sessions.set(id, store)
  }
  return store
}
export function uiFor(id: string): Ui {
  let store = interfaces.get(id)
  if (!store) {
    store = createUiStore(id, () => {
      const owner = sessionFor(id)
      return { runtimeId: id, sessionFile: owner.sessionFile, cwd: owner.cwd }
    })()
    interfaces.set(id, store)
  }
  return store
}

/**
 * aux（辅助对话）的 ui store 只登记进查找表，**不进** `sessions`。
 *
 * 这样 `ExtensionDialog` / `StatusBar` 凭 `:session-id="auxRuntimeId"` 能拿到 aux
 * 自己的 ui（扩展询问不会落到主会话、回答不会发错进程），而 `allConversations()`
 * 仍然看不见 aux（左侧会话列表、项目"运行中"、看板卡片都不受影响）。
 */
export function registerAuxUiStore(id: string, store: Ui) {
  interfaces.set(id, store)
}

export function dropAuxUiStore(id: string) {
  interfaces.delete(id)
}
export function activateSession(id: string) {
  sessionFor(id)
  uiFor(id)
  activeRuntimeId.value = id
}
export function createConversation(project: string) {
  const id = createUuid()
  pruneDormantConversations()
  const store = sessionFor(id)
  store.cwd = project
  activateSession(id)
  return store
}

/** Drop dormant (not started, not streaming, not active) conversation stores
 *  once too many accumulate; each holds loaded history incl. base64 images.
 *  Dormant conversations are lazily restarted with a fresh worker and their
 *  history reloads from disk when the user reopens them, so eviction is safe. */
const MAX_OPEN_CONVERSATIONS = 12
export function pruneDormantConversations() {
  if (sessions.size <= MAX_OPEN_CONVERSATIONS) return
  for (const [id, store] of [...sessions]) {
    if (sessions.size <= MAX_OPEN_CONVERSATIONS) break
    if (isMember(id) || id === activeRuntimeId.value || store.started || store.isStreaming) continue
    sessions.delete(id)
    interfaces.delete(id)
    // Remove the cached Pinia instance as well, or its state stays in memory.
    const pinia = getActivePinia() as unknown as { _s?: Map<string, unknown> } | null
    pinia?._s?.delete(`session:${id}`)
    pinia?._s?.delete(`ui:${id}`)
  }
}
export function findConversation(file: string, project?: string) {
  return [...sessions.values()].find(store => sameSessionIdentity(store.sessionFile, store.cwd, file, project))
}
/** Resolve a history-route id (runtime id map key or session file) to an
 *  in-memory conversation without creating a store as a side effect. */
export function peekConversation(id: string, project?: string): Session | undefined {
  return sessions.get(id) ?? findConversation(id, project)
}
export function isSessionRunning(file: string, project?: string) {
  return !!findConversation(file, project)?.isStreaming
}
export function allConversations() {
  return [...sessions.values()]
}

/** aux 的 session store 不属于会话列表（见 `stores/auxChat.ts` 的 store 表）。 */
export function hasConversation(id: string) {
  return sessions.has(id)
}

// Reads follow the selected conversation, but actions are bound to the store
// at lookup time. Async work in that store never follows later UI navigation.
function selected<T extends object>(get: (id: string) => T): T {
  return new Proxy({} as T, {
    get: (_, key) => Reflect.get(get(activeRuntimeId.value), key),
    set: (_, key, value) => Reflect.set(get(activeRuntimeId.value), key, value),
  }) as T
}
const session = selected(sessionFor)
const ui = selected(uiFor)
export const useSessionStore = () => session
export const useUiStore = () => ui
export { activeRuntimeId }
