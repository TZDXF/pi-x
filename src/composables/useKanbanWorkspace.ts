import { computed, ref, watch } from "vue"
import { allConversations, sessionFor, uiFor, findConversation } from "@/stores/conversations"
import { sessionRunStatus, sessionActivitySnapshot } from "@/stores/sessionRunStatus"
import { sessionIdentityKey } from "@/lib/sessionIdentity"
import { normalizeProjectPath, samePath } from "@/lib/paths"
import { createUuid } from "@/lib/uuid"
import type { KanbanCard, KanbanStatus } from "@/lib/kanban"
import { kanbanLivePreview } from "@/lib/kanbanLivePreview"
import type { BoardDraft } from "@/lib/workspaceState"
import type { useWorkspaceStore } from "@/stores/workspace"

type Workspace = ReturnType<typeof useWorkspaceStore>

/** Projects, drafts, saved history and live runtimes share one card identity. */
export function useKanbanWorkspace(workspace: Workspace, enabled: () => boolean) {
  const selectedProject = ref("")
  const loading = ref(false)
  const error = ref("")
  const selection = ref<KanbanCard | null>(null)
  const detailsOpen = ref(false)
  const projects = computed(() => {
    const values = workspace.orderedProjects().filter(path => !workspace.isProjectless(path))
    if (workspace.projectless) values.push(workspace.projectless)
    return values.map(value => ({ value, label: workspace.projectName(value) }))
  })
  const folders = computed(() => [
    ...new Set(
      projects.value.flatMap(item =>
        workspace.isProjectless(item.value) ? [item.value] : workspace.projectFolders(item.value),
      ),
    ),
  ])
  const isIncluded = (project: string) => folders.value.some(folder => samePath(folder, project))
  const cardProject = (project: string) => (workspace.isProjectless(project) ? project : workspace.projectRoot(project))

  const cards = computed<KanbanCard[]>(() => {
    const result = new Map<string, KanbanCard>()
    const archived = new Set(
      Object.values(workspace.histories)
        .flat()
        .filter(row => row.archived)
        .map(row => sessionIdentityKey(row.file, row.cwd)),
    )
    const drafts = Object.values(workspace.boardDrafts ?? {})
    const draftByFile = new Map(
      drafts
        .filter(draft => draft.sessionFile)
        .map(draft => [sessionIdentityKey(draft.sessionFile!, draft.project), draft]),
    )
    const conversations = allConversations()
    const statusFor = (file: string | undefined, project: string, runtimeId?: string): KanbanStatus => {
      if (runtimeId && uiFor(runtimeId).activeDialog) return "waiting"
      const run = file ? sessionRunStatus(file, project) : undefined
      const owner = runtimeId ? sessionFor(runtimeId) : undefined
      if (
        run === "running" ||
        owner?.isStreaming ||
        owner?.isCompacting ||
        owner?.retryInfo ||
        (owner?.promptQueue.length ?? 0) > 0
      )
        return "running"
      return run === "completed" || run === "error" ? "completed" : "idle"
    }
    for (const folder of folders.value) {
      for (const row of workspace.histories[folder] ?? []) {
        if (row.archived) continue
        const identity = sessionIdentityKey(row.file, row.cwd)
        const draft = draftByFile.get(identity)
        const owner = findConversation(row.file, row.cwd)
        const activity = sessionActivitySnapshot(row.file, row.cwd)
        result.set(identity, {
          id: identity,
          file: row.file,
          cwd: row.cwd,
          runtimeId: owner?.runtimeId,
          draftId: draft?.id,
          project: cardProject(row.cwd),
          projectName: workspace.projectName(row.cwd),
          projectless: workspace.isProjectless(row.cwd),
          title: row.title || row.preview || draft?.message || "",
          preview: row.lastUserMessage ?? (row.preview || draft?.message || ""),
          updatedAt: Math.max(row.mtimeMs || Date.parse(row.timestamp || "") || 0, activity?.updatedAt ?? 0),
          status: statusFor(row.file, row.cwd, owner?.runtimeId),
          failed: activity?.status === "error",
        })
      }
    }
    for (const owner of conversations) {
      if (!isIncluded(owner.cwd) || !owner.sessionFile) continue
      const file = owner.sessionFile
      const identity = sessionIdentityKey(file, owner.cwd)
      // An archived session must stay hidden even when its runtime is still alive.
      if (archived.has(identity)) continue
      const existing = result.get(identity)
      if (existing) continue
      const draft = draftByFile.get(identity)
      const firstPrompt = owner.entries.find(entry => entry.kind === "user")
      const pending = owner.promptQueue[0]
      if (!firstPrompt && !owner.isStreaming && !draft?.sessionFile) {
        if (!pending || drafts.some(item => (item.runtimeId || item.id) === owner.runtimeId)) continue
      }
      const activity = sessionActivitySnapshot(file, owner.cwd)
      result.set(identity, {
        id: identity,
        file,
        cwd: owner.cwd,
        runtimeId: owner.runtimeId,
        draftId: draft?.id,
        project: cardProject(owner.cwd),
        projectName: workspace.projectName(owner.cwd),
        projectless: workspace.isProjectless(owner.cwd),
        title: firstPrompt?.text || pending?.text || draft?.message || "",
        preview: firstPrompt?.text || pending?.text || draft?.message || "",
        updatedAt: activity?.updatedAt ?? draft?.updatedAt ?? firstPrompt?.timestamp ?? 0,
        status: !firstPrompt && pending && !owner.isStreaming ? "todo" : statusFor(file, owner.cwd, owner.runtimeId),
        failed: activity?.status === "error",
      })
    }
    for (const draft of drafts) {
      if (!isIncluded(draft.project)) continue
      if (draft.sessionFile && archived.has(sessionIdentityKey(draft.sessionFile, draft.project))) continue
      if (draft.sessionFile && result.has(sessionIdentityKey(draft.sessionFile, draft.project))) continue
      const owner = conversations.find(owner => owner.runtimeId === (draft.runtimeId || draft.id))
      const submitted = !!draft.sessionFile
      const file = draft.sessionFile
      result.set(file ? sessionIdentityKey(file, draft.project) : `draft:${draft.id}`, {
        id: file ? sessionIdentityKey(file, draft.project) : `draft:${draft.id}`,
        file,
        cwd: draft.project,
        runtimeId: owner?.runtimeId,
        draftId: draft.id,
        project: cardProject(draft.project),
        projectName: workspace.projectName(draft.project),
        projectless: workspace.isProjectless(draft.project),
        title: draft.message,
        preview: draft.message,
        updatedAt: draft.updatedAt,
        status: submitted ? statusFor(file, draft.project, owner?.runtimeId) : "todo",
        failed: file ? sessionActivitySnapshot(file, draft.project)?.status === "error" : false,
      })
    }
    const owners = new Map(conversations.map(owner => [owner.runtimeId, owner]))
    for (const card of result.values()) {
      const owner = card.runtimeId ? owners.get(card.runtimeId) : undefined
      if (owner) {
        for (let index = owner.entries.length - 1; index >= 0; index--) {
          const entry = owner.entries[index]!
          if (entry.kind !== "user") continue
          card.preview = entry.text
          break
        }
      }
      if (card.status === "running" && owner) card.activity = kanbanLivePreview(owner) ?? undefined
    }
    return [...result.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  })
  const selectedCard = computed(() => {
    const selected = selection.value
    if (!selected) return null
    return (
      cards.value.find(card => card.id === selected.id || (!!selected.draftId && card.draftId === selected.draftId)) ??
      selected
    )
  })
  const selectedDraft = computed(() =>
    selectedCard.value?.draftId ? (workspace.boardDrafts[selectedCard.value.draftId] ?? null) : null,
  )

  let refreshVersion = 0
  async function refresh() {
    const version = ++refreshVersion
    loading.value = true
    error.value = ""
    const results = await Promise.allSettled(folders.value.map(folder => workspace.refresh(folder)))
    if (version !== refreshVersion) return
    const failure = results.find(result => result.status === "rejected")
    if (failure?.status === "rejected") error.value = String(failure.reason)
    loading.value = false
  }
  watch(
    () => (enabled() ? folders.value.join("\n") : null),
    value => {
      if (value !== null) void refresh()
    },
    { immediate: true },
  )
  watch(projects, values => {
    if (selectedProject.value && !values.some(value => value.value === selectedProject.value))
      selectedProject.value = ""
  })

  async function createDraft(input: { project: string; message: string }): Promise<BoardDraft | null> {
    const project = normalizeProjectPath(input.project)
    const message = input.message.trim()
    if (!project || !message || !projects.value.some(item => samePath(item.value, project))) return null
    const timestamp = Date.now()
    const draft: BoardDraft = { id: createUuid(), project, message, createdAt: timestamp, updatedAt: timestamp }
    workspace.upsertBoardDraft(draft)
    await workspace.flushPersistence()
    return draft
  }

  function draftConversation(draft: BoardDraft) {
    const owner = sessionFor(draft.runtimeId || draft.id)
    owner.cwd = draft.project
    if (!owner.started) void owner.loadOfflineModels()
    return owner
  }

  // Bind once a first prompt actually exists. Merely opening/completing a draft
  // may start a worker and reserve a filename, but must not consume the todo.
  watch(
    () =>
      allConversations().map(owner => ({
        id: owner.runtimeId,
        file: owner.sessionFile,
        project: owner.cwd,
        submitted: owner.isStreaming || owner.entries.some(entry => entry.kind === "user"),
      })),
    owners => {
      for (const draft of Object.values(workspace.boardDrafts ?? {})) {
        const owner = owners.find(owner => owner.id === (draft.runtimeId || draft.id))
        if (!owner?.file || !owner.submitted || draft.sessionFile === owner.file) continue
        workspace.upsertBoardDraft({
          ...draft,
          project: owner.project,
          sessionFile: owner.file,
          runtimeId: owner.id,
          updatedAt: Date.now(),
        })
      }
    },
  )

  return {
    projects,
    cards,
    selectedProject,
    loading,
    error,
    selection,
    selectedCard,
    selectedDraft,
    detailsOpen,
    refresh,
    createDraft,
    draftConversation,
  }
}
