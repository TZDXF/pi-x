import { expect, test, vi } from "vitest"
import { readFileSync } from "node:fs"
import ts from "typescript"
import { createI18n } from "vue-i18n"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

async function loadLocale(locale: string) {
  const source = read(`../src/i18n/locales/${locale}.ts`)
  const output = ts.transpile(source, { module: ts.ModuleKind.ESNext })
  return (await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`)).default
}

test("storage management is routed, registered and available through both transports", () => {
  const router = read("../src/lib/router.ts")
  const tabs = read("../src/components/settings/tabs.ts")
  const lib = read("../src-tauri/src/lib.rs")
  const remote = read("../src-tauri/src/remote/dispatch/session.rs")
  const api = read("../src/api/client/storage.ts")

  expect(router).toMatch(/"storage",/)
  expect(tabs).toMatch(/id: "storage"[\s\S]*?import\("\.\/StorageSettings\.vue"\)/)
  expect(tabs).toMatch(/"model-config", "storage", "archives", "usage", "about"/)
  expect(lib).toMatch(/storage::storage_summary/)
  expect(lib).toMatch(/storage::storage_cleanup/)
  expect(remote).toMatch(/"storage_summary" =>/)
  expect(remote).toMatch(/"storage_cleanup" =>/)
  expect(api).toMatch(/invoke<StorageSummary>\("storage_summary"\)/)
  expect(api).toMatch(/invoke<StorageCleanupResult>\("storage_cleanup", \{ kind \}\)/)
})

test("storage UI only manages sessions and workspaces and guards destructive cleanup", () => {
  const page = read("../src/components/settings/StorageSettings.vue")
  const backend = read("../src-tauri/src/storage.rs")

  for (const id of ["sessions", "archivedSessions", "workspaces"]) {
    expect(page).toContain(`${id}:`)
    expect(backend).toContain(`category("${id}")`)
  }
  expect(page).toMatch(/pendingCleanup = category/)
  expect(page).toMatch(/cleanupArchivedConfirm/)
  expect(page).toMatch(/@click="confirmCleanup"/)
  expect(page).toMatch(/navigate\('\/settings\/archives'\)/)
  expect(backend).toMatch(/Re-check under the same lock used by archive\/restore operations/)
  expect(backend).toMatch(/fn scan_workspaces/)
  expect(backend).toMatch(/resolve_projectless_dir/)
  expect(backend).toMatch(/only_archived_sessions_can_be_bulk_cleaned/)
  expect(page).not.toMatch(/cache:|logs:|appData:/)
  expect(backend).not.toMatch(/category\("cache"\)|category\("logs"\)|category\("appData"\)/)
})

test("storage panel copy exists in both locales", async () => {
  for (const locale of ["zh-CN", "en"]) {
    const messages = await loadLocale(locale)
    const i18n = createI18n({ legacy: false, locale, fallbackLocale: false, messages: { [locale]: messages } })
    for (const key of [
      "storage.nav",
      "storage.title",
      "storage.description",
      "storage.total",
      "storage.categories.sessions",
      "storage.categories.archivedSessions",
      "storage.categories.workspaces",
      "storage.descriptions.sessions",
      "storage.descriptions.archivedSessions",
      "storage.descriptions.workspaces",
      "storage.cleanupArchivedConfirm",
      "storage.cleaned",
      "storage.cleanedPartial",
      "storage.scopeNote",
    ]) {
      expect(i18n.global.t(key), `${locale}: ${key}`).not.toBe(key)
    }
  }
})

test("byte formatting uses binary units and bounded precision", async () => {
  vi.stubGlobal("localStorage", { getItem: () => "en", setItem() {} })
  vi.stubGlobal("navigator", { language: "en", languages: ["en"] })
  const { formatBytes } = await import("../src/lib/format")
  expect(formatBytes(0)).toBe("0 B")
  expect(formatBytes(1023)).toBe("1,023 B")
  expect(formatBytes(1024)).toBe("1 KB")
  expect(formatBytes(1536)).toBe("1.5 KB")
  expect(formatBytes(10 * 1024)).toBe("10 KB")
  expect(formatBytes(1024 ** 2)).toBe("1 MB")
  expect(formatBytes(-1)).toBe("0 B")
  expect(formatBytes(Number.NaN)).toBe("0 B")
})
