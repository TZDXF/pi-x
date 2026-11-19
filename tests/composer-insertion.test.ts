import { expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { appendComposerText } from "@/lib/composer"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

test("context insertion preserves the draft and separates blocks without adding blank lines", () => {
  expect(appendComposerText("", "first")).toBe("first")
  expect(appendComposerText("existing", "annotation")).toBe("existing\n\nannotation")
  expect(appendComposerText("existing\n", "annotation")).toBe("existing\n\nannotation")
})

test("project file annotations reuse the sidebar chat insertion chain", () => {
  const preview = read("../src/components/ProjectFilePreview.vue")
  const files = read("../src/components/ProjectFiles.vue")
  const sidebar = read("../src/components/RightSidebar.vue")
  const chat = read("../src/components/ChatView.vue")

  expect(preview).toContain("annotateInsert")
  expect(preview).toContain('emit("send-to-chat", buildCodeCommentsBlock(')
  expect(files).toMatch(/<ProjectFilePreview[\s\S]*?@send-to-chat="emit\('send-to-chat', \$event\)"/)
  expect(sidebar).toMatch(/<ProjectFiles[\s\S]*?@send-to-chat="\$emit\('send-to-chat', \$event\)"/)
  expect(chat).toContain('@send-to-chat="insertIntoComposer"')
  expect(chat).toContain("appendComposerText(bridge.value.textInput")
})
