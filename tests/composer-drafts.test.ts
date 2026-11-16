import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import ts from "typescript"

const source = readFileSync(new URL("../src/stores/composerDrafts.ts", import.meta.url), "utf8")
const js = ts
  .transpile(source, { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 })
  .replace('from "vue"', `from "${import.meta.resolve("vue")}"`)
const storage = new Map()
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
}
let sequence = 0
const load = () => import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}#${sequence++}`)

test("a project new-session draft is restored, then cleared after sending", async () => {
  const drafts = await load()
  drafts.recordComposerDraft("C:/project", null, "unsent project text")
  expect(drafts.composerDraftText("C:/project", null)).toBe("unsent project text")
  expect(drafts.composerDraftText("C:/other-project", null)).toBe("")

  const restored = await load()
  expect(restored.composerDraftText("C:/project", null)).toBe("unsent project text")
  restored.recordComposerDraft("C:/project", null, "")
  restored.recordComposerDraft("C:/project", "C:/sessions/one.jsonl", "")
  expect(restored.composerDraftText("C:/project", null)).toBe("")
  expect(restored.composerDraftText("C:/project", "C:/sessions/one.jsonl")).toBe("")
})

test("saved session drafts remain independent from the project new-session input", async () => {
  const drafts = await load()
  drafts.recordComposerDraft("C:/project", null, "next session")
  drafts.recordComposerDraft("C:/project", "C:/sessions/one.jsonl", "existing session")
  expect(drafts.composerDraftText("C:/project", null)).toBe("next session")
  expect(drafts.composerDraftText("C:/project", "C:/sessions/one.jsonl")).toBe("existing session")
})

test("image-only drafts retain original files independently of the project and other sessions", async () => {
  const drafts = await load()
  const image = new File(["hello"], "photo.png", { type: "image/png" })
  const files = [image]
  drafts.recordComposerDraft("C:/project", "C:/sessions/images.jsonl", "", files)
  files.length = 0

  expect(drafts.composerDraftFiles("C:/project", "C:\\sessions\\images.jsonl")).toEqual([image])
  expect(drafts.composerDraftFiles("C:/project", null)).toEqual([])
  expect(drafts.composerDraftFiles("C:/project", "C:/sessions/other.jsonl")).toEqual([])
  const snapshot = drafts.composerDraftFiles("C:/project", "C:/sessions/images.jsonl")
  snapshot.length = 0
  expect(drafts.composerDraftFiles("C:/project", "C:/sessions/images.jsonl")).toEqual([image])

  drafts.recordComposerDraft("C:/project", "C:/sessions/images.jsonl", "")
  expect(drafts.composerDraftFiles("C:/project", "C:/sessions/images.jsonl")).toEqual([])
})

test("text persistence excludes file objects and preview URLs, retaining legacy text draft compatibility", async () => {
  const drafts = await load()
  const image = new File(["image bytes"], "photo.png", { type: "image/png" })
  drafts.recordComposerDraft("C:/project", "C:/sessions/with-image.jsonl", "draft text", [image])
  drafts.recordComposerDraft("C:/project", "C:/sessions/image-only.jsonl", "", [image])
  const saved = JSON.parse(storage.get("pix.composerDrafts"))
  expect(saved.find(draft => draft.file === "C:/sessions/with-image.jsonl")).toEqual({
    project: "C:/project",
    file: "C:/sessions/with-image.jsonl",
    text: "draft text",
  })
  expect(saved.some(draft => draft.file === "C:/sessions/image-only.jsonl")).toBe(false)

  const reloaded = await load()
  expect(reloaded.composerDraftText("C:/project", "C:/sessions/with-image.jsonl")).toBe("draft text")
  expect(reloaded.composerDraftFiles("C:/project", "C:/sessions/with-image.jsonl")).toEqual([])
  expect(drafts.composerDraftFiles("C:/project", "C:/sessions/with-image.jsonl")).toEqual([image])
})
