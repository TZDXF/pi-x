import { computed, readonly, ref } from "vue"

/**
 * Central keyboard-shortcut registry.
 *
 * A shortcut is stored as a canonical combo string, e.g. "ctrl+shift+e".
 * Modifier order is fixed (ctrl, alt, shift, meta) and the key part is the
 * lowercased `KeyboardEvent.key`, so recorded combos match subsequent events
 * on the same keyboard layout. Users may rebind any configurable action;
 * overrides persist in localStorage under STORAGE_KEY.
 */

export type ShortcutScope = "global" | "chat" | "editor" | "sidebar"

export interface ShortcutActionDef {
  scope: ShortcutScope
  /** i18n key under the top-level `shortcuts.actions` section. */
  labelKey: string
  default: string
}

export const SHORTCUT_ACTION_DEFS = {
  "app.newSession": { scope: "global", labelKey: "shortcuts.actions.newSession", default: "ctrl+n" },
  "app.focusComposer": { scope: "global", labelKey: "shortcuts.actions.focusComposer", default: "ctrl+i" },
  "app.toggleSidebar": { scope: "global", labelKey: "shortcuts.actions.toggleSidebar", default: "ctrl+b" },
  "app.settings": { scope: "global", labelKey: "shortcuts.actions.settings", default: "ctrl+," },
  "app.schedules": { scope: "global", labelKey: "shortcuts.actions.schedules", default: "ctrl+shift+l" },
  "app.archives": { scope: "global", labelKey: "shortcuts.actions.archives", default: "ctrl+shift+h" },
  "app.prevSession": { scope: "global", labelKey: "shortcuts.actions.prevSession", default: "alt+arrowup" },
  "app.nextSession": { scope: "global", labelKey: "shortcuts.actions.nextSession", default: "alt+arrowdown" },
  "chat.stop": { scope: "chat", labelKey: "shortcuts.actions.stop", default: "escape" },
  "chat.forkLast": { scope: "chat", labelKey: "shortcuts.actions.forkLast", default: "ctrl+shift+f" },
  "chat.copyLastAnswer": { scope: "chat", labelKey: "shortcuts.actions.copyLastAnswer", default: "ctrl+shift+c" },
  "chat.scrollTop": { scope: "chat", labelKey: "shortcuts.actions.scrollTop", default: "ctrl+home" },
  "chat.scrollBottom": { scope: "chat", labelKey: "shortcuts.actions.scrollBottom", default: "ctrl+end" },
  "chat.cycleModel": { scope: "chat", labelKey: "shortcuts.actions.cycleModel", default: "ctrl+alt+m" },
  "chat.cycleThinkingLevel": {
    scope: "chat",
    labelKey: "shortcuts.actions.cycleThinkingLevel",
    default: "ctrl+alt+t",
  },
  "editor.attachFile": { scope: "editor", labelKey: "shortcuts.actions.attachFile", default: "ctrl+shift+a" },
  "editor.toggleDelayedSend": {
    scope: "editor",
    labelKey: "shortcuts.actions.toggleDelayedSend",
    default: "ctrl+shift+d",
  },
  "sidebar.review": { scope: "sidebar", labelKey: "shortcuts.actions.review", default: "ctrl+shift+r" },
  "sidebar.files": { scope: "sidebar", labelKey: "shortcuts.actions.files", default: "ctrl+shift+e" },
  "sidebar.terminal": { scope: "sidebar", labelKey: "shortcuts.actions.terminal", default: "ctrl+`" },
  "sidebar.browser": { scope: "sidebar", labelKey: "shortcuts.actions.browser", default: "ctrl+shift+u" },
  "sidebar.closeTab": { scope: "sidebar", labelKey: "shortcuts.actions.closeTab", default: "ctrl+shift+w" },
  "sidebar.nextTab": { scope: "sidebar", labelKey: "shortcuts.actions.nextTab", default: "ctrl+pagedown" },
  "sidebar.prevTab": { scope: "sidebar", labelKey: "shortcuts.actions.prevTab", default: "ctrl+pageup" },
} as const satisfies Record<string, ShortcutActionDef>

export type ShortcutActionId = keyof typeof SHORTCUT_ACTION_DEFS

export const SHORTCUT_ACTION_IDS = Object.keys(SHORTCUT_ACTION_DEFS) as ShortcutActionId[]

/** Display-only keys handled directly by the composer; never configurable. */
export const LOCKED_SHORTCUTS = [
  { id: "editor.send", labelKey: "shortcuts.actions.send", default: "enter" },
  { id: "editor.newline", labelKey: "shortcuts.actions.newline", default: "shift+enter" },
] as const

export type LockedShortcutId = (typeof LOCKED_SHORTCUTS)[number]["id"]

const MODIFIER_ORDER = ["ctrl", "alt", "shift", "meta"] as const
const MODIFIER_KEYS = new Set<string>(MODIFIER_ORDER)

const STORAGE_KEY = "pix.shortcuts"

function isShortcutActionId(value: string): value is ShortcutActionId {
  return Object.prototype.hasOwnProperty.call(SHORTCUT_ACTION_DEFS, value)
}

function loadOverrides(): Partial<Record<ShortcutActionId, string>> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return {}
    const overrides: Partial<Record<ShortcutActionId, string>> = {}
    for (const [id, combo] of Object.entries(parsed as Record<string, unknown>)) {
      if (isShortcutActionId(id) && typeof combo === "string" && combo) overrides[id] = combo
    }
    return overrides
  } catch {
    /* Storage is optional. */
    return {}
  }
}

