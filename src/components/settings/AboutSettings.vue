<script setup lang="ts">
/** About page: product logo, description, and hint text. */
import { useI18n } from "vue-i18n"
import PiXLogo from "@/components/PiXLogo.vue"

const { t } = useI18n()
</script>

<template>
  <div class="setting-row">
    <div>
      <h3><PiXLogo /></h3>
      <p>{{ t("settings.aboutBody") }}</p>
    </div>
  </div>
  <p class="text-muted-foreground mt-6 text-xs">
    {{ t("settings.aboutHint") }}
  </p>
</template>
