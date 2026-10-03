import { composerSources } from "./fixtures/chatSources"
import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

const source = readFileSync(new URL("../src/components/WorkspaceContext.vue", import.meta.url), "utf8")

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
  expect(source).not.toMatch(/prepareWorkspaceGit/)
  const functions = source.slice(source.indexOf("function selectMode("), source.indexOf("watch(() => props.project"))
  const context = {
    info: { value: { branches: ["main", "feature/base"] } },
    selection: { value: { project: "C:/repo", worktree: false, branch: "main" } },
    modeOpen: { value: true },
    branchOpen: { value: true },
    blocked: { value: false },
    ref: value => ({ value }),
    watch: () => {},
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

test("branch menu offers create-and-checkout only in local mode", () => {
  const menu = source.split('<Popover v-if="!isProjectless" v-model:open="branchOpen"')[1].split("</Popover>")[0]
  expect(menu).toMatch(/<div v-if="!selection\?\.worktree"/)
  expect(menu).toMatch(/@click="openCreateDialog"/)
  expect(menu).toMatch(/workspace\.createBranch/)
  expect(menu).not.toMatch(/newBranch|createBranch\(/)
  const dialog = source.split('<Dialog v-model:open="createOpen"')[1].split("</Dialog>")[0]
  expect(dialog).toMatch(/workspace\.branchHint/)
  expect(dialog).toMatch(/v-model="newBranch"/)
  expect(dialog).toMatch(/@keydown\.enter="createBranch"/)
  expect(dialog).toMatch(/:disabled="blocked \|\| creating \|\| !newBranch\.trim\(\)"/)
  expect(dialog).toMatch(/workspace\.create/)
})

function branchHarness(overrides = {}) {
  const calls = []
  const context = vm.createContext({
    __out: null,
    props: { project: "C:/repo" },
    ref: value => ({ value }),
    // 最小响应式：赋值即触发回调，模拟组件内 open 变化时的重置逻辑。
    watch: (source, cb) => {
      let current = source.value
      Object.defineProperty(source, "value", {
        get: () => current,
        set: next => {
          current = next
          cb(next)
        },
      })
    },
    loading: { value: false },
    info: { value: null },
    selection: { value: { project: "C:/repo", worktree: false, branch: "main" } },
    gitError: { value: "" },
    blocked: { value: false },
    modeOpen: { value: false },
    projectOpen: { value: false },
    branchOpen: { value: true },
    createOpen: { value: true },
    workspaceGitInfo: async () => ({
      branch: "feature/new",
      branches: ["main", "feature/new"],
      unborn_branch: false,
      worktree: false,
      worktrees: [],
    }),
    workspace: { gitBusy: false, registerWorktrees: () => {} },
    createWorkspaceGit: async (project, branch, worktree) => {
      calls.push([project, branch, worktree])
      return project
    },
    tBackendError: String,
    ...overrides,
  })
  const code =
    source.slice(source.indexOf("let request = 0"), source.indexOf("watch(() => props.project")) +
    "\n__out = { newBranch, createError, creating, createBranch, createOpen, branchOpen, openCreateDialog }"
  vm.runInNewContext(ts.transpile(code), context)
  return { context: { ...context, ...context.__out }, calls }
}

test("creating a branch checks it out and refreshes the draft selection", async () => {
  const { context, calls } = branchHarness()
  context.newBranch.value = " feature/new "
  await context.createBranch()
  expect(calls).toEqual([["C:/repo", "feature/new", false]])
  expect(context.selection.value).toEqual({ project: "C:/repo", worktree: false, branch: "feature/new" })
  expect(context.newBranch.value).toBe("")
  expect(context.createOpen.value).toBe(false)
  expect(context.workspace.gitBusy).toBe(false)
  expect(context.creating.value).toBe(false)
})

test("opening the dialog closes the branch menu and resets the draft name", () => {
  const { context } = branchHarness()
  context.newBranch.value = "feature/stale"
  context.createError.value = "stale error"
  context.openCreateDialog()
  expect(context.branchOpen.value).toBe(false)
  expect(context.createOpen.value).toBe(true)
  expect(context.newBranch.value).toBe("")
  expect(context.createError.value).toBe("")
})

test("branch creation failure keeps the dialog open and surfaces the error", async () => {
  const { context, calls } = branchHarness({
    createWorkspaceGit: async () => {
      calls.push("throw")
      throw new Error("branch already exists")
    },
  })
  context.createOpen.value = true
  context.newBranch.value = "feature/new"
  await context.createBranch()
  expect(calls).toEqual(["throw"])
  expect(context.createError.value).toBe("Error: branch already exists")
  expect(context.createOpen.value).toBe(true)
  expect(context.selection.value.branch).toBe("main")
  expect(context.workspace.gitBusy).toBe(false)
})

test("branch creation is skipped when blocked or the name is blank", async () => {
  const blocked = branchHarness({ blocked: { value: true } })
  blocked.context.newBranch.value = "feature/new"
  await blocked.context.createBranch()
  expect(blocked.calls).toEqual([])

  const blank = branchHarness()
  blank.context.newBranch.value = "   "
  await blank.context.createBranch()
  expect(blank.calls).toEqual([])
  expect(blank.context.createError.value).toBe("")
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
    samePath: (a, b) => a === b,
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
    // startSession 切片引用的模块级计时工具与 perf 日志（切片外定义，这里桩掉）。
    nowMs: () => Date.now(),
    pixLog: () => {},
    ...overrides,
  })
  const startup = readFileSync(new URL("../src/lib/workspaceStartup.ts", import.meta.url), "utf8")
  const code = startup.slice(
    startup.indexOf("const workspaceTrust ="),
    startup.indexOf("async function startRuntime(runtimeId"),
  )
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
  const chat = composerSources()
  const submit = chat.slice(chat.indexOf("async function onSubmit("), chat.indexOf("function thinkingLabel"))
  expect(submit).toMatch(/await deps\.ensureStarted\(session\.entries\.length \? null : deps\.workspaceSelection\(\)\)/)
  expect(submit.indexOf("await deps.ensureStarted") < submit.indexOf("await session.send")).toBeTruthy()
  expect(submit).toMatch(/bridge\.value\?\.setTextInput\(text\)\s*throw new Error/)
  expect(chat).toMatch(/v-model="workspaceSelection"/)
})
