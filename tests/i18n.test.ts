import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import ts from "typescript"
import { createI18n } from "vue-i18n"

async function loadLocale(locale) {
  const source = readFileSync(new URL(`../src/i18n/locales/${locale}.ts`, import.meta.url), "utf8")
  const output = ts.transpile(source, { module: ts.ModuleKind.ESNext })
  return (await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`)).default
}

for (const locale of ["zh-CN", "en"]) {
  const messages = await loadLocale(locale)
  const i18n = createI18n({ legacy: false, locale, fallbackLocale: false, messages: { [locale]: messages } })

  test(`${locale}: package source hint renders a literal version separator`, () => {
    const expected =
      locale === "en"
        ? "Supports npm:pkg@version, git:repo URLs, https:// URLs, and local paths."
        : "支持 npm:包名@版本、git:仓库地址、https:// 或本地路径。"
    expect(i18n.global.t("packages.customHint")).toBe(expected)
  })

  test(`${locale}: edit prompt cancel button has a translation`, () => {
    expect(i18n.global.t("chat.editCancel")).toBe(locale === "en" ? "Cancel" : "取消")
  })

  // 内置浏览器面板的文案:与 BrowserPanel.vue 使用的 key 保持同步,
  // 防止 locale 文件被覆盖后 key 丢失导致界面显示原始 key。
  test(`${locale}: browser panel keys exist`, () => {
    const zh = locale === "zh-CN"
    expect(i18n.global.t("sidebarTabs.browser")).toBe(zh ? "浏览器" : "Browser")
    for (const key of [
      "browse",
      "browseHint",
      "drawMode",
      "inspect",
      "inspectHint",
      "emptyHint",
      "loading",
      "proxyUnavailable",
      "addAnnotation",
      "textTool",
      "commentPlaceholder",
      "save",
      "cancel",
      "annotations",
      "annotationsEmpty",
      "insertToChat",
      "copyAnnotations",
      "deleteAnnotation",
      "area",
      "console",
      "consoleEmpty",
      "resizeDrawer",
      "chatPage",
      "chatElement",
      "chatArea",
      "chatComment",
    ]) {
      const rendered = i18n.global.t(`browser.${key}`)
      expect(rendered, `browser.${key} is missing`).not.toBe(`browser.${key}`)
    }
  })

  // 从组件源码提取 t('...') key 并比对语言包，防止 locale 文件被覆盖后 key 丢失。
  test(`${locale}: browser panel keys extracted from source exist`, () => {
    const panel = readFileSync(new URL("../src/components/browser/BrowserPanel.vue", import.meta.url), "utf8")
    const extracted = new Set()
    const re = /\bt\(\s*['"]([^'"]+)['"]\s*[,)]/g
    let m
    while ((m = re.exec(panel)) !== null) {
      extracted.add(m[1])
    }
    for (const key of extracted) {
      const rendered = i18n.global.t(key)
      expect(rendered, `${key} is missing`).not.toBe(key)
    }
  })

  // TZD-138：提问折叠按钮的文案，两个语言包必须同步。
  test(`${locale}: prompt collapse toggle keys exist`, () => {
    const zh = locale === "zh-CN"
    expect(i18n.global.t("chat.expandPrompt")).toBe(zh ? "展开完整提问" : "Show the full prompt")
    expect(i18n.global.t("chat.collapsePrompt")).toBe(zh ? "收起提问" : "Collapse prompt")
    const collapse = readFileSync(new URL("../src/components/chat/CollapsiblePromptText.vue", import.meta.url), "utf8")
    for (const key of ["chat.expandPrompt", "chat.collapsePrompt"])
      expect(collapse, `${key} is not used`).toContain(`t("${key}")`)
  })
}

for (const locale of ["zh-CN", "en"]) {
  const messages = await loadLocale(locale)
  const i18n = createI18n({ legacy: false, locale, fallbackLocale: false, messages: { [locale]: messages } })

  // 快捷键页把停止动作保留为「未绑定」（TZD-134 只移除默认 Esc），文案需中英同步。
  test(`${locale}: stop action copy is restored and an unbound label exists`, () => {
    expect(i18n.global.t("shortcuts.actions.stop")).toBe(locale === "en" ? "Stop generating" : "停止生成")
    expect(i18n.global.t("settings.shortcutStop")).toBe(locale === "en" ? "Stop" : "停止生成")
    expect(i18n.global.t("shortcuts.unbound")).toBe(locale === "en" ? "Not bound" : "未绑定")
  })

  // 内置插件页新增的 pi 内置扩展说明,两个语言包必须同步。
  test(`${locale}: built-in packages tab explains pi's own builtin extensions`, () => {
    const hint = i18n.global.t("packages.builtinPiHint")
    expect(hint).not.toBe("packages.builtinPiHint")
    expect(hint).toContain("builtin:mcp")
    expect(hint).toContain("-builtin:mcp")
    expect(i18n.global.t("completion.builtin")).toBe(locale === "en" ? "Built-in" : "内置")
  })
}
