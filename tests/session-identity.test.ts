import { expect, test } from "vitest"
import { sessionIdentityKey, sameSessionIdentity } from "@/lib/sessionIdentity"
import { sessionRunStatus, setSessionRunStatus, acknowledgeSessionRunStatus } from "@/stores/sessionRunStatus"

test("local identity keeps slash normalization and remote identity keeps POSIX backslashes", () => {
  expect(sameSessionIdentity("C:\\sessions\\a.jsonl", "C:/project", "C:/sessions/a.jsonl", "C:/other")).toBe(true)
  const project = "ssh://dev@host:22/project"
  expect(sameSessionIdentity("/sessions/a\\b.jsonl", project, "/sessions/a/b.jsonl", project)).toBe(false)
  expect(sessionIdentityKey("/a.jsonl", "ssh://dev@HOST:22/project/")).toBe(sessionIdentityKey("/a.jsonl", project))
})

test("run status and acknowledgement cannot leak across endpoints or local files", () => {
  const file = "/sessions/shared.jsonl"
  const first = "ssh://dev@first:22/project"
  const second = "ssh://dev@second:22/project"
  setSessionRunStatus(file, "running", first)
  setSessionRunStatus(file, "error", second)
  setSessionRunStatus(file, "completed")
  expect(sessionRunStatus(file, first)).toBe("running")
  expect(sessionRunStatus(file, second)).toBe("error")
  expect(sessionRunStatus(file)).toBe("completed")
  acknowledgeSessionRunStatus(file, second)
  expect(sessionRunStatus(file, second)).toBeUndefined()
  expect(sessionRunStatus(file, first)).toBe("running")
  expect(sessionRunStatus(file)).toBe("completed")
  setSessionRunStatus(file, null, first)
  acknowledgeSessionRunStatus(file)
})
