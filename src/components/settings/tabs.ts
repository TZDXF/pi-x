/** Settings tab registry: each tab is a route (#/settings/:tab) whose panel is
 *  lazy-loaded on first visit. Add a new settings page by appending an entry. */
import { defineAsyncComponent, type Component } from "vue"
import type { SettingsTab } from "@/lib/router"

export interface SettingsTabDef {
  id: SettingsTab
  /** i18n key for the nav label. */
  nav: string
  /** i18n key for the panel heading. */
  title: string
  /** Optional i18n key for the heading description. */
  desc?: string
  /** Hidden on the web build; deep links fall back to the default tab. */
  desktopOnly?: boolean
  /** Receives the current chat project path as the `project` prop. */
  needsProject?: boolean
  component: Component
}

/** Default tab when the route param is missing or not applicable. */
export const DEFAULT_SETTINGS_TAB: SettingsTab = "general"

export const SETTINGS_TAB_DEFS: readonly SettingsTabDef[] = [
  {
    id: "general",
    nav: "settings.general",
    title: "settings.generalTitle",
    component: defineAsyncComponent(() => import("./GeneralSettings.vue")),
  },
  {
    id: "remote",
    nav: "settings.remote",
    title: "settings.remote",
    desc: "settings.remoteDesc",
    component: defineAsyncComponent(() => import("./RemoteSettings.vue")),
  },
  {
    id: "archive",
    nav: "sessionArchive.title",
    title: "sessionArchive.title",
    desc: "sessionArchive.description",
    component: defineAsyncComponent(() => import("./ArchiveSettings.vue")),
  },
  {
    id: "packages",
    nav: "packages.title",
    title: "packages.title",
    desc: "packages.description",
    needsProject: true,
    component: defineAsyncComponent(() => import("./packages/PackageSettings.vue")),
  },
  {
    id: "models",
    nav: "settings.providersModels",
    title: "settings.providersModelsTitle",
    desc: "settings.providersModelsDesc",
    desktopOnly: true,
    component: defineAsyncComponent(() => import("./ModelsSettings.vue")),
  },
  {
    id: "model-config",
    nav: "titleGeneration.page",
    title: "titleGeneration.page",
    desktopOnly: true,
    component: defineAsyncComponent(() => import("./TitleModelSettings.vue")),
  },
  {
    id: "agent-config",
    nav: "agentConfig.title",
    title: "agentConfig.title",
    desc: "agentConfig.description",
    desktopOnly: true,
    component: defineAsyncComponent(() => import("./AgentSettings.vue")),
  },
  {
    id: "skills",
    nav: "skillsConfig.title",
    title: "skillsConfig.title",
    desktopOnly: true,
    needsProject: true,
    component: defineAsyncComponent(() => import("./SkillSettings.vue")),
  },
  {
    id: "about",
    nav: "settings.about",
    title: "settings.aboutTitle",
    component: defineAsyncComponent(() => import("./AboutSettings.vue")),
  },
]