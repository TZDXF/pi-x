import { invoke } from "@/api/transport"
import { listen } from "@/api/transport"
import { terminalConnectionId } from "@/lib/sshTrust"
import type { CsvPage } from "@/lib/csvTable"
import { sshConnectionList } from "./ssh"

export async function invokeProjectFile<T>(
  command: "list_project_directory" | "read_file_preview",
  project: string,
  path: string,
): Promise<T> {
  const sshConnectionId = await terminalConnectionId(project, sshConnectionList)
  return invoke<T>(command, { project, path, sshConnectionId })
}

/**
 * Read one slice of a project CSV/TSV for the table preview. Rows are parsed by
 * the backend and only a bounded window comes back, so a large sheet never
 * becomes one IPC payload. A returned slice may be **shorter than `limit`**
 * when the backend hits its byte budget: callers continue from
 * `offset + page.rows.length`, never from `offset + limit`.
 */
export async function readCsvPage(project: string, path: string, offset: number, limit: number): Promise<CsvPage> {
  const sshConnectionId = await terminalConnectionId(project, sshConnectionList)
  return invoke<CsvPage>("read_csv_page", { project, path, offset, limit, sshConnectionId })
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
