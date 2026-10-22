import { isRemoteProject } from "@/lib/ssh"
import { normalizeProjectPath, normalizeSlashes } from "@/lib/paths"

/** Remote paths are only unique inside their project/endpoint; bare paths remain local identities. */
export function sessionIdentityKey(file: string, project?: string): string {
  return project && isRemoteProject(project)
    ? JSON.stringify([normalizeProjectPath(project), file])
    : normalizeSlashes(file)
}

export function sameSessionIdentity(
  file: string | null | undefined,
  project: string | undefined,
  otherFile: string,
  otherProject?: string,
): boolean {
  return !!file && sessionIdentityKey(file, project) === sessionIdentityKey(otherFile, otherProject)
}
