import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { createI18n } from 'vue-i18n'

async function loadLocale(locale) {
  const source = readFileSync(new URL(`../src/i18n/locales/${locale}.ts`, import.meta.url), 'utf8')
  const output = ts.transpile(source, { module: ts.ModuleKind.ESNext })
  return (await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)).default
}

for (const locale of ['zh-CN', 'en']) {
  const messages = await loadLocale(locale)
  const i18n = createI18n({ legacy: false, locale, fallbackLocale: false, messages: { [locale]: messages } })

  test(`${locale}: package source hint renders a literal version separator`, () => {
    const expected = locale === 'en'
      ? 'Supports npm:pkg@version, git:repo URLs, https:// URLs, and local paths.'
      : '支持 npm:包名@版本、git:仓库地址、https:// 或本地路径。'
    assert.equal(i18n.global.t('packages.customHint'), expected)
  })

  test(`${locale}: edit prompt cancel button has a translation`, () => {
    assert.equal(i18n.global.t('chat.editCancel'), locale === 'en' ? 'Cancel' : '取消')
  })

  // 内置浏览器面板的文案:与 BrowserPanel.vue 使用的 key 保持同步,
  // 防止 locale 文件被覆盖后 key 丢失导致界面显示原始 key。
  test(`${locale}: browser panel keys exist`, () => {
    const zh = locale === 'zh-CN'
    assert.equal(i18n.global.t('sidebarTabs.browser'), zh ? '浏览器' : 'Browser')
    for (const key of [
      'browse', 'browseHint', 'drawMode', 'inspect', 'inspectHint', 'emptyHint', 'loading',
      'proxyUnavailable', 'addAnnotation', 'textTool', 'commentPlaceholder', 'save', 'cancel',
      'annotations', 'annotationsEmpty', 'insertToChat', 'copyAnnotations', 'deleteAnnotation',
      'area', 'console', 'consoleEmpty', 'chatPage', 'chatElement', 'chatArea', 'chatComment',
    ]) {
      const rendered = i18n.global.t(`browser.${key}`)
      assert.notEqual(rendered, `browser.${key}`, `browser.${key} is missing`)
    }
  })
}
