import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

const source = readFileSync(new URL("../src/components/WorkspaceContext.vue", import.meta.url), "utf8")
const app = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8")

test("environment and branch menus only record draft choices", () => {
  const menu = source.split('<Popover v-if="!isProjectless" v-model:open="modeOpen"')[1].split("</Popover>")[0]
  const content = menu.split("<PopoverContent")[1]
  expect((content.match(/<Button\b/g) || []).length).toBe(2)
  expect(content).toMatch(/@click="selectMode\(false\)"/)
  expect(content).toMatch(/@click="selectMode\(true\)"/)
  expect(content).not.toMatch(/v-for|tree\.branch/)
  expect(source).toMatch(/v-for="branch in branchOptions"/)
  expect(source).toMatch(/:disabled="blocked \|\| \(selection\?\.worktree && unbornBranch\(branch\)\)"/)
  expect(source).toMatch(/workspace\.noCommitsYet/)
  expect(source).toMatch(/workspace\.baseBranch/)
  expect(source).not.toMatch(/createWorkspaceGit|prepareWorkspaceGit|<Dialog/)
  const functions = source.slice(source.indexOf("function selectMode("), source.indexOf("watch(() => props.project"))
  const context = {
    info: { value: { branches: ["main", "feature/base"] } },
    selection: { value: { project: "C:/repo", worktree: false, branch: "main" } },
    modeOpen: { value: true },
    branchOpen: { value: true },
    blocked: { value: false },
  }
  vm.runInNewContext(ts.transpile(functions), context)
  context.selectMode(true)
  context.selectBranch("feature/base")
  expect(context.selection.value.worktree).toBe(true)
  expect(context.selection.value.branch).toBe("feature/base")
  expect(context.modeOpen.value).toBe(false)
  expect(context.branchOpen.value).toBe(false)
  context.blocked.value = true
  context.selectMode(false)
  expect(context.selection.value.worktree).toBe(true)
})

test("projectless drafts show a default project and hide Git menus", () => {
  expect(source).toMatch(
    /const isProjectless = computed\(\(\) => !props\.project \|\| workspace\.isProjectless\(props\.project\)\)/,
  )
  expect(source).toMatch(/projectless\.name/)
  expect(source).toMatch(/if \(!props\.project\) return/)
  expect(source).toMatch(/<Popover v-if="!isProjectless" v-model:open="modeOpen"/)
  expect(source).toMatch(/<Popover v-if="!isProjectless" v-model:open="branchOpen"/)
})

test("workspace menus open upward without trigger arrows", () => {
  const contents = source.match(/<PopoverContent\b[^>]*>/g) || []
  expect(contents.length).toBe(3)
  for (const content of contents) expect(content).toMatch(/side="top"/)
  expect(source).not.toMatch(/ChevronDown/)
})

function harness(overrides = {}) {
  const events = []
  const owner = {
    runtimeId: "draft",
    cwd: "C:/repo",
    entries: [],
    promptQueue: [],
    started: true,
    clear() {
      events.push("clear")
    },
  }
  const context = vm.createContext({
    events,
    owner,
    ref: value => ({ value }),
    activeRuntimeId: { value: "draft" },
    phase: { value: "chat" },
    selectingProject: { value: false },
    t: key => key,
    sessionFor: () => owner,
    workspace: {
      gitBusy: false,
      rememberWorkspace: async path => events.push(`remember:${path}`),
      unremoveProject: () => {},
    },
    connecting: { value: false },
    project: { value: "C:/repo" },
    config: { value: {} },
    lastError: { value: null },
    workspaceGitInfo: async () => ({ branch: "main" }),
    prepareWorkspaceGit: async () => {
      events.push("create")
      return "C:/tree"
    },
    normalizeProjectPath: value => value,
    trustStatus: async () => ({ needsDecision: false }),
    trustSave: async () => {},
    killPi: async () => events.push("kill"),
    saveConfig: async () => events.push("save"),
    startRuntime: async () => {
      events.push(`start:${owner.cwd}`)
      return true
    },
    uiFor: () => ({ pushToast: message => events.push(`error:${message}`) }),
    ui: { pushToast: () => {} },
    tBackendError: String,
    ...overrides,
  })
  const code = app.slice(app.indexOf("const workspaceTrust ="), app.indexOf("async function startRuntime(runtimeId"))
  vm.runInContext(
    ts.transpile(code) + "\nglobalThis.api = {start, decideWorkspaceTrust, finishWorkspaceTrust, workspaceTrust}",
    context,
  )
  return { ...context.api, context, owner, events }
}
const selection = { project: "C:/repo", worktree: true, branch: "feature/base" }

