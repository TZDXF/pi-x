<script setup lang="ts">
/** MCP settings: a single server list per scope (global / project). The list
 *  is the editor: cards render the parsed mcp.json; dialog save and delete
 *  persist immediately (unknown def fields preserved). Connection status and
 *  usage estimates come from useMcpStatus (see mcp/useMcpStatus.ts). If the
 *  file fails to parse, a raw JSON fallback with an explicit save button is
 *  the repair path (McpRawJsonEditor). */
import { computed, onMounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { Plus, RefreshCw } from "@lucide/vue"
import { getMcpConfig, saveMcpConfig, trustStatus, type McpScope, type TrustStatus } from "@/api/piClient"
import { formatCodedError } from "@/lib/backendError"
import { confirmDialog } from "@/lib/hostBridge"
import {
  mcpConfigTemplate,
  mcpEntryTransport,
  mcpServerEntries,
  removeMcpServer,
  serializeMcpDoc,
  upsertMcpServer,
  validateMcpJson,
  type McpJsonError,
  type McpJsonValidation,
} from "@/lib/mcpConfig"
import { useUiStore } from "@/stores/conversations"
import { Button } from "@/components/ui/button"
import McpServerEditor, { type McpServerSubmit } from "./mcp/McpServerEditor.vue"
import McpServerCard, { type McpServerListEntry } from "./mcp/McpServerCard.vue"
import McpToolsDialog from "./mcp/McpToolsDialog.vue"
import McpRawJsonEditor from "./mcp/McpRawJsonEditor.vue"
import { useMcpStatus } from "./mcp/useMcpStatus"

interface McpDraft {
  path: string
  exists: boolean
  content: string
  savedContent: string
}

const props = defineProps<{ project?: string }>()
const { t } = useI18n()
const ui = useUiStore()

const SCOPES = ["global", "project"] as const

const loading = ref(true)
const error = ref("")
const saving = ref(false)
const drafts = ref<Partial<Record<McpScope, McpDraft>>>({})
const activeScope = ref<McpScope>("global")
const validationError = ref<McpJsonError | null>(null)
const projectTrust = ref<TrustStatus | null>(null)

const dialogOpen = ref(false)
/** null = create; otherwise edit this server. */
const editingServer = ref<{ name: string; def: Record<string, unknown> } | null>(null)
/** Server whose full tool list the dialog shows. */
const toolsDialog = ref<{ name: string } | null>(null)

const active = computed(() => drafts.value[activeScope.value])
const dirty = computed(() => !!active.value && active.value.content !== active.value.savedContent)
const hasProject = computed(() => !!props.project)
const projectUntrusted = computed(
  () => activeScope.value === "project" && projectTrust.value != null && projectTrust.value.decision !== true,
)

/** Normalized parse for the list: a mcp.json that does not exist yet (empty
 *  content) is an empty document, not a validation error, so the server list
 *  shows the empty state and the first save creates the file. Real JSON
 *  errors still surface and switch to the raw-JSON repair view. */
function parsedDocument(content: string): McpJsonValidation {
  if (!content.trim()) return { ok: true, value: {} }
  return validateMcpJson(content)
}

/** Validated document backing the server list, with the live status and the
 *  normalized transport merged in so the template reads one entry object
 *  instead of re-resolving `statusFor(entry.name)!` per binding. */
const parsedDoc = computed(() => parsedDocument(active.value?.content ?? ""))
const serverList = computed<McpServerListEntry[]>(() => {
  if (!parsedDoc.value.ok) return []
  return mcpServerEntries(parsedDoc.value.value).map(entry => ({
    ...entry,
    transport: mcpEntryTransport(entry.def),
    status: statusFor(entry.name),
  }))
})

const {
  status,
  statusLoading,
  statusError,
  statusLoaded,
  refreshStatus,
  loadUsage,
  statusFor,
  usageFor,
  loadUsageFor,
  toolRowText,
} = useMcpStatus({
  project: () => props.project,
  scope: () => activeScope.value,
})

function fmt(e: unknown): string {
  return formatCodedError(t, e)
}

/** Shared styling of the amber notice bars (untrusted project / status note). */
const amberNoticeClass =
  "rounded-lg border border-amber-600/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"

async function loadScope(scope: McpScope) {
  const file = await getMcpConfig(scope, props.project)
  drafts.value[scope] = {
    path: file.path,
    exists: file.exists,
    // Offer a template for first-time creation instead of an empty buffer.
    content: file.content || mcpConfigTemplate(),
    savedContent: file.content,
  }
}

async function load() {
  loading.value = true
  error.value = ""
  validationError.value = null
  try {
    await loadScope("global")
    if (hasProject.value) await loadScope("project")
    if (!hasProject.value) drafts.value.project = undefined
    if (activeScope.value === "project" && !hasProject.value) activeScope.value = "global"
    if (hasProject.value) {
      projectTrust.value = await trustStatus(props.project!)
    } else {
      projectTrust.value = null
    }
  } catch (e) {
    error.value = fmt(e)
  } finally {
    loading.value = false
  }
  // Connection check runs on open, not on demand; errors surface inline.
  void refreshStatus()
  void loadUsage()
}

function onEdit(value: string | number) {
  if (!active.value) return
  active.value.content = String(value)
  // Live diagnostics; saving re-validates authoritatively.
  const result = validateMcpJson(active.value.content)
  validationError.value = result.ok ? null : result.error
}

/** Validate a candidate document, persist it to mcp.json (with the untrusted
 *  project confirmation) and only then adopt it into the draft. Returns true
 *  when the file was written. */
async function commitContent(content: string): Promise<boolean> {
  const draft = active.value
  if (!draft) return false
  const result = validateMcpJson(content)
  if (!result.ok) {
    validationError.value = result.error
    return false
  }
  validationError.value = null
  if (projectUntrusted.value) {
    const proceed = await confirmDialog(t("mcpConfig.untrustedSaveConfirm"), {
      title: t("mcpConfig.title"),
      okLabel: t("mcpConfig.save"),
      cancelLabel: t("common.cancel"),
    })
    if (!proceed) return false
  }
  saving.value = true
  try {
    await saveMcpConfig(activeScope.value, content, props.project)
    draft.content = content
    draft.savedContent = content
    draft.exists = true
    ui.pushToast(t("mcpConfig.saved"), "info")
    // The saved file changed: re-run the connection check so state and tools
    // in the list reflect it.
    void refreshStatus()
    return true
  } catch (e) {
    ui.pushToast(fmt(e), "error")
    return false
  } finally {
    saving.value = false
  }
}

/** Serialized mcpServers mutation of the current draft, or null when the
 *  draft is not valid JSON (the raw-JSON fallback is the repair path then). */
function mutatedContent(mutate: (doc: Record<string, unknown>) => Record<string, unknown>): string | null {
  const draft = active.value
  if (!draft) return null
  const result = parsedDocument(draft.content)
  if (!result.ok) {
    validationError.value = result.error
    return null
  }
  return serializeMcpDoc(mutate(result.value))
}

function openCreate() {
  editingServer.value = null
  dialogOpen.value = true
}

function openEdit(name: string, def: Record<string, unknown>) {
  editingServer.value = { name, def }
  dialogOpen.value = true
}

function openTools(name: string) {
  toolsDialog.value = { name }
}

async function onServerSubmit(payload: McpServerSubmit) {
  if (saving.value || !active.value) return
  const isCreate = editingServer.value == null
  // On rename, a conflict is a target name that exists and differs from the
  // original: saving would silently overwrite that other server otherwise.
  const nameConflict = serverList.value.some(
    entry => entry.name === payload.name && (isCreate || entry.name !== editingServer.value!.name),
  )
  if (nameConflict) {
    ui.pushToast(t("mcpConfig.editor.nameConflict", { name: payload.name }), "error")
    return
  }
  const previousName = isCreate ? null : editingServer.value!.name
  const next = mutatedContent(doc => {
    // Rename = remove the old entry (form fields were already applied to the def).
    const base = previousName && previousName !== payload.name ? removeMcpServer(doc, previousName) : doc
    return upsertMcpServer(base, payload.name, payload.def)
  })
  // The dialog stays open on failure so nothing is lost; success closes it.
  if (next != null && (await commitContent(next))) dialogOpen.value = false
}

async function deleteServer(name: string) {
  if (saving.value) return
  const proceed = await confirmDialog(t("mcpConfig.deleteConfirm", { name }), {
    title: t("mcpConfig.title"),
    okLabel: t("mcpConfig.delete"),
    cancelLabel: t("common.cancel"),
  })
  if (!proceed) return
  const next = mutatedContent(doc => removeMcpServer(doc, name))
  if (next != null) await commitContent(next)
}

async function save() {
  const draft = active.value
  if (!draft || saving.value) return
  await commitContent(draft.content)
}

watch(
  () => props.project,
  () => {
    void load()
  },
)
onMounted(load)
</script>

<template>
  <header class="flex flex-col gap-2 text-left">
    <h2 class="text-base leading-none font-medium">{{ t("mcpConfig.title") }}</h2>
  </header>
  <p v-if="loading" class="text-sm text-muted-foreground">{{ t("agentConfig.loading") }}</p>
  <div v-else-if="error" role="alert" class="space-y-3">
    <p class="text-sm text-destructive">{{ error }}</p>
    <Button variant="outline" @click="load">{{ t("agentConfig.retry") }}</Button>
  </div>
  <div v-else class="min-w-0 space-y-6">
    <section class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap gap-2">
          <Button
            v-for="scope in SCOPES"
            :key="scope"
            variant="outline"
            size="sm"
            :disabled="scope === 'project' && !hasProject"
            :aria-pressed="activeScope === scope"
            @click="activeScope = scope"
          >
            {{ t(scope === "global" ? "mcpConfig.scope.global" : "mcpConfig.scope.project") }}
          </Button>
        </div>
        <Button variant="outline" size="sm" :disabled="statusLoading" @click="refreshStatus">
          <RefreshCw :size="14" class="mr-1" :class="{ 'animate-spin': statusLoading }" />
          {{ t(statusLoading ? "mcpConfig.refreshing" : "mcpConfig.refresh") }}
        </Button>
      </div>
      <p v-if="!hasProject" class="text-xs text-muted-foreground">{{ t("mcpConfig.projectRequired") }}</p>
      <div v-else-if="projectUntrusted" role="status" :class="amberNoticeClass">
        {{ t("mcpConfig.untrustedWarning") }}
      </div>
      <template v-if="active">
        <div class="flex flex-wrap items-center gap-2">
          <span class="break-all font-mono text-xs text-muted-foreground">{{ active.path }}</span>
          <span class="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {{ t(active.exists ? "mcpConfig.exists" : "mcpConfig.missing") }}
          </span>
        </div>

        <template v-if="parsedDoc.ok">
          <p v-if="statusError" role="alert" class="text-sm text-destructive">{{ statusError }}</p>
          <div v-if="statusLoaded && status?.note" role="status" :class="amberNoticeClass">
            {{ t("mcpConfig.untrustedNote") }}
          </div>
          <div
            v-if="statusLoaded && status && !status.ok"
            role="status"
            class="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {{ t("mcpConfig.statusFailed") }}
          </div>
          <ul v-if="statusLoaded && status?.errors.length" class="space-y-1">
            <li v-for="(message, i) in status.errors" :key="i" class="font-mono text-xs text-destructive">
              {{ t("mcpConfig.configError", { message }) }}
            </li>
          </ul>
          <p v-if="statusLoading && !statusLoaded" role="status" class="text-xs text-muted-foreground">
            {{ t("mcpConfig.refreshing") }}
          </p>
          <div class="flex justify-end">
            <Button size="sm" class="gap-1" @click="openCreate">
              <Plus :size="14" />
              {{ t("mcpConfig.addServer") }}
            </Button>
          </div>
          <p v-if="!serverList.length" class="text-sm text-muted-foreground">{{ t("mcpConfig.listEmpty") }}</p>
          <McpServerCard
            v-for="entry in serverList"
            :key="entry.name"
            :entry="entry"
            :load="loadUsageFor(entry.name)"
            :usage="usageFor(entry.name)"
            @edit="openEdit(entry.name, entry.def)"
            @delete="deleteServer(entry.name)"
            @open-tools="openTools(entry.name)"
          />
        </template>

        <McpRawJsonEditor
          v-else
          :content="active.content"
          :saving="saving"
          :dirty="dirty"
          :parse-error="parsedDoc.error"
          :validation-error="validationError"
          @update="onEdit"
          @save="save"
        />
      </template>
    </section>
  </div>

  <McpServerEditor v-model:open="dialogOpen" :server="editingServer" :saving="saving" @submit="onServerSubmit" />

  <McpToolsDialog
    :name="toolsDialog?.name ?? null"
    :tools="statusFor(toolsDialog?.name ?? '')?.tools ?? []"
    :row-text="tool => toolRowText(toolsDialog?.name ?? '', tool)"
    @close="toolsDialog = null"
  />
</template>
