import { expect, test } from "vitest"
import { bundledLanguages } from "shiki/langs"
import { readFileSync } from "node:fs"
import { tokenizeLines } from "@/lib/codeHighlight"
import { highlightFileLines } from "@/lib/filePreviewCode"
import { highlightDiffLines, diffLangOf } from "@/lib/reviewHighlight"
import { parseDiff } from "@/lib/reviewDiff"

/** 桌面端 Tauri 的 CSP 是 `script-src 'self'`，WebAssembly 编译会被拒绝；这里模拟该环境。 */
function withoutWebAssembly<T>(run: () => Promise<T>): Promise<T> {
  const originalCompile = WebAssembly.compile
  const originalInstantiate = WebAssembly.instantiate
  const blocked = () => {
    throw new Error("Compiling or instantiating WebAssembly module violates Content Security Policy")
  }
  WebAssembly.compile = blocked as typeof WebAssembly.compile
  WebAssembly.instantiate = blocked as typeof WebAssembly.instantiate
  return run().finally(() => {
    WebAssembly.compile = originalCompile
    WebAssembly.instantiate = originalInstantiate
  })
}

test("代码着色不依赖 WebAssembly（桌面端 CSP 下仍可着色）", async () => {
  // 回归：默认 shiki 入口用 oniguruma 的 WASM 引擎，Tauri 的 `script-src 'self'`
  // 会拒绝 WebAssembly 编译，异常被吞后文件预览与 diff 审查全部静默退化成纯文本。
  const lines = await withoutWebAssembly(() => tokenizeLines("const a = 1\n", "typescript"))
  expect(lines).not.toBeNull()
  expect(lines?.[0].map(token => token.content).join("")).toBe("const a = 1")
  expect(lines?.[0][0].htmlStyle?.["--shiki-light"]).toMatch(/^#/)
  expect(lines?.[0][0].htmlStyle?.["--shiki-dark"]).toMatch(/^#/)
})

test("整文件着色按行返回，与源码拆分口径一致", async () => {
  const text = 'import { ref } from "vue"\n\nconst a = ref(1)\n'
  const lines = await tokenizeLines(text, "typescript")
  // 与 `text.split("\n")` 一一对齐（含末尾空行），行号栏与批注锚点才不错位。
  expect(lines?.length).toBe(text.split("\n").length)
  expect(lines?.[1]).toEqual([])
  expect(lines?.[2].map(token => token.content).join("")).toBe("const a = ref(1)")

  const html = await highlightFileLines(text, "src/a.ts")
  expect(html?.length).toBe(text.split("\n").length)
  expect(html?.[0]).toContain("--shiki-light")
  expect(html?.[0]).toContain("--shiki-dark")
  expect(html?.[1]).toBe("")
})

test("着色 HTML 转义源码，不产出可执行的标记", async () => {
  const html = await highlightFileLines('const tpl = "<script>alert(1)</script>"\n', "a.ts")
  const first = html?.[0] ?? ""
  expect(first).toContain("&lt;script&gt;")
  expect(first).not.toContain("<script>")
})

test("CRLF 与制表符不破坏行对齐", async () => {
  const text = "a\r\n\tb\r\nc"
  const lines = await tokenizeLines(text, "typescript")
  expect(lines?.length).toBe(3)
  expect(lines?.[1].map(token => token.content).join("")).toBe("\tb")
})

test("未收录语言与空内容返回 null，调用方回退纯文本", async () => {
  expect(await tokenizeLines("", "typescript")).toBeNull()
  expect(await tokenizeLines("plain", "text")).toBeNull()
  expect(await highlightFileLines("hello", "notes.txt")).toBeNull()
  expect(await highlightFileLines("node_modules\n", ".gitignore")).toBeNull()
  expect(await highlightFileLines("x", "a.unknownext")).toBeNull()
})

test("超大文件跳过着色，保留纯文本渲染", async () => {
  const text = "const a = 1\n".repeat(20_000) // 240k > 200k 阈值
  expect(await highlightFileLines(text, "a.ts")).toBeNull()
})

test("diff 审查与文件预览共用同一个着色器", async () => {
  const lines = parseDiff("@@ -1 +1 @@\n-const n = 1;\n+const n = 2;\n").slice(1)
  const html = await withoutWebAssembly(() => highlightDiffLines(lines, "a.ts"))
  expect(html?.get(lines[0])).toContain("--shiki-light")
  expect(html?.get(lines[1])).toContain("--shiki-light")
})

test("着色器不走 shiki 默认的 WASM 引擎入口", () => {
  // 只有 `shiki/core` + 纯 JS 引擎才是无 WASM 的路径；`shiki` 默认入口会加载 oniguruma。
  // 类型用 `import type` 取没关系（编译后擦除），运行时值导入才是会被打进来的引擎。
  const shared = readFileSync(new URL("../src/lib/codeHighlight.ts", import.meta.url), "utf8")
  expect(shared).toMatch(/from "shiki\/core"/)
  expect(shared).toMatch(/from "shiki\/engine\/javascript"/)
  for (const file of ["src/lib/codeHighlight.ts", "src/lib/filePreviewCode.ts", "src/lib/reviewHighlight.ts"]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
    const valueImports = source.match(/^import (?!type ).* from "shiki"/gm) ?? []
    expect(valueImports, `${file} must not import values from the default shiki entry`).toEqual([])
  }
})

test("常见扩展名与特殊文件名都能映射到已收录的语言", () => {
  // TZD-136 补齐：初版映射表只有 60 余项，.env/.tf/.nix/.zig/.cmake 等常见文件都退化成纯文本。
  const cases: [string, string][] = [
    ["Dockerfile", "dockerfile"],
    ["Dockerfile.dev", "dockerfile"],
    ["Makefile", "makefile"],
    ["CMakeLists.txt", "cmake"],
    ["Jenkinsfile", "groovy"],
    ["Gemfile", "ruby"],
    [".env", "dotenv"],
    ["main.tf", "terraform"],
    ["default.nix", "nix"],
    ["build.zig", "zig"],
    ["schema.proto", "proto"],
    ["deploy.yaml", "yaml"],
    ["notes.md", "markdown"],
    ["icon.svg", "xml"],
  ]
  for (const [path, lang] of cases) expect([path, diffLangOf(path)]).toEqual([path, lang])
  // 扩展名 → 语言的每一项都必须是 shiki 真正收录的 id，否则只会静默不着色。
  const source = readFileSync(new URL("../src/lib/reviewHighlight.ts", import.meta.url), "utf8")
  const block = source.slice(source.indexOf("const EXT_TO_LANG"), source.indexOf("/** 由文件路径推断"))
  const langs = [...block.matchAll(/^  [a-z0-9]+: "([^"]+)",$/gm)].map(match => match[1])
  expect(langs.length).toBeGreaterThan(100)
  for (const lang of langs) expect(bundledLanguages, `unknown shiki language: ${lang}`).toHaveProperty([lang])
})

test("每个映射到的语言都能真实着色", async () => {
  const source = readFileSync(new URL("../src/lib/reviewHighlight.ts", import.meta.url), "utf8")
  const block = source.slice(source.indexOf("const EXT_TO_LANG"), source.indexOf("/** 由文件路径推断"))
  const langs = [...new Set([...block.matchAll(/^  [a-z0-9]+: "([^"]+)",$/gm)].map(match => match[1]))]
  const failures: string[] = []
  for (const lang of langs) {
    const tokens = await withoutWebAssembly(() => tokenizeLines("x\n", lang))
    if (!tokens) failures.push(lang)
  }
  expect(failures).toEqual([])
})
