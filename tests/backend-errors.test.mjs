import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { loadTsSource } from './lib/load-ts.mjs'

const backendError = loadTsSource(readFileSync(new URL('../src/lib/backendError.ts', import.meta.url), 'utf8'))
const { CODED_ERROR_PREFIX, encodeCodedError, parseCodedError, formatCodedError } = backendError

const t = (key, params) => {
  // 与 vue-i18n 一致的桩实现：命中返回插值文案，缺失返回 key 本身。
  const catalog = {
    'backendErrors.startPiFailed': '启动 pi 失败: {detail}',
    'backendErrors.portListenFailed': '无法监听端口 {port}: {detail}',
  }
  const template = catalog[key]
  if (template === undefined) return key
  return template.replace(/\{(\w+)\}/g, (_, name) => params?.[name] ?? `{${name}}`)
}

test('coded errors round trip through encode and parse', () => {
  const encoded = encodeCodedError('piNotFound', '未找到 pi')
  assert.ok(encoded.startsWith(CODED_ERROR_PREFIX))
  // 逐字段断言：loadTsSource 的对象来自独立 VM realm，无法跨 realm 做深度相等。
  const parsed = parseCodedError(encoded)
  assert.equal(parsed.code, 'piNotFound')
  assert.equal(parsed.fallback, '未找到 pi')
  assert.equal(parsed.params, undefined)
})

test('coded errors carry named params', () => {
  const parsed = parseCodedError(encodeCodedError('portListenFailed', '无法监听端口 {port}: {detail}', { port: '1421', detail: 'denied' }))
  assert.equal(parsed.params.port, '1421')
  assert.equal(parsed.params.detail, 'denied')
})

test('plain text and malformed payloads are not treated as coded errors', () => {
  assert.equal(parseCodedError('启动 pi 失败: boom'), null)
  assert.equal(parseCodedError(`${CODED_ERROR_PREFIX}not-json`), null)
  assert.equal(parseCodedError(`${CODED_ERROR_PREFIX}{"code":42}`), null)
})

test('formatCodedError translates known codes and interpolates params', () => {
  assert.equal(
    formatCodedError(t, encodeCodedError('startPiFailed', '启动 pi 失败: boom', { detail: 'boom' })),
    '启动 pi 失败: boom',
  )
  assert.equal(
    formatCodedError(t, encodeCodedError('portListenFailed', '无法监听端口 {port}: {detail}', { port: '1421', detail: 'denied' })),
    '无法监听端口 1421: denied',
  )
})

test('formatCodedError falls back to the embedded copy for unknown codes', () => {
  assert.equal(formatCodedError(t, encodeCodedError('someFutureCode', '未知编码的兜底文案')), '未知编码的兜底文案')
  assert.equal(formatCodedError(t, `${CODED_ERROR_PREFIX}broken`), `${CODED_ERROR_PREFIX}broken`)
})

test('formatCodedError strips the String(error) prefix and passes plain text through', () => {
  const coded = encodeCodedError('startPiFailed', '启动 pi 失败: boom', { detail: 'boom' })
  assert.equal(formatCodedError(t, `Error: ${coded}`), '启动 pi 失败: boom')
  assert.equal(formatCodedError(t, 'pi request failed: 500'), 'pi request failed: 500')
  assert.equal(formatCodedError(t, ''), '')
  assert.equal(formatCodedError(t, null), '')
})

/** 语言包是纯对象字面量（无 import），去掉 `export default` 后可直接求值。 */
function loadMessages(locale) {
  const source = readFileSync(new URL(`../src/i18n/locales/${locale}.ts`, import.meta.url), 'utf8')
  return new Function(`${source.replace('export default', 'return')}`)()
}

test('backend error catalogs exist with matching keys in zh-CN and en', () => {
  const catalogs = {}
  for (const locale of ['zh-CN', 'en']) {
    catalogs[locale] = loadMessages(locale).backendErrors
    assert.ok(catalogs[locale], `${locale} is missing the backendErrors section`)
  }
  assert.deepEqual(
    Object.keys(catalogs['zh-CN']).sort(),
    Object.keys(catalogs.en).sort(),
    'zh-CN and en backendErrors keys must match',
  )
})

test('every Rust and transport error code is present in both catalogs, with no orphans', () => {
  const catalogs = { 'zh-CN': loadMessages('zh-CN').backendErrors, en: loadMessages('en').backendErrors }

  const codes = new Set()
  const rustDir = new URL('../src-tauri/src/', import.meta.url)
  for (const file of readdirSync(rustDir)) {
    if (!file.endsWith('.rs')) continue
    const source = readFileSync(new URL(file, rustDir), 'utf8')
    for (const match of source.matchAll(/pix_error(?:_detail|_with)?\(\s*"([A-Za-z0-9_]+)"/g)) {
      codes.add(match[1])
    }
  }
  const transport = readFileSync(new URL('../src/api/transport.ts', import.meta.url), 'utf8')
  for (const match of transport.matchAll(/encodeCodedError\(\s*"([A-Za-z0-9_]+)"/g)) {
    codes.add(match[1])
  }

  assert.ok(codes.size > 50, `expected the full error inventory, found ${codes.size}`)

  for (const code of codes) {
    assert.ok(catalogs['zh-CN'][code] !== undefined, `zh-CN is missing backendErrors.${code}`)
    assert.ok(catalogs.en[code] !== undefined, `en is missing backendErrors.${code}`)
  }
  for (const [locale, catalog] of Object.entries(catalogs)) {
    const orphans = Object.keys(catalog).filter(code => !codes.has(code))
    assert.deepEqual(orphans, [], `${locale} has catalog entries without a Rust/transport call site`)
  }
})
