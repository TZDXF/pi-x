<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"
import { Eye, Languages, Trash2 } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import { ask } from "@tauri-apps/plugin-dialog"
import {
  deleteHostedSkill,
  listDiscoveredSkills,
  listHostedSkills,
  openHostedSkillsDirectory,
  packageTranslate,
  setHostedSkillsEnabled,
  skillListFiles,
  skillReadFile,
} from "@/api/piClient"
import type { DiscoveredSkill, HostedSkill } from "@/api/piClient"
import { useUiStore } from "@/stores/conversations"
import { isMarkdownExt } from "@/lib/fileKind"
import { normalizeSlashes } from "@/lib/paths"
import type { FilePreview } from "@/lib/projectFiles"
import { markdownLinkOptions } from "@/lib/linkOptions"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import ProjectFiles from "@/components/ProjectFiles.vue"
import ProjectFilePreview from "@/components/ProjectFilePreview.vue"
import { Markdown } from "vue-stream-markdown"

const { t, locale } = useI18n()
const ui = useUiStore()
const skills = ref<HostedSkill[]>([])
const discovered = ref<DiscoveredSkill[]>([])
const loading = ref(true)
const error = ref("")

// ---- 单技能文件预览（参考 PackageResourcePage：文件列表 + 预览 + 翻译）----
const previewing = ref<string | null>(null)
const files = ref<string[]>([])
const filesLoading = ref(false)
const selected = ref<string | null>(null)
const filter = ref("")
const translating = ref(false)
const translated = ref("")
let filesRequest = 0
let translationRequest = 0

const hasMatches = computed(() =>
  files.value.some(path => path.toLowerCase().includes(normalizeSlashes(filter.value.trim()).toLowerCase())),
)
const targetLang = computed(() => (locale.value === "zh-CN" ? "Simplified Chinese" : "English"))

// Capture the skill identity so an in-flight read never changes its data source.
const readSkillFile = computed(() => {
  const skillPath = previewing.value
  if (!skillPath) return undefined
  return async (relPath: string): Promise<FilePreview> => ({
    kind: "text",
    text: await skillReadFile(skillPath, relPath),
    truncated: false,
    mime: null,
    data: null,
  })
})

watch([previewing, selected], () => {
  ++translationRequest
  translating.value = false
  translated.value = ""
})

watch(previewing, async path => {
  const request = ++filesRequest
  files.value = []
  selected.value = null
  filter.value = ""
  if (!path) return
  filesLoading.value = true
  try {
    const allFiles = await skillListFiles(path)
    if (request === filesRequest) files.value = allFiles.filter(isMarkdownExt).map(normalizeSlashes)
  } catch (e) {
    if (request === filesRequest) ui.pushToast(String(e), "error")
  } finally {
    if (request === filesRequest) filesLoading.value = false
  }
})

function togglePreview(skill: { path: string }) {
  previewing.value = previewing.value === skill.path ? null : skill.path
}

async function translate(content: string) {
  if (!content.trim() || translating.value) return
  const request = ++translationRequest
  translating.value = true
  translated.value = ""
  try {
    const text = await packageTranslate(content, targetLang.value)
    if (request === translationRequest) translated.value = text
  } catch (e) {
    if (request === translationRequest) ui.pushToast(String(e), "error")
  } finally {
    if (request === translationRequest) translating.value = false
  }
}

