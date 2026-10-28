<script setup lang="ts">
/** 用量/成本汇总面板（设置 → 用量统计）：聚合 pi 会话文件中的 token/cost，仅本地会话。 */
import { computed, onMounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { CircleDollarSign, ExternalLink, Hash, Layers, RotateCw, SquareStack } from "@lucide/vue"
import { fetchUsageSummary, type UsageSummary, type UsageTotals } from "@/api/usage"
import { compactNumber, formatDateTime } from "@/lib/format"
import { navigate, sessionRoute } from "@/lib/router"
import { tBackendError } from "@/i18n"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useWorkspaceStore } from "@/stores/workspace"

const { t } = useI18n()
const workspace = useWorkspaceStore()

const summary = ref<UsageSummary | null>(null)
const loading = ref(false)
const error = ref("")
// Select 的值是字符串；"all" 表示不过滤项目，"0" 表示全部历史。
const days = ref("30")
const projectFilter = ref("all")
const metric = ref<"cost" | "tokens">("cost")

const ranges = ["7", "30", "90", "0"] as const

async function load() {
  loading.value = true
  error.value = ""
  try {
    summary.value = await fetchUsageSummary(
      Number(days.value),
      projectFilter.value === "all" ? null : projectFilter.value,
    )
  } catch (e) {
    error.value = tBackendError(e)
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch([days, projectFilter], load)

/** 项目过滤下拉：当前汇总里出现过的项目（选中项若不在列表中也要保留）。 */
const projectOptions = computed(() => {
  const seen = new Map<string, string>()
  for (const row of summary.value?.byProject ?? [])
    if (!seen.has(row.project)) seen.set(row.project, workspace.projectName(row.project))
  if (projectFilter.value !== "all" && !seen.has(projectFilter.value))
    seen.set(projectFilter.value, workspace.projectName(projectFilter.value))
  return [...seen.entries()].map(([cwd, name]) => ({ cwd, name })).sort((a, b) => a.name.localeCompare(b.name))
})

function formatCost(cost: number): string {
  if (!cost) return "$0"
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(2)}`
}

const totals = computed<UsageTotals>(
  () =>
    summary.value?.totals ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: 0,
      messages: 0,
    },
)
const summaryCards = computed(() => [
  { icon: CircleDollarSign, label: t("usage.totalCost"), value: formatCost(totals.value.cost) },
  { icon: Hash, label: t("usage.totalTokens"), value: compactNumber(totals.value.totalTokens) },
  { icon: Layers, label: t("usage.sessionCount"), value: compactNumber(summary.value?.sessionsScanned ?? 0) },
  { icon: SquareStack, label: t("usage.messageCount"), value: compactNumber(totals.value.messages) },
])

const byDay = computed(() => summary.value?.byDay ?? [])
const maxDayValue = computed(() =>
  Math.max(1e-9, ...byDay.value.map(d => (metric.value === "cost" ? d.cost : d.totalTokens))),
)
function barHeight(day: { cost: number; totalTokens: number }): number {
  const value = metric.value === "cost" ? day.cost : day.totalTokens
  return Math.max(2, Math.round((value / maxDayValue.value) * 100))
}
function barValue(day: { cost: number; totalTokens: number }): string {
  return metric.value === "cost" ? formatCost(day.cost) : compactNumber(day.totalTokens)
}

const label = (row: { name: string | null; file: string }) => row.name || t("sidebar.untitled")
function openSession(file: string, project: string) {
  navigate(sessionRoute(file, project))
}
</script>

<template>
  <div class="space-y-5">
    <div class="flex flex-wrap items-center gap-3">
      <Select v-model="days">
        <SelectTrigger class="w-36 shrink-0 text-xs" :aria-label="t('usage.range')">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="value in ranges" :key="value" :value="value">
            {{ t(value === "0" ? "usage.rangeAll" : "usage.rangeDays", { days: value }) }}
          </SelectItem>
        </SelectContent>
      </Select>
      <Select v-model="projectFilter">
        <SelectTrigger class="w-48 shrink-0 text-xs" :aria-label="t('sessionArchive.filter')">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{{ t("sessionArchive.filterAll") }}</SelectItem>
          <SelectItem v-for="p in projectOptions" :key="p.cwd" :value="p.cwd">{{ p.name }}</SelectItem>
        </SelectContent>
      </Select>
      <Select v-model="metric">
        <SelectTrigger class="w-32 shrink-0 text-xs" :aria-label="t('usage.metric')">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="cost">{{ t("usage.metricCost") }}</SelectItem>
          <SelectItem value="tokens">{{ t("usage.metricTokens") }}</SelectItem>
        </SelectContent>
      </Select>
      <Button variant="outline" size="sm" class="h-8 shrink-0 gap-2 px-3 text-xs" :disabled="loading" @click="load">
        <RotateCw :size="14" :class="{ 'animate-spin': loading }" />
        {{ t("sessionArchive.refresh") }}
      </Button>
    </div>

    <p v-if="error" class="text-sm text-destructive break-words">{{ error }}</p>
    <p v-else-if="loading && !summary" class="text-sm text-muted-foreground">{{ t("usage.loading") }}</p>
    <template v-else-if="summary">
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div v-for="card in summaryCards" :key="card.label" class="rounded-lg border border-border/60 p-3">
          <p class="flex items-center gap-1.5 text-xs text-muted-foreground">
            <component :is="card.icon" :size="13" />{{ card.label }}
          </p>
          <p class="mt-1 text-xl font-semibold tabular-nums">{{ card.value }}</p>
        </div>
      </div>
      <p class="text-xs text-muted-foreground">
        {{
          t("usage.tokenBreakdown", {
            input: compactNumber(totals.input),
            output: compactNumber(totals.output),
            cacheRead: compactNumber(totals.cacheRead),
            cacheWrite: compactNumber(totals.cacheWrite),
          })
        }}
      </p>

      <section v-if="byDay.length" class="rounded-lg border border-border/60 p-3">
        <h3 class="text-sm font-medium">{{ t("usage.dailyTitle") }}</h3>
        <div class="mt-3 flex h-28 items-end gap-0.5">
          <div
            v-for="day in byDay"
            :key="day.day"
            class="flex min-w-[3px] flex-1 flex-col justify-end"
            :title="`${day.day} · ${barValue(day)}`"
          >
            <div class="w-full rounded-sm bg-primary/70" :style="{ height: `${barHeight(day)}%` }" />
          </div>
        </div>
        <div class="mt-1 flex justify-between text-[11px] text-muted-foreground tabular-nums">
          <span>{{ byDay[0]?.day }}</span>
          <span>{{ byDay[byDay.length - 1]?.day }}</span>
        </div>
      </section>

      <section v-if="summary.byProject.length" class="overflow-hidden rounded-lg border border-border/60">
        <header class="border-b border-border/60 bg-muted/40 px-3 py-2 text-sm font-medium">
          {{ t("usage.byProject") }}
        </header>
        <ul class="divide-y divide-border/60">
          <li v-for="row in summary.byProject" :key="row.project" class="flex items-center gap-3 px-3 py-2 text-sm">
            <span class="min-w-0 flex-1 truncate" :title="row.project">{{ workspace.projectName(row.project) }}</span>
            <span class="shrink-0 text-xs text-muted-foreground tabular-nums">
              {{ t("usage.sessionsShort", { count: row.sessions }) }}
            </span>
            <span class="w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{{
              compactNumber(row.totalTokens)
            }}</span>
            <span class="w-20 shrink-0 text-right font-medium tabular-nums">{{ formatCost(row.cost) }}</span>
          </li>
        </ul>
      </section>

      <section v-if="summary.byModel.length" class="overflow-hidden rounded-lg border border-border/60">
        <header class="border-b border-border/60 bg-muted/40 px-3 py-2 text-sm font-medium">
          {{ t("usage.byModel") }}
        </header>
        <ul class="divide-y divide-border/60">
          <li
            v-for="row in summary.byModel"
            :key="`${row.provider}/${row.model}`"
            class="flex items-center gap-3 px-3 py-2 text-sm"
          >
            <span class="min-w-0 flex-1 truncate" :title="`${row.provider}/${row.model}`">
              {{ row.provider }}/{{ row.model }}
            </span>
            <span class="w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{{
              compactNumber(row.totalTokens)
            }}</span>
            <span class="w-20 shrink-0 text-right font-medium tabular-nums">{{ formatCost(row.cost) }}</span>
          </li>
        </ul>
      </section>

      <section v-if="summary.sessions.length" class="overflow-hidden rounded-lg border border-border/60">
        <header class="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-3 py-2 text-sm font-medium">
          {{ t("usage.sessionsTitle") }}
          <span
            v-if="summary.truncated"
            class="ml-auto shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-normal text-muted-foreground"
          >
            {{ t("usage.truncated", { limit: summary.sessions.length }) }}
          </span>
        </header>
        <ul class="divide-y divide-border/60">
          <li v-for="row in summary.sessions" :key="row.file" class="group flex items-center gap-3 px-3 py-2 text-sm">
            <div class="min-w-0 flex-1">
              <p class="truncate" :title="label(row)">{{ label(row) }}</p>
              <p class="text-xs text-muted-foreground">
                {{ workspace.projectName(row.project) }} · {{ formatDateTime(row.lastAt) }}
              </p>
            </div>
            <span class="w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{{
              compactNumber(row.totalTokens)
            }}</span>
            <span class="w-20 shrink-0 text-right font-medium tabular-nums">{{ formatCost(row.cost) }}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              class="shrink-0 text-muted-foreground hover:text-foreground"
              :title="t('usage.openSession')"
              :aria-label="t('usage.openSession')"
              @click="openSession(row.file, row.project)"
            >
              <ExternalLink :size="15" />
            </Button>
          </li>
        </ul>
      </section>

      <p v-if="!summary.sessionsScanned" class="py-8 text-center text-sm text-muted-foreground">
        {{ t("usage.empty") }}
      </p>
      <p class="text-xs text-muted-foreground">{{ t("usage.sourceNote") }}</p>
    </template>
  </div>
</template>
