import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import ts from "typescript"
import { createI18n } from "vue-i18n"

async function loadLocale(locale) {
  const source = readFileSync(new URL(`../src/i18n/locales/${locale}.ts`, import.meta.url), "utf8")
  const output = ts.transpile(source, { module: ts.ModuleKind.ESNext })
  return (await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`)).default
}

test("usage summary is a settings tab reachable from the router and tab registry", () => {
  const router = readFileSync(new URL("../src/lib/router.ts", import.meta.url), "utf8")
  const tabs = readFileSync(new URL("../src/components/settings/tabs.ts", import.meta.url), "utf8")
  expect(router).toMatch(/"archives",\s*"usage",/)
  expect(tabs).toMatch(/id: "usage"/)
  expect(tabs).toMatch(/import\("@\/components\/UsageSummaryPage\.vue"\)/)
  expect(tabs).toMatch(/tabIds: \["model-config", "archives", "usage", "about"\]/)
})

test("the usage command scans pi session files and serves both transports", () => {
  const usage = readFileSync(new URL("../src-tauri/src/usage.rs", import.meta.url), "utf8")
  const lib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8")
  const dispatch = readFileSync(new URL("../src-tauri/src/remote/dispatch/mod.rs", import.meta.url), "utf8")
  // 扫描器走 pi 会话目录（尊重 PI_CODING_AGENT_DIR），mtime 缓存不落盘。
  expect(usage).toMatch(/agent_dir\(\)\.join\("sessions"\)/)
  expect(usage).toMatch(/pub async fn usage_summary\(days: Option<u32>, project: Option<String>\)/)
  expect(usage).toMatch(/OnceLock<Mutex<HashMap<PathBuf, SessionUsage>>>/)
  expect(lib).toMatch(/usage::usage_summary/)
  expect(dispatch).toMatch(/usage::handle\(cmd, &a\)/)
})

test("the usage panel aggregates by day/project/model and can open recorded sessions", () => {
  const page = readFileSync(new URL("../src/components/UsageSummaryPage.vue", import.meta.url), "utf8")
  const api = readFileSync(new URL("../src/api/usage.ts", import.meta.url), "utf8")
  expect(api).toMatch(/invoke<UsageSummary>\("usage_summary", \{ days, project \}\)/)
  expect(page).toMatch(/navigate\(sessionRoute\(file, project\)\)/)
  expect(page).toMatch(/@click="openSession\(row\.file, row\.project\)"/)
  expect(page).toMatch(/t\("usage\.byProject"\)/)
  expect(page).toMatch(/t\("usage\.byModel"\)/)
  expect(page).toMatch(/t\("usage\.sourceNote"\)/)
  // 与归档面板同形态：无 ScrollArea / h1，由设置页供给框架。
  expect(page).not.toMatch(/ScrollArea/)
  expect(page).not.toMatch(/<h1/)
})

test("usage panel copy exists in both locales", async () => {
  for (const locale of ["zh-CN", "en"]) {
    const messages = await loadLocale(locale)
    const i18n = createI18n({ legacy: false, locale, fallbackLocale: false, messages: { [locale]: messages } })
    for (const key of [
      "usage.nav",
      "usage.title",
      "usage.description",
      "usage.range",
      "usage.rangeDays",
      "usage.rangeAll",
      "usage.metric",
      "usage.metricCost",
      "usage.metricTokens",
      "usage.totalCost",
      "usage.totalTokens",
      "usage.sessionCount",
      "usage.messageCount",
      "usage.tokenBreakdown",
      "usage.dailyTitle",
      "usage.byProject",
      "usage.byModel",
      "usage.sessionsTitle",
      "usage.sessionsShort",
      "usage.truncated",
      "usage.openSession",
      "usage.empty",
      "usage.sourceNote",
    ]) {
      expect(i18n.global.t(key), `${locale}: ${key}`).not.toBe(key)
    }
  }
})