async function load() {
  loading.value = true
  error.value = ""
  try {
    const [hosted, found] = await Promise.all([listHostedSkills(), listDiscoveredSkills()])
    skills.value = hosted
    // Hide skills already managed under ~/.pix/skills.
    discovered.value = found.filter(s => !s.hosted)
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

async function openDirectory() {
  try {
    await openHostedSkillsDirectory()
  } catch (e) {
    ui.pushToast(String(e), "error")
  }
}

async function toggle(skill: HostedSkill, checked: boolean) {
  const previous = skill.enabled
  skill.enabled = checked
  try {
    await setHostedSkillsEnabled(skills.value.filter(s => s.enabled).map(s => s.path))
    ui.pushToast(t("skillsConfig.enabledSaved"), "info")
  } catch (e) {
    skill.enabled = previous
    ui.pushToast(String(e), "error")
  }
}

async function remove(skill: HostedSkill) {
  const confirmed = await ask(t("skillsConfig.deleteConfirm", { name: skill.name }), {
    title: t("skillsConfig.title"),
    okLabel: t("skillsConfig.delete"),
    cancelLabel: t("common.cancel"),
  })
  if (!confirmed) return
  try {
    await deleteHostedSkill(skill.path)
    if (previewing.value === skill.path) previewing.value = null
    await load()
  } catch (e) {
    ui.pushToast(String(e), "error")
  }
}

function displaySkillPath(path: string): string {
  return normalizeSlashes(path)
}

function sourceLabel(skill: DiscoveredSkill): string {
  if (skill.sourceKind === "packageGlobal")
    return t(`skillsConfig.source.${skill.sourceKind}`, { name: skill.sourceName ?? "?" })
  return t(`skillsConfig.source.${skill.sourceKind}`)
}

onMounted(load)
</script>

<template>
  <header class="flex flex-col gap-2 text-left">
    <h2 class="text-base leading-none font-medium">{{ t("skillsConfig.title") }}</h2>
  </header>
  <p v-if="loading" class="text-sm text-muted-foreground">{{ t("agentConfig.loading") }}</p>
  <div v-else-if="error" role="alert" class="space-y-3">
    <p class="text-sm text-destructive">{{ error }}</p>
    <Button variant="outline" @click="load">{{ t("agentConfig.retry") }}</Button>
  </div>
  <div v-else class="min-w-0 space-y-6">
    <section class="space-y-3">
      <h3 class="text-sm font-medium">{{ t("skillsConfig.hosted") }}</h3>
      <div>
        <div class="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" @click="openDirectory">{{ t("skillsConfig.openDirectory") }}</Button>
          <Button variant="outline" size="sm" @click="load">{{ t("skillsConfig.refresh") }}</Button>
        </div>
        <p v-if="!skills.length" class="mt-3 text-sm text-muted-foreground">{{ t("skillsConfig.empty") }}</p>
        <div v-for="skill in skills" :key="skill.path" class="mt-3 space-y-2">
          <div class="flex items-center gap-3 rounded-lg border p-3">
            <div class="min-w-0 flex-1 space-y-1">
              <div class="flex flex-wrap items-center gap-2">
                <p class="text-sm font-medium">{{ skill.name }}</p>
                <span class="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{{
                  t("skillsConfig.sourceHosted")
                }}</span>
              </div>
              <p class="break-all font-mono text-xs text-muted-foreground" :title="displaySkillPath(skill.path)">
                {{ displaySkillPath(skill.path) }}
              </p>
              <p
                v-if="skill.description"
                class="line-clamp-2 whitespace-pre-line text-xs leading-relaxed text-muted-foreground"
              >
                {{ skill.description }}
              </p>
            </div>
            <Switch
              :model-value="skill.enabled"
              :aria-label="`${t('skillsConfig.enable')} · ${skill.name}`"
              @update:model-value="v => toggle(skill, Boolean(v))"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              :aria-pressed="previewing === skill.path"
              :aria-label="`${t('skillsConfig.preview')} · ${skill.name}`"
              :title="t('skillsConfig.preview')"
              @click="togglePreview(skill)"
              ><Eye :size="15"
            /></Button>
            <Button
              variant="ghost"
              size="icon-sm"
              class="text-destructive hover:text-destructive"
              :aria-label="`${t('skillsConfig.delete')} · ${skill.name}`"
              :title="t('skillsConfig.delete')"
              @click="remove(skill)"
              ><Trash2 :size="15"
            /></Button>
          </div>
          <div v-if="previewing === skill.path" class="flex h-96 min-h-0 gap-3 overflow-hidden rounded-lg border p-1">
            <div class="flex min-h-0 w-60 shrink-0 flex-col overflow-hidden rounded border">
              <div class="shrink-0 border-b p-1.5">
                <input
                  v-model="filter"
                  :placeholder="t('packages.filterFiles')"
                  class="h-7 w-full rounded border bg-transparent px-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
                />
              </div>
              <ProjectFiles
                v-show="hasMatches"
                v-model:selected-path="selected"
                project=""
                :files="files"
                :filter="filter"
                :preview="false"
                :show-header="false"
              />
              <p v-if="!hasMatches" class="text-muted-foreground py-3 text-center text-xs">
                {{ files.length ? t("packages.noMatchingFiles") : t("skillsConfig.noPreviewFiles") }}
              </p>
            </div>
            <ProjectFilePreview
              v-if="selected"
              class="overflow-hidden rounded border"
              project=""
              :path="selected"
              :read-file="readSkillFile"
              :closable="false"
            >
              <template #toolbar="{ text, loading: contentLoading }">
                <Button
                  variant="ghost"
                  size="sm"
                  :disabled="translating || contentLoading || !text.trim()"
                  @click="translate(text)"
                >
                  <Spinner v-if="translating" class="size-3" />
                  <Languages v-else :size="14" />
                  {{ t("packages.translate") }}
                </Button>
              </template>
              <template #after-content>
                <template v-if="translated">
                  <div class="my-3 border-t" />
                  <Markdown
                    :content="translated"
                    mode="static"
                    :enable-animate="false"
                    :link-options="markdownLinkOptions"
                    class="text-sm"
                  />
                </template>
              </template>
            </ProjectFilePreview>
          </div>
        </div>
      </div>
    </section>
    <section class="space-y-3">
      <h3 class="text-sm font-medium">{{ t("skillsConfig.discovered") }} ({{ discovered.length }})</h3>
      <p v-if="!discovered.length" class="text-sm text-muted-foreground">{{ t("skillsConfig.noDiscovered") }}</p>
      <div v-for="skill in discovered" :key="skill.path" class="space-y-2">
        <div class="flex items-start gap-3 rounded-lg border p-3">
          <div class="min-w-0 flex-1 space-y-1">
            <div class="flex flex-wrap items-center gap-2">
              <p class="text-sm font-medium">{{ skill.name }}</p>
              <span class="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{{ sourceLabel(skill) }}</span>
            </div>
            <p class="break-all font-mono text-xs text-muted-foreground" :title="displaySkillPath(skill.path)">
              {{ displaySkillPath(skill.path) }}
            </p>
            <p
              v-if="skill.description"
              class="line-clamp-2 whitespace-pre-line text-xs leading-relaxed text-muted-foreground"
            >
              {{ skill.description }}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            :aria-pressed="previewing === skill.path"
            :aria-label="`${t('skillsConfig.preview')} · ${skill.name}`"
            :title="t('skillsConfig.preview')"
            @click="togglePreview(skill)"
            ><Eye :size="15"
          /></Button>
        </div>
        <div v-if="previewing === skill.path" class="flex h-96 min-h-0 gap-3 overflow-hidden rounded-lg border p-1">
          <div class="flex min-h-0 w-60 shrink-0 flex-col overflow-hidden rounded border">
            <div class="shrink-0 border-b p-1.5">
              <input
                v-model="filter"
                :placeholder="t('packages.filterFiles')"
                class="h-7 w-full rounded border bg-transparent px-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
              />
            </div>
            <ProjectFiles
              v-show="hasMatches"
              v-model:selected-path="selected"
              project=""
              :files="files"
              :filter="filter"
              :preview="false"
              :show-header="false"
            />
            <p v-if="!hasMatches" class="text-muted-foreground py-3 text-center text-xs">
              {{ files.length ? t("packages.noMatchingFiles") : t("skillsConfig.noPreviewFiles") }}
            </p>
          </div>
          <ProjectFilePreview
            v-if="selected"
            class="overflow-hidden rounded border"
            project=""
            :path="selected"
            :read-file="readSkillFile"
            :closable="false"
          >
            <template #toolbar="{ text, loading: contentLoading }">
              <Button
                variant="ghost"
                size="sm"
                :disabled="translating || contentLoading || !text.trim()"
                @click="translate(text)"
              >
                <Spinner v-if="translating" class="size-3" />
                <Languages v-else :size="14" />
                {{ t("packages.translate") }}
              </Button>
            </template>
            <template #after-content>
              <template v-if="translated">
                <div class="my-3 border-t" />
                <Markdown
                  :content="translated"
                  mode="static"
                  :enable-animate="false"
                  :link-options="markdownLinkOptions"
                  class="text-sm"
                />
              </template>
            </template>
          </ProjectFilePreview>
        </div>
      </div>
    </section>
  </div>
</template>
