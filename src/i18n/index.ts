/**
 * i18n setup: vue-i18n with zh-CN / en locales.
 *
 * The active locale is persisted to ~/.pix/config.json and defaults to the
 * OS language when supported, falling back to zh-CN.
 */
import { createI18n } from "vue-i18n"
import { formatCodedError } from "@/lib/backendError"
import { createConfigPreference } from "@/lib/configPreference"
import zhCN from "./locales/zh-CN"
import en from "./locales/en"

export type Locale = "zh-CN" | "en"

export const LOCALES: { value: Locale; label: string }[] = [
  { value: "zh-CN", label: "简体中文" },
  { value: "en", label: "English" },
]

function normalize(value: string): Locale | null {
  const v = value.toLowerCase()
  if (v.startsWith("zh")) return "zh-CN"
  if (v.startsWith("en")) return "en"
  return null
}

function initialLocale(): Locale {
  for (const lang of navigator.languages ?? [navigator.language]) {
    const v = normalize(lang)
    if (v) return v
  }
  return "zh-CN"
}

export const i18n = createI18n({
  legacy: false,
  locale: initialLocale(),
  fallbackLocale: "zh-CN",
  messages: { "zh-CN": zhCN, en },
})

const preference = createConfigPreference<Locale>({
  key: "locale",
  legacyKey: "pix.locale",
  defaultValue: initialLocale,
  validate: (value): value is Locale => value === "zh-CN" || value === "en",
  onChange: locale => {
    i18n.global.locale.value = locale
  },
})

export function setLocale(locale: Locale) {
  return preference.set(locale)
}

export function currentLocale(): Locale {
  return i18n.global.locale.value
}

/** 翻译后端/传输层的编码错误（PIXERR: 前缀）；普通文本原样返回。 */
export function tBackendError(raw: unknown): string {
  return formatCodedError((key, params) => i18n.global.t(key, params ?? {}), raw)
}
