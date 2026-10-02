import { invoke } from "../transport"

export interface HostedSkill {
  name: string
  description: string
  path: string
  kind: "directory" | "file"
  enabled: boolean
}
export const listHostedSkills = () => invoke<HostedSkill[]>("skills_hosted_list")
export const openHostedSkillsDirectory = () => invoke<void>("skills_hosted_open_dir")
export const deleteHostedSkill = (path: string) => invoke<void>("skills_hosted_delete", { path })
export const setHostedSkillsEnabled = (paths: string[]) => invoke<void>("skills_hosted_set_enabled", { paths })

/** A skill Pi discovers outside the hosted skills, including package skills (read-only). */
export interface DiscoveredSkill {
  name: string
  description: string
  path: string
  hosted: boolean
  sourceKind: "globalPi" | "globalAgents" | "packageGlobal" | "settingsGlobal"
  sourceName: string | null
}
export const listDiscoveredSkills = () => invoke<DiscoveredSkill[]>("skills_discovered_list")

/** List files inside a skill (relative posix paths) for preview. */
export const skillListFiles = (path: string) => invoke<string[]>("skills_list_files", { path })

/** Read one file inside a skill for preview; relPath is relative to the skill root. */
export const skillReadFile = (path: string, relPath: string) => invoke<string>("skills_read_file", { path, relPath })
