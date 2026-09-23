<script setup lang="ts">
/** Full-page workspace settings, routed via #/settings/:tab. */
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { ArrowLeft } from "@lucide/vue"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { isDesktop } from "@/api/transport"
import { useRoute, isSettingsTab, navigate, goHome, type SettingsTab } from "@/lib/router"
import RemoteSettings from "@/components/settings/RemoteSettings.vue"
import GeneralSettings from "@/components/settings/GeneralSettings.vue"
import ArchiveSettings from "@/components/settings/ArchiveSettings.vue"
import ModelsSettings from "@/components/settings/ModelsSettings.vue"
import AboutSettings from "@/components/settings/AboutSettings.vue"
import AgentSettings from "@/components/AgentSettings.vue"
import SkillSettings from "@/components/SkillSettings.vue"
import TitleModelSettings from "@/components/TitleModelSettings.vue"
import PackageSettings from "@/components/PackageSettings.vue"

const props = defineProps<{ project?: string }>()

const route = useRoute()
const { t } = useI18n()

const DESKTOP_ONLY = new Set(["models", "agent-config", "skills", "model-config"])

// Guard the tab param: desktop-only tabs fall back to "general" on the web.
const tab = computed<SettingsTab>(() => {
  const requested = route.value.params.tab
  if (isSettingsTab(requested) && (isDesktop || !DESKTOP_ONLY.has(requested))) return requested
  return "general"
})

function selectTab(value: SettingsTab) {
  navigate(`/settings/${value}`)
}

const headings = computed(() => {
  switch (tab.value) {
    case "remote": return { title: t("settings.remote"), desc: t("settings.remoteDesc") }
    case "general": return { title: t("settings.generalTitle"), desc: "" }
    case "archive": return { title: t("sessionArchive.title"), desc: t("sessionArchive.description") }
    case "models": return { title: t("settings.providersModelsTitle"), desc: t("settings.providersModelsDesc") }
    case "model-config": return { title: t("titleGeneration.page"), desc: "" }
    case "packages": return { title: t("packages.title"), desc: t("packages.description") }
    case "about": return { title: t("settings.aboutTitle"), desc: "" }
    case "agent-config": return { title: t("agentConfig.title"), desc: t("agentConfig.description") }
    case "skills": return { title: t("skillsConfig.title"), desc: "" }
    default: return { title: t("settings.generalTitle"), desc: "" }
  }
})
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
        <li><button :class="{ active: tab === 'general' }" @click="selectTab('general')">{{ t("settings.general") }}</button></li>
        <li><button :class="{ active: tab === 'remote' }" @click="selectTab('remote')">{{ t("settings.remote") }}</button></li>
        <li><button :class="{ active: tab === 'archive' }" @click="selectTab('archive')">{{ t("sessionArchive.title") }}</button></li>
        <li><button :class="{ active: tab === 'packages' }" @click="selectTab('packages')">{{ t("packages.title") }}</button></li>
        <li v-if="isDesktop"><button :class="{ active: tab === 'models' }" @click="selectTab('models')">{{ t("settings.providersModels") }}</button></li>
        <li v-if="isDesktop"><button :class="{ active: tab === 'model-config' }" @click="selectTab('model-config')">{{ t("titleGeneration.page") }}</button></li>
        <li v-if="isDesktop"><button :class="{ active: tab === 'agent-config' }" @click="selectTab('agent-config')">{{ t("agentConfig.title") }}</button></li>
        <li v-if="isDesktop"><button :class="{ active: tab === 'skills' }" @click="selectTab('skills')">{{ t("skillsConfig.title") }}</button></li>
        <li><button :class="{ active: tab === 'about' }" @click="selectTab('about')">{{ t("settings.about") }}</button></li>
      </ul>
    </nav>
    <ScrollArea :key="tab" class="settings-scroll">
      <div class="settings-body">
        <header class="settings-header">
          <h1>{{ headings?.title }}</h1>
          <p v-if="headings?.desc">{{ headings.desc }}</p>
        </header>
        <AgentSettings v-if="isDesktop && tab === 'agent-config'" />
        <SkillSettings v-else-if="isDesktop && tab === 'skills'" />
        <RemoteSettings v-else-if="tab === 'remote'" />
        <GeneralSettings v-else-if="tab === 'general'" />
        <ArchiveSettings v-else-if="tab === 'archive'" />
        <ModelsSettings v-else-if="isDesktop && tab === 'models'" />
        <TitleModelSettings v-else-if="isDesktop && tab === 'model-config'" />
        <PackageSettings v-else-if="tab === 'packages'" :active="tab === 'packages'" :project="props.project" />
        <AboutSettings v-else-if="tab === 'about'" />
      </div>
    </ScrollArea>
  </div>
</template>
