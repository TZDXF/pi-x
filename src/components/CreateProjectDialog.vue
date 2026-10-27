<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog"
import { FolderPlus, LoaderCircle, PlugZap, Plus, X } from "@lucide/vue"
import { isDesktop } from "@/api/transport"
import { sshConnectionList, sshConnectionProbe, type SshConnection, type SshProbeResult } from "@/api/piClient"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import SshSettings from "@/components/settings/SshSettings.vue"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useUiStore } from "@/stores/conversations"
import { useWorkspaceStore, type ProjectGroup } from "@/stores/workspace"
import { baseName, normalizeProjectPath, samePath } from "@/lib/paths"
import {
  buildDockerUri,
  buildSshUri,
  buildWslUri,
  connectionKind,
  connectionLabel,
  isRemoteProject,
  normalizeSshPath,
  parseRemoteUri,
  rememberSshProjectConnection,
  resolveSshConnectionId,
} from "@/lib/ssh"
import { tBackendError } from "@/i18n"
import { useSshDeploy } from "@/composables/useSshDeploy"
import SshDeployStatus from "@/components/SshDeployStatus.vue"

const props = defineProps<{ open: boolean; editPath?: string | null }>()
const emit = defineEmits<{ close: []; save: [group: ProjectGroup] }>()
const { t } = useI18n()
const workspace = useWorkspaceStore()
const ui = useUiStore()
const title = ref("")
const folders = ref<string[]>([])
const primary = ref("")
const error = ref("")
const adding = ref(false)
const folderName = baseName
const valid = computed(() => !!title.value.trim() && folders.value.length > 0 && folders.value.includes(primary.value))

// ---- 远程项目模式（P1 契约 §6.3 + 多后端契约 §5.4）：选连接（SSH/WSL/Docker）+ 输入远程路径 → probe 校验 → 保存为项目 ----
const mode = ref<"local" | "remote">("local")
const connections = ref<SshConnection[]>([])
const connectionsLoading = ref(false)
const connectionId = ref("")
const remotePath = ref("")
const probing = ref(false)
const probeResult = ref<SshProbeResult | null>(null)
const {
  statuses: deployStatuses,
  deployingIds,
  progress: deployProgress,
  loadStatus: loadDeployStatus,
  deploy,
} = useSshDeploy({
  onSuccess: () => ui.pushToast(t("ssh.deploySuccess"), "info"),
  onError: e => (error.value = tBackendError(e)),
})
const deployStatus = computed(() => (connectionId.value ? deployStatuses.value[connectionId.value] : null))
const deploying = computed(() => deployingIds.value.has(connectionId.value))
const showConnectionDialog = ref(false)

const selectedConnection = computed(
  () => connections.value.find(connection => connection.id === connectionId.value) ?? null,
)
const selectedKind = computed(() => (selectedConnection.value ? connectionKind(selectedConnection.value) : null))
/** 路径输入标签按连接 kind 区分：ssh=远程路径、wsl=发行版内路径、docker=容器内路径。 */
const pathLabelKey = computed(() =>
  selectedKind.value === "wsl"
    ? "projectDialog.wslPath"
    : selectedKind.value === "docker"
      ? "projectDialog.dockerPath"
      : "projectDialog.sshPath",
)
/** 远程模式：连接与路径就绪即可提交；probe 仅做校验提示，不阻塞（目录校验由 spawn 侧兜底）。 */
const remoteValid = computed(() => !!selectedConnection.value && normalizeSshPath(remotePath.value.trim()) !== null)
const submitValid = computed(() => (mode.value === "remote" ? remoteValid.value : valid.value))

async function loadConnections() {
  if (!isDesktop || connectionsLoading.value) return
  connectionsLoading.value = true
  try {
    connections.value = await sshConnectionList()
  } catch (e) {
    error.value = tBackendError(e)
  } finally {
    connectionsLoading.value = false
  }
}

/** 打开连接创建对话框 */
function openConnectionDialog() {
  showConnectionDialog.value = true
}