test("first send waits for checkout preparation before starting the same runtime", async () => {
  let resolve
  const creation = new Promise(r => {
    resolve = r
  })
  const h = harness({
    prepareWorkspaceGit: async received => {
      expect(received).toBe(selection)
      return creation
    },
  })
  const sending = h.start(selection).then(ok => {
    if (ok) h.events.push("send")
  })
  await new Promise(resolve => setImmediate(resolve))
  expect(h.context.workspace.gitBusy).toBe(true)
  expect(h.events).toEqual([])
  expect(await h.start(selection)).toBe(false)
  resolve("C:/tree")
  await sending
  expect(h.events).toEqual(["remember:C:/tree", "kill", "clear", "save", "start:C:/tree", "send"])
  expect(h.owner.runtimeId).toBe("draft")
  expect(h.context.workspace.gitBusy).toBe(false)
})

test("creation failure never starts a runtime or changes the project", async () => {
  const h = harness({
    prepareWorkspaceGit: async () => {
      throw new Error("creation failed")
    },
  })
  expect(await h.start(selection)).toBe(false)
  expect(h.owner.cwd).toBe("C:/repo")
  expect(h.context.project.value).toBe("C:/repo")
  expect(h.context.workspace.gitBusy).toBe(false)
  expect(h.context.connecting.value).toBe(false)
  expect(h.events).toEqual(["error:Error: creation failed"])
})

test("initialization failure reuses the created worktree on retry", async () => {
  let attempts = 0
  const h = harness({ startRuntime: async () => ++attempts > 1 })
  expect(await h.start(selection)).toBe(false)
  expect(await h.start(selection)).toBe(true)
  expect(h.events.filter(e => e === "create").length).toBe(1)
})

test("trust is awaited without replacing the composer; declining prevents startup", async () => {
  const h = harness({ trustStatus: async () => ({ needsDecision: true, projectPath: "C:/tree" }) })
  const pending = h.start(selection)
  await new Promise(resolve => setImmediate(resolve))
  expect(h.workspaceTrust.value.projectPath).toBe("C:/tree")
  expect(h.events.some(e => e.startsWith("start:"))).toBeFalsy()
  await h.decideWorkspaceTrust(false, false)
  expect(await pending).toBe(false)
  expect(h.owner.cwd).toBe("C:/repo")
  const retry = h.start(selection)
  await new Promise(resolve => setImmediate(resolve))
  await h.decideWorkspaceTrust(true, false)
  expect(await retry).toBe(true)
  expect(h.events.filter(e => e === "create").length).toBe(1)
})

test("local mode does not create a worktree and only prepares a changed branch", async () => {
  const h = harness()
  expect(await h.start({ ...selection, worktree: false, branch: "main" })).toBe(true)
  expect(h.events.includes("create")).toBeFalsy()
  expect(await h.start({ ...selection, worktree: false })).toBe(true)
  expect(h.events.includes("create")).toBeTruthy()
})

test("chat awaits preparation and throws on failure so input and attachments are retained", () => {
  const chat = readFileSync(new URL("../src/components/ChatView.vue", import.meta.url), "utf8")
  const submit = chat.slice(chat.indexOf("async function onSubmit("), chat.indexOf("function thinkingLabel"))
  expect(submit).toMatch(/await props\.ensureStarted\(session\.entries\.length \? null : workspaceSelection\.value\)/)
  expect(submit.indexOf("await props.ensureStarted") < submit.indexOf("await session.send")).toBeTruthy()
  expect(submit).toMatch(/bridge\.value\?\.setTextInput\(text\)\s*throw new Error/)
  expect(chat).toMatch(/v-model="workspaceSelection"/)
})
