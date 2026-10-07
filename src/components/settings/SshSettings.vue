<script setup lang="ts">
/** 远程连接管理（P1 契约 §2 + 多后端契约 §3/§4/§5.4）：连接列表、新增/编辑/删除与连接测试（probe）。 */
import { computed, onMounted, reactive, ref } from "vue"
import { useI18n } from "vue-i18n"
import { LoaderCircle, Pencil, PlugZap, Plus, Trash2 } from "@lucide/vue"
import { isDesktop } from "@/api/transport"
import {
  dockerContainerList,
  sshConnectionDelete,
  sshConnectionList,
  sshConnectionProbe,
  sshConnectionSave,
  sshProbeTarget,
  wslDistroList,
  type DockerContainerListResult,
  type SshConnection,
  type SshProbeResult,
  type WslDistroListResult,
} from "@/api/piClient"
import { tBackendError } from "@/i18n"
import { useUiStore } from "@/stores/conversations"
import { connectionKind, isWslPlatform, type RemoteKind } from "@/lib/ssh"
import { remoteFormFields, remoteKindOptions } from "@/lib/remoteBackends"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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
const form = reactive({ name: "", host: "", port: "22", user: "", keyPath: "", distro: "", container: "" })
/** 连接后端种类（多后端契约 §3.1）；编辑时由连接的 kind 决定，不可更改。 */
const formKind = ref<RemoteKind>("ssh")

// ---- 后端枚举与不可用态（多后端契约 §4.1/§4.4）----
// 平台守卫：wsl.exe 仅 Windows 提供，非 Windows 直接隐藏 WSL 入口。
const isWindows = isWslPlatform()
const wslList = ref<WslDistroListResult | null>(null)
const dockerList = ref<DockerContainerListResult | null>(null)
const enumsLoading = ref(false)

const kindOptions = computed(() =>
  remoteKindOptions({
    isWindows,
    wslAvailable: wslList.value?.available ?? null,
    dockerAvailable: dockerList.value?.available ?? null,
  }),
)
const formFields = computed(() => remoteFormFields(formKind.value))
const wslAvailable = computed(() => wslList.value?.available ?? false)
const dockerAvailable = computed(() => dockerList.value?.available ?? false)
/** 保存按钮可用性：名称恒必填，其余按 kind 各有必填项。 */
const formReady = computed(() => {
  if (!form.name.trim()) return false
  if (formKind.value === "ssh") return !!form.host.trim()
  if (formKind.value === "wsl") return !!form.distro
  return !!form.container
})

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

/**
 * 枚举 WSL 发行版与 Docker 容器，驱动 kind 入口置灰与下拉选项。
 * 枚举命令失败（如后端不可达）按不可用态呈现，不抛错 toast（多后端契约 §4.4）。
 */
async function loadEnumerations() {
  if (enumsLoading.value) return
  enumsLoading.value = true
  const [wsl, docker] = await Promise.allSettled([wslDistroList(), dockerContainerList()])
  wslList.value =
    wsl.status === "fulfilled" ? wsl.value : { available: false, distros: [], errorKind: null, error: null }
  dockerList.value =
    docker.status === "fulfilled"
      ? docker.value
      : { available: false, containers: [], errorKind: null, error: null }
  enumsLoading.value = false
}

function kindLabel(connection: SshConnection) {
  const kind = connectionKind(connection)
  return t(kind === "wsl" ? "ssh.kindWsl" : kind === "docker" ? "ssh.kindDocker" : "ssh.kindSsh")
}

function connectionLabel(connection: SshConnection) {
  const kind = connectionKind(connection)
  if (kind === "wsl") {
    const distro = connection.distro ?? ""
    return connection.user ? `${connection.user}@${distro}` : distro
  }
  if (kind === "docker") return connection.container ?? ""
  const authority = connection.user ? `${connection.user}@${connection.host}` : connection.host
  return connection.port === 22 ? authority : `${authority}:${connection.port}`
}

function openCreate() {
  editingId.value = null
  formKind.value = "ssh"
  Object.assign(form, { name: "", host: "", port: "22", user: "", keyPath: "", distro: "", container: "" })
  formProbe.value = null
  formError.value = ""
  dialogOpen.value = true
  void loadEnumerations()
}

function openEdit(connection: SshConnection) {
  editingId.value = connection.id
  formKind.value = connectionKind(connection)
  Object.assign(form, {
    name: connection.name,
    host: connection.host,
    port: String(connection.port),
    user: connection.user ?? "",
    keyPath: connection.keyPath ?? "",
    distro: connection.distro ?? "",
    container: connection.container ?? "",
  })
  formProbe.value = null
  formError.value = ""
  dialogOpen.value = true
  void loadEnumerations()
}

/** 表单可用时的目标参数；非法返回 null 并写 formError。后端做 per-kind 裁剪与最终校验（契约 §3.1）。 */
function formTarget() {
  const name = form.name.trim()
  if (!name) {
    formError.value = t("ssh.nameRequired")
    return null
  }
  const base = { id: editingId.value ?? undefined, name, kind: formKind.value }
  if (formKind.value === "wsl") {
    if (!form.distro) {
      formError.value = t("ssh.distroRequired")
      return null
    }
    return { ...base, kind: "wsl" as const, distro: form.distro, user: form.user.trim() || null }
  }
  if (formKind.value === "docker") {
    if (!form.container) {
      formError.value = t("ssh.containerRequired")
      return null
    }
    return { ...base, kind: "docker" as const, container: form.container }
  }
  const host = form.host.trim()
  const port = Number(form.port)
  if (!host) formError.value = t("ssh.hostRequired")
  else if (!Number.isInteger(port) || port < 1 || port > 65535) formError.value = t("ssh.portInvalid")
  else
    return {
      ...base,
      kind: "ssh" as const,
      host,
      port,
      user: form.user.trim() || null,
      keyPath: form.keyPath.trim() || null,
    }
  return null
}

