import { invoke } from "@/api/transport"
import { listen } from "@/api/transport"
import { terminalConnectionId } from "@/lib/sshTrust"
import { sshConnectionList } from "./ssh"

export async function invokeProjectFile<T>(
  command: "list_project_directory" | "read_file_preview",
  project: string,
  path: string,
): Promise<T> {
  const sshConnectionId = await terminalConnectionId(project, sshConnectionList)
  return invoke<T>(command, { project, path, sshConnectionId })
}

/** Payload of `pi://project-files-changed`: changes inside the browsed scope. */
export interface ProjectFilesChanged {
  project: string
  /** Project-relative paths that changed. */
  paths: string[]
  /** The watch was re-armed or lost its root: reload every loaded directory. */
  reset: boolean
}

/** Start the backend watch for a local project directory (reference counted by root). */
export const watchProjectFiles = (project: string) => invoke<void>("watch_project_files", { project })

/** Release one watcher subscription; the OS watch ends with the last one. */
export const unwatchProjectFiles = (project: string) => invoke<void>("unwatch_project_files", { project })

/** Declare the directories/files on screen so unrelated churn is filtered out. */
export const setProjectFilesInterest = (project: string, paths: string[]) =>
  invoke<void>("set_project_files_interest", { project, paths })

/** Directory/file changes inside watched project roots, coalesced by the backend. */
export function onProjectFilesChanged(handler: (change: ProjectFilesChanged) => void): Promise<() => void> {
  return listen<ProjectFilesChanged>("pi://project-files-changed", event => handler(event.payload))
}
