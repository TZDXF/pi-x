<script setup lang="ts">
/** Keyboard shortcuts panel: rebind actions, detect conflicts, reset defaults. */
import { computed, onBeforeUnmount, ref } from "vue"
import { useI18n } from "vue-i18n"
import { RotateCcw } from "@lucide/vue"
import SettingRow from "@/components/shared/SettingRow.vue"
import SettingHeading from "@/components/shared/SettingHeading.vue"
import SettingDescription from "@/components/shared/SettingDescription.vue"
import KeyHint from "@/components/shared/KeyHint.vue"
import { Button } from "@/components/ui/button"
import {
  LOCKED_SHORTCUTS,
  SHORTCUT_ACTION_DEFS,
  SHORTCUT_ACTION_IDS,
  comboFromEvent,
  findShortcutConflict,
  formatComboParts,
  isShortcutModified,
  resetAllShortcuts,
  setShortcutOverride,
  shortcutCombo,
  type LockedShortcutId,
  type ShortcutActionId,
  type ShortcutScope,
} from "@/lib/shortcuts"

const { t } = useI18n()

const SCOPES: ShortcutScope[] = ["global", "chat", "editor", "sidebar"]

const recording = ref<ShortcutActionId | null>(null)
const errorTarget = ref<ShortcutActionId | null>(null)
const errorName = ref("")

const anyModified = computed(() => SHORTCUT_ACTION_IDS.some(id => isShortcutModified(id)))

function rowsFor(scope: ShortcutScope): ShortcutActionId[] {
  return SHORTCUT_ACTION_IDS.filter(id => SHORTCUT_ACTION_DEFS[id].scope === scope)
}

function lockedFor(scope: ShortcutScope) {
  return scope === "editor" ? LOCKED_SHORTCUTS : []
}

function actionName(id: ShortcutActionId | LockedShortcutId): string {
  if (id in SHORTCUT_ACTION_DEFS) return t(SHORTCUT_ACTION_DEFS[id as ShortcutActionId].labelKey)
  const locked = LOCKED_SHORTCUTS.find(entry => entry.id === id)
  return locked ? t(locked.labelKey) : id
}

function startRecording(id: ShortcutActionId) {
  errorTarget.value = null
  recording.value = id
}

function stopRecording() {
  recording.value = null
}

function onRecordKeydown(event: KeyboardEvent) {
  const target = recording.value
  if (!target) return
  event.preventDefault()
  event.stopPropagation()
  if (event.isComposing) return
  const combo = comboFromEvent(event)
  if (!combo) return
  if (combo === "escape") {
    stopRecording()
    return
  }
  const conflict = findShortcutConflict(combo, target)
  if (conflict) {
    errorTarget.value = target
    errorName.value = actionName(conflict)
    stopRecording()
    return
  }
  setShortcutOverride(target, combo)
  stopRecording()
}

function reset(id: ShortcutActionId) {
  setShortcutOverride(id, null)
  if (errorTarget.value === id) errorTarget.value = null
}

function resetAll() {
  resetAllShortcuts()
  errorTarget.value = null
  stopRecording()
}

// Capture phase wins over the global dispatcher, so recorded keys never fire.
window.addEventListener("keydown", onRecordKeydown, true)
onBeforeUnmount(() => window.removeEventListener("keydown", onRecordKeydown, true))
</script>

<template>
  <div>
    <div class="flex items-start justify-between gap-4 pb-5">
      <SettingDescription class="mt-0">{{ t("settings.shortcutsDesc") }}</SettingDescription>
      <Button variant="outline" size="sm" :disabled="!anyModified" @click="resetAll">
        <RotateCcw :size="14" />
        {{ t("shortcuts.resetAll") }}
      </Button>
    </div>
    <section v-for="scope in SCOPES" :key="scope">
      <h3 class="text-muted-foreground pt-4 pb-1 text-[11px] font-medium tracking-[0.04em] uppercase first:pt-0">
        {{ t(`shortcuts.scope.${scope}`) }}
      </h3>
      <SettingRow v-for="id in rowsFor(scope)" :key="id">
        <div class="min-w-0">
          <SettingHeading>{{ actionName(id) }}</SettingHeading>
          <SettingDescription v-if="errorTarget === id" class="text-destructive">
            {{ t("shortcuts.conflict", { name: errorName }) }}
          </SettingDescription>
          <SettingDescription v-else-if="recording === id">
            {{ t("shortcuts.recording") }} {{ t("shortcuts.escCancel") }}
          </SettingDescription>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Button
            v-if="isShortcutModified(id)"
            variant="ghost"
            size="sm"
            class="text-muted-foreground"
            @click="reset(id)"
          >
            <RotateCcw :size="14" />
            {{ t("shortcuts.reset") }}
          </Button>
          <button
            type="button"
            class="hover:bg-border flex min-h-8 cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-1 transition-colors"
            :class="{ 'border-primary ring-ring ring-1': recording === id }"
            :aria-keyshortcuts="shortcutCombo(id)"
            @click="recording === id ? stopRecording() : startRecording(id)"
            @blur="recording === id && stopRecording()"
          >
            <template v-if="recording === id">
              <span class="text-muted-foreground animate-pulse text-xs">{{ t("shortcuts.recording") }}</span>
            </template>
            <template v-else>
              <KeyHint v-for="part in formatComboParts(shortcutCombo(id))" :key="part">{{ part }}</KeyHint>
            </template>
          </button>
        </div>
      </SettingRow>
      <SettingRow v-for="entry in lockedFor(scope)" :key="entry.id">
        <div class="min-w-0">
          <SettingHeading>{{ actionName(entry.id) }}</SettingHeading>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <span class="text-muted-foreground text-xs">{{ t("shortcuts.locked") }}</span>
          <span class="flex items-center gap-1 opacity-60">
            <KeyHint v-for="part in formatComboParts(entry.default)" :key="part">{{ part }}</KeyHint>
          </span>
        </div>
      </SettingRow>
    </section>
  </div>
</template>
