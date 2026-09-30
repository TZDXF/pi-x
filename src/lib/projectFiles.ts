import { normalizeSlashes } from "./paths"
import { buildFileTree, type FileTreeNode } from "./reviewFileTree"

export interface ProjectFileEntry {
  name: string
  path: string
  is_dir: boolean
}

export interface FilePreview {
  kind: "text" | "image" | "binary"
  text: string | null
  truncated: boolean
  mime: string | null
  data: string | null
}

/** Static file sources use the same directory entries as the project's lazy directory loader. */
export function fileDirectoryEntries(files: string[], filter = ""): Record<string, ProjectFileEntry[]> {
  const query = normalizeSlashes(filter.trim()).toLowerCase()
  const paths = [...new Set(files.map(normalizeSlashes))].filter(path => path.toLowerCase().includes(query))
  const result: Record<string, ProjectFileEntry[]> = Object.create(null)
  function append(nodes: FileTreeNode[], parent: string) {
    result[parent] = nodes.map(node => ({ name: node.name, path: node.fullPath, is_dir: !node.file }))
    for (const node of nodes) if (!node.file) append(node.children, node.fullPath)
  }
  append(buildFileTree(paths.map(path => ({ path }))), "")
  return result
}
