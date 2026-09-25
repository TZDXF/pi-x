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
  <div class="settings-page">
    <nav class="settings-nav" :aria-label="t('settings.nav')">
      <Button variant="ghost" size="sm" class="settings-back" @click="goHome()">
        <ArrowLeft :size="16" />
        {{ t("settings.back") }}
      </Button>
      <h2>{{ t("settings.title") }}</h2>
      <ul class="settings-menu">
        <li v-for="def in visibleTabs" :key="def.id">
          <button :class="{ active: active.id === def.id }" @click="navigate(`/settings/${def.id}`)">
            {{ t(def.nav) }}
          </button>
        </li>
      </ul>
    </nav>
    <ScrollArea :key="active.id" class="settings-scroll">
      <div class="settings-body">
        <header class="settings-header">
          <h1>{{ t(active.title) }}</h1>
          <p v-if="active.desc">{{ t(active.desc) }}</p>
        </header>
        <component :is="active.component" v-bind="active.needsProject ? { project: props.project } : {}" />
      </div>
    </ScrollArea>
  </div>
</template>