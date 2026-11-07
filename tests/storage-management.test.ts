import { expect, test, vi } from "vitest"
import { readFileSync } from "node:fs"
import ts from "typescript"
import { createI18n } from "vue-i18n"
import * as vue from "vue"
import { compileScript, parse } from "vue/compiler-sfc"

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

test("storage includes WebView caches and guards destructive cleanup", () => {
  const page = read("../src/components/settings/StorageSettings.vue")
  const backend = read("../src-tauri/src/storage.rs")

  for (const id of ["sessions", "archivedSessions"]) {
    expect(page).toContain(`${id}:`)
    expect(backend).toContain(`category("${id}")`)
  }
  expect(page).toMatch(/pendingCleanup = category/)
  expect(page).toMatch(/cleanupArchivedConfirm/)
  expect(page).toMatch(/cleanupWebviewCacheConfirm/)
  expect(page).toContain('id === "webviewCache"')
  expect(page).toContain('t("storage.fileCount", { count: category.fileCount })')
  expect(page).toContain('v-if="isCleanable(category.id)"')
  expect(page).toMatch(/@click="confirmCleanup"/)
  expect(page).toMatch(/navigate\('\/settings\/archives'\)/)
  expect(backend).toMatch(/Re-check under the same lock used by archive\/restore operations/)
  expect(page).not.toContain("workspaces")
  expect(backend).not.toMatch(/scan_workspaces|storage_roots|resolve_projectless_dir/)
  expect(read("../src/api/client/storage.ts")).toContain('"archivedSessions" | "webviewCache"')
  expect(backend).toContain("categories.push(webview_cache::scan(root))")
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
      "storage.categories.webviewCache",
      "storage.descriptions.sessions",
      "storage.descriptions.archivedSessions",
      "storage.descriptions.webviewCache",
      "storage.cleanupArchivedConfirm",
      "storage.cleanupWebviewCacheConfirm",
      "storage.fileCount",
      "backendErrors.webviewCacheCleanupFailed",
      "storage.cleaned",
      "storage.cleanedPartial",
      "storage.scopeNote",
    ]) {
      expect(i18n.global.t(key), `${locale}: ${key}`).not.toBe(key)
    }
    expect(messages.storage.categories).not.toHaveProperty("workspaces")
    expect(messages.storage.descriptions).not.toHaveProperty("workspaces")
  }
})

test("cache cleanup confirms the right category, refreshes usage and recovers from native errors", async () => {
  const cache = { id: "webviewCache", bytes: 8192, fileCount: 8, itemCount: 0 }
  const initial = { totalBytes: 8192, categories: [cache] }
  const refreshed = { totalBytes: 128, categories: [{ ...cache, bytes: 128, fileCount: 1 }] }
  const getStorageSummary = vi.fn().mockResolvedValue(initial)
  const cleanupStorage = vi.fn().mockResolvedValue({ freedBytes: 8064, deletedItems: 7, failed: 0 })
  const pushToast = vi.fn()
  const { descriptor } = parse(read("../src/components/settings/StorageSettings.vue"))
  const compiled = compileScript(descriptor, { id: "storage-settings-test" })
  const code = ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const modules: Record<string, unknown> = {
    vue: { ...vue, onMounted() {} },
    "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
    "@lucide/vue": {},
    "@/api/piClient": { cleanupStorage, getStorageSummary },
    "@/lib/format": { formatBytes: String },
    "@/lib/backendError": { formatCodedError: (_t: unknown, error: Error) => error.message },
    "@/lib/router": {},
    "@/stores/conversations": { useUiStore: () => ({ pushToast }) },
    "@/components/ui/button": {},
    "@/components/ui/dialog": {},
  }
  const exports: any = {}
  new Function("exports", "require", code)(exports, (id: string) => modules[id])
  const panel = exports.default.setup({}, { expose() {} })
  await panel.load()
  panel.pendingCleanup.value = cache
  expect(panel.pendingDescription.value).toBe("storage.cleanupWebviewCacheConfirm")
  getStorageSummary.mockResolvedValue(refreshed)
  await panel.confirmCleanup()
  expect(cleanupStorage).toHaveBeenCalledExactlyOnceWith("webviewCache")
  expect(panel.summary.value.totalBytes).toBe(128)
  expect(panel.pendingCleanup.value).toBeNull()
  expect(panel.busy.value).toBeNull()
  expect(pushToast).toHaveBeenCalledWith("storage.cleaned", "info")

  cleanupStorage.mockRejectedValueOnce(new Error("native cleanup failed"))
  panel.pendingCleanup.value = cache
  await panel.confirmCleanup()
  expect(panel.error.value).toBe("native cleanup failed")
  expect(getStorageSummary).toHaveBeenCalledTimes(3)
  expect(panel.busy.value).toBeNull()

  panel.pendingCleanup.value = { id: "sessions", bytes: 10 }
  await panel.confirmCleanup()
  expect(cleanupStorage).toHaveBeenCalledTimes(2)
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
