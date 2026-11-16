import { expect, test, vi } from "vitest"
import { ref } from "vue"
import { submitBoardDraft } from "@/lib/submitBoardDraft"
import { createWorkspaceStartup } from "@/lib/workspaceStartup"
import type { SessionStore } from "@/stores/session"
import type { BoardDraft } from "@/lib/workspaceState"

const draft: BoardDraft = { id: "todo", project: "/root", message: "Task", createdAt: 1, updatedAt: 1 }

function harness() {
  const owner = {
    runtimeId: draft.id,
    cwd: draft.project,
    started: false,
    entries: [],
    commands: [],
    send: vi.fn(async () => {}),
    init: vi.fn(async () => {}),
    refreshCommands: vi.fn(async () => {}),
    newSession: vi.fn(async () => {}),
  } as unknown as SessionStore
  const deps = {
    ensureStarted: vi.fn(async () => true),
    knownSessions: () => [],
    translate: (key: string) => key,
  }
  return { owner, deps }
}

test("background draft submission waits for startup and sends the saved image and text", async () => {
  const { owner, deps } = harness()
  let ready!: (allowed: boolean) => void
  deps.ensureStarted.mockImplementation(
    () =>
      new Promise(resolve => {
        ready = resolve
      }),
  )
  const pending = submitBoardDraft(
    {
      ...draft,
      message: " Task ",
      attachments: [{ filename: "photo.png", mediaType: "image/png", url: "data:image/png;base64,aGVsbG8=" }],
    },
    owner,
    deps,
  )
  expect(owner.send).not.toHaveBeenCalled()
  ready(true)
  await pending
  expect(owner.send).toHaveBeenCalledExactlyOnceWith(
    "Task",
    [{ data: "aGVsbG8=", mimeType: "image/png" }],
    "Task",
    expect.any(String),
  )
})

test("failed startup and unsupported attachments do not send or lose the saved draft", async () => {
  const { owner, deps } = harness()
  deps.ensureStarted.mockResolvedValue(false)
  await expect(submitBoardDraft(draft, owner, deps)).rejects.toThrow("completion.startFailed")
  const document = {
    ...draft,
    attachments: [{ filename: "notes.txt", mediaType: "text/plain", url: "data:text/plain;base64,YQ==" }],
  }
  await expect(submitBoardDraft(document, owner, deps)).rejects.toThrow("chat.imageAttachmentsOnly")
  expect(owner.send).not.toHaveBeenCalled()
  expect(document.attachments).toHaveLength(1)
  expect(deps.ensureStarted).toHaveBeenCalledOnce()
})

test("extension commands keep their original text while desktop compact is submitted as a command", async () => {
  const { owner, deps } = harness()
  owner.commands = [{ name: "extension", source: "extension" }] as SessionStore["commands"]
  await submitBoardDraft({ ...draft, message: "/extension task" }, owner, deps)
  expect(owner.send).toHaveBeenLastCalledWith("/extension task", undefined, "/extension task", expect.any(String))
  await submitBoardDraft({ ...draft, message: "/compact keep context" }, owner, deps)
  expect(owner.send).toHaveBeenLastCalledWith("/compact keep context", undefined, undefined, expect.any(String))
})

test("background runtime creation leaves navigation available and the active conversation unchanged", async () => {
  const { owner } = harness()
  let finish!: () => void
  const spawnPi = vi.fn(
    () =>
      new Promise<void>(resolve => {
        finish = resolve
      }),
  )
  const context = {
    api: { spawnPi, pixLog: vi.fn(), killPi: vi.fn(async () => {}) },
    conversations: { sessionFor: () => owner, uiFor: () => ({ pushToast: vi.fn() }), activeRuntimeId: ref("visible") },
    workspace: { projectGroups: {}, projectRoot: (path: string) => path },
    phase: ref("pick"),
    config: ref({ lastProject: "/visible" }),
    project: ref("/visible"),
    connecting: ref(false),
    selectingProject: ref(false),
    lastError: ref(null),
    pushToast: vi.fn(),
    translate: (key: string) => key,
    translateError: String,
    rebuildConversation: vi.fn(),
  } as unknown as Parameters<typeof createWorkspaceStartup>[0]
  const startup = createWorkspaceStartup(context)
  const pending = startup.startSession(owner.runtimeId, null, true)
  expect(spawnPi).toHaveBeenCalledWith("/root", undefined, "todo", undefined)
  expect(context.connecting.value).toBe(false)
  expect(owner.started).toBe(false)
  const duplicate = startup.startSession(owner.runtimeId, null, true)
  expect(spawnPi).toHaveBeenCalledOnce()
  finish()
  expect(await pending).toBe(true)
  expect(await duplicate).toBe(true)
  expect(owner.started).toBe(true)
  expect(context.conversations.activeRuntimeId.value).toBe("visible")
  expect(context.project.value).toBe("/visible")
  expect(context.phase.value).toBe("pick")
  expect(context.config.value.lastProject).toBe("/visible")
})
