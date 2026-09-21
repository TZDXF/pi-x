<script setup lang="ts">
/** Categorized workspace settings and Pi runtime configuration. */
import { ref, watch } from "vue"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  detectPi,
  getConfig,
  saveConfig,
  type AppConfig,
  type PiInfo,
} from "@/api/piClient"
import { useUiStore } from "@/stores/ui"

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const ui = useUiStore()

const tab = ref("general")
const piPath = ref("")
const info = ref<PiInfo | null>(null)
const detecting = ref(false)
const saving = ref(false)

watch(
  () => props.open,
  async (o) => {
    if (!o) return
    info.value = null
    try {
      const c: AppConfig = await getConfig()
      piPath.value = c.piPath ?? ""
    } catch {
      piPath.value = ""
    }
  },
)

async function detect() {
  detecting.value = true
  try {
    info.value = await detectPi(piPath.value.trim() || undefined)
  } catch (e) {
    ui.pushToast(String(e), "error")
  } finally {
    detecting.value = false
  }
}

async function save() {
  saving.value = true
  try {
    const c: AppConfig = await getConfig()
    await saveConfig({ ...c, piPath: piPath.value.trim() || undefined })
    ui.pushToast("已保存，重启会话后生效", "info")
    emit("close")
  } catch (e) {
    ui.pushToast(String(e), "error")
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog :open="props.open" @update:open="(v: boolean) => !v && emit('close')">
    <DialogContent class="settings-dialog">
      <nav class="settings-nav" aria-label="设置分类">
        <h2>设置</h2>
        <button :class="{ active: tab === 'general' }" @click="tab = 'general'">
          常规</button
        ><button
          :class="{ active: tab === 'runtime' }"
          @click="tab = 'runtime'"
        >
          运行环境</button
        ><button :class="{ active: tab === 'about' }" @click="tab = 'about'">
          关于 Pi X
        </button>
        <p>你的本地 AI 工作区</p>
      </nav>
      <section class="settings-body">
        <template v-if="tab === 'general'">
          <DialogHeader
            ><DialogTitle>常规</DialogTitle
            ><DialogDescription
              >工作区与对话的使用方式。</DialogDescription
            ></DialogHeader
          >
          <div class="setting-row">
            <div>
              <h3>本地工作区</h3>
              <p>在左侧打开项目文件夹，Pi 将在该目录中运行。</p>
            </div>
            <span class="setting-badge">本地</span>
          </div>
          <div class="setting-row">
            <div>
              <h3>项目与会话</h3>
              <p>历史会话按项目保存，重启后自动打开上次的项目。</p>
            </div>
          </div>
          <div class="setting-row">
            <div>
              <h3>键盘快捷操作</h3>
              <p>
                发送消息 <kbd>Enter</kbd> · 换行 <kbd>Shift + Enter</kbd
                ><br />停止生成 <kbd>Esc</kbd> · 文件引用 <kbd>@</kbd> · 命令
                <kbd>/</kbd>
              </p>
            </div>
          </div>
        </template>
        <template v-else-if="tab === 'about'">
          <DialogHeader
            ><DialogTitle>关于 Pi X</DialogTitle
            ><DialogDescription
              >专注于代码与创造的桌面 AI 工作区。</DialogDescription
            ></DialogHeader
          >
          <div class="setting-row">
            <div>
              <h3>Pi X</h3>
              <p>
                基于 pi coding agent
                的桌面客户端。支持流式对话、工具调用、会话分支和项目上下文。
              </p>
            </div>
          </div>
          <p class="text-muted-foreground mt-6 text-xs">
            模型与推理强度可在对话输入框下方切换。
          </p>
        </template>
        <template v-else>
          <DialogHeader>
            <DialogTitle>运行环境</DialogTitle
            ><DialogDescription
              >配置 Pi 可执行文件与连接环境。</DialogDescription
            >
          </DialogHeader>

          <div class="flex flex-col gap-3">
            <label for="pi-executable" class="text-sm font-medium"
              >Pi 可执行文件路径</label
            >
            <Input
              id="pi-executable"
              v-model="piPath"
              placeholder="留空时自动从 PATH 检测"
              class="font-mono text-xs"
            />
            <p class="text-muted-foreground text-xs">
              Windows 下会自动解析 npm
              <code>.cmd</code> 启动脚本。修改将在重启会话后生效。
            </p>

            <div class="flex items-center gap-2">
              <button
                class="border-input hover:bg-accent rounded-md border px-3 py-1.5 text-xs"
                :disabled="detecting"
                @click="detect"
              >
                {{ detecting ? "检测中…" : "检测" }}
              </button>
              <span v-if="info" class="text-xs">
                <template v-if="info.found">
                  <span class="text-chart-2 font-medium">已找到</span>
                  <span class="text-muted-foreground">
                    · {{ info.path
                    }}{{ info.version ? ` · ${info.version}` : "" }}</span
                  >
                </template>
                <span v-else class="text-destructive font-medium">未找到</span>
              </span>
            </div>

            <div class="mt-2 flex justify-end gap-2">
              <button
                class="border-input hover:bg-accent rounded-md border px-3 py-1.5 text-xs"
                @click="emit('close')"
              >
                取消
              </button>
              <button
                class="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 text-xs"
                :disabled="saving"
                @click="save"
              >
                {{ saving ? "保存中…" : "保存更改" }}
              </button>
            </div>
          </div>
        </template>
      </section>
    </DialogContent>
  </Dialog>
</template>
