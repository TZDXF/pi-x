import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import { composerChipDeletion, composerParts } from "@/lib/composerTokens"
import { normalizeSlashes } from "@/lib/paths"

test("composer chips hide paths and slash prefixes without changing raw text", () => {
  const text = '/review @"C:/project/src/my file.ts" @session("C:/sessions/old.jsonl") with @src/App.vue '
  const parts = composerParts(text)
  expect(parts.filter(p => p.kind !== "text").map(p => [p.kind, p.label])).toEqual([
    ["command", "review"],
    ["file", "my file.ts"],
    ["session", "old.jsonl"],
    ["file", "App.vue"],
  ])
  expect(parts.map(p => p.raw).join("")).toBe(text)
})

test("unfinished completion tokens remain editable plain text", () => {
  for (const text of ["/rev", "@src/in", '@"src/unclosed', "mail@example.com"])
    expect(
      composerParts(text)
        .map(p => p.raw)
        .join(""),
    ).toBe(text)
  expect(composerParts("/rev").some(p => p.kind !== "text")).toBe(false)
  expect(composerParts("@src/in").some(p => p.kind !== "text")).toBe(false)
  expect(composerParts("mail@example.com ").some(p => p.kind !== "text")).toBe(false)
})

test("known session references display their current title", () => {
  const raw = '@session("C:/sessions/old.jsonl")'
  const labels = { [normalizeSlashes("C:\\sessions\\old.jsonl")]: "修复登录问题" }
  const [part] = composerParts(`请看 ${raw} 的上下文`, labels)
  expect(part.kind).toBe("text")
  const session = composerParts(`请看 ${raw} 的上下文`, labels).find(p => p.kind === "session")
  expect(session.label).toBe("修复登录问题")
  expect(session.raw).toBe(raw)
  expect(composerParts(`请看 ${raw} `, {}).find(p => p.kind === "session").label).toBe("old.jsonl")
})

test("rich editor preserves browser newline and undo behavior for plain text", () => {
  const editor = readFileSync(new URL("../src/components/ComposerRichEditor.vue", import.meta.url), "utf8")
  expect(editor).toMatch(/insertLineBreak/)
  expect(editor).toMatch(/editorRequiresRender\(editor\.value, value\)/)
  expect(editor).not.toMatch(/replaceSelection/)
  expect(editor).toMatch(/composerChipDeletion\(textInput\.value, parts, key, caret\)/)
})

test("rich editor wires workspace session titles into chip rendering", () => {
  const editor = readFileSync(new URL("../src/components/ComposerRichEditor.vue", import.meta.url), "utf8")
  const composable = readFileSync(new URL("../src/composables/useSessionLabels.ts", import.meta.url), "utf8")
  expect(editor).toMatch(/useSessionLabels/)
  expect(composable).toMatch(/row\.title \|\| row\.preview/)
  expect(editor).toMatch(/composerParts\(value, sessionLabels\.value\)/)
  expect(editor).toMatch(/watch\(sessionLabels/)
})

test("rendered user messages reuse the composer chip styling", () => {
  const view = readFileSync(new URL("../src/components/ChatView.vue", import.meta.url), "utf8")
  const display = readFileSync(new URL("../src/components/ComposerText.vue", import.meta.url), "utf8")
  const editor = readFileSync(new URL("../src/components/ComposerRichEditor.vue", import.meta.url), "utf8")
  expect(view).toMatch(/<ComposerText v-else :text="entry\.text" \/>/)
  expect(display).toMatch(/composerParts\(props\.text, sessionLabels\.value\)/)
  expect(display).toMatch(/composerChipClass/)
  expect(display).toMatch(/composerChipText\(part\)/)
  for (const source of [display, editor]) {
    expect(source).not.toMatch(/inline-flex max-w-52 items-center/)
  }
})

test("backspace and delete remove reference chips at their whole boundaries", () => {
  const raw = '@"src/my file.ts"'
  const text = `before ${raw} after`
  const parts = composerParts(text)
  const start = 7
  const end = start + raw.length

  expect(composerChipDeletion(text, parts, "Backspace", end)).toEqual({
    chipIndex: 0,
    start,
    end,
    caret: start,
  })
  expect(composerChipDeletion(text, parts, "Backspace", end + 1)).toEqual({
    chipIndex: 0,
    start,
    end: end + 1,
    caret: start,
  })
  expect(composerChipDeletion(text, parts, "Delete", start)).toEqual({
    chipIndex: 0,
    start,
    end,
    caret: start,
  })
  expect(composerChipDeletion(text, parts, "Delete", start - 1)).toEqual({
    chipIndex: 0,
    start: start - 1,
    end,
    caret: start - 1,
  })
  expect(composerChipDeletion(text, parts, "Backspace", text.length)).toBeNull()
})
