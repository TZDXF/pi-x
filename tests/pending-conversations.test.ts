import { test, expect } from "vitest"
import { pendingConversations } from "@/lib/pendingConversations"
const draft = (sessionFile, text = "Send later", cwd = "project") => ({ cwd, sessionFile, promptQueue: [{ text }] })

test("new queued conversations appear before a history file or row exists", () => {
  const items = [draft(null), draft("new.jsonl")]
  expect(pendingConversations(items, ["project"], [], "").length).toBe(2)
})

test("history rows deduplicate pending conversations, including Windows paths", () => {
  const items = [draft("sessions\\one.jsonl"), draft("sessions/two.jsonl")]
  const result = pendingConversations(items, ["project"], ["sessions/one.jsonl"], "")
  expect(result.length).toBe(1)
  expect(result[0]).toBe(items[1])
})

test("pending rows respect project folders, search and queue cancellation", () => {
  const items = [draft(null), draft(null, "Other", "other"), draft(null, "Nested", "project/sub")]
  expect(pendingConversations(items, ["project", "project/sub"], [], "NESTED").length).toBe(1)
  items[0].promptQueue = []
  expect(pendingConversations(items, ["project"], [], "").length).toBe(0)
})
