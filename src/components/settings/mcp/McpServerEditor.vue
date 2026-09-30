<script setup lang="ts">
/** MCP server create/edit dialog: form controls for the common fields
 *  (transport, command/args/env/cwd or url/headers, enabled) plus a JSON mode
 *  for pasting full definitions; unknown def fields survive a round trip.
 *  The parent owns the document — this dialog only validates and emits
 *  submit({ name, def }). */
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  applyMcpForm,
  mcpEntryTransport,
  mcpFormError,
  mcpFormFromDef,
  mcpServerNameValid,
  parseMcpEntryJson,
  type McpServerForm,
} from "@/lib/mcpConfig"
import McpRowsEditor, { type McpRow } from "./McpRowsEditor.vue"
import { nextMcpRowId } from "./rowIds"

export interface McpServerSubmit {
  name: string
  def: Record<string, unknown>
}

const props = defineProps<{
  open: boolean
  /** null = create; otherwise edit this server (def may carry unknown fields). */
  server: { name: string; def: Record<string, unknown> } | null
  /** True while the parent persists the submission to mcp.json. */
  saving?: boolean
}>()

const emit = defineEmits<{
  "update:open": [value: boolean]
  submit: [payload: McpServerSubmit]
}>()

const { t } = useI18n()

// Example JSON is code, not copy — vue-i18n treats literal {} as interpolation.
const JSON_EXAMPLE = `{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem"]
  }
}`

type Mode = "form" | "json"

const mode = ref<Mode>("form")
const name = ref("")
const form = ref<McpServerForm>(mcpFormFromDef({}))
/** Raw def the form edits on top of; unknown fields survive via applyMcpForm. */
const baseDef = ref<Record<string, unknown>>({})
const jsonText = ref("")
const jsonSnapshot = ref("")
const jsonError = ref("")
const nameError = ref("")

const argRows = ref<McpRow[]>([])
const envRows = ref<McpRow[]>([])
const headerRows = ref<McpRow[]>([])

function rowsFromArgs(args: string[]): McpRow[] {
  return args.map((value) => ({ id: nextMcpRowId(), key: "", value }))
}

function rowsFromMap(map: Record<string, string>): McpRow[] {
  return Object.entries(map).map(([key, value]) => ({ id: nextMcpRowId(), key, value }))
}

function argsFromRows(rows: McpRow[]): string[] {
  return rows.map((row) => row.value.trim()).filter(Boolean)
}

/** Empty keys are dropped, duplicate keys: last row wins. */
function mapFromRows(rows: McpRow[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (key) map[key] = row.value.trim()
  }
  return map
}

function loadForm(def: Record<string, unknown>) {
  form.value = mcpFormFromDef(def)
  argRows.value = rowsFromArgs(form.value.args)
  envRows.value = rowsFromMap(form.value.env)
  headerRows.value = rowsFromMap(form.value.headers)
}

watch(
  () => [props.open, props.server] as const,
  ([open]) => {
    if (!open) return
    const server = props.server
    mode.value = "form"
    name.value = server?.name ?? ""
    nameError.value = ""
    jsonError.value = ""
    jsonText.value = ""
    jsonSnapshot.value = ""
    baseDef.value = server ? { ...server.def } : {}
    loadForm(baseDef.value)
  },
)

/** The form as currently edited, with args/env/header rows folded in. */
function currentForm(): McpServerForm {
  return {
    ...form.value,
    args: argsFromRows(argRows.value),
    env: mapFromRows(envRows.value),
    headers: mapFromRows(headerRows.value),
  }
}

/** The definition the form currently describes, or "" when it is still empty
 *  (keeps JSON mode blank so pasting does not merge into a stale skeleton). */
function serializeDefinition(): string {
  const def = applyMcpForm(baseDef.value, currentForm())
  const hasContent =
    form.value.transport === "stdio"
      ? !!def.command
      : typeof def.url === "string" && !!def.url.trim()
  return hasContent ? JSON.stringify(def, null, 2) : ""
}

const urlInvalid = computed(() => mcpFormError(form.value) === "urlInvalid")
const formError = computed(() => mcpFormError(form.value))
const saveDisabled = computed(() => {
  if (mode.value === "json") return !jsonText.value.trim()
  // A stale name error only blocks saving while the name is still filled in;
  // an empty name is caught by checkName on submit.
  return !!formError.value || (!!nameError.value && !!name.value.trim())
})