/** 连接创建完成后刷新列表 */
function onConnectionCreated() {
  showConnectionDialog.value = false
  void loadConnections()
}

watch(
  () => [props.open, props.editPath] as const,
  ([open]) => {
    showConnectionDialog.value = false
    if (!open) return
    const group = props.editPath ? workspace.projectGroups[props.editPath] : null
    title.value = group?.name || (props.editPath ? workspace.projectName(props.editPath) : "")
    folders.value = group ? [...group.folders] : props.editPath ? [props.editPath] : []
    primary.value = group?.primary || props.editPath || ""
    error.value = ""
    probing.value = false
    probeResult.value = null
    remotePath.value = ""
    connectionId.value = ""
    // 编辑远程项目时按 URI 回选连接与路径（per-kind 匹配，多后端契约 §5.4）。
    if (props.editPath && isRemoteProject(props.editPath)) {
      mode.value = "remote"
      const target = parseRemoteUri(props.editPath)
      remotePath.value = target?.target.path ?? ""
      void loadConnections().then(() => {
        connectionId.value = (props.editPath && resolveSshConnectionId(props.editPath, connections.value)) || ""
      })
    } else {
      mode.value = "local"
    }
    if (mode.value === "remote") void loadConnections()
  },
)

watch(mode, value => {
  if (value === "remote") {
    probeResult.value = null
    void loadConnections()
  }
})

async function testConnection() {
  const connection = selectedConnection.value
  if (!connection || probing.value) return
  probing.value = true
  probeResult.value = null
  delete deployStatuses.value[connection.id]
  try {
    probeResult.value = await sshConnectionProbe(connection.id)
    // probe 成功后异步获取部署状态
    void loadDeployStatus(connection)
  } catch (e) {
    error.value = tBackendError(e)
  } finally {
    probing.value = false
  }
}

async function deployPi() {
  const connection = selectedConnection.value
  if (connection) await deploy(connection)
}

/** 按连接的 kind 构造展示 URI（唯一入口 build*Uri，禁止手拼；多后端契约 §5.4）。 */
function remoteUriFor(connection: SshConnection, path: string): string {
  switch (connectionKind(connection)) {
    case "wsl":
      return buildWslUri({ distro: connection.distro ?? "", user: connection.user ?? null, path })
    case "docker":
      return buildDockerUri({ container: connection.container ?? "", path })
    default:
      return buildSshUri({ host: connection.host, port: connection.port, user: connection.user, path })
  }
}

/** 远程模式提交：构造远程 URI，记录连接关联后按普通项目保存。 */
function submitRemote() {
  const connection = selectedConnection.value
  const path = normalizeSshPath(remotePath.value.trim())
  if (!connection || !path) return
  let uri: string
  try {
    uri = remoteUriFor(connection, path)
  } catch (e) {
    error.value = tBackendError(e)
    return
  }
  if (
    workspace.projects.some(existing => existing !== props.editPath && samePath(existing, uri)) ||
    Object.entries(workspace.projectGroups).some(
      ([root, group]) => root !== props.editPath && group.folders.some(folder => samePath(folder, uri)),
    )
  ) {
    error.value = t("projectDialog.alreadyAdded")
    return
  }
  rememberSshProjectConnection(uri, connection.id)
  emit("save", { name: title.value.trim() || baseName(uri), folders: [uri], primary: uri })
}

