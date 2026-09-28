import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

function harness(initial = {}, component = "SkillSettings") {
  const source = readFileSync(new URL(`../src/components/settings/${component}.vue`, import.meta.url), "utf8")
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
    .replace(/^import .*$/gm, "")
  let config = initial,
    mount,
    failRead = false,
    failWrite = false,
    askResult = true
  const promptFiles = {
    "AGENTS.md": "",
    "SYSTEM.md": "",
    "APPEND_SYSTEM.md": "",
    ...config.__promptFiles,
  }
  delete config.__promptFiles
  const toasts = []
  const hosted = config.__hosted ?? []
  delete config.__hosted
  let savedEnabled = null
  let opened = 0,
    failOpen = false
  let deletedPaths = []
  const context = vm.createContext({
    ref: value => ({ value }),
    computed: fn => ({
      get value() {
        return fn()
      },
    }),
    onMounted: fn => {
      mount = fn
    },
    useI18n: () => ({ t: key => key }),
    useUiStore: () => ({ pushToast: (...args) => toasts.push(args) }),
    listHostedSkills: async () => {
      if (failRead) throw Error("read failure")
      return hosted
    },
    listDiscoveredSkills: async () => [],
    openHostedSkillsDirectory: async () => {
      if (failOpen) throw Error("open failure")
      opened++
    },
    setHostedSkillsEnabled: async paths => {
      if (failWrite) throw Error("write failure")
      savedEnabled = paths
    },
    deleteHostedSkill: async path => {
      if (failWrite) throw Error("write failure")
      deletedPaths.push(path)
    },
    ask: async () => askResult,
    getConfig: async () => {
      if (failRead) throw Error("read failure")
      return config
    },
    saveConfig: async value => {
      if (failWrite) throw Error("write failure")
      config = value
    },
    listGlobalPrompts: async () => {
      if (failRead) throw Error("read failure")
      return Object.entries(promptFiles).map(([fileName, content]) => ({ fileName, content, exists: !!content }))
    },
    saveGlobalPrompt: async (fileName, value) => {
      if (failWrite) throw Error("write failure")
      promptFiles[fileName] = value
    },
  })
  const fields =
    component === "AgentSettings"
      ? "files, selectedName, selectedFile, error, saving, load, save, updatePrompt"
      : "skills, error, load, toggle, remove, openDirectory"
  vm.runInContext(
    ts.transpile(source + `\nglobalThis.api = { ${fields} };`, { target: ts.ScriptTarget.ES2022 }),
    context,
  )
  return {
    api: context.api,
    mount: () => (mount ? mount() : Promise.resolve()),
    config: () => config,
    prompts: () => promptFiles,
    toasts,
    failRead: value => {
      failRead = value
    },
    failWrite: value => {
      failWrite = value
    },
    hosted,
    askResult: value => {
      askResult = value
    },
    savedEnabled: () => savedEnabled,
    opened: () => opened,
    failOpen: value => {
      failOpen = value
    },
    deletedPaths: () => deletedPaths,
  }
}

test("hosted skills load from the .pix store and enabled paths come from Pi", async () => {
  const skill = {
    name: "my-skill",
    description: "d",
    path: "C:/Users/u/.pix/skills/my-skill",
    kind: "directory",
    enabled: true,
  }
  const h = harness({ __hosted: [skill] })
  await h.mount()
  assert.equal(h.api.skills.value.length, 1)
  assert.equal(h.api.skills.value[0].enabled, true)
  assert.equal(h.api.error.value, "")
})

test("toggling enables by registering paths in Pi settings; failure reverts", async () => {
  const enabled = { name: "on", description: "", path: "C:/Users/u/.pix/skills/on", kind: "file", enabled: true }
  const disabled = {
    name: "off",
    description: "",
    path: "C:/Users/u/.pix/skills/off",
    kind: "directory",
    enabled: false,
  }
  const h = harness({ __hosted: [enabled, disabled] })
  await h.mount()

  await h.api.toggle(disabled, true)
  assert.equal(disabled.enabled, true)
  assert.deepEqual(h.savedEnabled(), [enabled.path, disabled.path])

  h.failWrite(true)
  await h.api.toggle(disabled, false)
  assert.equal(disabled.enabled, true, "optimistic change is reverted on failure")
  assert.equal(h.toasts.at(-1)[1], "error")
})

