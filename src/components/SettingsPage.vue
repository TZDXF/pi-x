<script setup lang="ts">
/** Full-page workspace settings, routed via #/settings/:tab.
 *  Tabs are declared in ./settings/tabs.ts and lazy-loaded per route. */
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { ArrowLeft } from "@lucide/vue"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { isDesktop } from "@/api/transport"
import { useRoute, navigate, goHome } from "@/lib/router"
import { DEFAULT_SETTINGS_TAB, SETTINGS_TAB_DEFS, type SettingsTabDef } from "@/components/settings/tabs"

const props = defineProps<{ project?: string }>()

const route = useRoute()
const { t } = useI18n()

const visibleTabs = computed(() => SETTINGS_TAB_DEFS.filter((d) => isDesktop || !d.desktopOnly))

// Guard the tab param: unknown or desktop-only tabs fall back to the default.
const active = computed<SettingsTabDef>(
  () => visibleTabs.value.find((d) => d.id === route.value.params.tab)
    ?? SETTINGS_TAB_DEFS.find((d) => d.id === DEFAULT_SETTINGS_TAB)!,
)
</script>

<template>
  <div class="settings-page flex-1 min-h-0 grid [grid-template-columns:190px_minmax(0,_1fr)] overflow-hidden max-[640px]:[grid-template-columns:125px_minmax(0,_1fr)]">
    <nav class="settings-nav bg-sidebar border-r border-border pt-5 pr-3.5 pb-7 pl-3.5 flex flex-col gap-[5px] min-h-0 min-w-0 max-[640px]:py-6 max-[640px]:px-2" :aria-label="t('settings.nav')">
      <Button variant="ghost" size="sm" class="settings-back [align-self:flex-start] mt-0 mr-0 mb-1.5 ml-0 py-2.5 px-3 text-[13px] text-muted-foreground hover:bg-border hover:text-foreground" @click="goHome()">
        <ArrowLeft :size="16" />
        {{ t("settings.back") }}
      </Button>
      <h2 class="px-3 pb-4.5 text-base font-semibold">{{ t("settings.title") }}</h2>
      <ul class="settings-menu [list-style:none] m-0 p-0 flex flex-col gap-[5px] w-full">
        <li v-for="def in visibleTabs" :key="def.id">
          <Button variant="quiet" size="content" class="w-full justify-start rounded-[7px] px-3 py-2.5 text-left text-[13px] text-foreground hover:bg-border" :class="{ 'bg-border': active.id === def.id }" @click="navigate(`/settings/${def.id}`)">
            {{ t(def.nav) }}
          </Button>
        </li>
      </ul>
    </nav>
    <ScrollArea :key="active.id" class="settings-scroll min-h-0 h-full">
      <div class="settings-body min-w-0 py-9.5 px-9 wrap-anywhere max-[640px]:py-9.5 max-[640px]:px-4.5">
        <header class="settings-header mb-7.5 text-left">
          <h1 class="text-lg font-semibold">{{ t(active.title) }}</h1>
          <p v-if="active.desc" class="mt-1.5 text-xs text-muted-foreground">{{ t(active.desc) }}</p>
        </header>
        <component :is="active.component" v-bind="active.needsProject ? { project: props.project } : {}" />
      </div>
    </ScrollArea>
  </div>
</template>
