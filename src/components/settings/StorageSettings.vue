<script setup lang="ts">
import { computed, onMounted, ref, type Component } from "vue"
import { useI18n } from "vue-i18n"
import { Archive, HardDrive, MessageSquareText, RefreshCw, Trash2 } from "@lucide/vue"
import {
  cleanupStorage,
  getStorageSummary,
  type StorageCategory,
  type StorageCategoryId,
  type StorageSummary,
} from "@/api/piClient"
import { formatBytes, formatDateTime } from "@/lib/format"
import { formatCodedError } from "@/lib/backendError"
import { navigate } from "@/lib/router"
import { useUiStore } from "@/stores/conversations"
import { Button } from "@/components/ui/button"
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
const summary = ref<StorageSummary | null>(null)
const loading = ref(true)
const refreshing = ref(false)
const error = ref("")
const busy = ref<StorageCategoryId | null>(null)
const pendingCleanup = ref<StorageCategory | null>(null)

const categoryUi: Record<StorageCategoryId, { icon: Component; bar: string; iconColor: string }> = {
  sessions: { icon: MessageSquareText, bar: "bg-blue-500", iconColor: "text-blue-500" },
  archivedSessions: { icon: Archive, bar: "bg-violet-500", iconColor: "text-violet-500" },
}

const categories = computed(() => summary.value?.categories ?? [])
const pendingTitle = computed(() => (pendingCleanup.value ? t(`storage.categories.${pendingCleanup.value.id}`) : ""))
const pendingDescription = computed(() => {
  if (!pendingCleanup.value) return ""
  return t("storage.cleanupArchivedConfirm", { size: formatBytes(pendingCleanup.value.bytes) })
})

function isCleanable(id: StorageCategoryId) {
  return id === "archivedSessions"
}

function percentage(bytes: number) {
  return summary.value?.totalBytes ? (bytes / summary.value.totalBytes) * 100 : 0
}

