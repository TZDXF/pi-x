import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { effectScope, nextTick, ref } from "vue"

const mocks = vi.hoisted(() => ({
  watch: vi.fn(),
  unwatch: vi.fn(),
  interest: vi.fn(),
  listener: vi.fn(),
  off: vi.fn(),
  isRemote: vi.fn((value: string) => value.startsWith("ssh://")),
}))

vi.mock("@/api/client/projectFiles", () => ({
  watchProjectFiles: mocks.watch,
  unwatchProjectFiles: mocks.unwatch,
  setProjectFilesInterest: mocks.interest,
  onProjectFilesChanged: async (handler: (change: { project: string; paths: string[]; reset: boolean }) => void) => {
    mocks.listener(handler)
    return mocks.off
  },
}))
vi.mock("@/lib/ssh", () => ({ isRemoteProject: mocks.isRemote }))

import { useProjectFileWatch } from "@/composables/useProjectFileWatch"

const scopes: ReturnType<typeof effectScope>[] = []
beforeEach(() => {
  vi.clearAllMocks()
  mocks.watch.mockResolvedValue(undefined)
  mocks.unwatch.mockResolvedValue(undefined)
  mocks.interest.mockResolvedValue(undefined)
})
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
})

async function flush(times = 4) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
    await nextTick()
  }
}

function setup(initial: string, interest?: () => string[]) {
  const project = ref(initial)
  const shown = ref<string[]>([""])
  const changes: { paths: string[]; reset: boolean }[] = []
  const scope = effectScope()
  scopes.push(scope)
  const result = scope.run(() =>
    useProjectFileWatch({
      project: () => project.value,
      interest: interest ?? (() => shown.value),
      onChange: change => changes.push({ paths: change.paths, reset: change.reset }),
    }),
  )!
  return { project, shown, changes, watching: result.watching }
}

test("a local project root is watched and its changes are forwarded", async () => {
  const { changes, watching } = setup("C:/repo")
  await flush()
  expect(mocks.watch).toHaveBeenCalledWith("C:/repo")
  expect(watching.value).toBe("C:/repo")
  const handler = mocks.listener.mock.calls[0][0]
  handler({ project: "C:/repo", paths: ["src/lib.ts"], reset: false })
  expect(changes).toEqual([{ paths: ["src/lib.ts"], reset: false }])
  // 根目录重建后的 reset 也要透传，前端据此整表重载。
  handler({ project: "C:/repo", paths: [], reset: true })
  expect(changes.at(-1)).toEqual({ paths: [], reset: true })
  // Events for another project never leak into this tab.
  handler({ project: "C:/other", paths: ["README.md"], reset: false })
  expect(changes).toHaveLength(2)
})

test("the browsed scope is published on start and whenever it grows or shrinks", async () => {
  const { shown } = setup("C:/repo")
  await flush()
  expect(mocks.interest).toHaveBeenCalledWith("C:/repo", [""])
  shown.value = ["", "dist"]
  await flush()
  expect(mocks.interest).toHaveBeenLastCalledWith("C:/repo", ["", "dist"])
  // 收起目录后重新收窄关注范围，避免为不可见目录持续推送事件。
  shown.value = [""]
  await flush()
  expect(mocks.interest).toHaveBeenLastCalledWith("C:/repo", [""])
})

test("interest follows the previewed file as it changes", async () => {
  const shown = ref([""])
  const { changes } = setup("C:/repo", () => shown.value)
  await flush()
  const handler = mocks.listener.mock.calls[0][0]
  shown.value = ["", "src", "src/lib.ts"]
  await flush()
  expect(mocks.interest).toHaveBeenLastCalledWith("C:/repo", ["", "src", "src/lib.ts"])
  handler({ project: "C:/repo", paths: ["src/lib.ts"], reset: false })
  expect(changes).toEqual([{ paths: ["src/lib.ts"], reset: false }])
})

test("switching projects stops the old watch and starts the new one", async () => {
  const { project } = setup("C:/repo")
  await flush()
  project.value = "C:/next"
  await flush()
  expect(mocks.unwatch).toHaveBeenCalledWith("C:/repo")
  expect(mocks.off).toHaveBeenCalledTimes(1)
  expect(mocks.watch).toHaveBeenLastCalledWith("C:/next")
  expect(mocks.watch).toHaveBeenCalledTimes(2)
})

test("closing the tab (empty project) releases the watcher without starting another", async () => {
  const { project, watching } = setup("C:/repo")
  await flush()
  project.value = ""
  await flush()
  expect(mocks.unwatch).toHaveBeenCalledWith("C:/repo")
  expect(mocks.watch).toHaveBeenCalledTimes(1)
  expect(watching.value).toBe("")
})

test("remote projects and static resource lists are never watched", async () => {
  const { watching } = setup("ssh://dev@host/work")
  await flush()
  expect(mocks.watch).not.toHaveBeenCalled()
  expect(watching.value).toBe("")
  const empty = setup("")
  await flush()
  expect(empty.watching.value).toBe("")
  expect(mocks.watch).not.toHaveBeenCalled()
  expect(mocks.unwatch).not.toHaveBeenCalled()
})

test("an unwatchable directory leaves the UI on manual refresh", async () => {
  mocks.watch.mockRejectedValue(new Error("PIXERR:projectDirMissing"))
  const { watching } = setup("C:/missing")
  await flush()
  expect(watching.value).toBe("")
  expect(mocks.off).toHaveBeenCalledTimes(1)
})

test("disposing the sidebar releases the subscription", async () => {
  setup("C:/repo")
  await flush()
  scopes.splice(0).forEach(scope => scope.stop())
  await flush()
  expect(mocks.unwatch).toHaveBeenCalledWith("C:/repo")
  expect(mocks.off).toHaveBeenCalledTimes(1)
})
