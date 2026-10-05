<script setup lang="ts">
/** SSH 连接管理（契约 §2）：连接列表、新增/编辑/删除与连接测试（probe）。 */
import { onMounted, reactive, ref } from "vue"
import { useI18n } from "vue-i18n"
import { LoaderCircle, Pencil, PlugZap, Plus, Trash2 } from "@lucide/vue"
import { isDesktop } from "@/api/transport"
import {
  sshConnectionDelete,
  sshConnectionList,
  sshConnectionProbe,
  sshConnectionSave,
  sshProbeTarget,
  type SshConnection,
  type SshProbeResult,
} from "@/api/piClient"
import { tBackendError } from "@/i18n"
import { useUiStore } from "@/stores/conversations"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

const { t } = useI18n()
const ui = useUiStore()

const connections = ref<SshConnection[]>([])
const loading = ref(false)
const busyIds = ref(new Set<string>())
const probes = ref<Record<string, SshProbeResult>>({})

const dialogOpen = ref(false)
const editingId = ref<string | null>(null)
const saving = ref(false)
const probingForm = ref(false)
const formProbe = ref<SshProbeResult | null>(null)
const formError = ref("")
const form = reactive({ name: "", host: "", port: "22", user: "", keyPath: "" })

onMounted(load)

async function load() {
  if (!isDesktop) return
  loading.value = true
  try {
    connections.value = await sshConnectionList()
  } catch (e) {
    ui.pushToast(tBackendError(e), "error")
  } finally {
    loading.value = false
  }
}

function hostLabel(connection: SshConnection) {
  const authority = connection.user ? `${connection.user}@${connection.host}` : connection.host
  return connection.port === 22 ? authority : `${authority}:${connection.port}`
}

function openCreate() {
  editingId.value = null
  Object.assign(form, { name: "", host: "", port: "22", user: "", keyPath: "" })
  formProbe.value = null
  formError.value = ""
  dialogOpen.value = true
}

function openEdit(connection: SshConnection) {
  editingId.value = connection.id
  Object.assign(form, {
    name: connection.name,
    host: connection.host,
    port: String(connection.port),
    user: connection.user ?? "",
    keyPath: connection.keyPath ?? "",
  })
  formProbe.value = null
  formError.value = ""
  dialogOpen.value = true
}

/** 表单可用时的目标参数；非法返回 null 并写 formError。 */
function formTarget() {
  const host = form.host.trim()
  const name = form.name.trim()
  const port = Number(form.port)
  if (!name) formError.value = t("ssh.nameRequired")
  else if (!host) formError.value = t("ssh.hostRequired")
  else if (!Number.isInteger(port) || port < 1 || port > 65535) formError.value = t("ssh.portInvalid")
  else
    return {
      id: editingId.value ?? undefined,
      name,
      host,
      port,
      user: form.user.trim() || null,
      keyPath: form.keyPath.trim() || null,
    }
  return null
}

async function testForm() {
  const target = formTarget()
  if (!target) return
  probingForm.value = true
  formProbe.value = null
  try {
    formProbe.value = await sshProbeTarget({
      host: target.host,
      port: target.port,
      user: target.user,
      keyPath: target.keyPath,
    })
  } catch (e) {
    ui.pushToast(tBackendError(e), "error")
  } finally {
    probingForm.value = false
  }
}

async function save() {
  const target = formTarget()
  if (!target) return
  saving.value = true
  formError.value = ""
  try {
    await sshConnectionSave(target)
    dialogOpen.value = false
    ui.pushToast(t("ssh.saved"), "info")
    await load()
  } catch (e) {
    formError.value = tBackendError(e)
  } finally {
    saving.value = false
  }
}

async function remove(connection: SshConnection) {
  if (busyIds.value.has(connection.id)) return
  busyIds.value.add(connection.id)
  try {
    await sshConnectionDelete(connection.id)
    await load()
  } catch (e) {
    ui.pushToast(tBackendError(e), "error")
  } finally {
    busyIds.value.delete(connection.id)
  }
}

async function probe(connection: SshConnection) {
  if (busyIds.value.has(connection.id)) return
  busyIds.value.add(connection.id)
  try {
    probes.value = { ...probes.value, [connection.id]: await sshConnectionProbe(connection.id) }
  } catch (e) {
    ui.pushToast(tBackendError(e), "error")
  } finally {
    busyIds.value.delete(connection.id)
  }
}

function probeLines(info: {
  uname: string | null
  arch: string | null
  nodeVersion: string | null
  piVersion: string | null
}): string[] {
  const lines: string[] = []
  if (info.uname) lines.push(info.arch ? `${info.uname} (${info.arch})` : info.uname)
  if (info.nodeVersion) lines.push(`node ${info.nodeVersion}`)
  if (info.piVersion) lines.push(`pi ${info.piVersion}`)
  return lines
}
</script>

