import { reactive } from "vue"
import { createSessionStore } from "./session"
import { createUiStore } from "./ui"
import { activeRuntimeId } from "./runtime"

export type { Block, ToolCallBlock, ToolRun, Entry } from "./session"

type Session = ReturnType<ReturnType<typeof createSessionStore>>
type Ui = ReturnType<ReturnType<typeof createUiStore>>
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
  if (!store) { store = createUiStore(id)(); interfaces.set(id, store) }
  return store
}
export function activateSession(id: string) {
  sessionFor(id)
  uiFor(id)
  activeRuntimeId.value = id
}
export function createConversation(project: string) {
  const id = crypto.randomUUID()
  const store = sessionFor(id)
  store.cwd = project
  activateSession(id)
  return store
}
const normalized = (file: string) => file.replace(/\\/g, "/")
export function findConversation(file: string) {
  return [...sessions.values()].find(store => store.sessionFile && normalized(store.sessionFile) === normalized(file))
}
export function isSessionRunning(file: string) {
  return !!findConversation(file)?.isStreaming
}
export function allConversations() { return [...sessions.values()] }

// Reads follow the selected conversation, but actions are bound to the store
// at lookup time. Async work in that store never follows later UI navigation.
function selected<T extends object>(get: (id: string) => T): T {
  return new Proxy({} as T, {
    get: (_, key) => Reflect.get(get(activeRuntimeId.value), key),
    set: (_, key, value) => Reflect.set(get(activeRuntimeId.value), key, value),
  })
}
const session = selected(sessionFor)
const ui = selected(uiFor)
export const useSessionStore = () => session
export const useUiStore = () => ui
export { activeRuntimeId }