test("opening the hosted directory and deleting requires confirmation", async () => {
  const skill = { name: "gone", description: "", path: "C:/Users/u/.pix/skills/gone", kind: "file", enabled: false }
  const h = harness({ __hosted: [skill] })
  await h.mount()

  await h.api.openDirectory()
  assert.equal(h.opened(), 1)
  h.failOpen(true)
  await h.api.openDirectory()
  assert.equal(h.opened(), 1)
  assert.equal(h.toasts.at(-1)[1], "error")

  h.askResult(false)
  await h.api.remove(skill)
  assert.deepEqual(h.deletedPaths(), [])

  h.askResult(true)
  await h.api.remove(skill)
  assert.deepEqual(h.deletedPaths(), [skill.path])
})

test("load failures support retry", async () => {
  const h = harness()
  h.failRead(true)
  await h.mount()
  assert.match(h.api.error.value, /read failure/)
  h.failRead(false)
  await h.api.load()
  assert.equal(h.api.error.value, "")
})

test("prompt page shows missing files, creates edits, and preserves drafts across selection", async () => {
  const h = harness({ __promptFiles: { "SYSTEM.md": "old" }, piPath: "pi" }, "AgentSettings")
  await h.mount()
  assert.deepEqual(
    Array.from(h.api.files.value, file => file.fileName),
    ["AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md"],
  )
  assert.equal(h.api.selectedFile.value.content, "old")
  assert.equal(h.api.selectedFile.value.exists, true)
  h.api.selectedName.value = "AGENTS.md"
  assert.equal(h.api.selectedFile.value.exists, false)
  h.api.updatePrompt("中文")
  h.api.selectedName.value = "SYSTEM.md"
  h.api.updatePrompt("new system prompt")
  h.api.selectedName.value = "AGENTS.md"
  assert.equal(h.api.selectedFile.value.content, "中文", "switching files preserves unsaved edits")
  await h.api.save()
  assert.equal(h.prompts()["AGENTS.md"], "中文")
  assert.equal(h.api.selectedFile.value.exists, true)
  assert.equal(h.api.selectedFile.value.savedContent, "中文")
  assert.equal(h.prompts()["SYSTEM.md"], "old", "only the selected file was saved")
  assert.equal(h.config().piPath, "pi")
  h.api.updatePrompt("")
  await h.api.save()
  assert.equal(h.prompts()["AGENTS.md"], "")
  assert.equal(h.api.selectedFile.value.exists, false)
})

test("failed prompt save retains the draft and file status", async () => {
  const h = harness({}, "AgentSettings")
  await h.mount()
  h.api.updatePrompt("new content")
  h.failWrite(true)
  await h.api.save()
  assert.equal(h.api.selectedFile.value.savedContent, "")
  assert.equal(h.api.selectedFile.value.exists, false)
  assert.equal(h.api.selectedFile.value.content, "new content")
  assert.equal(h.toasts.at(-1)[1], "error")
})

test("settings exposes separate prompt and skills pages", () => {
  const tabs = readFileSync(new URL("../src/components/settings/tabs.ts", import.meta.url), "utf8")
  assert.match(tabs, /id: "agent-config",[\s\S]*?\.\/AgentSettings\.vue/)
  assert.match(tabs, /id: "skills",[\s\S]*?\.\/SkillSettings\.vue/)
  const prompt = readFileSync(new URL("../src/components/settings/AgentSettings.vue", import.meta.url), "utf8")
  assert.doesNotMatch(prompt, /managedSkills|manage-skills/)
})
