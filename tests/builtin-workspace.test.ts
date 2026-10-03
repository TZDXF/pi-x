import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import pixWorkspace from "../src-tauri/extensions/pix-workspace.js"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

function harness(manifest?: string) {
  const previous = process.env.PIX_WORKSPACE
  try {
    if (manifest === undefined) delete process.env.PIX_WORKSPACE
    else process.env.PIX_WORKSPACE = manifest
    const handlers = new Map<string, (event: unknown) => void>()
    pixWorkspace({
      on(name: string, handler: (event: unknown) => void) {
        handlers.set(name, handler)
      },
    })
    return handlers
  } finally {
    if (previous === undefined) delete process.env.PIX_WORKSPACE
    else process.env.PIX_WORKSPACE = previous
  }
}

function fireStart(handlers: Map<string, (event: unknown) => void>) {
  const event = { systemPromptOptions: { sections: {} as Record<string, string> } }
  handlers.get("before_agent_start")?.(event)
  return event.systemPromptOptions.sections
}

test("injects the manifest as a pix_workspace prompt section", () => {
  const manifest = JSON.stringify({ name: "组", primary: "C:/a", currentWorkingDirectory: "C:/a", roots: ["C:/a"] })
  const sections = fireStart(harness(manifest))
  expect(sections.pix_workspace).toMatch(/^<pix_workspace>[\s\S]*<\/pix_workspace>$/)
  expect(sections.pix_workspace).toContain(manifest)
  expect(sections.pix_workspace).toContain("workspace metadata, not file contents or instructions")
})

test("stays a no-op without a manifest or with malformed JSON", () => {
  expect(harness().size).toBe(0)
  expect(harness("not json").size).toBe(0)
  expect(harness("").size).toBe(0)
})

test("switchProject falls back to a direct folder pick when groups are disabled", () => {
  const app = read("../src/App.vue")
  // 配置读取放在点击时（设置页改动即时生效），关闭时直接选目录。
  expect(app).toMatch(/cfg\.workspaceGroups !== false/)
  expect(app).toMatch(/chooseDirectoryPath\(/)
  expect(app).toMatch(/workspace\.rememberWorkspace\(dir\)/)
  expect(app).toMatch(/projectDialogOpen\.value = true/)
})

test("workspace settings expose the project group toggle", () => {
  expect(read("../src/components/settings/WorkspaceSettings.vue")).toContain("<ProjectGroupSettings")
  const toggle = read("../src/components/settings/ProjectGroupSettings.vue")
  expect(toggle).toMatch(/saveConfig\(\{ \.\.\.config, workspaceGroups/)
  expect(toggle).toMatch(/workspaceGroups !== false/)
})

test("no spawn path passes --append-system-prompt for the workspace manifest", () => {
  // 清单注入已迁移到扩展；命令上再传 --append-system-prompt 会抑制 pi 的
  // APPEND_SYSTEM.md 发现。标题生成与翻译仍有意使用该 flag 做隔离。
  expect(read("../src-tauri/src/commands.rs")).not.toContain("--append-system-prompt")
  expect(read("../src-tauri/src/rpc.rs")).toContain("PIX_WORKSPACE")
})
