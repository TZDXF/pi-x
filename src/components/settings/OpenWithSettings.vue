<script setup lang="ts">
import SettingRow from "@/components/shared/SettingRow.vue"
import SettingHeading from "@/components/shared/SettingHeading.vue"
import SettingDescription from "@/components/shared/SettingDescription.vue"
import { computed, onMounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  detectEditors,
  detectIcons,
  EDITOR_OPTIONS,
  isEditorKind,
  openWithPreference,
  setOpenWith,
  type EditorIconMap,
} from "@/lib/openWith"
const { t } = useI18n()
const availability = ref<Record<string, boolean>>({})
/** 首次检测成功后置 true;此前(或检测失败,如远程模式)不隐藏任何 IDE */
const detected = ref(false)
const icons = ref<EditorIconMap>({})
const executable = ref(openWithPreference.value.executable)
const error = ref("")
const detecting = ref(false)
watch(
  () => openWithPreference.value.executable,
  value => {
    executable.value = value
  },
)
// 检测不到的 IDE 不显示;当前选中的一条始终保留(未检测到时附带提示,便于察觉并改选)
const visibleOptions = computed(() =>
  EDITOR_OPTIONS.filter(
    option => !detected.value || availability.value[option.id] !== false || option.id === openWithPreference.value.kind,
  ),
)
const iconOf = (id: string) => icons.value[id] ?? null
const selectedIcon = computed(() => iconOf(openWithPreference.value.kind))
function save(value: unknown) {
  if (!isEditorKind(value)) return
  error.value = ""
  try {
    setOpenWith(value, executable.value)
  } catch (e) {
    error.value = String(e)
  }
}
async function detect() {
  detecting.value = true
  error.value = ""
  try {
    availability.value = await detectEditors()
    detected.value = true
  } catch (e) {
    error.value = String(e)
  } finally {
    detecting.value = false
  }
}
onMounted(() => {
  detect()
  detectIcons().then(map => {
    icons.value = map
  })
})
</script>

<template>
  <SettingRow>
    <div class="min-w-0">
      <SettingHeading id="open-with-label">{{ t("openWith.default") }}</SettingHeading>
      <SettingDescription>{{ t("openWith.description") }}</SettingDescription>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <Select :model-value="openWithPreference.kind" @update:model-value="save">
        <SelectTrigger class="h-8 w-48 text-xs" aria-labelledby="open-with-label">
          <img v-if="selectedIcon" :src="selectedIcon" class="size-4 shrink-0" alt="" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="option in visibleOptions" :key="option.id" :value="option.id">
            <img v-if="iconOf(option.id)" :src="iconOf(option.id)!" class="size-4 shrink-0" alt="" />
            {{ option.label
            }}{{ detected && availability[option.id] === false ? ` · ${t("openWith.notDetected")}` : "" }}
          </SelectItem>
          <SelectItem value="system">
            <img v-if="iconOf('system')" :src="iconOf('system')!" class="size-4 shrink-0" alt="" />
            {{ t("openWith.system") }}
          </SelectItem>
          <SelectItem value="custom">{{ t("openWith.custom") }}</SelectItem>
        </SelectContent>
      </Select>
      <Button variant="outline" size="sm" :disabled="detecting" @click="detect">{{ t("openWith.detect") }}</Button>
    </div>
  </SettingRow>
  <SettingRow v-if="openWithPreference.kind === 'custom'">
    <div class="min-w-0">
      <label for="editor-executable" class="text-sm font-medium">{{ t("openWith.executable") }}</label>
      <SettingDescription>{{ t("openWith.executableHint") }}</SettingDescription>
    </div>
    <div class="flex min-w-0 items-center gap-2">
      <Input
        id="editor-executable"
        v-model="executable"
        class="w-64 text-xs"
        placeholder="C:\\Program Files\\Editor\\editor.exe"
        @keydown.enter="save('custom')"
      />
      <Button variant="outline" size="sm" @click="save('custom')">{{ t("openWith.save") }}</Button>
    </div>
  </SettingRow>
  <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
</template>
