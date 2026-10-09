import { expect, test, vi } from "vitest"
import { ref } from "vue"

const state = vi.hoisted(() => ({ read: vi.fn(async () => []) }))
vi.mock("@/lib/fileRewind", () => ({ fileRewindState: (...args) => state.read(...args) }))
async function harness() {
  // Vitest 复用 worker 且不隔离模块；不能复用其他 session 测试加载过的 mock。
  vi.resetModules()
  vi.doMock("@/lib/fileRewind", () => ({ fileRewindState: (...args) => state.read(...args) }))
  const { createSessionArtifacts } = await import("@/stores/session/artifacts")
  const context = {
    sessionFile: ref("first.jsonl"),
    fileChangeArtifacts: ref([]),
    revertedFileChangeCalls: ref(new Set()),
  }
  return { ...context, ...createSessionArtifacts(context) }
}
const entry = id => ({
  id,
  customType: "pix-file-change",
  data: {
    toolCallId: "tool",
    toolName: "write",
    files: [{ path: "a.ts", existedBefore: false, beforeContent: null, afterContent: "a" }],
  },
})

test("live and persisted representations of one tool call do not duplicate its artifact", async () => {
  const h = await harness()
  h.mergeFileChangeArtifact(entry(undefined))
  h.mergeFileChangeArtifact(entry("entry-id"))
  expect(h.fileChangeArtifacts.value.length).toBe(1)
  expect(h.fileChangeArtifacts.value[0].entryId).toBe("entry-id")
})

test("persisted markers restore on reopen and only update the owning session", async () => {
  const h = await harness()
  state.read.mockResolvedValueOnce(["persisted"])
  await h.refreshFileRewindState("first.jsonl")
  expect([...h.revertedFileChangeCalls.value]).toEqual(["persisted"])
  h.recordFileRewinds("other.jsonl", ["wrong"])
  expect([...h.revertedFileChangeCalls.value]).toEqual(["persisted"])
  h.recordFileRewinds("first.jsonl", ["new"])
  expect([...h.revertedFileChangeCalls.value]).toEqual(["persisted", "new"])
})

test("a stale marker read cannot overwrite a newly completed rewind", async () => {
  let resolve
  state.read.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done
      }),
  )
  const h = await harness()
  const loading = h.refreshFileRewindState("first.jsonl")
  h.recordFileRewinds("first.jsonl", ["new"])
  resolve([])
  await loading
  expect([...h.revertedFileChangeCalls.value]).toEqual(["new"])
})