function checkName(): boolean {
  const value = name.value.trim()
  if (!value) {
    nameError.value = "nameRequired"
    return false
  }
  if (!mcpServerNameValid(value)) {
    nameError.value = "nameInvalid"
    return false
  }
  nameError.value = ""
  return true
}

function switchMode(next: Mode) {
  if (next === mode.value) return
  if (next === "json") {
    jsonSnapshot.value = serializeDefinition()
    jsonText.value = jsonSnapshot.value
    jsonError.value = ""
    mode.value = "json"
    return
  }
  // Unedited JSON switches straight back; a parsed-but-failed edit stays in
  // JSON mode so nothing is silently dropped.
  if (jsonText.value.trim() === jsonSnapshot.value.trim()) {
    mode.value = "form"
    return
  }
  const parsed = parseMcpEntryJson(jsonText.value, name.value)
  if (!parsed.ok) {
    jsonError.value = t(`mcpConfig.editor.jsonErrors.${parsed.error}`)
    return
  }
  name.value = parsed.name
  baseDef.value = parsed.def
  loadForm(parsed.def)
  jsonError.value = ""
  mode.value = "form"
}

function submit() {
  if (saveDisabled.value) return
  if (!checkName()) return
  if (mode.value === "json") {
    const parsed = parseMcpEntryJson(jsonText.value, name.value)
    if (!parsed.ok) {
      jsonError.value = t(`mcpConfig.editor.jsonErrors.${parsed.error}`)
      return
    }
    const finalName = parsed.name || name.value.trim()
    if (!mcpServerNameValid(finalName)) {
      nameError.value = "nameInvalid"
      return
    }
    // Legacy "sse" and shapeless defs are rejected: pi cannot load them.
    if (mcpEntryTransport(parsed.def) === "unknown") {
      jsonError.value = t("mcpConfig.editor.jsonErrors.unsupported")
      return
    }
    emit("submit", { name: finalName, def: parsed.def })
    return
  }
  const error = mcpFormError(form.value)
  if (error) return
  emit("submit", { name: name.value.trim(), def: applyMcpForm(baseDef.value, currentForm()) })
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>
          {{ server ? t("mcpConfig.editor.editTitle") : t("mcpConfig.editor.createTitle") }}
        </DialogTitle>
        <DialogDescription>{{ t("mcpConfig.editor.dialogDesc") }}</DialogDescription>
      </DialogHeader>

      <div class="flex flex-col gap-3 py-1">
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground" for="mcp-server-name">{{
            t("mcpConfig.editor.nameLabel")
          }}</label>
          <Input
            id="mcp-server-name"
            v-model="name"
            class="h-8 text-xs"
            :placeholder="t('mcpConfig.editor.namePlaceholder')"
            :aria-invalid="!!nameError || undefined"
            spellcheck="false"
            @blur="name.trim() ? checkName() : (nameError = '')"
          />
          <p v-if="nameError" class="text-xs text-destructive">
            {{ t(`mcpConfig.editor.errors.${nameError}`) }}
          </p>
        </div>

        <div class="flex items-center justify-between gap-2">
          <label class="text-xs text-muted-foreground">{{ t("mcpConfig.editor.modeLabel") }}</label>
          <div class="flex rounded-md border p-0.5">
            <button
              v-for="item in (['form', 'json'] as const)"
              :key="item"
              type="button"
              :aria-pressed="mode === item"
              class="rounded-sm px-2 py-0.5 text-xs transition-colors"
              :class="
                mode === item
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              "
              @click="switchMode(item)"
            >
              {{ t(`mcpConfig.editor.mode.${item}`) }}
            </button>
          </div>
        </div>

        <template v-if="mode === 'form'">
          <div class="flex flex-col gap-1">
            <label class="text-xs text-muted-foreground" for="mcp-server-transport">{{
              t("mcpConfig.editor.transportLabel")
            }}</label>
            <Select v-model="form.transport">
              <SelectTrigger id="mcp-server-transport" class="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem v-for="kind in (['stdio', 'http'] as const)" :key="kind" :value="kind">
                    {{ t(`mcpConfig.editor.transports.${kind}`) }}
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <p class="text-[11px] text-muted-foreground">
              {{ t(`mcpConfig.editor.transportHint.${form.transport}`) }}
            </p>
          </div>

          <template v-if="form.transport === 'stdio'">
            <div class="flex flex-col gap-1">
              <label class="text-xs text-muted-foreground" for="mcp-server-command">{{
                t("mcpConfig.editor.commandLabel")
              }}</label>
              <Input
                id="mcp-server-command"
                v-model="form.command"
                class="h-8 font-mono text-xs"
                :placeholder="t('mcpConfig.editor.commandPlaceholder')"
                spellcheck="false"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-xs text-muted-foreground">{{ t("mcpConfig.editor.argsLabel") }}</label>
              <McpRowsEditor
                :rows="argRows"
                single
                :add-label="t('mcpConfig.editor.addArg')"
                :value-placeholder="t('mcpConfig.editor.argPlaceholder')"
                @update:rows="argRows = $event"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-xs text-muted-foreground">{{ t("mcpConfig.editor.envLabel") }}</label>
              <McpRowsEditor
                :rows="envRows"
                :add-label="t('mcpConfig.editor.addEnv')"
                :key-placeholder="t('mcpConfig.editor.envKeyPlaceholder')"
                :value-placeholder="t('mcpConfig.editor.envValuePlaceholder')"
                @update:rows="envRows = $event"
              />
            </div>
            <div class="flex flex-col gap-1">
              <label class="text-xs text-muted-foreground" for="mcp-server-cwd">{{
                t("mcpConfig.editor.cwdLabel")
              }}</label>
              <Input
                id="mcp-server-cwd"
                v-model="form.cwd"
                class="h-8 font-mono text-xs"
                :placeholder="t('mcpConfig.editor.cwdPlaceholder')"
                spellcheck="false"
              />
            </div>
          </template>

          <template v-else>
            <div class="flex flex-col gap-1">
              <label class="text-xs text-muted-foreground" for="mcp-server-url">{{
                t("mcpConfig.editor.urlLabel")
              }}</label>
              <Input
                id="mcp-server-url"
                v-model="form.url"
                class="h-8 font-mono text-xs"
                :placeholder="t('mcpConfig.editor.urlPlaceholder')"
                :aria-invalid="urlInvalid || undefined"
                spellcheck="false"
              />
              <p v-if="urlInvalid" class="text-xs text-destructive">
                {{ t("mcpConfig.editor.errors.urlInvalid") }}
              </p>
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-xs text-muted-foreground">{{ t("mcpConfig.editor.headersLabel") }}</label>
              <McpRowsEditor
                :rows="headerRows"
                :add-label="t('mcpConfig.editor.addHeader')"
                :key-placeholder="t('mcpConfig.editor.headerKeyPlaceholder')"
                :value-placeholder="t('mcpConfig.editor.headerValuePlaceholder')"
                @update:rows="headerRows = $event"
              />
            </div>
          </template>

          <div class="flex items-center justify-between gap-2">
            <label class="text-xs text-muted-foreground" for="mcp-server-enabled">{{
              t("mcpConfig.editor.enabledLabel")
            }}</label>
            <Switch
              id="mcp-server-enabled"
              :model-value="form.enabled !== false"
              @update:model-value="form.enabled = $event === false ? false : undefined"
            />
          </div>
        </template>

        <template v-else>
          <div class="flex flex-col gap-1">
            <label class="text-xs text-muted-foreground" for="mcp-server-json">{{
              t("mcpConfig.editor.jsonLabel")
            }}</label>
            <Textarea
              id="mcp-server-json"
              v-model="jsonText"
              rows="10"
              spellcheck="false"
              class="resize-y font-mono text-xs"
              :placeholder="JSON_EXAMPLE"
              :aria-invalid="!!jsonError || undefined"
            />
            <p v-if="jsonError" role="alert" class="text-xs text-destructive">{{ jsonError }}</p>
            <p v-else class="text-[11px] text-muted-foreground">{{ t("mcpConfig.editor.jsonHint") }}</p>
          </div>
        </template>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="saving" @click="emit('update:open', false)">
          {{ t("common.cancel") }}
        </Button>
        <Button :disabled="saveDisabled || saving" @click="submit">{{ t("mcpConfig.save") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
