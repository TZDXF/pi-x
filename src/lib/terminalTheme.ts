import { readonly, ref } from "vue"

/** xterm 面板用到的四个核心颜色，其余颜色交给 xterm 默认调色板。 */
export interface TerminalColors {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
}

export type TerminalPresetKey = keyof typeof TERMINAL_PRESETS
export type TerminalThemeKey = TerminalPresetKey | "custom"

export const TERMINAL_PRESETS = {
  default: {
    background: "#09090b",
    foreground: "#e4e4e7",
    cursor: "#e4e4e7",
    selectionBackground: "#3f3f46",
  },
  dracula: {
    background: "#282a36",
    foreground: "#f8f8f2",
    cursor: "#f8f8f2",
    selectionBackground: "#44475a",
  },
  solarizedDark: {
    background: "#002b36",
    foreground: "#93a1a1",
    cursor: "#93a1a1",
    selectionBackground: "#073642",
  },
  nord: {
    background: "#2e3440",
    foreground: "#d8dee9",
    cursor: "#d8dee9",
    selectionBackground: "#434c5e",
  },
  githubLight: {
    background: "#ffffff",
    foreground: "#24292f",
    cursor: "#24292f",
    selectionBackground: "#c8e1ff",
  },
} satisfies Record<string, TerminalColors>

const STORAGE_KEY = "pix.terminalTheme"
const COLOR_FIELDS = ["background", "foreground", "cursor", "selectionBackground"] as const
type ColorField = (typeof COLOR_FIELDS)[number]
const isHexColor = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)

const defaultState = (): { preset: TerminalThemeKey; colors: TerminalColors } => ({
  preset: "default",
  colors: { ...TERMINAL_PRESETS.default },
})

function initialState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as {
      preset?: unknown
      colors?: Record<string, unknown>
    } | null
    if (!raw || typeof raw !== "object") return defaultState()
    const state = defaultState()
    const colors = {} as TerminalColors
    let valid = true
    for (const field of COLOR_FIELDS) {
      const value = raw.colors?.[field]
      if (!isHexColor(value)) {
        valid = false
        break
      }
      colors[field] = value
    }
    if (valid) state.colors = colors
    if (raw.preset === "custom" && valid) state.preset = "custom"
    else if (typeof raw.preset === "string" && raw.preset in TERMINAL_PRESETS)
      state.preset = raw.preset as TerminalPresetKey
    if (state.preset !== "custom") state.colors = { ...TERMINAL_PRESETS[state.preset] }
    return state
  } catch {
    return defaultState()
  }
}

const state = ref(initialState())
export const terminalTheme = readonly(state)

export function terminalPresetLabelKey(key: TerminalThemeKey): string {
  return key === "custom"
    ? "settings.terminalPresetCustom"
    : `settings.terminalPreset${key[0].toUpperCase()}${key.slice(1)}`
}

export function setTerminalPreset(key: TerminalThemeKey) {
  if (key !== "custom" && !(key in TERMINAL_PRESETS)) return
  state.value = {
    preset: key,
    colors: key === "custom" ? { ...state.value.colors } : { ...TERMINAL_PRESETS[key] },
  }
  persist()
}

/** 修改单个颜色后进入自定义状态；非法值被忽略。 */
export function setTerminalColor(field: ColorField, value: string) {
  if (!COLOR_FIELDS.includes(field) || !isHexColor(value)) return
  state.value = { preset: "custom", colors: { ...state.value.colors, [field]: value.toLowerCase() } }
  persist()
}

export function resetTerminalTheme() {
  state.value = defaultState()
  persist()
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.value))
  } catch {
    /* Storage is optional. */
  }
}

function syncTerminalTheme(event: StorageEvent) {
  if (event.key !== STORAGE_KEY && event.key !== null) return
  state.value = initialState()
}

window.addEventListener("storage", syncTerminalTheme)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.removeEventListener("storage", syncTerminalTheme)
  })
}
