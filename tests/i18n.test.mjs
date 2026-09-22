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
}
