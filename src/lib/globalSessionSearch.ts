import { searchSessions, sshConnectionList, sshSessionSearch, type SessionSearchHit } from "@/api/piClient"
import { normalizeProjectPath } from "@/lib/paths"
import { buildRemoteUri, isRemoteProject, parseRemoteUri, resolveSshConnectionId } from "@/lib/ssh"

export interface GlobalSessionSearchHit extends SessionSearchHit {
  /** Local cwd or remote display URI used when resuming the session. */
  path: string
}

export interface GlobalSessionSearchApi {
  searchLocal(query: string): Promise<SessionSearchHit[]>
  searchRemote(project: string, connectionId: string, query: string): Promise<SessionSearchHit[]>
  listConnections: typeof sshConnectionList
}

const defaultApi: GlobalSessionSearchApi = {
  searchLocal: searchSessions,
  searchRemote: sshSessionSearch,
  listConnections: sshConnectionList,
}

/** Preserve the remote endpoint identity while replacing only its project path. */
export function remoteSessionProject(project: string, cwd: string): string {
  const remote = parseRemoteUri(project)
  if (!remote || !cwd) return project
  switch (remote.kind) {
    case "ssh":
      return buildRemoteUri({ kind: "ssh", target: { ...remote.target, path: cwd } })
    case "wsl":
      return buildRemoteUri({ kind: "wsl", target: { ...remote.target, path: cwd } })
    case "docker":
      return buildRemoteUri({ kind: "docker", target: { ...remote.target, path: cwd } })
  }
}

export function mergeGlobalSessionSearchHits(
  groups: GlobalSessionSearchHit[][],
  limit = 100,
): GlobalSessionSearchHit[] {
  const unique = new Map<string, GlobalSessionSearchHit>()
  for (const hit of groups.flat()) {
    const key = `${hit.path}\0${hit.session.file}`
    const previous = unique.get(key)
    if (!previous || (!previous.snippet && hit.snippet)) unique.set(key, hit)
  }
  return [...unique.values()]
    .sort((a, b) => b.session.mtimeMs - a.session.mtimeMs || a.session.file.localeCompare(b.session.file))
    .slice(0, limit)
}

/** Run local and unique remote-endpoint searches, retaining partial results. */
export async function performGlobalSessionSearch(
  query: string,
  projects: string[],
  api: GlobalSessionSearchApi = defaultApi,
): Promise<{ results: GlobalSessionSearchHit[]; failed: boolean }> {
  const tasks: Promise<GlobalSessionSearchHit[]>[] = [
    api.searchLocal(query).then(hits => hits.map(hit => ({ ...hit, path: normalizeProjectPath(hit.session.cwd) }))),
  ]
  const remoteProjects = [...new Set(projects.filter(isRemoteProject))]
  let failed = false
  let connections: Awaited<ReturnType<GlobalSessionSearchApi["listConnections"]>> = []
  if (remoteProjects.length) {
    try {
      connections = await api.listConnections()
    } catch {
      failed = true
    }
  }
  const searchedConnections = new Set<string>()
  for (const project of remoteProjects) {
    const connectionId = resolveSshConnectionId(project, connections)
    if (!connectionId) {
      failed = true
      continue
    }
    if (searchedConnections.has(connectionId)) continue
    searchedConnections.add(connectionId)
    tasks.push(
      api.searchRemote(project, connectionId, query).then(hits =>
        hits.map(hit => ({
          ...hit,
          path: remoteSessionProject(project, hit.session.cwd),
        })),
      ),
    )
  }
  const settled = await Promise.allSettled(tasks)
  const groups: GlobalSessionSearchHit[][] = []
  for (const result of settled) {
    if (result.status === "fulfilled") groups.push(result.value)
    else failed = true
  }
  return { results: mergeGlobalSessionSearchHits(groups), failed }
}
