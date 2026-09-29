import { readFileSync } from "node:fs"
import { expect, test } from "vitest"

const read = path => readFileSync(new URL(path, import.meta.url), "utf8")

test("development marker is gated by Vite development mode", () => {
  const titlebar = read("../src/components/WindowTitleBar.vue")
  const about = read("../src/components/settings/AboutSettings.vue")

  for (const source of [titlebar, about]) {
    expect(source).toContain("const isDevelopment = import.meta.env.DEV")
    expect(source).toContain('v-if="isDevelopment"')
    expect(source).toContain('t("app.development")')
  }
})

test("development marker has localized labels", () => {
  expect(read("../src/i18n/locales/zh-CN.ts")).toContain('development: "开发环境"')
  expect(read("../src/i18n/locales/en.ts")).toContain('development: "Development"')
})
