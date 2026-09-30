<script setup lang="ts">
/** MCP settings: status overview (via `pi mcp list --json`, manual refresh
 *  only — connecting to every server can be slow) plus a raw-text editor for
 *  the global and the current project's mcp.json. */
import { computed, onMounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { RefreshCw } from "@lucide/vue"
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
import { mcpConfigTemplate, mcpStateLabelKey, validateMcpJson, type McpJsonError } from "@/lib/mcpConfig"
import { useUiStore } from "@/stores/conversations"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

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

const active = computed(() => drafts.value[activeScope.value])
const dirty = computed(() => !!active.value && active.value.content !== active.value.savedContent)
const hasProject = computed(() => !!props.project)
const projectUntrusted = computed(
  () => activeScope.value === "project" && projectTrust.value != null && projectTrust.value.decision !== true,
)

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
}

function onEdit(value: string | number) {
  if (!active.value) return
  active.value.content = String(value)
  // Live diagnostics; saving re-validates authoritatively.
  const result = validateMcpJson(active.value.content)
  validationError.value = result.ok ? null : result.error
}

async function save() {
  const draft = active.value
  if (!draft || saving.value) return
  const result = validateMcpJson(draft.content)
  if (!result.ok) {
    validationError.value = result.error
    return
  }
  validationError.value = null
  if (projectUntrusted.value) {
    const proceed = await ask(t("mcpConfig.untrustedSaveConfirm"), {
      title: t("mcpConfig.title"),
      okLabel: t("mcpConfig.save"),
      cancelLabel: t("common.cancel"),
    })
    if (!proceed) return
  }
  saving.value = true
  try {
    await saveMcpConfig(activeScope.value, draft.content, props.project)
    draft.savedContent = draft.content
    draft.exists = true
    ui.pushToast(t("mcpConfig.saved"), "info")
  } catch (e) {
    ui.pushToast(fmt(e), "error")
  } finally {
    saving.value = false
  }
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
        <h3 class="text-sm font-medium">{{ t("mcpConfig.statusTitle") }}</h3>
        <Button variant="outline" size="sm" :disabled="statusLoading" @click="refreshStatus">
          <RefreshCw :size="14" class="mr-1" :class="{ 'animate-spin': statusLoading }" />
          {{ t(statusLoading ? "mcpConfig.refreshing" : "mcpConfig.refresh") }}
        </Button>
      </div>
      <p class="text-xs text-muted-foreground">{{ t("mcpConfig.statusDesc") }}</p>
      <p v-if="statusError" role="alert" class="text-sm text-destructive">{{ statusError }}</p>
      <template v-if="statusLoaded && status">
        <div
          v-if="status.note"
          role="status"
          class="rounded-lg border border-amber-600/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
        >
          {{ t("mcpConfig.untrustedNote") }}
        </div>
        <div
          v-if="!status.ok"
          role="status"
          class="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {{ t("mcpConfig.statusFailed") }}
        </div>
        <ul v-if="status.errors.length" class="space-y-1">
          <li v-for="(message, i) in status.errors" :key="i" class="font-mono text-xs text-destructive">
            {{ t("mcpConfig.configError", { message }) }}
          </li>
        </ul>
        <p v-if="!status.servers.length" class="text-sm text-muted-foreground">{{ t("mcpConfig.statusEmpty") }}</p>
        <div v-for="server in status.servers" :key="`${server.scope}:${server.name}`" class="rounded-lg border p-3">
          <div class="flex flex-wrap items-center gap-2">
            <p class="text-sm font-medium">{{ server.name }}</p>
            <Badge variant="secondary">{{ t(`mcpConfig.scope.${server.scope}`) }}</Badge>
            <Badge variant="outline" :class="stateBadgeClass(server.enabled ? server.state : 'disabled')">
              {{ stateLabel(server) }}
            </Badge>
            <span class="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {{ t("mcpConfig.exposure") }}: {{ server.exposure }}
            </span>
            <span v-if="server.tools.length" class="text-xs text-muted-foreground">
              {{ t("mcpConfig.toolsCount", { count: server.tools.length }) }}
            </span>
          </div>
          <p class="mt-1 break-all font-mono text-xs text-muted-foreground">{{ server.transport }}</p>
          <pre
            v-if="server.error"
            class="mt-2 max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap text-destructive"
            >{{ server.error }}</pre
          >
        </div>
      </template>
    </section>

    <section class="space-y-3">
      <h3 class="text-sm font-medium">{{ t("mcpConfig.editorTitle") }}</h3>
      <div class="flex flex-wrap gap-2" role="tablist">
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
    </section>
  </div>
</template>
