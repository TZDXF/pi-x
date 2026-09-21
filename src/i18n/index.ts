/**
 * i18n setup: vue-i18n with zh-CN / en locales.
 *
 * The active locale is persisted to localStorage ("pix.locale") and defaults
 * to the OS language when supported, falling back to zh-CN.
 */
import { createI18n } from "vue-i18n"
import zhCN from "./locales/zh-CN"
import en from "./locales/en"

export type Locale = "zh-CN" | "en"

export const LOCALES: { value: Locale; label: string }[] = [
  { value: "zh-CN", label: "简体中文" },
  { value: "en", label: "English" },
]

const STORAGE_KEY = "pix.locale"

function normalize(value: string): Locale | null {
  const v = value.toLowerCase()
  if (v.startsWith("zh")) return "zh-CN"
  if (v.startsWith("en")) return "en"
  return null
}

function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const v = normalize(stored)
      if (v) return v
    }
  } catch {
    /* Storage is optional. */
  }
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

export function setLocale(locale: Locale) {
  i18n.global.locale.value = locale
  try {
    localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    /* Storage is optional. */
  }
}

export function currentLocale(): Locale {
  return i18n.global.locale.value
}
