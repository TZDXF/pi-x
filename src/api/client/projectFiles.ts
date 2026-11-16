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

/** Start watching for one subscriber; subscriptions are reference counted per root. */
export const watchProjectFiles = (project: string, subscriber: string) =>
  invoke<void>("watch_project_files", { project, subscriber })

/** Release this subscriber only; other tabs on the same root keep watching. */
export const unwatchProjectFiles = (project: string, subscriber: string) =>
  invoke<void>("unwatch_project_files", { project, subscriber })

/** Declare the directories/files this subscriber shows; reports are the union across tabs. */
export const setProjectFilesInterest = (project: string, subscriber: string, paths: string[]) =>
  invoke<void>("set_project_files_interest", { project, subscriber, paths })

/** Directory/file changes inside watched project roots, coalesced by the backend. */
export function onProjectFilesChanged(handler: (change: ProjectFilesChanged) => void): Promise<() => void> {
  return listen<ProjectFilesChanged>("pi://project-files-changed", event => handler(event.payload))
}