async function addFolder() {
  if (adding.value) return
  adding.value = true
  try {
    const result = isDesktop
      ? await openFolderDialog({ directory: true, title: t("welcome.openFolderTitle") })
      : window.prompt(t("settings.remoteProject"))
    if (typeof result !== "string" || !result.trim()) return
    const path = normalizeProjectPath(result.trim())
    if (!props.open || folders.value.some(folder => samePath(folder, path))) return
    if (folders.value.length >= 32) {
      error.value = t("projectDialog.tooManyFolders")
      return
    }
    if (
      workspace.projects.some(existing => existing !== props.editPath && samePath(existing, path)) ||
      Object.entries(workspace.projectGroups).some(
        ([root, group]) => root !== props.editPath && group.folders.some(folder => samePath(folder, path)),
      )
    ) {
      error.value = t("projectDialog.alreadyAdded")
      return
    }
    error.value = ""
    folders.value.push(path)
    if (!primary.value) primary.value = path
    if (!title.value.trim() && folders.value.length === 1) title.value = folderName(path)
  } catch (e) {
    error.value = String(e)
  } finally {
    adding.value = false
  }
}

function removeFolder(path: string) {
  folders.value = folders.value.filter(folder => folder !== path)
  if (primary.value === path) primary.value = folders.value[0] || ""
}

function submit() {
  if (mode.value === "remote") {
    submitRemote()
    return
  }
  if (!valid.value) return
  emit("save", { name: title.value.trim(), folders: [...folders.value], primary: primary.value })
}
</script>

