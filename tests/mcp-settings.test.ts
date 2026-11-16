import { readFileSync } from "node:fs"
import { expect, test } from "vitest"

const settings = readFileSync(new URL("../src/components/settings/McpSettings.vue", import.meta.url), "utf8")

test("MCP 连接进度只在刷新按钮中展示，并保留无障碍播报", () => {
  expect(settings.match(/mcpConfig\.refreshing/g)).toHaveLength(1)
  expect(settings).toMatch(
    /<Button[^>]*:disabled="statusLoading"[^>]*aria-live="polite"[^>]*aria-atomic="true"[^>]*@click="refreshStatus"[^>]*>[\s\S]*?mcpConfig\.refreshing[\s\S]*?<\/Button>/,
  )
})

test("MCP 配置保留文件路径，仅在尚未创建时显示文件状态", () => {
  expect(settings).toContain("{{ active.path }}")
  expect(settings).not.toContain("mcpConfig.exists")
  expect(settings).toMatch(/<span v-if="!active.exists"[^>]*>\s*{{ t\("mcpConfig.missing"\) }}/)
})
