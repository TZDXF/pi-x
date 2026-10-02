import { invoke } from "../transport"

// ---- pi package management (official catalog + pi install/remove/update) ----

export interface CatalogPackage {
  name: string
  description: string
  author: string
  /** Downloads in the last month. */
  downloadsMonth: number
  /** Last publish time, unix epoch ms. */
  updatedMs: number
  /** Resource types: extension / skill / prompt / theme / package. */
  types: string[]
  /** Install source, e.g. "npm:pi-mcp-adapter". */
  source: string
  detailUrl: string
  npmUrl: string | null
}

export interface InstalledPackage {
  /** Install source as stored in settings.json. */
  source: string
  scope: "global" | "project"
  /** Resource filters when the object form is used (verbatim passthrough). */
  filters: Record<string, unknown> | null
}

export interface CatalogPage {
  packages: CatalogPackage[]
  hasMore: boolean
}

/** Search the official pi package catalog (pi.dev/packages). */
export const packageCatalog = (query = "", sort = "downloads", packageType = "", page = 1) =>
  invoke<CatalogPage>("package_catalog", { query, sort, packageType, page })

/** Installed packages from global settings and the given project's settings. */
export const packageList = (project?: string) =>
  invoke<InstalledPackage[]>("package_list", { project: project ?? null })

/** Install a package; scope "project" installs project-locally (pi install -l). */
export const packageInstall = (source: string, scope: "global" | "project" = "global", project?: string) =>
  invoke<string>("package_install", { source, scope, project: project ?? null })

/** Remove a package by its source string as shown in packageList. */
export const packageRemove = (source: string, scope: "global" | "project" = "global", project?: string) =>
  invoke<string>("package_remove", { source, scope, project: project ?? null })

/** Update one package, or all packages when source is omitted. */
export const packageUpdate = (source?: string) => invoke<string>("package_update", { source: source ?? null })

/** One loadable resource (extension / skill / prompt / theme file) of an installed package. */
export interface PackageResource {
  resourceType: "extensions" | "skills" | "prompts" | "themes"
  /** Path relative to the package root. */
  path: string
  enabled: boolean
}

/** List an installed package's resources with their enabled state. */
export const packageResources = (source: string, scope: "global" | "project", project?: string) =>
  invoke<PackageResource[]>("package_resources", { source, scope, project: project ?? null })

/** Enable or disable one resource of an installed package (writes +path / -path filters). */
/** List every file inside an installed package (relative posix paths). */
export const packageListFiles = (source: string, scope: "global" | "project", project?: string) =>
  invoke<string[]>("package_list_files", { source, scope, project: project ?? null })

/** Read one file inside an installed package for preview. */
export const packageReadFile = (source: string, scope: "global" | "project", path: string, project?: string) =>
  invoke<string>("package_read_file", { source, scope, path, project: project ?? null })

/** Translate content using the configured translation model. */
export const packageTranslate = (content: string, targetLang: string) =>
  invoke<string>("package_translate", { content, targetLang })

export const packageSetResource = (
  source: string,
  scope: "global" | "project",
  resourceType: PackageResource["resourceType"],
  path: string,
  enabled: boolean,
  project?: string,
) =>
  invoke<void>("package_set_resource", {
    source,
    scope,
    resourceType,
    path,
    enabled,
    project: project ?? null,
  })

/** Normalize an install source ("npm:@scope/pkg@1.2.3", "pkg", "@scope/pkg") to a bare package name. */
export function packageNameOf(source: string): string {
  let s = source.trim()
  if (s.startsWith("npm:")) s = s.slice(4)
  // strip version/tag suffix, keeping scoped names intact (@scope/pkg@1.0 → @scope/pkg)
  const at = s.lastIndexOf("@")
  if (at > 0) s = s.slice(0, at)
  return s
}
