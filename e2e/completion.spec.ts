import { test, expect, type Locator } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

type InvokeArgs = {
  query?: string
  command?: {
    type?: string
    message?: string
    customInstructions?: string
  }
}

type InvokeCall = {
  command: string
  args: InvokeArgs
}

function editorText(editor: Locator) {
  return editor.evaluate(element => {
    function read(node: Node): string {
      if (node instanceof HTMLElement && node.dataset.editorCaret !== undefined) return ""
      if (node instanceof HTMLElement && node.dataset.raw) return node.dataset.raw
      if (node.nodeName === "BR") return "\n"
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || ""
      return Array.from(node.childNodes).map(read).join("")
    }
    return read(element)
  })
}

function expectEditorText(editor: Locator, value: string) {
  return expect.poll(() => editorText(editor)).toBe(value)
}

let harness: VueHarness

test.beforeAll(async () => {
  harness = await startVueHarness({
    name: "completion",
    port: 1451,
    html: `<!doctype html>
<html lang="zh-CN" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script src="/theme-init.js"></script>
    <script>localStorage.setItem("pix.runningBehavior", "steer")</script>
    <title>PiX completion E2E</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>`,
    setup: async server => {
      await server.warmupRequest("/src/main.ts")
    },
  })
})

test.afterAll(async () => {
  await harness?.close()
})

