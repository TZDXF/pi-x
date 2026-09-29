import { test, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { loadTsSource } from "./lib/load-ts.mjs"

const backendError = loadTsSource(readFileSync(new URL("../src/lib/backendError.ts", import.meta.url), "utf8"))
const { CODED_ERROR_PREFIX, encodeCodedError, parseCodedError, formatCodedError } = backendError

const t = (key, params) => {
  // 与 vue-i18n 一致的桩实现：命中返回插值文案，缺失返回 key 本身。
  const catalog = {
    "backendErrors.startPiFailed": "启动 pi 失败: {detail}",
    "backendErrors.portListenFailed": "无法监听端口 {port}: {detail}",
  }
  const template = catalog[key]
  if (template === undefined) return key
  return template.replace(/\{(\w+)\}/g, (_, name) => params?.[name] ?? `{${name}}`)
}

test("coded errors round trip through encode and parse", () => {
  const encoded = encodeCodedError("piNotFound", "未找到 pi")
  expect(encoded.startsWith(CODED_ERROR_PREFIX)).toBeTruthy()
  // 逐字段断言：loadTsSource 的对象来自独立 VM realm，无法跨 realm 做深度相等。
  const parsed = parseCodedError(encoded)
  expect(parsed.code).toBe("piNotFound")
  expect(parsed.fallback).toBe("未找到 pi")
  expect(parsed.params).toBe(undefined)
})

test("coded errors carry named params", () => {
  const parsed = parseCodedError(
    encodeCodedError("portListenFailed", "无法监听端口 {port}: {detail}", { port: "1421", detail: "denied" }),
  )
  expect(parsed.params.port).toBe("1421")
  expect(parsed.params.detail).toBe("denied")
})

test("plain text and malformed payloads are not treated as coded errors", () => {
  expect(parseCodedError("启动 pi 失败: boom")).toBe(null)
  expect(parseCodedError(`${CODED_ERROR_PREFIX}not-json`)).toBe(null)
  expect(parseCodedError(`${CODED_ERROR_PREFIX}{"code":42}`)).toBe(null)
})

test("formatCodedError translates known codes and interpolates params", () => {
  expect(formatCodedError(t, encodeCodedError("startPiFailed", "启动 pi 失败: boom", { detail: "boom" }))).toBe(
    "启动 pi 失败: boom",
  )
  expect(
    formatCodedError(
      t,
      encodeCodedError("portListenFailed", "无法监听端口 {port}: {detail}", { port: "1421", detail: "denied" }),
    ),
  ).toBe("无法监听端口 1421: denied")
})

test("formatCodedError falls back to the embedded copy for unknown codes", () => {
  expect(formatCodedError(t, encodeCodedError("someFutureCode", "未知编码的兜底文案"))).toBe("未知编码的兜底文案")
  expect(formatCodedError(t, `${CODED_ERROR_PREFIX}broken`)).toBe(`${CODED_ERROR_PREFIX}broken`)
})

test("formatCodedError strips the String(error) prefix and passes plain text through", () => {
  const coded = encodeCodedError("startPiFailed", "启动 pi 失败: boom", { detail: "boom" })
  expect(formatCodedError(t, `Error: ${coded}`)).toBe("启动 pi 失败: boom")
  expect(formatCodedError(t, "pi request failed: 500")).toBe("pi request failed: 500")
  expect(formatCodedError(t, "")).toBe("")
  expect(formatCodedError(t, null)).toBe("")
})

/** 语言包是纯对象字面量（无 import），去掉 `export default` 后可直接求值。 */
function loadMessages(locale) {
  const source = readFileSync(new URL(`../src/i18n/locales/${locale}.ts`, import.meta.url), "utf8")
  return new Function(`${source.replace("export default", "return")}`)()
}

test("backend error catalogs exist with matching keys in zh-CN and en", () => {
  const catalogs = {}
  for (const locale of ["zh-CN", "en"]) {
    catalogs[locale] = loadMessages(locale).backendErrors
    expect(catalogs[locale], `${locale} is missing the backendErrors section`).toBeTruthy()
  }
  expect(Object.keys(catalogs["zh-CN"]).sort(), "zh-CN and en backendErrors keys must match").toEqual(
    Object.keys(catalogs.en).sort(),
  )
})

test("every Rust and transport error code is present in both catalogs, with no orphans", () => {
  const catalogs = { "zh-CN": loadMessages("zh-CN").backendErrors, en: loadMessages("en").backendErrors }

  const codes = new Set()
  const rustDir = new URL("../src-tauri/src/", import.meta.url)
  // 递归扫描：modules 拆分成子目录（如 packages/）后调用点仍在仓库内。
  const rustFiles = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir)
      if (entry.isDirectory()) walk(url)
      else if (entry.name.endsWith(".rs")) rustFiles.push(url)
    }
  }
  walk(rustDir)
  for (const file of rustFiles) {
    const source = readFileSync(file, "utf8")
    for (const match of source.matchAll(/pix_error(?:_detail|_with)?\(\s*"([A-Za-z0-9_]+)"/g)) {
      codes.add(match[1])
    }
  }
  const transport = readFileSync(new URL("../src/api/transport.ts", import.meta.url), "utf8")
  for (const match of transport.matchAll(/encodeCodedError\(\s*"([A-Za-z0-9_]+)"/g)) {
    codes.add(match[1])
  }
  // 前端组件/库也会编码错误（如回滚冲突），统一纳入扫描保证清单完整。
  const frontendFiles = ["src/components/TurnChangesCard.vue"]
  for (const relative of frontendFiles) {
    const source = readFileSync(new URL(`../${relative}`, import.meta.url), "utf8")
    for (const match of source.matchAll(/encodeCodedError\(\s*"([A-Za-z0-9_]+)"/g)) {
      codes.add(match[1])
    }
  }

  expect(codes.size > 50, `expected the full error inventory, found ${codes.size}`).toBeTruthy()

  for (const code of codes) {
    expect(catalogs["zh-CN"][code] !== undefined, `zh-CN is missing backendErrors.${code}`).toBeTruthy()
    expect(catalogs.en[code] !== undefined, `en is missing backendErrors.${code}`).toBeTruthy()
  }
  for (const [locale, catalog] of Object.entries(catalogs)) {
    const orphans = Object.keys(catalog).filter(code => !codes.has(code))
    expect(orphans, `${locale} has catalog entries without a Rust/transport call site`).toEqual([])
  }
})
