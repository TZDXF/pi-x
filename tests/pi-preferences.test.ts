import { expect, test } from "vitest"
import { computed, ref } from "vue"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"
import { parseUpdateCommand } from "@/lib/piPreferences"

function harness() {
  const source = readFileSync(new URL("../src/components/settings/PiPreferencesSettings.vue", import.meta.url), "utf8")
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]!
    .replace(/^import .*$/gm, "")
  const settings = {
    skills: [],
    retry: { maxRetries: 3 },
    selfUpdateCommand: null,
    selfUpdateCommandSupported: true,
    sessionShareDestination: "auto",
    collapseChangelog: false,
  }
  const patches: unknown[] = [],
    toasts: unknown[] = []
  let fail = false
  const context = vm.createContext({
    ref,
    computed,
    onMounted() {},
    parseUpdateCommand,
    useI18n: () => ({ t: key => key }),
    useUiStore: () => ({ pushToast: (...args) => toasts.push(args) }),
    getPiSettings: async () => ({ ...settings }),
    savePiSettings: async patch => {
      if (fail) throw Error("write failed")
      patches.push(JSON.parse(JSON.stringify(patch)))
      Object.assign(settings, patch)
    },
  })
  vm.runInContext(
    ts.transpile(source + "\nglobalThis.api = { load, save, saved, command, collapse, destination, dirty };", {
      target: ts.ScriptTarget.ES2022,
    }),
    context,
  )
  return {
    api: context.api,
    patches,
    toasts,
    settings,
    fail: () => {
      fail = true
    },
  }
}

test("update command parsing preserves argv boundaries and placeholders without shell evaluation", () => {
  const argv = ["C:/Program Files/tool.exe", "", "npm:{packageName}@{version}", "$(untrusted)"]
  expect(parseUpdateCommand(JSON.stringify(argv))).toEqual({ ok: true, argv })
  expect(parseUpdateCommand("  ")).toEqual({ ok: true, argv: null })
  for (const text of ['"npm update"', "[]", '[" "]', '["npm", 1]', "{}", "null", "[", '["npm","\\u0000"]'])
    expect(parseUpdateCommand(text)).toEqual({ ok: false })
})

test("preferences load without writing and save only fields actually edited", async () => {
  const h = harness()
  await h.api.load()
  await h.api.save()
  expect(h.patches).toEqual([])
  h.api.destination.value = "gist"
  await h.api.save()
  expect(h.patches).toEqual([{ sessionShareDestination: "gist" }])
  expect(h.api.dirty.value).toBe(false)
  h.api.collapse.value = true
  await h.api.save()
  expect(h.patches.at(-1)).toEqual({ collapseChangelog: true })
})

test("custom update command can be saved and cleared back to the native updater", async () => {
  const h = harness()
  await h.api.load()
  h.api.command.value = '["mise", "use", "-g", "npm:{installSpec}"]'
  await h.api.save()
  expect(h.patches.at(-1)).toEqual({ selfUpdateCommand: ["mise", "use", "-g", "npm:{installSpec}"] })
  h.api.command.value = ""
  await h.api.save()
  expect(h.patches.at(-1)).toEqual({ selfUpdateCommand: null })
})

test("invalid commands never write another changed preference and failures retain the draft", async () => {
  const h = harness()
  await h.api.load()
  h.api.command.value = "npm install -g pi"
  h.api.collapse.value = true
  await h.api.save()
  expect(h.patches).toEqual([])
  h.api.command.value = '["npm", "update"]'
  h.fail()
  await h.api.save()
  expect(h.api.command.value).toBe('["npm", "update"]')
  expect(h.api.dirty.value).toBe(true)
  expect(h.settings.collapseChangelog).toBe(false)
})
