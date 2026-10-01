<script setup lang="ts">
/** MCP settings: a single server list per scope (global / project). The list
 *  is the editor: cards render the parsed mcp.json; dialog save and delete
 *  persist immediately (unknown def fields preserved). Connection status
 *  (state, tools, error) comes from `pi mcp list --json`, fetched
 *  automatically on mount and refreshed after every config change — there is
 *  no manual per-server check. If the file fails to parse, a raw JSON
 *  fallback with an explicit save button is the repair path. */
import { computed, onMounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { Pencil, Plus, RefreshCw, Trash2 } from "@lucide/vue"
import { ask } from "@tauri-apps/plugin-dialog"
import {
  getMcpConfig,
  getMcpStatus,
  saveMcpConfig,
  trustStatus,
  type McpScope,
  type McpServerStatus,
  type McpStatusResult,
  type TrustStatus,
} from "@/api/piClient"
import { formatCodedError } from "@/lib/backendError"
import {
  mcpConfigTemplate,
  mcpEntryTransport,
  mcpServerEntries,
  mcpStateLabelKey,
  removeMcpServer,
  serializeMcpDoc,
  upsertMcpServer,
  validateMcpJson,
  type McpJsonError,
  type McpJsonValidation,
} from "@/lib/mcpConfig"
import { useUiStore } from "@/stores/conversations"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import McpServerEditor, { type McpServerSubmit } from "./mcp/McpServerEditor.vue"

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

const status = ref<McpStatusResult | null>(null)
const statusLoading = ref(false)
const statusError = ref("")
const statusLoaded = ref(false)

const dialogOpen = ref(false)
/** null = create; otherwise edit this server. */
const editingServer = ref<{ name: string; def: Record<string, unknown> } | null>(null)

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

/** Validated document backing the server list. */
const parsedDoc = computed(() => parsedDocument(active.value?.content ?? ""))
const serverList = computed(() => (parsedDoc.value.ok ? mcpServerEntries(parsedDoc.value.value) : []))

/** Live status reports keyed by "scope:name" — status covers both scopes. */
const statusByKey = computed(() => {
  const map = new Map<string, McpServerStatus>()
  for (const server of status.value?.servers ?? []) map.set(`${server.scope}:${server.name}`, server)
  return map
})

function statusFor(name: string): McpServerStatus | undefined {
  return statusByKey.value.get(`${activeScope.value}:${name}`)
}

function fmt(e: unknown): string {
  return formatCodedError(t, e)
}

function stateBadgeClass(state: string): string {
  if (state === "connected") return "text-green-600 dark:text-green-400"
  if (state === "failed" || state === "disconnected" || state === "closed") return "text-destructive"
  if (state === "needs-auth") return "text-amber-600 dark:text-amber-400"
  return ""
}

function validationText(e: McpJsonError): string {
  if (e.kind === "parse") {
    const pos = e.line != null ? t("mcpConfig.errorAt", { line: e.line, column: e.column ?? 1 }) : ""
    return `${t("mcpConfig.errors.parse")} ${pos} ${e.message ?? ""}`.trim()
  }
  return t(`mcpConfig.errors.${e.kind}`)
}

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
    const proceed = await ask(t("mcpConfig.untrustedSaveConfirm"), {
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
  const proceed = await ask(t("mcpConfig.deleteConfirm", { name }), {
    title: t("mcpConfig.title"),
    okLabel: t("mcpConfig.delete"),
    cancelLabel: t("common.cancel"),
  })
  if (!proceed) return
  const next = mutatedContent(doc => removeMcpServer(doc, name))
  if (next != null) await commitContent(next)
}

function endpointSummary(def: Record<string, unknown>): string {
  const transport = mcpEntryTransport(def)
  if (transport === "http") return String(def.url ?? "")
  if (transport === "stdio") {
    const args = Array.isArray(def.args) ? def.args.map(String).join(" ") : ""
    return [def.command, args].filter(Boolean).join(" ")
  }
  return JSON.stringify(def)
}

function isServerDisabled(def: Record<string, unknown>): boolean {
  return def.enabled === false
}

async function save() {
  const draft = active.value
  if (!draft || saving.value) return
  await commitContent(draft.content)
}

async function refreshStatus() {
  if (statusLoading.value) return
  statusLoading.value = true
  statusError.value = ""
  try {
    status.value = await getMcpStatus(props.project)
    statusLoaded.value = true
  } catch (e) {
    statusError.value = fmt(e)
  } finally {
    statusLoading.value = false
  }
}

function stateLabel(server: McpServerStatus): string {
  const label = mcpStateLabelKey(server.enabled ? server.state : "disabled")
  return label.raw ? t(label.key, { state: label.raw }) : t(label.key)
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
      <div
        v-else-if="projectUntrusted"
        role="status"
        class="rounded-lg border border-amber-600/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
      >
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
          <div
            v-if="statusLoaded && status?.note"
            role="status"
            class="rounded-lg border border-amber-600/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
          >
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
          <div v-for="entry in serverList" :key="entry.name" class="rounded-lg border p-3">
            <div class="flex flex-wrap items-center gap-2">
              <p class="text-sm font-medium">{{ entry.name }}</p>
              <Badge v-if="mcpEntryTransport(entry.def) === 'http'" variant="secondary">
                {{ t("mcpConfig.editor.transports.http") }}
              </Badge>
              <Badge v-else-if="mcpEntryTransport(entry.def) === 'stdio'" variant="secondary">
                {{ t("mcpConfig.editor.transports.stdio") }}
              </Badge>
              <Badge v-if="isServerDisabled(entry.def)" variant="outline" class="text-muted-foreground">
                {{ t("mcpConfig.state.disabled") }}
              </Badge>
              <span
                v-if="mcpEntryTransport(entry.def) === 'unknown'"
                class="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground"
              >
                {{ t("mcpConfig.unknownShape") }}
              </span>
              <template v-if="statusFor(entry.name)">
                <Badge
                  variant="outline"
                  :class="stateBadgeClass(statusFor(entry.name)!.enabled ? statusFor(entry.name)!.state : 'disabled')"
                >
                  {{ stateLabel(statusFor(entry.name)!) }}
                </Badge>
                <span class="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {{ t("mcpConfig.exposure") }}: {{ statusFor(entry.name)!.exposure }}
                </span>
              </template>
              <span class="ml-auto flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-7 w-7 text-muted-foreground hover:text-foreground"
                  :aria-label="t('mcpConfig.edit')"
                  :title="t('mcpConfig.edit')"
                  @click="openEdit(entry.name, entry.def)"
                >
                  <Pencil :size="14" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-7 w-7 text-muted-foreground hover:text-destructive"
                  :aria-label="t('mcpConfig.delete')"
                  :title="t('mcpConfig.delete')"
                  @click="deleteServer(entry.name)"
                >
                  <Trash2 :size="14" />
                </Button>
              </span>
            </div>
            <p class="mt-1 break-all font-mono text-xs text-muted-foreground">
              {{ endpointSummary(entry.def) }}
            </p>
            <div v-if="statusFor(entry.name)?.tools.length" class="mt-2 flex flex-wrap gap-1">
              <Badge
                v-for="tool in statusFor(entry.name)!.tools"
                :key="tool"
                variant="secondary"
                class="font-mono text-xs font-normal"
              >
                {{ tool }}
              </Badge>
            </div>
            <pre
              v-if="statusFor(entry.name)?.error"
              class="mt-2 max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap text-destructive"
              >{{ statusFor(entry.name)!.error }}</pre>
          </div>
        </template>

        <!-- Repair path for a mcp.json that no longer parses: raw JSON with
             an explicit save; the list view cannot render it. -->
        <template v-else>
          <p role="alert" class="text-sm text-destructive">{{ validationText(parsedDoc.error) }}</p>
          <Textarea
            :model-value="active.content"
            class="min-h-64 font-mono text-sm"
            spellcheck="false"
            aria-describedby="mcp-json-validation"
            @update:model-value="onEdit"
          />
          <p v-if="validationError" id="mcp-json-validation" role="alert" class="text-sm text-destructive">
            {{ validationText(validationError) }}
          </p>
          <div class="flex items-center gap-3">
            <Button :disabled="saving || !dirty || !!validationError" @click="save">{{
              t(saving ? "mcpConfig.saving" : "mcpConfig.save")
            }}</Button>
            <span v-if="dirty" class="text-xs text-muted-foreground">{{ t("mcpConfig.unsaved") }}</span>
          </div>
        </template>
      </template>
    </section>
  </div>

  <McpServerEditor v-model:open="dialogOpen" :server="editingServer" :saving="saving" @submit="onServerSubmit" />
</template>