<template>
  <Dialog
    :open="props.open"
    @update:open="
      value => {
        if (!value) emit('close')
      }
    "
  >
    <DialogContent class="sm:max-w-lg" aria-describedby="project-dialog-description">
      <DialogHeader>
        <DialogTitle>{{ t(props.editPath ? "projectDialog.editTitle" : "projectDialog.title") }}</DialogTitle>
        <DialogDescription id="project-dialog-description">
          {{ t("projectDialog.description") }}
        </DialogDescription>
      </DialogHeader>
      <!-- 项目来源切换：本地文件夹 / 远程（SSH/WSL/Docker，多后端契约 §5.4；远程项目为单目录） -->
      <div
        v-if="!props.editPath"
        class="bg-muted text-muted-foreground flex gap-1 rounded-lg p-1 text-sm font-medium"
        role="tablist"
        :aria-label="t('projectDialog.modeLabel')"
      >
        <button
          v-for="value in ['local', 'remote'] as const"
          :key="value"
          v-show="value === 'local' || isDesktop"
          type="button"
          role="tab"
          class="flex-1 rounded-md px-3 py-1.5 transition-colors"
          :class="mode === value ? 'bg-background text-foreground shadow-sm' : 'hover:text-foreground'"
          :aria-selected="mode === value"
          @click="mode = value"
        >
          {{ t(value === "local" ? "projectDialog.modeLocal" : "projectDialog.modeRemote") }}
        </button>
      </div>
      <form class="space-y-5" @submit.prevent="submit">
        <template v-if="mode === 'remote'">
          <div class="flex items-end gap-2">
            <label class="min-w-0 flex-1 space-y-2 text-sm font-medium" for="ssh-project-connection">
              {{ t("projectDialog.remoteConnection") }}
              <Select v-model="connectionId">
                <SelectTrigger id="ssh-project-connection" class="w-full">
                  <SelectValue :placeholder="t('projectDialog.remoteConnectionPlaceholder')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="connection in connections" :key="connection.id" :value="connection.id">
                    {{ connection.name }}（{{ connectionLabel(connection) }}）
                  </SelectItem>
                </SelectContent>
              </Select>
            </label>
            <Button type="button" variant="outline" @click="openConnectionDialog">
              <Plus :size="15" />
              {{ t("projectDialog.newConnection") }}
            </Button>
          </div>
          <p v-if="connectionsLoading" class="text-xs text-muted-foreground">{{ t("ssh.loading") }}</p>
          <p
            v-else-if="!connections.length"
            class="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground"
          >
            {{ t("projectDialog.noRemoteConnections") }}
          </p>
          <div class="flex items-end gap-2">
            <label class="min-w-0 flex-1 space-y-2 text-sm font-medium" for="ssh-project-path">
              {{ t(pathLabelKey) }}
              <Input
                id="ssh-project-path"
                v-model="remotePath"
                class="font-mono"
                :placeholder="t('projectDialog.sshPathPlaceholder')"
              />
            </label>
            <Button type="button" variant="outline" :disabled="!selectedConnection || probing" @click="testConnection">
              <LoaderCircle v-if="probing" :size="15" class="animate-spin" />
              <PlugZap v-else :size="15" />
              {{ t("ssh.testConnection") }}
            </Button>
          </div>
          <p v-if="probeResult" class="rounded-md border border-border px-3 py-2 text-xs">
            <span v-if="probeResult.ok" class="text-green-700 dark:text-green-400">
              {{ t("ssh.probeOk") }}
            </span>
            <span v-else class="text-destructive">{{ tBackendError(probeResult.error) }}</span>
          </p>
          <SshDeployStatus
            :status="deployStatus"
            :deploying="deploying"
            :progress="deployProgress"
            @deploy="deployPi"
          />
          <label class="block space-y-2 text-sm font-medium" for="project-name-ssh">
            {{ t("projectDialog.name") }}
            <Input
              id="project-name-ssh"
              v-model="title"
              autofocus
              maxlength="120"
              :placeholder="t('projectDialog.namePlaceholder')"
            />
          </label>
          <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
          <div class="flex justify-end gap-2">
            <Button type="button" variant="outline" @click="emit('close')">{{ t("common.cancel") }}</Button>
            <Button type="submit" :disabled="!submitValid">{{ t("projectDialog.create") }}</Button>
          </div>
        </template>
        <template v-else>
          <label class="block space-y-2 text-sm font-medium" for="project-name">
            {{ t("projectDialog.name") }}
            <Input
              id="project-name"
              v-model="title"
              autofocus
              maxlength="120"
              :placeholder="t('projectDialog.namePlaceholder')"
            />
          </label>
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-sm font-medium">{{ t("projectDialog.folders") }}</span>
              <Button type="button" variant="outline" size="sm" :disabled="adding" @click="addFolder"
                ><FolderPlus :size="15" />{{ t("projectDialog.addFolder") }}</Button
              >
            </div>
            <p
              v-if="!folders.length"
              class="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground"
            >
              {{ t("projectDialog.empty") }}
            </p>
            <div
              v-else
              class="max-h-64 space-y-1 overflow-y-auto"
              role="radiogroup"
              :aria-label="t('projectDialog.primaryHint')"
            >
              <div v-for="path in folders" :key="path" class="flex items-center gap-2 rounded-md border px-3 py-2">
                <label class="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                  <input
                    v-model="primary"
                    type="radio"
                    name="primary-project"
                    :value="path"
                    :aria-label="`${t('projectDialog.primary')} · ${path}`"
                  />
                  <span class="min-w-0 flex-1"
                    ><span class="block truncate text-sm font-medium">{{ folderName(path) }}</span
                    ><span class="block truncate text-xs text-muted-foreground" :title="path">{{ path }}</span></span
                  >
                  <span v-if="primary === path" class="shrink-0 text-xs text-muted-foreground">{{
                    t("projectDialog.primary")
                  }}</span>
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  :aria-label="`${t('projectDialog.removeFolder')} · ${path}`"
                  @click="removeFolder(path)"
                  ><X :size="15"
                /></Button>
              </div>
            </div>
            <p class="text-xs text-muted-foreground">{{ t("projectDialog.primaryHint") }}</p>
          </div>
          <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
          <div class="flex justify-end gap-2">
            <Button type="button" variant="outline" @click="emit('close')">{{ t("common.cancel") }}</Button
            ><Button type="submit" :disabled="!submitValid">{{
              t(props.editPath ? "projectDialog.save" : "projectDialog.create")
            }}</Button>
          </div>
        </template>
      </form>
      <!-- 作为嵌套弹窗打开，避免将设置页的连接列表渲染到项目弹窗外。 -->
      <SshSettings
        v-if="showConnectionDialog"
        create-only
        @close="showConnectionDialog = false"
        @created="onConnectionCreated"
      />
    </DialogContent>
  </Dialog>
</template>
