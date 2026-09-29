import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

const source = readFileSync(new URL("../src/components/WorkspaceContext.vue", import.meta.url), "utf8")
const app = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8")

test("environment and branch menus only record draft choices", () => {
  const menu = source.split('<Popover v-model:open="modeOpen"')[1].split("</Popover>")[0]
  const content = menu.split("<PopoverContent")[1]
  assert.equal((content.match(/<Button\b/g) || []).length, 2)
  assert.match(content, /@click="selectMode\(false\)"/)
  assert.match(content, /@click="selectMode\(true\)"/)
  assert.doesNotMatch(content, /v-for|tree\.branch/)
  assert.match(source, /v-for="branch in branchOptions"/)
  assert.match(source, /:disabled="blocked \|\| \(selection\?\.worktree && unbornBranch\(branch\)\)"/)
  assert.match(source, /workspace\.noCommitsYet/)
  assert.match(source, /workspace\.baseBranch/)
  assert.doesNotMatch(source, /createWorkspaceGit|prepareWorkspaceGit|<Dialog/)
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
  assert.equal(context.selection.value.worktree, true)
  assert.equal(context.selection.value.branch, "feature/base")
  assert.equal(context.modeOpen.value, false)
  assert.equal(context.branchOpen.value, false)
  context.blocked.value = true
  context.selectMode(false)
  assert.equal(context.selection.value.worktree, true)
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
  const code = app.slice(app.indexOf("const workspaceTrust ="), app.indexOf("async function startRuntime()"))
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
      assert.equal(received, selection)
      return creation
    },
  })
  const sending = h.start(selection).then(ok => {
    if (ok) h.events.push("send")
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.context.workspace.gitBusy, true)
  assert.deepEqual(h.events, [])
  assert.equal(await h.start(selection), false)
  resolve("C:/tree")
  await sending
  assert.deepEqual(h.events, ["remember:C:/tree", "kill", "clear", "save", "start:C:/tree", "send"])
  assert.equal(h.owner.runtimeId, "draft")
  assert.equal(h.context.workspace.gitBusy, false)
})

test("creation failure never starts a runtime or changes the project", async () => {
  const h = harness({
    prepareWorkspaceGit: async () => {
      throw new Error("creation failed")
    },
  })
  assert.equal(await h.start(selection), false)
  assert.equal(h.owner.cwd, "C:/repo")
  assert.equal(h.context.project.value, "C:/repo")
  assert.equal(h.context.workspace.gitBusy, false)
  assert.equal(h.context.connecting.value, false)
  assert.deepEqual(h.events, ["error:Error: creation failed"])
})

test("initialization failure reuses the created worktree on retry", async () => {
  let attempts = 0
  const h = harness({ startRuntime: async () => ++attempts > 1 })
  assert.equal(await h.start(selection), false)
  assert.equal(await h.start(selection), true)
  assert.equal(h.events.filter(e => e === "create").length, 1)
})

test("trust is awaited without replacing the composer; declining prevents startup", async () => {
  const h = harness({ trustStatus: async () => ({ needsDecision: true, projectPath: "C:/tree" }) })
  const pending = h.start(selection)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.workspaceTrust.value.projectPath, "C:/tree")
  assert.ok(!h.events.some(e => e.startsWith("start:")))
  await h.decideWorkspaceTrust(false, false)
  assert.equal(await pending, false)
  assert.equal(h.owner.cwd, "C:/repo")
  const retry = h.start(selection)
  await new Promise(resolve => setImmediate(resolve))
  await h.decideWorkspaceTrust(true, false)
  assert.equal(await retry, true)
  assert.equal(h.events.filter(e => e === "create").length, 1)
})

test("local mode does not create a worktree and only prepares a changed branch", async () => {
  const h = harness()
  assert.equal(await h.start({ ...selection, worktree: false, branch: "main" }), true)
  assert.ok(!h.events.includes("create"))
  assert.equal(await h.start({ ...selection, worktree: false }), true)
  assert.ok(h.events.includes("create"))
})

test("chat awaits preparation and throws on failure so input and attachments are retained", () => {
  const chat = readFileSync(new URL("../src/components/ChatView.vue", import.meta.url), "utf8")
  const submit = chat.slice(chat.indexOf("async function onSubmit("), chat.indexOf("function thinkingLabel"))
  assert.match(submit, /await props\.ensureStarted\(session\.entries\.length \? null : workspaceSelection\.value\)/)
  assert.ok(submit.indexOf("await props.ensureStarted") < submit.indexOf("await session.send"))
  assert.match(submit, /bridge\.value\?\.setTextInput\(text\)\s*throw new Error/)
  assert.match(chat, /v-model="workspaceSelection"/)
})
