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
    id: "appearance",
    nav: "settings.appearance",
    title: "settings.appearanceTitle",
    desc: "settings.appearanceDesc",
    component: defineAsyncComponent(() => import("./AppearanceSettings.vue")),
  },
  {
    id: "shortcuts",
    nav: "settings.shortcutsNav",
    title: "settings.shortcutsTitle",
    desc: "settings.shortcutsDesc",
    component: defineAsyncComponent(() => import("./ShortcutsSettings.vue")),
  },
  {
    id: "notifications",
    nav: "settings.notifications",
    title: "settings.notifications",
    desc: "settings.notificationsDesc",
    component: defineAsyncComponent(() => import("./NotificationSettings.vue")),
  },
  {
    id: "remote",
    nav: "settings.remote",
    title: "settings.remote",
    desc: "settings.remoteDesc",
    desktopOnly: true,
    component: defineAsyncComponent(() => import("./RemoteSettings.vue")),
  },
  {
    id: "ssh",
    nav: "ssh.nav",
    title: "ssh.title",
    desc: "ssh.desc",
    desktopOnly: true,
    component: defineAsyncComponent(() => import("./SshSettings.vue")),
  },
  {
    id: "models",
    nav: "settings.providersModels",
    title: "settings.providersModelsTitle",
    desc: "settings.providersModelsDesc",
    component: defineAsyncComponent(() => import("./ModelsSettings.vue")),
  },
  {
    id: "run-config",
    nav: "settings.runConfigNav",
    title: "settings.runConfigTitle",
    desc: "settings.runConfigDesc",
    component: defineAsyncComponent(() => import("./RunConfigSettings.vue")),
  },
  {
    id: "model-config",
    nav: "titleGeneration.page",
    title: "titleGeneration.page",
    component: defineAsyncComponent(() => import("./ModelConfigSettings.vue")),
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
    id: "package-resources",
    nav: "packages.title",
    title: "packages.resourcesNav",
    component: defineAsyncComponent(() => import("./packages/PackageResourcePage.vue")),
  },
  {
    id: "agent-config",
    nav: "agentConfig.title",
    title: "agentConfig.title",
    desc: "agentConfig.description",
    component: defineAsyncComponent(() => import("./AgentSettings.vue")),
  },
  {
    id: "skills",
    nav: "skillsConfig.title",
    title: "skillsConfig.title",
    component: defineAsyncComponent(() => import("./SkillSettings.vue")),
  },
  {
    id: "mcp",
    nav: "mcpConfig.title",
    title: "mcpConfig.title",
    desc: "mcpConfig.description",
    needsProject: true,
    component: defineAsyncComponent(() => import("./McpSettings.vue")),
  },
  {
    id: "archives",
    nav: "sessionArchive.nav",
    title: "sessionArchive.title",
    desc: "sessionArchive.description",
    component: defineAsyncComponent(() => import("@/components/ArchivedSessionsPage.vue")),
  },
  {
    id: "about",
    nav: "settings.about",
    title: "settings.aboutTitle",
    component: defineAsyncComponent(() => import("./AboutSettings.vue")),
  },
]

export type SettingsGroupId = "general" | "capabilities" | "other"

export interface SettingsGroupDef {
  id: SettingsGroupId
  /** i18n key for the collapsed menu section heading. */
  labelKey: string
  /** Settings tabs rendered inside this section, in display order. */
  tabIds: readonly SettingsTab[]
}

/** The visible information architecture; unknown deep links fall back to the default tab. */
export const SETTINGS_GROUP_DEFS: readonly SettingsGroupDef[] = [
  {
    id: "general",
    labelKey: "settings.groups.general",
    tabIds: ["general", "appearance", "models", "shortcuts", "notifications", "remote", "ssh"],
  },
  {
    id: "capabilities",
    labelKey: "settings.groups.capabilities",
    tabIds: ["run-config", "agent-config", "packages", "skills", "mcp"],
  },
  {
    id: "other",
    labelKey: "settings.groups.other",
    tabIds: ["model-config", "archives", "about"],
  },
]

export function settingsGroupForTab(tabId: SettingsTab): SettingsGroupDef {
  return SETTINGS_GROUP_DEFS.find(group => group.tabIds.includes(tabId)) ?? SETTINGS_GROUP_DEFS[0]!
}