test("composer completion, IME, RPC context, retry, and command dispatch", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))

  const calls: InvokeCall[] = []
  let failedSearch = false
  await page.routeWebSocket("**/api/events*", () => {})
  await page.route("**/api/invoke", async route => {
    const { command, args } = route.request().postDataJSON() as { command: string; args: InvokeArgs }
    calls.push({ command, args })
    let data: unknown = {}
    if (command === "app_config_get") data = { lastProject: "C:/test-project" }
    else if (command === "rpc_running") data = false
    else if (command === "trust_status") data = { needsDecision: false }
    else if (/sessions|projects/.test(command)) data = []
    else if (command === "search_files") {
      if (failedSearch) {
        await route.fulfill({ status: 500, json: { error: "Search unavailable" } })
        return
      }
      if (args.query === "slow") await new Promise(resolve => setTimeout(resolve, 450))
      data =
        args.query === "none"
          ? []
          : [
              { name: "中文 file.ts", path: "src/中文 file.ts", dir: "src" },
              { name: "index.ts", path: "src/index.ts", dir: "src" },
            ]
    } else if (command === "rpc_spawn") await new Promise(resolve => setTimeout(resolve, 100))
    else if (command === "rpc_request") {
      const type = args.command?.type
      const response =
        type === "get_commands"
          ? {
              commands: [
                { name: "review", description: "Review code", source: "prompt" },
                { name: "skill:check", description: "Check project", source: "skill" },
                { name: "extension", description: "Extension test", source: "extension" },
              ],
            }
          : type === "get_available_models"
            ? { models: [] }
            : type === "get_state"
              ? { sessionId: "test", messageCount: 0 }
              : type === "get_messages"
                ? { messages: [] }
                : {}
      data = { success: true, command: type, data: response }
    }
    await route.fulfill({ json: { data } })
  })

  await page.goto(harness.url)
  const editor = page.locator('main [data-slot="input-group-control"]').first()
  await expect(editor).toBeVisible()
  expect(calls.filter(call => call.command === "rpc_spawn")).toHaveLength(0)
  await editor.fill("/")

  const rows = page.locator('[data-slot="command-item"]')
  await expect(rows.filter({ hasText: "/review" })).toBeVisible()
  await expect(editor).toBeEditable()
  expect(calls.filter(call => call.command === "rpc_spawn")).toHaveLength(1)
  await editor.fill("/compact keep decisions")
  await editor.press("Enter")
  await page.waitForResponse(
    response =>
      response.url().endsWith("/api/invoke") &&
      (response.request().postDataJSON() as { args: InvokeArgs }).args?.command?.type === "compact",
  )
  const compact = calls.find(call => call.args.command?.type === "compact")
  expect(compact?.args.command?.customInstructions).toBe("keep decisions")

  await editor.fill("/")
  await expect(rows.filter({ hasText: "/review" })).toBeVisible()
  await editor.press("ArrowDown")
  await editor.press("Enter")
  await expectEditorText(editor, "/skill:check ")
  expect(calls.filter(call => call.args.command?.type === "prompt")).toHaveLength(0)

  await editor.fill("/rev")
  await expect(rows.filter({ hasText: "/review" })).toBeVisible()
  await editor.press("Tab")
  await expectEditorText(editor, "/review ")

  await editor.fill("检查 @src")
  await expect(rows.filter({ hasText: "中文 file.ts" })).toBeVisible()
  await editor.press("Enter")
  await expectEditorText(editor, '检查 @"src/中文 file.ts" ')
  await expect(editor).toBeFocused()

  await editor.press("Enter")
  await expectEditorText(editor, "")
  const prompt = calls.find(call => call.args.command?.type === "prompt")
  expect(prompt?.args.command?.message).toBe('检查 @"src/中文 file.ts"')

  await editor.fill("before @sr after")
  await expectEditorText(editor, "before @sr after")
  await editor.evaluate(element => {
    let remaining = 10
    let target: Node | null = null
    let targetOffset = 0
    for (const [index, node] of Array.from(element.childNodes).entries()) {
      if (node instanceof HTMLElement && node.dataset.raw) {
        const length = node.dataset.raw.length
        if (remaining <= length) {
          target = element
          targetOffset = index + (remaining > length / 2 ? 1 : 0)
          break
        }
        remaining -= length
        continue
      }
      const length = node.textContent?.length || 0
      if (node.nodeType === Node.TEXT_NODE && remaining <= length) {
        target = node
        targetOffset = remaining
        break
      }
      remaining -= length
    }
    if (!target) throw new Error("Unable to place the editor caret at offset 10")
    const range = document.createRange()
    range.setStart(target, targetOffset)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    element.dispatchEvent(new Event("select", { bubbles: true }))
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
  await expect(rows.filter({ hasText: "index.ts" })).toBeVisible()
  await rows.filter({ hasText: "index.ts" }).click()
  await expectEditorText(editor, "before @src/index.ts after")

  await editor.fill("@src")
  await expect(rows.first()).toBeVisible()
  await editor.dispatchEvent("keydown", { key: "Enter", isComposing: true })
  await expectEditorText(editor, "@src")
  await editor.dispatchEvent("compositionstart")
  await editor.dispatchEvent("keydown", { key: "Enter", isComposing: false })
  await expectEditorText(editor, "@src")
  await editor.dispatchEvent("compositionend")
  await editor.press("Escape")
  await expect(rows).toHaveCount(0)
  await expect(editor).toHaveAttribute("aria-expanded", "false")

  failedSearch = true
  await editor.fill("@error")
  await expect(page.getByRole("alert").filter({ hasText: "Search unavailable" })).toBeVisible()
  failedSearch = false
  await page.getByRole("button", { name: /^(重试|Retry)$/ }).click()
  await expect(rows.first()).toBeVisible()

  await editor.fill("@slow")
  await page.waitForTimeout(180)
  await editor.fill("plain text")
  await page.waitForTimeout(500)
  await expect(rows).toHaveCount(0)

  await editor.fill("/unsupported")
  await editor.press("Escape")
  await editor.press("Enter")
  await page.waitForTimeout(100)
  await expectEditorText(editor, "/unsupported")
  expect(calls.filter(call => call.args.command?.type === "prompt")).toHaveLength(1)

  await editor.fill("/review explain")
  await editor.press("Enter")
  await page.waitForTimeout(100)
  let lastPrompt = calls.filter(call => call.args.command?.type === "prompt")[
    calls.filter(call => call.args.command?.type === "prompt").length - 1
  ]
  expect(lastPrompt?.args.command?.message).toBe("/review explain")

  await editor.fill('/extension @"src/index.ts"')
  await editor.press("Enter")
  await page.waitForTimeout(100)
  lastPrompt = calls.filter(call => call.args.command?.type === "prompt")[
    calls.filter(call => call.args.command?.type === "prompt").length - 1
  ]
  expect(lastPrompt?.args.command?.message).toBe('/extension @"src/index.ts"')
  await editor.fill("@none")
  await expect(page.getByRole("status").filter({ hasText: /没有匹配|无匹配|No matching/ })).toBeVisible()
  await editor.press("Shift+Enter")
  await expectEditorText(editor, "@none\n\n")

  await editor.fill("/new ")
  await editor.press("Escape")
  await editor.press("Enter")
  await page.waitForTimeout(100)
  await expect(page).toHaveURL(/#\/project\//)
  await expectEditorText(editor, "")
  expect(errors).toEqual([])
})
