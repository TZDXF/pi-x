import { composerSources } from "./fixtures/chatSources"
import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import * as completion from "@/lib/completion"

const {
  desktopCommands,
  completionToken,
  insertCompletion,
  insertSessionCompletion,
  sessionReference,
  fileReference,
  withSessionReferences,
  mergeWorkspaceFiles,
  sortCommands,
  sortReferences,
} = completion

test("built-in slash commands exclude export while keeping new and compact", () => {
  expect([...desktopCommands]).toEqual(["new", "compact"])
  const chat = composerSources()
  const submit = chat.slice(chat.indexOf("async function onSubmit("), chat.indexOf("function thinkingLabel"))
  expect(submit).not.toMatch(/exportSessionHtml|type: ["']export_html["']|commandName === ["']export["']/)
  expect(submit).toMatch(/completion\.unsupported/)
})

test("slash completion is start-only and supports skill, unicode and hyphenated names", () => {
  for (const text of ["/", "/skill:review", "/my-template", "/检查"]) {
    expect(completionToken(text, text.length)?.kind).toBe("command")
  }
  for (const text of ["explain /skill", "/review args", "//file"]) expect(completionToken(text, text.length)).toBe(null)
})
test("file completion uses caret, excludes emails and selections", () => {
  const text = "检查 @src/in 然后继续"
  const caret = text.indexOf(" 然后")
  const token = completionToken(text, caret)
  expect(token.query).toBe("src/in")
  expect(insertCompletion(text, token, "src/index.ts").text).toBe("检查 @src/index.ts 然后继续")
  expect(completionToken("mail@example.com", 16)).toBe(null)
  expect(completionToken("@src", 2, 4)).toBe(null)
})
test("quoted paths, Windows separators, unicode and mid-token edits", () => {
  expect(fileReference("src\\中文 name.ts")).toBe('@"src/中文 name.ts"')
  expect(fileReference("src\\中文.ts")).toBe("@src/中文.ts")
  const text = 'read @"my folder/old.ts" please'
  const caret = text.indexOf("old") + 2
  const result = insertCompletion(text, completionToken(text, caret), "my folder/new.ts")
  expect(result.text).toBe('read @"my folder/new.ts" please')
  expect(result.caret).toBe('read @"my folder/new.ts"'.length)
  expect(completionToken('@"my folder/a', 13)?.query).toBe("my folder/a")
})
test("command selection preserves following arguments and replaces token suffix", () => {
  const text = "/revie old args"
  expect(insertCompletion(text, completionToken(text, 4), "review").text).toBe("/review old args")
})
test("multi-root completions interleave folders and use absolute secondary paths", () => {
  const primary = [
    { name: "a.ts", path: "src/a.ts", dir: "src" },
    { name: "b.ts", path: "src/b.ts", dir: "src" },
  ]
  const secondary = [{ name: "App.vue", path: "src/App.vue", dir: "src" }]
  const hits = mergeWorkspaceFiles("C:/api", ["C:/api", "C:\\code\\ui"], [primary, secondary])
  expect([...hits.map(hit => hit.path)]).toEqual(["src/a.ts", "C:/code/ui/src/App.vue", "src/b.ts"])
  expect(hits[1].dir).toBe("ui/src")
})
test("AI Elements command list forwards slot and editor intercepts keys before submit", () => {
  const list = readFileSync(
    new URL("../src/components/ai-elements/prompt-input/PromptInputCommandList.vue", import.meta.url),
    "utf8",
  )
  expect(list).toMatch(/<slot\s*\/>/)
  const chat = composerSources()
  expect(chat).toMatch(/@keydown.capture="completion\?\.onKeydown\(\$event\)"/)
  expect(chat).not.toMatch(/cmdOpen|fileOpen/)
})

test("session mentions complete independently of file references and expand only known sessions", () => {
  const file = "C:\\Users\\me\\.pi\\agent\\sessions\\one.jsonl"
  const mention = sessionReference(file)
  expect(mention).toBe('@session("C:/Users/me/.pi/agent/sessions/one.jsonl")')
  expect(completionToken(mention, mention.length)).toBe(null)
  const text = "Compare @prev with this session"
  const completed = insertSessionCompletion(text, completionToken(text, 13), file).text
  expect(completed).toBe(`Compare ${mention} with this session`)
  expect(withSessionReferences(completed, [])).toBe(completed)
  const expanded = withSessionReferences(completed, [{ file, title: "Previous work" }])
  expect(expanded).toMatch(/Previous work/)
  expect(expanded).toMatch(/JSONL session files/)
  expect(expanded).toMatch(/C:\/Users\/me/)
  expect(withSessionReferences(`${mention} ${mention}`, [{ file }]).match(/"file":/g)?.length).toBe(1)
})

test("completion lists group references and slash commands by requested type order", () => {
  const references = sortReferences([
    { kind: "session" as const, value: "session", label: "session" },
    { kind: "file" as const, value: "file", label: "file" },
  ])
  expect(references.map(item => item.value)).toEqual(["file", "session"])

  const commands = sortCommands([
    { name: "extension", source: "extension" },
    { name: "compact", source: "builtin" },
    { name: "prompt", source: "prompt" },
    { name: "skill", source: "skill" },
  ])
  expect(commands.map(command => command.name)).toEqual(["skill", "compact", "extension", "prompt"])
})