async function load() {
  if (refreshing.value) return
  refreshing.value = true
  error.value = ""
  try {
    summary.value = await getStorageSummary()
  } catch (e) {
    error.value = formatCodedError(t, e)
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

async function confirmCleanup() {
  const target = pendingCleanup.value
  if (!target || busy.value || !isCleanable(target.id)) return
  pendingCleanup.value = null
  busy.value = target.id
  error.value = ""
  try {
    const result = await cleanupStorage(target.id)
    summary.value = await getStorageSummary()
    if (result.failed) {
      ui.pushToast(
        t("storage.cleanedPartial", {
          count: result.failed,
          size: formatBytes(result.freedBytes),
        }),
        "error",
      )
    } else {
      ui.pushToast(t("storage.cleaned", { size: formatBytes(result.freedBytes) }), "info")
    }
  } catch (e) {
    error.value = formatCodedError(t, e)
    // The operation may have completed partially before an error.
    try {
      summary.value = await getStorageSummary()
    } catch {
      // Preserve the actionable cleanup error if the refresh also fails.
    }
  } finally {
    busy.value = null
  }
}

onMounted(load)
</script>

<template>
  <div class="max-w-4xl space-y-5">
    <div v-if="loading" class="flex items-center gap-2 py-10 text-sm text-muted-foreground">
      <RefreshCw :size="16" class="animate-spin" />
      {{ t("storage.loading") }}
    </div>

    <template v-else-if="summary">
      <section class="rounded-xl border border-border/60 bg-card p-4">
        <div class="flex items-start gap-3">
          <div class="rounded-lg bg-primary/10 p-2 text-primary">
            <HardDrive :size="20" />
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-sm text-muted-foreground">{{ t("storage.total") }}</p>
            <p class="mt-0.5 text-2xl font-semibold tabular-nums">{{ formatBytes(summary.totalBytes) }}</p>
          </div>
          <Button variant="outline" size="sm" class="gap-2" :disabled="refreshing || !!busy" @click="load">
            <RefreshCw :size="14" :class="{ 'animate-spin': refreshing }" />
            {{ t("storage.refresh") }}
          </Button>
        </div>
        <div
          class="mt-4 flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-muted"
          role="img"
          :aria-label="t('storage.total')"
        >
          <div
            v-for="category in categories"
            :key="category.id"
            v-show="category.bytes > 0"
            :class="categoryUi[category.id].bar"
            :style="{ width: `${percentage(category.bytes)}%` }"
            :title="`${t(`storage.categories.${category.id}`)} · ${formatBytes(category.bytes)}`"
          />
        </div>
        <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
          <span v-for="category in categories" :key="category.id" class="flex items-center gap-1.5">
            <span class="size-2 rounded-full" :class="categoryUi[category.id].bar" />
            {{ t(`storage.categories.${category.id}`) }}
          </span>
        </div>
      </section>

      <p
        v-if="error"
        class="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        {{ error }}
      </p>

      <div class="grid gap-3 md:grid-cols-2">
        <section
          v-for="category in categories"
          :key="category.id"
          class="flex min-w-0 flex-col rounded-xl border border-border/60 p-4"
        >
          <div class="flex items-start gap-3">
            <component
              :is="categoryUi[category.id].icon"
              :size="18"
              class="mt-0.5 shrink-0"
              :class="categoryUi[category.id].iconColor"
            />
            <div class="min-w-0 flex-1">
              <h3 class="text-sm font-medium">{{ t(`storage.categories.${category.id}`) }}</h3>
              <p class="mt-0.5 text-xs text-muted-foreground">
                {{ t("storage.sessionCount", { count: category.itemCount }) }}
              </p>
            </div>
            <span class="shrink-0 text-sm font-semibold tabular-nums">{{ formatBytes(category.bytes) }}</span>
          </div>
          <p class="mt-3 flex-1 text-xs leading-5 text-muted-foreground">
            {{ t(`storage.descriptions.${category.id}`) }}
          </p>
          <div v-if="category.id === 'archivedSessions'" class="mt-3 flex flex-wrap justify-end gap-2">
            <Button
              v-if="category.id === 'archivedSessions'"
              variant="ghost"
              size="sm"
              class="mr-auto gap-2"
              @click="navigate('/settings/archives')"
            >
              <Archive :size="14" />
              {{ t("storage.manageArchives") }}
            </Button>
            <Button
              v-if="isCleanable(category.id)"
              variant="outline"
              size="sm"
              class="gap-2"
              :disabled="!category.bytes || !!busy || refreshing"
              @click="pendingCleanup = category"
            >
              <RefreshCw v-if="busy === category.id" :size="14" class="animate-spin" />
              <Trash2 v-else :size="14" />
              {{ t("storage.clean") }}
            </Button>
          </div>
        </section>
      </div>

      <footer class="space-y-1 text-xs text-muted-foreground">
        <p>{{ t("storage.scopeNote") }}</p>
        <p>{{ t("storage.scannedAt", { time: formatDateTime(summary.scannedAt) }) }}</p>
      </footer>
    </template>

    <div v-else class="space-y-3 py-6 text-sm">
      <p class="text-destructive">{{ error }}</p>
      <Button variant="outline" class="gap-2" @click="load">
        <RefreshCw :size="14" />
        {{ t("storage.reload") }}
      </Button>
    </div>

    <Dialog
      :open="!!pendingCleanup"
      @update:open="
        (open: boolean) => {
          if (!open && !busy) pendingCleanup = null
        }
      "
    >
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t("storage.cleanupTitle", { name: pendingTitle }) }}</DialogTitle>
          <DialogDescription>{{ pendingDescription }}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="pendingCleanup = null">{{ t("common.cancel") }}</Button>
          <Button variant="destructive" @click="confirmCleanup">
            {{ t("storage.confirmClean") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
