import { expect, test } from "vitest"
import { createMarkmendParser } from "vue-stream-markdown"
import { withVisibleFrontmatter } from "@/lib/markdownPreview"

test("rendered previews show leading YAML frontmatter before the Markdown body", async () => {
  const source = "---\nname: demo\ndescription: Show YAML\n---\n\n# Demo\n\nBody"
  const rendered = withVisibleFrontmatter(source)

  expect(rendered).toBe("```yaml\nname: demo\ndescription: Show YAML\n```\n\n# Demo\n\nBody")

  const { document } = await createMarkmendParser().parse(rendered, "static")
  expect(document.nodes[0]).toEqual([
    "pre",
    { language: "yaml" },
    ["code", { class: "language-yaml" }, "name: demo\ndescription: Show YAML"],
  ])
  expect(document.nodes.slice(1)).toEqual([
    ["h1", { id: "demo" }, "Demo"],
    ["p", {}, "Body"],
  ])
})

test("frontmatter conversion preserves CRLF and YAML containing code fences", async () => {
  const source = "---\r\nname: demo\r\nexample: |\r\n  ```\r\n  ```\r\n--- \r\nBody"
  const rendered = withVisibleFrontmatter(source)

  expect(rendered).toBe("````yaml\r\nname: demo\r\nexample: |\r\n  ```\r\n  ```\r\n````\r\n\r\nBody")
  const { document } = await createMarkmendParser().parse(rendered, "static")
  expect(document.nodes[0]).toEqual([
    "pre",
    { language: "yaml" },
    ["code", { class: "language-yaml" }, "name: demo\nexample: |\n  ```\n  ```"],
  ])
  expect(document.nodes[1]).toEqual(["p", {}, "Body"])
})

test.each(["# Demo\n\n---\nname: not-frontmatter\n---", "---\nname: unterminated", "---", ""])(
  "leaves content without complete leading frontmatter unchanged: %j",
  source => {
    expect(withVisibleFrontmatter(source)).toBe(source)
  },
)
