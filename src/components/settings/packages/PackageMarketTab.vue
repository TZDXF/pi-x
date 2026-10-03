<script setup lang="ts">
/** Marketplace tab: search, filter and install packages from the pi.dev catalog. */
import { useI18n } from "vue-i18n"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Download, ExternalLink } from "@lucide/vue"
import { openExternal } from "@/lib/hostBridge"
import type { PackagesContext } from "./usePackages"

const props = defineProps<{ ctx: PackagesContext }>()
const { t } = useI18n()

const { query, sortBy, typeFilter, catalogHasMore, catalog, catalogLoading, catalogError, busy } = props.ctx
const {
  loadCatalog,
  loadMoreCatalog,
  install,
  chooseProjectForInstall,
  scopesOf,
  typeLabel,
  fmtDownloads,
  fmtUpdated,
} = props.ctx
</script>

<template>
  <div class="mb-3 flex items-center gap-2">
    <Input v-model="query" :placeholder="t('packages.searchPlaceholder')" class="h-8 flex-1" />
    <Select v-model="sortBy">
      <SelectTrigger class="h-8 w-32 shrink-0"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="downloads">{{ t("packages.sortDownloads") }}</SelectItem>
        <SelectItem value="updated">{{ t("packages.sortUpdated") }}</SelectItem>
        <SelectItem value="name">{{ t("packages.sortName") }}</SelectItem>
      </SelectContent>
    </Select>
  </div>

  <div class="mb-3 flex flex-wrap items-center gap-1.5">
    <Button
      v-for="tf in ['all', 'extension', 'skill', 'prompt', 'theme']"
      :key="tf"
      :variant="typeFilter === tf ? 'default' : 'outline'"
      size="sm"
      class="h-7 px-2.5 text-xs"
      @click="typeFilter = tf"
    >
      {{ tf === "all" ? t("packages.typeAll") : t(`packages.types.${tf}`) }}
    </Button>
  </div>

  <div v-if="catalogLoading && !catalog.length" class="flex items-center justify-center gap-2 py-12">
    <Spinner class="size-4" />
    <span class="text-muted-foreground text-sm">{{ t("packages.loading") }}</span>
  </div>
  <div v-else-if="catalogError && !catalog.length" class="py-8 text-center">
    <p class="text-destructive text-sm">{{ catalogError }}</p>
    <Button variant="outline" size="sm" class="mt-3" @click="loadCatalog">
      {{ t("packages.retry") }}
    </Button>
  </div>
  <p v-else-if="!catalog.length" class="text-muted-foreground py-8 text-center text-sm">
    {{ t("packages.empty") }}
  </p>

  <div v-else class="grid gap-3">
    <div v-for="p in catalog" :key="p.name" class="rounded-md border p-3">
      <div class="flex flex-wrap items-center gap-2">
        <h4 class="text-sm font-medium">{{ p.name }}</h4>
        <Badge v-for="tp in p.types" :key="tp" variant="secondary">{{ typeLabel(tp) }}</Badge>
        <Badge v-if="scopesOf(p.name).size" variant="outline" class="text-chart-2">
          {{ t("packages.installedBadge") }}
        </Badge>
      </div>
      <p v-if="p.description" class="text-muted-foreground mt-1 line-clamp-2 text-xs">
        {{ p.description }}
      </p>
      <p class="text-muted-foreground mt-1.5 text-xs">
        {{ p.author }} · {{ fmtDownloads(p.downloadsMonth) }}/{{ t("packages.perMonth") }}
        <template v-if="p.updatedMs"> · {{ fmtUpdated(p.updatedMs) }}</template>
      </p>
      <div class="mt-2 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          :disabled="busy !== null || scopesOf(p.name).has('global')"
          @click="install(p.source, 'global')"
        >
          <Spinner v-if="busy === `install:${p.source}`" class="size-3" />
          <Download v-else :size="14" />
          {{ scopesOf(p.name).has("global") ? t("packages.installedBadge") : t("packages.install") }}
        </Button>
        <Button variant="outline" size="sm" :disabled="busy !== null" @click="chooseProjectForInstall(p.source)">
          {{ t("packages.installProject") }}
        </Button>
        <Button variant="ghost" size="sm" @click="openExternal(p.detailUrl)">
          <ExternalLink :size="14" />
          {{ t("packages.details") }}
        </Button>
        <code class="text-muted-foreground ml-auto hidden font-mono text-xs sm:block"> pi install {{ p.source }} </code>
      </div>
    </div>
  </div>
  <div v-if="catalog.length && catalogHasMore" class="mt-3 text-center">
    <p v-if="catalogError" class="text-destructive mb-2 text-sm">{{ catalogError }}</p>
    <Button variant="outline" size="sm" :disabled="catalogLoading" @click="loadMoreCatalog">
      <Spinner v-if="catalogLoading" class="size-4" />
      {{ t(catalogError ? "packages.retry" : "packages.loadMore") }}
    </Button>
  </div>
</template>
