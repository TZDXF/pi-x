import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

function harness(initial = {}, component = "SkillSettings") {
  const source = readFileSync(new URL(`../src/components/settings/${component}.vue`, import.meta.url), "utf8")
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
    .replace(/^import[\s\S]*?from\s+["'][^"']+["']\n/gm, "")
    .replace(/^import\s+["'][^"']+["']\n/gm, "")
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
    // 预览区响应式副作用不在这批用例的覆盖范围内，提供空实现保证脚本可求值。
    watch: () => {},
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
  expect(h.api.skills.value.length).toBe(1)
  expect(h.api.skills.value[0].enabled).toBe(true)
  expect(h.api.error.value).toBe("")
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
  expect(disabled.enabled).toBe(true)
  expect(h.savedEnabled()).toEqual([enabled.path, disabled.path])

  h.failWrite(true)
  await h.api.toggle(disabled, false)
  expect(disabled.enabled, "optimistic change is reverted on failure").toBe(true)
  expect(h.toasts.at(-1)[1]).toBe("error")
})

test("opening the hosted directory and deleting requires confirmation", async () => {
  const skill = { name: "gone", description: "", path: "C:/Users/u/.pix/skills/gone", kind: "file", enabled: false }
  const h = harness({ __hosted: [skill] })
  await h.mount()

  await h.api.openDirectory()
  expect(h.opened()).toBe(1)
  h.failOpen(true)
  await h.api.openDirectory()
  expect(h.opened()).toBe(1)
  expect(h.toasts.at(-1)[1]).toBe("error")

  h.askResult(false)
  await h.api.remove(skill)
  expect(h.deletedPaths()).toEqual([])

  h.askResult(true)
  await h.api.remove(skill)
  expect(h.deletedPaths()).toEqual([skill.path])
})

test("load failures support retry", async () => {
  const h = harness()
  h.failRead(true)
  await h.mount()
  expect(h.api.error.value).toMatch(/read failure/)
  h.failRead(false)
  await h.api.load()
  expect(h.api.error.value).toBe("")
})

test("prompt page shows missing files, creates edits, and preserves drafts across selection", async () => {
  const h = harness({ __promptFiles: { "SYSTEM.md": "old" }, piPath: "pi" }, "AgentSettings")
  await h.mount()
  expect(Array.from(h.api.files.value, file => file.fileName)).toEqual(["AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md"])
  expect(h.api.selectedFile.value.content).toBe("old")
  expect(h.api.selectedFile.value.exists).toBe(true)
  h.api.selectedName.value = "AGENTS.md"
  expect(h.api.selectedFile.value.exists).toBe(false)
  h.api.updatePrompt("中文")
  h.api.selectedName.value = "SYSTEM.md"
  h.api.updatePrompt("new system prompt")
  h.api.selectedName.value = "AGENTS.md"
  expect(h.api.selectedFile.value.content, "switching files preserves unsaved edits").toBe("中文")
  await h.api.save()
  expect(h.prompts()["AGENTS.md"]).toBe("中文")
  expect(h.api.selectedFile.value.exists).toBe(true)
  expect(h.api.selectedFile.value.savedContent).toBe("中文")
  expect(h.prompts()["SYSTEM.md"], "only the selected file was saved").toBe("old")
  expect(h.config().piPath).toBe("pi")
  h.api.updatePrompt("")
  await h.api.save()
  expect(h.prompts()["AGENTS.md"]).toBe("")
  expect(h.api.selectedFile.value.exists).toBe(false)
})

test("failed prompt save retains the draft and file status", async () => {
  const h = harness({}, "AgentSettings")
  await h.mount()
  h.api.updatePrompt("new content")
  h.failWrite(true)
  await h.api.save()
  expect(h.api.selectedFile.value.savedContent).toBe("")
  expect(h.api.selectedFile.value.exists).toBe(false)
  expect(h.api.selectedFile.value.content).toBe("new content")
  expect(h.toasts.at(-1)[1]).toBe("error")
})

test("settings exposes separate prompt and skills pages", () => {
  const tabs = readFileSync(new URL("../src/components/settings/tabs.ts", import.meta.url), "utf8")
  expect(tabs).toMatch(/id: "agent-config",[\s\S]*?\.\/AgentSettings\.vue/)
  expect(tabs).toMatch(/id: "skills",[\s\S]*?\.\/SkillSettings\.vue/)
  const prompt = readFileSync(new URL("../src/components/settings/AgentSettings.vue", import.meta.url), "utf8")
  expect(prompt).not.toMatch(/managedSkills|manage-skills/)
})
