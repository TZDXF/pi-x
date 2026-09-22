<script setup lang="ts">
/** Categorized workspace settings and Pi runtime configuration shell. */
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { isDesktop } from "@/api/transport"
import RemoteSettings from "@/components/settings/RemoteSettings.vue"
import GeneralSettings from "@/components/settings/GeneralSettings.vue"
import ModelsSettings from "@/components/settings/ModelsSettings.vue"
import RuntimeSettings from "@/components/settings/RuntimeSettings.vue"
import AboutSettings from "@/components/settings/AboutSettings.vue"
import AgentSettings from "./AgentSettings.vue"
import SkillSettings from "./SkillSettings.vue"
import TitleModelSettings from "./TitleModelSettings.vue"
import PackageSettings from "./PackageSettings.vue"

const props = defineProps<{ open: boolean; project?: string }>()
const emit = defineEmits<{ close: [] }>()

const tab = ref("general")
const { t } = useI18n()
</script>

<template>
  <Dialog :open="props.open" @update:open="(v: boolean) => !v && emit('close')">
    <DialogContent class="settings-dialog">
      <Tabs v-model="tab" orientation="vertical" class="contents">
        <nav class="settings-nav" :aria-label="t('settings.nav')">
          <h2>{{ t("settings.title") }}</h2>
          <TabsList variant="line">
            <TabsTrigger value="remote" class="justify-start">{{ t("settings.remote") }}</TabsTrigger>
            <TabsTrigger value="general" class="justify-start">{{ t("settings.general") }}</TabsTrigger>
            <TabsTrigger v-if="isDesktop" value="models" class="justify-start">{{ t("settings.providersModels") }}</TabsTrigger>
            <TabsTrigger v-if="isDesktop" value="runtime" class="justify-start">{{ t("settings.runtime") }}</TabsTrigger>
            <TabsTrigger v-if="isDesktop" value="agent-config" class="justify-start">{{ t("agentConfig.title") }}</TabsTrigger>
            <TabsTrigger v-if="isDesktop" value="skills" class="justify-start">{{ t("skillsConfig.title") }}</TabsTrigger>
            <TabsTrigger value="packages" class="justify-start">{{ t("packages.title") }}</TabsTrigger>
            <TabsTrigger value="about" class="justify-start">{{ t("settings.about") }}</TabsTrigger>
            <TabsTrigger v-if="isDesktop" value="model-config" class="justify-start">{{ t("titleGeneration.page") }}</TabsTrigger>
          </TabsList>
          <p>{{ t("settings.subtitle") }}</p>
        </nav>
        <ScrollArea :key="tab" class="settings-scroll">
        <TabsContent v-if="isDesktop" value="agent-config" class="settings-body">
          <AgentSettings />
        </TabsContent>
        <TabsContent v-if="isDesktop" value="skills" class="settings-body">
          <SkillSettings />
        </TabsContent>
        <TabsContent value="remote" class="settings-body">
          <DialogHeader
            ><DialogTitle>{{ t("settings.remote") }}</DialogTitle
            ><DialogDescription>{{ t("settings.remoteDesc") }}</DialogDescription></DialogHeader
          >
          <RemoteSettings />
        </TabsContent>
        <TabsContent value="general" class="settings-body">
          <DialogHeader
            ><DialogTitle>{{ t("settings.generalTitle") }}</DialogTitle
            ><DialogDescription>{{ t("settings.generalDesc") }}</DialogDescription></DialogHeader
          >
          <GeneralSettings />
        </TabsContent>
        <TabsContent v-if="isDesktop" value="models" class="settings-body">
          <DialogHeader
            ><DialogTitle>{{ t("settings.providersModelsTitle") }}</DialogTitle
            ><DialogDescription>{{ t("settings.providersModelsDesc") }}</DialogDescription></DialogHeader
          >
          <ModelsSettings />
        </TabsContent>
        <TabsContent v-if="isDesktop" value="model-config" class="settings-body">
          <DialogHeader><DialogTitle>{{ t("titleGeneration.page") }}</DialogTitle>
            <DialogDescription>{{ t("titleGeneration.description") }}</DialogDescription></DialogHeader>
          <TitleModelSettings />
        </TabsContent>
        <TabsContent value="packages" class="settings-body">
          <PackageSettings :active="tab === 'packages' && props.open" :project="props.project" />
        </TabsContent>
        <TabsContent value="about" class="settings-body">
          <DialogHeader
            ><DialogTitle>{{ t("settings.aboutTitle") }}</DialogTitle
            ><DialogDescription>{{ t("settings.aboutDesc") }}</DialogDescription></DialogHeader
          >
          <AboutSettings />
        </TabsContent>
        <TabsContent v-if="isDesktop" value="runtime" class="settings-body">
          <DialogHeader>
            <DialogTitle>{{ t("settings.runtimeTitle") }}</DialogTitle
            ><DialogDescription>{{ t("settings.runtimeDesc") }}</DialogDescription>
          </DialogHeader>
          <RuntimeSettings @close="emit('close')" />
        </TabsContent>
        </ScrollArea>
      </Tabs>
    </DialogContent>
  </Dialog>
</template>
