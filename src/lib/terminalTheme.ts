import { createLocalPreference } from "@/lib/localPreference"

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

function initialState(rawValue: string | null) {
  try {
    const raw = JSON.parse(rawValue ?? "null") as {
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

const preference = createLocalPreference({
  key: STORAGE_KEY,
  defaultValue: defaultState,
  read: initialState,
  serialize: JSON.stringify,
})
export const terminalTheme = preference.value

export function terminalPresetLabelKey(key: TerminalThemeKey): string {
  return key === "custom"
    ? "settings.terminalPresetCustom"
    : `settings.terminalPreset${key[0].toUpperCase()}${key.slice(1)}`
}

export function setTerminalPreset(key: TerminalThemeKey) {
  if (key !== "custom" && !(key in TERMINAL_PRESETS)) return
  preference.set({
    preset: key,
    colors: key === "custom" ? { ...terminalTheme.value.colors } : { ...TERMINAL_PRESETS[key] },
  })
}

/** 修改单个颜色后进入自定义状态；非法值被忽略。 */
export function setTerminalColor(field: ColorField, value: string) {
  if (!COLOR_FIELDS.includes(field) || !isHexColor(value)) return
  preference.set({ preset: "custom", colors: { ...terminalTheme.value.colors, [field]: value.toLowerCase() } })
}

export function resetTerminalTheme() {
  preference.set(defaultState())
}
