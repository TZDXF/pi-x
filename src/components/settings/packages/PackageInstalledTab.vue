<script setup lang="ts">
import SectionHeading from "@/components/shared/SectionHeading.vue"
import SettingRow from "@/components/shared/SettingRow.vue"
import SettingHeading from "@/components/shared/SettingHeading.vue"
import SettingDescription from "@/components/shared/SettingDescription.vue"
/** Installed tab: custom source install plus global/project package lists. */
import { useI18n } from "vue-i18n"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Separator } from "@/components/ui/separator"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { packageNameOf, type InstalledPackage } from "@/api/piClient"
import { joinDisplayPath } from "@/lib/paths"
import { Trash2, ArrowUpCircle, Plus, SlidersHorizontal } from "@lucide/vue"
import type { PackagesContext } from "./usePackages"

const props = defineProps<{ ctx: PackagesContext }>()
const emit = defineEmits<{ manage: [pkg: InstalledPackage] }>()
const { t } = useI18n()

const { customSource, customScope, globalInstalled, projectInstalled, viewedProject, busy } = props.ctx
const { installCustom, update, remove, filterSummary } = props.ctx
</script>

<template>
  <div class="mb-4">
    <SectionHeading>{{ t("packages.customTitle") }}</SectionHeading>
    <p class="text-muted-foreground mb-2 text-xs">{{ t("packages.customHint") }}</p>
    <div class="flex items-center gap-2">
      <Input
        v-model="customSource"
        placeholder="npm:@scope/pkg / git:github.com/user/repo / ./path"
        class="h-8 flex-1 font-mono text-xs"
        @keydown.enter="installCustom"
      />
      <Select v-model="customScope">
        <SelectTrigger class="h-8 w-28 shrink-0"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="global">{{ t("packages.scopeGlobal") }}</SelectItem>
          <SelectItem value="project">{{ t("packages.scopeProject") }}</SelectItem>
        </SelectContent>
      </Select>
      <Button size="sm" :disabled="busy !== null || !customSource.trim()" @click="installCustom">
        <Plus :size="14" />
        {{ t("packages.install") }}
      </Button>
    </div>
  </div>

  <Separator class="my-4" />

  <div class="mb-2 flex items-center justify-between">
    <SectionHeading class="!mb-0">{{ t("packages.scopeGlobal") }}</SectionHeading>
    <Button v-if="globalInstalled.length" variant="outline" size="sm" :disabled="busy !== null" @click="update()">
      <Spinner v-if="busy === 'all'" class="size-3" />
      <ArrowUpCircle v-else :size="14" />
      {{ t("packages.updateAll") }}
    </Button>
  </div>
  <p v-if="!globalInstalled.length" class="text-muted-foreground py-3 text-sm">
    {{ t("packages.noneGlobal") }}
  </p>
  <SettingRow v-for="p in globalInstalled" :key="`g:${p.source}`">
    <div class="min-w-0">
      <SettingHeading class="!text-sm">{{ packageNameOf(p.source) }}</SettingHeading>
      <SettingDescription class="font-mono text-xs">{{ p.source }}</SettingDescription>
      <SettingDescription v-if="p.filters" class="text-xs">{{ filterSummary(p.filters) }}</SettingDescription>
    </div>
    <div class="flex shrink-0 gap-2">
      <Button variant="outline" size="sm" @click="emit('manage', p)">
        <SlidersHorizontal :size="14" />
        {{ t("packages.manage") }}
      </Button>
      <Button variant="outline" size="sm" :disabled="busy !== null" @click="update(p.source)">
        <Spinner v-if="busy === `update:${p.source}`" class="size-3" />
        <ArrowUpCircle v-else :size="14" />
        {{ t("packages.update") }}
      </Button>
      <Button variant="outline" size="sm" :disabled="busy !== null" @click="remove(p)">
        <Spinner v-if="busy === `remove:${p.source}`" class="size-3" />
        <Trash2 v-else :size="14" />
        {{ t("packages.remove") }}
      </Button>
    </div>
  </SettingRow>

  <template v-if="viewedProject">
    <Separator class="my-4" />
    <SectionHeading>{{ t("packages.scopeProject") }}</SectionHeading>
    <p class="text-muted-foreground mb-2 font-mono text-xs">
      {{ joinDisplayPath(viewedProject, ".pi", "settings.json") }}
    </p>
    <p v-if="!projectInstalled.length" class="text-muted-foreground py-3 text-sm">
      {{ t("packages.noneProject") }}
    </p>
    <SettingRow v-for="p in projectInstalled" :key="`p:${p.source}`">
      <div class="min-w-0">
        <SettingHeading class="!text-sm">{{ packageNameOf(p.source) }}</SettingHeading>
        <SettingDescription class="font-mono text-xs">{{ p.source }}</SettingDescription>
        <SettingDescription v-if="p.filters" class="text-xs">{{ filterSummary(p.filters) }}</SettingDescription>
      </div>
      <div class="flex shrink-0 gap-2">
        <Button variant="outline" size="sm" @click="emit('manage', p)">
          <SlidersHorizontal :size="14" />
          {{ t("packages.manage") }}
        </Button>
        <Button variant="outline" size="sm" :disabled="busy !== null" @click="remove(p)">
          <Spinner v-if="busy === `remove:${p.source}`" class="size-3" />
          <Trash2 v-else :size="14" />
          {{ t("packages.remove") }}
        </Button>
      </div>
    </SettingRow>
  </template>

  <p class="text-muted-foreground mt-6 text-xs">{{ t("packages.restartHint") }}</p>
</template>
