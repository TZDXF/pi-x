import { expect, test } from "vitest"
import { createMarkmendParser } from "vue-stream-markdown"
import { splitMarkdownFrontmatter } from "@/lib/markdownPreview"

test("rendered previews separate original YAML frontmatter from the Markdown body", async () => {
  const source = "---\nname: demo\ndescription: Show YAML\n---\n\n# Demo\n\nBody"
  const content = splitMarkdownFrontmatter(source)

  expect(content).toEqual({
    frontmatter: "name: demo\ndescription: Show YAML",
    body: "\n# Demo\n\nBody",
  })

  const { document } = await createMarkmendParser().parse(content.body, "static")
  expect(document.nodes).toEqual([
    ["h1", { id: "demo" }, "Demo"],
    ["p", {}, "Body"],
  ])
})

test.each([" ", "\t"])("accepts trailing whitespace on the opening delimiter: %j", async whitespace => {
  const source = `---${whitespace}\nname: demo\ndescription: Show YAML\n---\n\n# Body`
  const content = splitMarkdownFrontmatter(source)

  expect(content).toEqual({ frontmatter: "name: demo\ndescription: Show YAML", body: "\n# Body" })
  const { document } = await createMarkmendParser().parse(content.body, "static")
  expect(document.nodes).toEqual([["h1", { id: "body" }, "Body"]])
})

test("recognizes an explicit YAML end marker without consuming later horizontal rules", async () => {
  const source = "---\nname: demo\ndescription: demo\n...\n\n# Body\n\n---\n\nAfter"
  const content = splitMarkdownFrontmatter(source)

  expect(content).toEqual({ frontmatter: "name: demo\ndescription: demo", body: "\n# Body\n\n---\n\nAfter" })
  const { document } = await createMarkmendParser().parse(content.body, "static")
  expect(document.nodes).toEqual([
    ["h1", { id: "body" }, "Body"],
    ["hr", {}],
    ["p", {}, "After"],
  ])
})

test("frontmatter extraction preserves CRLF, indentation, blank lines, and backticks", () => {
  const source =
    "---\r\nname: demo\r\nexample: |\r\n  first line\r\n\r\n  ```\r\n  ```\r\nmetadata: value\r\n--- \r\nBody"
  const content = splitMarkdownFrontmatter(source)

  expect(content).toEqual({
    frontmatter: "name: demo\r\nexample: |\r\n  first line\r\n\r\n  ```\r\n  ```\r\nmetadata: value",
    body: "Body",
  })
})

test.each(["# Demo\n\n---\nname: not-frontmatter\n---", "---\nname: unterminated", "---", ""])(
  "leaves content without complete leading frontmatter unchanged: %j",
  source => {
    expect(splitMarkdownFrontmatter(source)).toEqual({ frontmatter: null, body: source })
  },
)
