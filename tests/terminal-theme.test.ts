import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

const source = readFileSync(new URL("../src/lib/terminalTheme.ts", import.meta.url), "utf8")
  .replace(/^import .*$/gm, "")
  .replace(/if \(import\.meta\.hot\) \{[\s\S]*$/, "")
  .replace(/export /g, "")

function harness(stored: string | null) {
  let value = stored
  let storageListener: ((event: { key: string | null }) => void) | null = null
  const context = vm.createContext({
    ref: (initial: unknown) => ({ value: initial }),
    readonly: (value: unknown) => value,
    localStorage: {
      getItem: () => value,
      setItem: (_: string, next: string) => {
        value = next
      },
    },
    window: {
      addEventListener: (_: string, fn: (event: { key: string | null }) => void) => {
        storageListener = fn
      },
    },
  })
  vm.runInContext(
    ts.transpile(
      source +
        "\nglobalThis.api = { terminalTheme, TERMINAL_PRESETS, setTerminalPreset, setTerminalColor, resetTerminalTheme, terminalPresetLabelKey };",
      { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    ),
    context,
  )
  return {
    ...context.api,
    stored: () => value,
    storage: (next: string | null) => {
      value = next
      storageListener!({ key: "pix.terminalTheme" })
    },
  }
}

test("defaults to the dark default preset", () => {
  for (const stored of [null, "not json", JSON.stringify({ preset: "nope", colors: {} })]) {
    const h = harness(stored)
    expect(h.terminalTheme.value.preset).toBe("default")
    expect(h.terminalTheme.value.colors).toEqual(h.TERMINAL_PRESETS.default)
  }
})

test("preset selection swaps colors and persists", () => {
  const h = harness(null)
  h.setTerminalPreset("dracula")
  expect(h.terminalTheme.value.preset).toBe("dracula")
  expect(h.terminalTheme.value.colors).toEqual(h.TERMINAL_PRESETS.dracula)
  expect(JSON.parse(h.stored()).preset).toBe("dracula")
  expect(harness(h.stored()).terminalTheme.value.colors).toEqual(h.TERMINAL_PRESETS.dracula)
})

test("editing a color switches to custom and keeps the other colors", () => {
  const h = harness(null)
  h.setTerminalPreset("nord")
  h.setTerminalColor("background", "#112233")
  expect(h.terminalTheme.value.preset).toBe("custom")
  expect(h.terminalTheme.value.colors).toEqual({ ...h.TERMINAL_PRESETS.nord, background: "#112233" })

  h.setTerminalColor("foreground", "red")
  expect(h.terminalTheme.value.colors.foreground).toBe(h.TERMINAL_PRESETS.nord.foreground)
  h.setTerminalColor("bogus" as "cursor", "#445566")
  expect(h.terminalTheme.value.preset).toBe("custom")
})

test("custom schemes survive persistence and storage events", () => {
  const h = harness(null)
  h.setTerminalColor("selectionBackground", "#ABCDEF")
  const restored = harness(h.stored())
  expect(restored.terminalTheme.value.preset).toBe("custom")
  expect(restored.terminalTheme.value.colors.selectionBackground).toBe("#abcdef")

  restored.storage(JSON.stringify({ preset: "default", colors: h.TERMINAL_PRESETS.default }))
  expect(restored.terminalTheme.value.preset).toBe("default")
})

test("invalid persisted colors fall back to the preset colors", () => {
  const h = harness(
    JSON.stringify({
      preset: "custom",
      colors: { background: "nope", foreground: "#111111", cursor: "#222222", selectionBackground: "#333333" },
    }),
  )
  expect(h.terminalTheme.value.preset).toBe("default")
  expect(h.terminalTheme.value.colors).toEqual(h.TERMINAL_PRESETS.default)
})

test("reset restores the default preset and persists it", () => {
  const h = harness(null)
  h.setTerminalPreset("solarizedDark")
  h.resetTerminalTheme()
  expect(h.terminalTheme.value.preset).toBe("default")
  expect(JSON.parse(h.stored()).preset).toBe("default")
})

test("preset label keys cover every preset", () => {
  const presets = harness(null).TERMINAL_PRESETS
  for (const key of Object.keys(presets)) {
    expect(harness(null).terminalPresetLabelKey(key as "default")).toBe(
      `settings.terminalPreset${key[0].toUpperCase()}${key.slice(1)}`,
    )
  }
  expect(harness(null).terminalPresetLabelKey("custom")).toBe("settings.terminalPresetCustom")
})
