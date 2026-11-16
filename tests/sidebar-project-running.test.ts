import { expect, test } from "vitest"
import { projectHasRunningSession } from "@/components/workspace/sidebar/useSidebarSessionStatus"
import { setSessionRunStatus } from "@/stores/sessionRunStatus"

const projectRoot = (path: string) => (path.startsWith("C:/repo/worktree") ? "C:/repo" : path)

test("a project is running when any saved session is running", () => {
  setSessionRunStatus("sidebar-running.jsonl", "running", "C:/repo")

  expect(projectHasRunningSession("C:/repo", [{ file: "sidebar-running.jsonl" }], [], projectRoot)).toBe(true)
  setSessionRunStatus("sidebar-running.jsonl", "completed", "C:/repo")
  expect(projectHasRunningSession("C:/repo", [{ file: "sidebar-running.jsonl" }], [], projectRoot)).toBe(false)
})

test("a project is running when a new session in one of its worktrees is streaming", () => {
  expect(
    projectHasRunningSession("C:/repo", [], [{ cwd: "C:/repo/worktree/feature", isStreaming: true }], projectRoot),
  ).toBe(true)
  expect(
    projectHasRunningSession("C:/repo", [], [{ cwd: "C:/repo/worktree/feature", isStreaming: false }], projectRoot),
  ).toBe(false)
})
