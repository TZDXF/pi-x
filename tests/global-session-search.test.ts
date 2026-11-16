import { effectScope, ref } from "vue"
import { afterEach, describe, expect, test, vi } from "vitest"
import {
  mergeGlobalSessionSearchHits,
  performGlobalSessionSearch,
  remoteSessionProject,
  type GlobalSessionSearchApi,
} from "@/lib/globalSessionSearch"
import { useGlobalSessionSearch } from "@/components/workspace/sidebar/useGlobalSessionSearch"
import type { SessionSearchHit } from "@/api/piClient"

vi.mock("@/api/piClient", () => ({
  searchSessions: vi.fn(),
  sshConnectionList: vi.fn(),
  sshSessionSearch: vi.fn(),
}))

function hit(file: string, cwd: string, mtimeMs: number, snippet: string | null = "matched text"): SessionSearchHit {
  return {
    session: { file, id: file, cwd, mtimeMs, title: "Session" },
    role: snippet ? "assistant" : null,
    snippet,
    matchCount: snippet ? 1 : 0,
  }
}

const connection = {
  id: "remote-1",
  name: "Remote",
  host: "example.com",
  port: 22,
  user: "dev",
  keyPath: null,
  createdAt: "",
  lastUsedAt: null,
  lastProbe: null,
}

afterEach(() => {
  vi.useRealTimers()
})

test("remote result cwd retains the endpoint identity for resume navigation", () => {
  expect(remoteSessionProject("ssh://dev@example.com:2222/old", "/new/project")).toBe(
    "ssh://dev@example.com:2222/new/project",
  )
  expect(remoteSessionProject("wsl://dev@Ubuntu/old", "/new/project")).toBe("wsl://dev@Ubuntu/new/project")
})

test("global search dedupes remote connections, sorts hits and keeps local failures partial", async () => {
  const searchRemote = vi.fn(async (_project: string, _id: string, query: string) => [
    hit(`/remote/${query}.jsonl`, "/remote/project", 20),
  ])
  const api: GlobalSessionSearchApi = {
    searchLocal: async () => [hit("C:/sessions/local.jsonl", "C:/project", 10)],
    searchRemote,
    listConnections: async () => [connection],
  }
  const outcome = await performGlobalSessionSearch(
    "needle",
    ["ssh://dev@example.com/one", "ssh://dev@example.com/two"],
    api,
  )
  expect(searchRemote).toHaveBeenCalledTimes(1)
  expect(outcome.failed).toBe(false)
  expect(outcome.results.map(row => row.path)).toEqual(["ssh://dev@example.com/remote/project", "C:/project"])
})

test("one unavailable backend does not discard successful results", async () => {
  const api: GlobalSessionSearchApi = {
    searchLocal: async () => [hit("C:/sessions/local.jsonl", "C:/project", 10)],
    searchRemote: async () => {
      throw new Error("offline")
    },
    listConnections: async () => [connection],
  }
  const outcome = await performGlobalSessionSearch("needle", ["ssh://dev@example.com/one"], api)
  expect(outcome.failed).toBe(true)
  expect(outcome.results).toHaveLength(1)
  expect(outcome.results[0].session.id).toContain("local")
})

test("merge prefers a content hit over a title-only duplicate and applies the cap", () => {
  const titleOnly = { ...hit("same", "/project", 1, null), path: "/project" }
  const content = { ...hit("same", "/project", 1), path: "/project" }
  expect(mergeGlobalSessionSearchHits([[titleOnly], [content]])).toEqual([content])
  const many = Array.from({ length: 105 }, (_, index) => ({
    ...hit(String(index), "/project", index),
    path: "/project",
  }))
  const merged = mergeGlobalSessionSearchHits([many])
  expect(merged).toHaveLength(100)
  expect(merged[0].session.id).toBe("104")
})

describe("debounced sidebar search", () => {
  test("drops stale responses and clears results while typing", async () => {
    vi.useFakeTimers()
    const pending = new Map<
      string,
      (value: { results: { session: SessionSearchHit["session"]; path: string }[]; failed: boolean }) => void
    >()
    const search = vi.fn(
      (query: string) => new Promise<{ results: never[]; failed: boolean }>(resolve => pending.set(query, resolve)),
    )
    const query = ref("")
    const scope = effectScope()
    const state = scope.run(() => useGlobalSessionSearch(query, ref(true), () => [], search))!
    query.value = "first"
    await vi.advanceTimersByTimeAsync(250)
    query.value = "second"
    expect(state.results.value).toEqual([])
    await vi.advanceTimersByTimeAsync(250)
    pending.get("second")!({
      results: [{ ...hit("new", "/project", 2), path: "/project" }],
      failed: false,
    })
    await Promise.resolve()
    pending.get("first")!({
      results: [{ ...hit("old", "/project", 1), path: "/project" }],
      failed: true,
    })
    await Promise.resolve()
    expect(state.failed.value).toBe(false)
    expect(state.searching.value).toBe(false)
    expect(state.results.value.map(row => row.session.id)).toEqual(["new"])
    scope.stop()
  })
})
