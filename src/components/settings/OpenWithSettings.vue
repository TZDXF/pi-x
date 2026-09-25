<script setup lang="ts">
import { onMounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { detectEditors, EDITOR_OPTIONS, isEditorKind, openWithPreference, setOpenWith } from "@/lib/openWith"
const { t } = useI18n()
const availability = ref<Record<string, boolean>>({})
const executable = ref(openWithPreference.value.executable)
const error = ref("")
const detecting = ref(false)
watch(() => openWithPreference.value.executable, value => { executable.value = value })
function save(value: unknown) {
  if (!isEditorKind(value)) return
  error.value = ""
  try { setOpenWith(value, executable.value) } catch (e) { error.value = String(e) }
}
async function detect() {
  detecting.value = true
  error.value = ""
  try { availability.value = await detectEditors() } catch (e) { error.value = String(e) }
  finally { detecting.value = false }
}
onMounted(detect)
</script>

<template>
  <div class="setting-row">
    <div>
      <h3 id="open-with-label">{{ t('openWith.default') }}</h3>
      <p>{{ t('openWith.description') }}</p>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <Select :model-value="openWithPreference.kind" @update:model-value="save">
        <SelectTrigger class="h-8 w-48 text-xs" aria-labelledby="open-with-label"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem v-for="option in EDITOR_OPTIONS" :key="option.id" :value="option.id">
            {{ option.label }}{{ availability[option.id] === false ? ` · ${t('openWith.notDetected')}` : '' }}
          </SelectItem>
          <SelectItem value="system">{{ t('openWith.system') }}</SelectItem>
          <SelectItem value="custom">{{ t('openWith.custom') }}</SelectItem>
        </SelectContent>
      </Select>
      <Button variant="outline" size="sm" :disabled="detecting" @click="detect">{{ t('openWith.detect') }}</Button>
    </div>
  </div>
  <div v-if="openWithPreference.kind === 'custom'" class="setting-row">
    <div>
      <label for="editor-executable" class="text-sm font-medium">{{ t('openWith.executable') }}</label>
      <p>{{ t('openWith.executableHint') }}</p>
    </div>
    <div class="flex min-w-0 items-center gap-2">
      <Input id="editor-executable" v-model="executable" class="w-64 text-xs" placeholder="C:\\Program Files\\Editor\\editor.exe" @keydown.enter="save('custom')" />
      <Button variant="outline" size="sm" @click="save('custom')">{{ t('openWith.save') }}</Button>
    </div>
  </div>
  <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
</template>
