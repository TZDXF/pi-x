<script setup lang="ts">
/** Providers & models page: composes provider and model management sections. */
import { useI18n } from "vue-i18n"
import { Separator } from "@/components/ui/separator"
import ProviderSettings from "@/components/ProviderSettings.vue"
import ModelSettings from "@/components/ModelSettings.vue"

const { t } = useI18n()
</script>

<template>
  <p class="text-muted-foreground mb-4 text-xs">{{ t("settings.modelsFileHint") }}</p>
  <h3 class="settings-section">{{ t("settings.providers") }}</h3>
  <ProviderSettings />
  <Separator class="my-6" />
  <h3 class="settings-section">{{ t("settings.models") }}</h3>
  <ModelSettings />
</template>