<template>
  <template v-if="isDesktop">
    <div class="space-y-5">
      <div class="flex items-center justify-between gap-3">
        <p class="text-xs text-muted-foreground">{{ t("ssh.connectionsHint") }}</p>
        <Button size="sm" class="shrink-0" @click="openCreate"><Plus :size="15" />{{ t("ssh.addConnection") }}</Button>
      </div>

      <p v-if="loading" class="text-sm text-muted-foreground">{{ t("ssh.loading") }}</p>
      <p
        v-else-if="!connections.length"
        class="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground"
      >
        {{ t("ssh.empty") }}
      </p>

      <ul v-else class="[list-style:none] m-0 p-0 space-y-2">
        <li v-for="connection in connections" :key="connection.id" class="rounded-xl border border-border p-4">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-sm font-medium">{{ connection.name }}</span>
            <span class="text-muted-foreground font-mono text-xs">{{ hostLabel(connection) }}</span>
            <span
              v-if="probes[connection.id]"
              class="ms-auto rounded-full px-2 py-0.5 text-xs"
              :class="
                probes[connection.id]!.ok
                  ? 'bg-green-500/15 text-green-700 dark:text-green-400'
                  : 'bg-red-500/15 text-red-700 dark:text-red-400'
              "
            >
              {{ probes[connection.id]!.ok ? t("ssh.probeOk") : t("ssh.probeFailed") }}
            </span>
            <div class="ms-auto flex items-center gap-1" :class="{ 'ms-0': probes[connection.id] }">
              <Button
                variant="ghost"
                size="icon-sm"
                :disabled="busyIds.has(connection.id)"
                :title="t('ssh.probe')"
                :aria-label="`${t('ssh.probe')} · ${connection.name}`"
                @click="probe(connection)"
              >
                <LoaderCircle v-if="busyIds.has(connection.id)" :size="15" class="animate-spin" />
                <PlugZap v-else :size="15" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                :title="t('ssh.edit')"
                :aria-label="`${t('ssh.edit')} · ${connection.name}`"
                @click="openEdit(connection)"
              >
                <Pencil :size="15" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                class="text-destructive"
                :disabled="busyIds.has(connection.id)"
                :title="t('ssh.delete')"
                :aria-label="`${t('ssh.delete')} · ${connection.name}`"
                @click="remove(connection)"
              >
                <Trash2 :size="15" />
              </Button>
            </div>
          </div>
          <p v-if="connection.keyPath" class="mt-1 text-muted-foreground truncate font-mono text-xs">
            {{ connection.keyPath }}
          </p>
          <p v-if="probes[connection.id]?.ok" class="mt-1 text-xs text-muted-foreground">
            {{ probeLines(probes[connection.id]!).join(" · ") }}
          </p>
          <p v-else-if="probes[connection.id] && !probes[connection.id]!.ok" class="mt-1 text-xs text-destructive">
            {{ tBackendError(probes[connection.id]!.error) }}
          </p>
          <p
            v-else-if="connection.lastProbe?.ok"
            class="mt-1 text-muted-foreground truncate text-xs"
            :title="t('ssh.lastProbeAt', { time: connection.lastProbe.probedAt })"
          >
            {{ t("ssh.lastProbe") }}: {{ probeLines(connection.lastProbe).join(" · ") }}
          </p>
        </li>
      </ul>
    </div>

    <Dialog
      :open="dialogOpen"
      @update:open="
        value => {
          if (!value) dialogOpen = false
        }
      "
    >
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ t(editingId ? "ssh.editTitle" : "ssh.createTitle") }}</DialogTitle>
          <DialogDescription>{{ t("ssh.dialogDescription") }}</DialogDescription>
        </DialogHeader>
        <form class="space-y-4" @submit.prevent="save">
          <label class="block space-y-2 text-sm font-medium" for="ssh-name">
            {{ t("ssh.name") }}
            <Input
              id="ssh-name"
              v-model="form.name"
              autofocus
              maxlength="120"
              :placeholder="t('ssh.namePlaceholder')"
            />
          </label>
          <div class="grid grid-cols-[1fr_7rem] gap-3">
            <label class="block space-y-2 text-sm font-medium" for="ssh-host">
              {{ t("ssh.host") }}
              <Input id="ssh-host" v-model="form.host" :placeholder="t('ssh.hostPlaceholder')" />
            </label>
            <label class="block space-y-2 text-sm font-medium" for="ssh-port">
              {{ t("ssh.port") }}
              <Input id="ssh-port" v-model="form.port" type="number" min="1" max="65535" />
            </label>
          </div>
          <label class="block space-y-2 text-sm font-medium" for="ssh-user">
            {{ t("ssh.user") }}
            <Input id="ssh-user" v-model="form.user" :placeholder="t('ssh.userPlaceholder')" />
          </label>
          <label class="block space-y-2 text-sm font-medium" for="ssh-key-path">
            {{ t("ssh.keyPath") }}
            <Input id="ssh-key-path" v-model="form.keyPath" :placeholder="t('ssh.keyPathPlaceholder')" />
          </label>
          <p class="text-xs text-muted-foreground">{{ t("ssh.keyPathHint") }}</p>

          <div v-if="formProbe" class="rounded-md border border-border px-3 py-2 text-xs">
            <p
              v-if="formProbe.ok"
              :class="formProbe.piFound ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'"
            >
              {{ formProbe.piFound ? t("ssh.probeOk") : t("ssh.probeOkWithoutPi") }}
              <template v-if="probeLines(formProbe).length"> · {{ probeLines(formProbe).join(" · ") }}</template>
            </p>
            <template v-else>
              <p class="text-destructive">{{ tBackendError(formProbe.error) }}</p>
            </template>
          </div>
          <p v-if="formError" role="alert" class="text-sm text-destructive">{{ formError }}</p>

          <DialogFooter class="gap-2">
            <Button type="button" variant="outline" :disabled="probingForm || saving" @click="testForm">
              <LoaderCircle v-if="probingForm" :size="15" class="animate-spin" />
              {{ t("ssh.testConnection") }}
            </Button>
            <Button type="submit" :disabled="saving || !form.name.trim() || !form.host.trim()">
              {{ t("ssh.save") }}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </template>
  <p v-else class="text-sm">{{ t("ssh.desktopOnly") }}</p>
</template>
