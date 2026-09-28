import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { loadTsModule, pathsModule } from "./lib/load-ts.mjs"

const { composerParts } = loadTsModule(new URL("../src/lib/composerTokens.ts", import.meta.url))
const { normalizeSlashes } = pathsModule()
// VM 内创建的对象原型与测试环境不同，deepStrictEqual 会因原型差异而失败。
const plain = value => JSON.parse(JSON.stringify(value))

test("composer chips hide paths and slash prefixes without changing raw text", () => {
  const text = '/review @"C:/project/src/my file.ts" @session("C:/sessions/old.jsonl") with @src/App.vue '
  const parts = composerParts(text)
  assert.deepEqual(plain(parts.filter(p => p.kind !== "text").map(p => [p.kind, p.label])), [
    ["command", "review"],
    ["file", "my file.ts"],
    ["session", "old.jsonl"],
    ["file", "App.vue"],
  ])
  assert.equal(parts.map(p => p.raw).join(""), text)
})

test("unfinished completion tokens remain editable plain text", () => {
  for (const text of ["/rev", "@src/in", '@"src/unclosed', "mail@example.com"])
    assert.equal(
      composerParts(text)
        .map(p => p.raw)
        .join(""),
      text,
    )
  assert.equal(
    composerParts("/rev").some(p => p.kind !== "text"),
    false,
  )
  assert.equal(
    composerParts("@src/in").some(p => p.kind !== "text"),
    false,
  )
  assert.equal(
    composerParts("mail@example.com ").some(p => p.kind !== "text"),
    false,
  )
})

test("known session references display their current title", () => {
  const raw = '@session("C:/sessions/old.jsonl")'
  const labels = { [normalizeSlashes("C:\\sessions\\old.jsonl")]: "修复登录问题" }
  const [part] = composerParts(`请看 ${raw} 的上下文`, labels)
  assert.equal(part.kind, "text")
  const session = composerParts(`请看 ${raw} 的上下文`, labels).find(p => p.kind === "session")
  assert.equal(session.label, "修复登录问题")
  assert.equal(session.raw, raw)
  assert.equal(composerParts(`请看 ${raw} `, {}).find(p => p.kind === "session").label, "old.jsonl")
})

test("rich editor wires workspace session titles into chip rendering", () => {
  const editor = readFileSync(new URL("../src/components/ComposerRichEditor.vue", import.meta.url), "utf8")
  const composable = readFileSync(new URL("../src/composables/useSessionLabels.ts", import.meta.url), "utf8")
  assert.match(editor, /useSessionLabels/)
  assert.match(composable, /row\.title \|\| row\.preview/)
  assert.match(editor, /composerParts\(value, sessionLabels\.value\)/)
  assert.match(editor, /watch\(sessionLabels/)
})

test("rendered user messages reuse the composer chip styling", () => {
  const view = readFileSync(new URL("../src/components/ChatView.vue", import.meta.url), "utf8")
  const display = readFileSync(new URL("../src/components/ComposerText.vue", import.meta.url), "utf8")
  const editor = readFileSync(new URL("../src/components/ComposerRichEditor.vue", import.meta.url), "utf8")
  assert.match(view, /<ComposerText v-else :text="entry\.text" \/>/)
  assert.match(display, /composerParts\(props\.text, sessionLabels\.value\)/)
  assert.match(display, /composerChipClass/)
  assert.match(display, /composerChipText\(part\)/)
  for (const source of [display, editor]) {
    assert.doesNotMatch(source, /inline-flex max-w-52 items-center/)
  }
})