function saveOverrides(overrides: Partial<Record<ShortcutActionId, string>>) {
  try {
    const entries = Object.entries(overrides).filter(([, combo]) => !!combo)
    if (entries.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* Storage is optional. */
  }
}

const overrides = ref<Partial<Record<ShortcutActionId, string>>>(loadOverrides())

/** The combo currently bound to an action (override or default). */
export function shortcutCombo(id: ShortcutActionId): string {
  return overrides.value[id] ?? SHORTCUT_ACTION_DEFS[id].default
}

export function isShortcutModified(id: ShortcutActionId): boolean {
  const combo = overrides.value[id]
  return !!combo && combo !== SHORTCUT_ACTION_DEFS[id].default
}

/** Bind a new combo, or pass null to fall back to the default. */
export function setShortcutOverride(id: ShortcutActionId, combo: string | null) {
  const next = { ...overrides.value }
  if (!combo || combo === SHORTCUT_ACTION_DEFS[id].default) delete next[id]
  else next[id] = combo
  overrides.value = next
  saveOverrides(next)
}

export function resetAllShortcuts() {
  overrides.value = {}
  saveOverrides({})
}

/** The action currently bound to a combo, ignoring `excludeId`. */
export function resolveShortcut(combo: string, excludeId?: ShortcutActionId): ShortcutActionId | null {
  for (const id of SHORTCUT_ACTION_IDS) {
    if (id === excludeId) continue
    if (shortcutCombo(id) === combo) return id
  }
  return null
}

/** Conflict lookup for the settings page; locked keys occupy their combo too. */
export function findShortcutConflict(
  combo: string,
  excludeId?: ShortcutActionId,
): ShortcutActionId | LockedShortcutId | null {
  const action = resolveShortcut(combo, excludeId)
  if (action) return action
  return LOCKED_SHORTCUTS.find(entry => entry.default === combo)?.id ?? null
}

const KEY_DISPLAY: Record<string, string> = {
  escape: "Esc",
  enter: "Enter",
  space: "Space",
  tab: "Tab",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  home: "Home",
  end: "End",
  pageup: "PgUp",
  pagedown: "PgDn",
  delete: "Del",
  backspace: "Backspace",
}
const MODIFIER_DISPLAY: Record<string, string> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Meta" }

/** Split a combo into display segments, e.g. ["Ctrl", "Shift", "E"]. */
export function formatComboParts(combo: string): string[] {
  return combo.split("+").map(part => {
    if (MODIFIER_DISPLAY[part]) return MODIFIER_DISPLAY[part]
    if (KEY_DISPLAY[part]) return KEY_DISPLAY[part]
    if (part.length === 1) return part.toUpperCase()
    return part.charAt(0).toUpperCase() + part.slice(1)
  })
}

const SPECIAL_KEYS: Record<string, string> = { " ": "space" }

function normalizeEventKey(key: string): string {
  const mapped = SPECIAL_KEYS[key] ?? key
  return mapped.toLowerCase()
}

/** Canonical combo for a keyboard event, or null for pure modifiers / IME. */
export function comboFromEvent(event: {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
  isComposing: boolean
}): string | null {
  if (event.isComposing) return null
  const key = normalizeEventKey(event.key)
  if (!key || MODIFIER_KEYS.has(key)) return null
  const parts: string[] = []
  if (event.ctrlKey) parts.push("ctrl")
  if (event.altKey) parts.push("alt")
  if (event.shiftKey) parts.push("shift")
  if (event.metaKey) parts.push("meta")
  parts.push(key)
  return parts.join("+")
}

function comboHasModifier(combo: string): boolean {
  return combo.split("+").some(part => MODIFIER_KEYS.has(part))
}

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return (
    !!el &&
    typeof el.closest === "function" &&
    !!el.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
    )
  )
}

type ShortcutHandler = (event: KeyboardEvent) => void
const handlers = new Map<ShortcutActionId, ShortcutHandler>()

/** Register the executor for an action; returns an unregister function. */
export function registerShortcutHandler(id: ShortcutActionId, handler: ShortcutHandler): () => void {
  handlers.set(id, handler)
  return () => {
    if (handlers.get(id) === handler) handlers.delete(id)
  }
}

// Dialogs (fork / preview / prompt edit) suppress shortcut dispatch entirely.
const suppressedTokens = ref<ReadonlySet<string>>(new Set())

export function setShortcutsSuppressed(token: string, active: boolean) {
  const next = new Set(suppressedTokens.value)
  if (active) next.add(token)
  else next.delete(token)
  suppressedTokens.value = next
}

export const shortcutsSuppressed = readonly(computed(() => suppressedTokens.value.size > 0))

/**
 * Resolve and dispatch a keydown against registered handlers.
 * Returns true when the event was consumed.
 */
export function dispatchShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || shortcutsSuppressed.value) return false
  const combo = comboFromEvent(event)
  if (!combo) return false
  const id = resolveShortcut(combo)
  if (!id) return false
  const editable = isEditableTarget(event.target)
  // Editor-scope actions only fire while typing; bare keys never hijack text
  // input (Escape stays available so generation can always be stopped).
  if (SHORTCUT_ACTION_DEFS[id].scope === "editor" && !editable) return false
  if (editable && !comboHasModifier(combo) && combo !== "escape") return false
  const handler = handlers.get(id)
  if (!handler) return false
  event.preventDefault()
  handler(event)
  return true
}