async function testForm() {
  const target = formTarget()
  // ssh_probe_target 仅接受 SSH 目标参数；按钮也只在 SSH 表单出现。
  if (!target || target.kind !== "ssh") return
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
            <span
              class="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
              :title="t('ssh.kindLabel')"
            >{{ kindLabel(connection) }}</span>
            <span class="text-sm font-medium">{{ connection.name }}</span>
            <span class="text-muted-foreground font-mono text-xs">{{ connectionLabel(connection) }}</span>
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
          <p
            v-if="connectionKind(connection) === 'ssh' && connection.keyPath"
            class="mt-1 text-muted-foreground truncate font-mono text-xs"
          >
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
          <!-- kind 选择器（多后端契约 §5.4）：编辑时种类不可更改；非 Windows 隐藏 WSL，
               枚举不可用的后端入口置灰并提示（§4.4）。 -->
          <div v-if="!editingId" class="space-y-2">
            <span class="block text-sm font-medium">{{ t("ssh.kindLabel") }}</span>
            <div class="bg-muted text-muted-foreground flex gap-1 rounded-lg p-1 text-sm font-medium" role="tablist">
              <button
                v-for="option in kindOptions"
                :key="option.kind"
                type="button"
                role="tab"
                :disabled="option.disabled"
                :title="option.disabled ? t(option.hintKey!) : undefined"
                class="flex-1 rounded-md px-3 py-1.5 transition-colors"
                :class="[
                  formKind === option.kind ? 'bg-background text-foreground shadow-sm' : 'hover:text-foreground',
                  { 'cursor-not-allowed opacity-50': option.disabled },
                ]"
                :aria-selected="formKind === option.kind"
                @click="formKind = option.kind"
              >
                {{ t(option.kind === "wsl" ? "ssh.kindWsl" : option.kind === "docker" ? "ssh.kindDocker" : "ssh.kindSsh") }}
              </button>
            </div>
            <p v-if="enumsLoading" class="text-xs text-muted-foreground">{{ t("ssh.loading") }}</p>
          </div>
          <!-- kind = ssh：主机/端口/用户/私钥（表单不变） -->
          <template v-if="formFields.includes('host')">
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
          </template>
          <!-- kind = wsl：发行版下拉（wsl_distro_list）+ 可选用户名 -->
          <template v-if="formFields.includes('distro')">
            <label class="block space-y-2 text-sm font-medium" for="ssh-distro">
              {{ t("ssh.distro") }}
              <Select v-model="form.distro" :disabled="!wslAvailable">
                <SelectTrigger id="ssh-distro" class="w-full">
                  <SelectValue :placeholder="t('ssh.distroPlaceholder')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="distro in wslList?.distros ?? []" :key="distro.name" :value="distro.name">
                    {{ distro.name }}（{{ distro.state
                    }}<template v-if="distro.isDefault"> · {{ t("ssh.distroDefault") }}</template>）
                  </SelectItem>
                </SelectContent>
              </Select>
            </label>
            <div v-if="wslList && !wslAvailable" class="rounded-md border border-border px-3 py-2 text-xs">
              <p class="text-muted-foreground">{{ t("ssh.wslUnavailable") }}</p>
              <p v-if="wslList.error" class="text-destructive">{{ tBackendError(wslList.error) }}</p>
            </div>
            <label class="block space-y-2 text-sm font-medium" for="ssh-wsl-user">
              {{ t("ssh.user") }}
              <Input id="ssh-wsl-user" v-model="form.user" :placeholder="t('ssh.wslUserPlaceholder')" />
            </label>
          </template>
          <!-- kind = docker：容器下拉（docker_container_list，含未运行容器） -->
          <template v-if="formFields.includes('container')">
            <label class="block space-y-2 text-sm font-medium" for="ssh-container">
              {{ t("ssh.container") }}
              <Select v-model="form.container" :disabled="!dockerAvailable">
                <SelectTrigger id="ssh-container" class="w-full">
                  <SelectValue :placeholder="t('ssh.containerPlaceholder')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="container in dockerList?.containers ?? []" :key="container.name" :value="container.name">
                    {{ container.name }}（{{ container.status || container.state }}）
                  </SelectItem>
                </SelectContent>
              </Select>
            </label>
            <div v-if="dockerList && !dockerAvailable" class="rounded-md border border-border px-3 py-2 text-xs">
              <p class="text-muted-foreground">{{ t("ssh.dockerUnavailable") }}</p>
              <p v-if="dockerList.error" class="text-destructive">{{ tBackendError(dockerList.error) }}</p>
            </div>
          </template>

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
            <!-- 「测试连接」走 ssh_probe_target（SSH 专属参数），仅 SSH 表单提供；
                 WSL/Docker 连接保存后可用列表行的 probe 按钮测试。 -->
            <Button v-if="formKind === 'ssh'" type="button" variant="outline" :disabled="probingForm || saving" @click="testForm">
              <LoaderCircle v-if="probingForm" :size="15" class="animate-spin" />
              {{ t("ssh.testConnection") }}
            </Button>
            <Button type="submit" :disabled="saving || !formReady">
              {{ t("ssh.save") }}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </template>
  <p v-else class="text-sm">{{ t("ssh.desktopOnly") }}</p>
</template>
