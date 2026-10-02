import { expect, test, vi } from "vitest"
import { createConversationLoader } from "@/lib/conversationLoader"

function conversation(runtimeId = "local") {
  return {
    runtimeId,
    cwd: "/project",
    sessionFile: "session.jsonl",
    syncedSessionMtime: 1,
    started: false,
    isStreaming: false,
    isResending: false,
    clear: vi.fn(),
    init: vi.fn(async () => {}),
    loadHistory: vi.fn(async () => {}),
    markRunning: vi.fn(),
  }
}
function harness() {
  const owner = conversation()
  const runtime = conversation("existing")
  const deps = {
    listRunning: vi.fn(async () => []),
    sessionFor: vi.fn(() => runtime),
    spawn: vi.fn(async () => {}),
    kill: vi.fn(async () => {}),
    mtime: vi.fn(async () => 1),
    rebuild: vi.fn(async () => {}),
  }
  return { owner, runtime, deps, loader: createConversationLoader(deps) }
}

test("an already loaded conversation reconciles disk changes for every entry point", async () => {
  const { owner, deps, loader } = harness()
  owner.started = true
  deps.mtime.mockResolvedValue(2)
  expect(await loader.load(owner, owner.sessionFile, owner.cwd)).toBe(owner)
  expect(deps.rebuild).toHaveBeenCalledWith(owner)
  expect(deps.spawn).not.toHaveBeenCalled()
  expect(deps.listRunning).not.toHaveBeenCalled()
})

test("matching disk metadata does not rebuild or respawn a loaded worker", async () => {
  const { owner, deps, loader } = harness()
  owner.started = true
  await loader.load(owner, owner.sessionFile, owner.cwd)
  expect(deps.rebuild).not.toHaveBeenCalled()
  expect(deps.spawn).not.toHaveBeenCalled()
})

test("running or resending turns are never rebuilt", async () => {
  for (const flag of ["isStreaming", "isResending"]) {
    const { owner, deps, loader } = harness()
    owner.started = true
    owner[flag] = true
    deps.mtime.mockResolvedValue(2)
    await loader.load(owner, owner.sessionFile, owner.cwd)
    expect(deps.mtime).not.toHaveBeenCalled()
    expect(deps.rebuild).not.toHaveBeenCalled()
  }
})

test("a turn starting during the metadata request prevents rebuilding", async () => {
  const { owner, deps, loader } = harness()
  owner.started = true
  deps.mtime.mockImplementation(async () => {
    owner.isStreaming = true
    return 2
  })
  await loader.reconcile(owner)
  expect(deps.rebuild).not.toHaveBeenCalled()
})

test("scheduler workers are attached by normalized saved identity, never spawned twice", async () => {
  const { owner, runtime, deps, loader } = harness()
  deps.listRunning.mockResolvedValue([
    {
      runtimeId: "existing",
      project: "/project",
      state: {
        sessionFile: "C:/sessions/a.jsonl",
        isStreaming: true,
      },
    },
  ])
  runtime.loadHistory.mockImplementation(async () => {
    expect(runtime.isStreaming).toBe(true)
  })
  expect(await loader.load(owner, "C:\\sessions\\a.jsonl", "/project")).toBe(runtime)
  expect(owner.sessionFile).toBeNull()
  expect(runtime.started).toBe(true)
  expect(runtime.markRunning).toHaveBeenCalledOnce()
  expect(deps.spawn).not.toHaveBeenCalled()
})

test("failed attachment never kills another window's worker", async () => {
  const { owner, runtime, deps, loader } = harness()
  deps.listRunning.mockResolvedValue([
    {
      runtimeId: "existing",
      project: "/project",
      state: {
        sessionFile: "session.jsonl",
        isStreaming: false,
      },
    },
  ])
  runtime.init.mockRejectedValue(new Error("attach failed"))
  await expect(loader.load(owner, "session.jsonl", "/project")).rejects.toThrow("attach failed")
  expect(deps.kill).not.toHaveBeenCalled()
  expect(runtime.started).toBe(false)
  expect(owner.sessionFile).toBe("session.jsonl")
})

test("a new worker is initialized without changing activation state", async () => {
  const { owner, deps, loader } = harness()
  expect(await loader.load(owner, "session.jsonl", "/project")).toBe(owner)
  expect(deps.spawn).toHaveBeenCalledWith("/project", "session.jsonl", "local")
  expect(owner.init).toHaveBeenCalledWith("/project")
  expect(owner.loadHistory).toHaveBeenCalledOnce()
  expect(owner.started).toBe(true)
})

test("failed own-worker initialization cleans up only that worker", async () => {
  const { owner, deps, loader } = harness()
  owner.loadHistory.mockRejectedValue(new Error("history failed"))
  await expect(loader.load(owner, "session.jsonl", "/project")).rejects.toThrow("history failed")
  expect(deps.kill).toHaveBeenCalledWith("local")
  expect(owner.started).toBe(false)
})

test("a session identity changing during metadata lookup invalidates the reconciliation", async () => {
  const { owner, deps, loader } = harness()
  owner.started = true
  deps.mtime.mockImplementation(async () => {
    owner.sessionFile = "other.jsonl"
    return 2
  })
  await loader.reconcile(owner)
  expect(deps.rebuild).not.toHaveBeenCalled()
})
