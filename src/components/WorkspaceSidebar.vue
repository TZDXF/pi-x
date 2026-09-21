<script setup lang="ts">
import { computed, ref, watch } from "vue"
import {
  Folder,
  FolderPlus,
  MessageSquare,
  PanelLeft,
  Plus,
  Search,
  Settings,
  RefreshCw,
  ChevronDown,
} from "@lucide/vue"
import { listSessions, type SessionMeta } from "@/api/piClient"
import { useSessionStore } from "@/stores/session"
import { useUiStore } from "@/stores/ui"
const props = defineProps<{ project: string; ready: boolean; busy: boolean }>()
const emit = defineEmits<{
  switchProject: []
  selectProject: [path: string]
  resumeSession: [file: string]
  settings: []
  collapse: []
}>()
const session = useSessionStore()
const ui = useUiStore()
const recentProjects = ref<string[]>([])
try {
  const stored: unknown = JSON.parse(
    localStorage.getItem("pix.recentProjects") || "[]",
  )
  if (Array.isArray(stored))
    recentProjects.value = stored
      .filter((p): p is string => typeof p === "string")
      .slice(0, 8)
} catch {
  /* Storage is optional. */
}
const history = ref<SessionMeta[]>([])
const query = ref("")
const loading = ref(false)
const expanded = ref(true)
const error = ref("")
let request = 0
const projectName = computed(
  () => props.project.split(/[\\/]/).filter(Boolean).pop() || "未打开项目",
)
const filtered = computed(() =>
  history.value.filter((s) =>
    `${s.preview || ""} ${s.id}`
      .toLowerCase()
      .includes(query.value.toLowerCase()),
  ),
)
async function refresh() {
  const id = ++request
  if (!props.project) {
    history.value = []
    return
  }
  loading.value = true
  error.value = ""
  try {
    const rows = await listSessions(props.project)
    if (id === request)
      history.value = rows.sort((a, b) => b.mtimeMs - a.mtimeMs)
  } catch {
    if (id === request) error.value = "无法加载会话，请重试"
  } finally {
    if (id === request) loading.value = false
  }
}
async function newSession() {
  try {
    await session.newSession()
    await refresh()
  } catch (e) {
    ui.pushToast(String(e), "error")
  }
}
function dateLabel(s: SessionMeta) {
  const date = new Date(s.timestamp || s.mtimeMs)
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" })
}
watch(
  () => props.project,
  () => {
    history.value = []
    if (props.project) {
      recentProjects.value = [
        props.project,
        ...recentProjects.value.filter((p) => p !== props.project),
      ].slice(0, 8)
      try {
        localStorage.setItem(
          "pix.recentProjects",
          JSON.stringify(recentProjects.value),
        )
      } catch {
        /* Storage is optional. */
      }
    }
    void refresh()
  },
  { immediate: true },
)
watch(
  () => [props.ready, session.sessionFile, session.isStreaming],
  () => {
    if (props.ready && !session.isStreaming) void refresh()
  },
)
</script>

<template>
  <aside class="workspace-sidebar" aria-label="项目与会话">
    <div class="sidebar-brand">
      <span class="brand-mark">P</span
      ><span>Pi <span class="text-muted-foreground">X</span></span
      ><button
        class="icon-button ml-auto"
        aria-label="收起侧栏"
        title="收起侧栏"
        @click="emit('collapse')"
      >
        <PanelLeft :size="17" />
      </button>
    </div>
    <button
      class="sidebar-action"
      :disabled="!ready || session.isStreaming"
      @click="newSession"
    >
      <Plus :size="17" />新会话
    </button>
    <label class="sidebar-search"
      ><Search :size="15" /><input
        v-model="query"
        placeholder="搜索会话"
        aria-label="搜索会话"
    /></label>
    <div class="sidebar-section-label">
      <span>项目</span
      ><button
        class="icon-button"
        :disabled="busy || session.isStreaming"
        title="打开项目"
        aria-label="打开项目"
        @click="emit('switchProject')"
      >
        <FolderPlus :size="15" />
      </button>
    </div>
    <button
      class="project-row"
      :title="project"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <ChevronDown :size="14" :class="{ '-rotate-90': !expanded }" /><Folder
        :size="16"
      /><span class="truncate">{{ projectName }}</span>
    </button>
    <div v-if="expanded" class="session-list">
      <div class="sidebar-section-label">
        <span>会话</span
        ><button
          class="icon-button"
          aria-label="刷新会话"
          title="刷新会话"
          :disabled="loading"
          @click="refresh"
        >
          <RefreshCw :size="13" :class="{ 'animate-spin': loading }" />
        </button>
      </div>
      <p v-if="loading && !history.length" class="sidebar-empty">
        正在加载会话…
      </p>
      <button
        v-if="ready && !history.some((s) => s.file === session.sessionFile)"
        class="session-row active"
        @click="query = ''"
      >
        <MessageSquare :size="14" /><span class="truncate">当前会话</span>
      </button>
      <button
        v-for="s in filtered"
        :key="s.file"
        class="session-row"
        :class="{ active: s.file === session.sessionFile }"
        :aria-current="s.file === session.sessionFile ? 'page' : undefined"
        :disabled="busy || session.isStreaming"
        :title="s.preview || s.id"
        @click="emit('resumeSession', s.file)"
      >
        <MessageSquare :size="14" /><span class="truncate">{{
          s.preview || "未命名会话"
        }}</span
        ><time>{{ dateLabel(s) }}</time>
      </button>
      <p v-if="error" class="sidebar-empty text-destructive">{{ error }}</p>
      <p v-else-if="!loading && !filtered.length" class="sidebar-empty">
        {{
          query
            ? "没有匹配的会话"
            : "从一个新会话开始。历史记录会保存在此项目下。"
        }}
      </p>
    </div>
    <div
      class="recent-projects"
      v-if="recentProjects.some((p) => p !== project)"
    >
      <div class="sidebar-section-label">最近项目</div>
      <button
        v-for="path in recentProjects.filter((p) => p !== project)"
        :key="path"
        class="project-row"
        :title="path"
        :disabled="busy || session.isStreaming"
        @click="emit('selectProject', path)"
      >
        <Folder :size="15" /><span class="truncate">{{
          path.split(/[\\/]/).filter(Boolean).pop()
        }}</span>
      </button>
    </div>
    <div class="sidebar-footer">
      <button class="sidebar-action" @click="emit('settings')">
        <Settings :size="17" />设置
      </button>
      <div class="sidebar-runtime">
        <span
          :class="ready ? 'bg-emerald-500' : 'bg-muted-foreground'"
          class="size-1.5 rounded-full"
        />{{ ready ? "Pi 已连接" : "本地工作区"
        }}<span class="ml-auto">Pi X</span>
      </div>
    </div>
  </aside>
</template>
