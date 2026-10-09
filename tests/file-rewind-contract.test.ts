import { readFileSync, existsSync } from "node:fs"
import { expect, test } from "vitest"

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

test("desktop, remote and session lifecycle expose artifact undo but no Git snapshot or snippet replay commands", () => {
  for (const file of [
    "src-tauri/src/lib.rs",
    "src-tauri/src/remote/dispatch/workspace.rs",
    "src/stores/session.ts",
    "src/stores/session/events.ts",
    "src/stores/workspace.ts",
  ]) {
    expect(source(file)).not.toMatch(
      /session_checkpoint|session_revert_changes|checkpointStart|checkpointSettle|turnCheckpointRecords/,
    )
  }
  expect(source("src-tauri/src/lib.rs")).toContain("session_file_rewind::session_file_rewind_apply")
  expect(source("src-tauri/src/remote/dispatch/workspace.rs")).toContain('"session_file_rewind_apply"')
  expect(existsSync(new URL("../src/lib/checkpoints.ts", import.meta.url))).toBe(false)
})

test("state is persisted by the backend apply command, not a separate fire-and-forget marker write", () => {
  expect(source("src/lib/fileRewind.ts")).toContain('"session_file_rewind_apply"')
  expect(source("src/lib/fileRewind.ts")).not.toContain("session_file_rewind_state_mark")
  expect(source("src-tauri/src/session_file_rewind.rs")).toContain("apply_plan_with_commit")
  expect(source("src-tauri/src/session_file_rewind.rs")).toContain("write_state(session, state)")
})

test("session deletion owns marker cleanup even after the JSONL has gone", () => {
  const deletion = source("src-tauri/src/sessions.rs")
    .split("pub async fn session_delete")[1]
    .split("pub async fn session_list_archived")[0]
  expect(deletion).toContain("session_file_rewind::delete_state_for_session(&path)")
  expect(source("src/stores/workspace.ts")).not.toMatch(
    /session_file_rewind_state_delete|session_checkpoint_manifest_delete/,
  )
})
