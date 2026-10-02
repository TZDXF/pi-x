import { invoke } from "../transport"

export interface FileHit {
  path: string
  name: string
  dir: string
}

export const searchFiles = (project: string, query: string) => invoke<FileHit[]>("search_files", { project, query })

export const openPath = (path: string) => invoke<void>("open_path", { path })

export const openTerminalInDir = (dir: string) => invoke<void>("open_terminal_in_dir", { dir })
