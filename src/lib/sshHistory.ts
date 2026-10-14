/**
 * SSH 连接历史记录（对齐 ZCode RemoteConnectionHistoryInput）。
 *
 * 存储最近连接的 host / port / user / keyPath，用于表单自动补全。
 * 数据持久化到 localStorage，按最近使用顺序去重。
 */

export interface SshHistoryEntry {
  host: string
  port: number
  user: string
  keyPath: string
  /** ISO 时间戳，用于排序 */
  lastUsedAt: string
}

const STORAGE_KEY = "pix.ssh.connectionHistory"
const MAX_ENTRIES = 50

/** 读取历史记录（按 lastUsedAt 降序）。 */
export function loadSshHistory(): SshHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const entries = JSON.parse(raw) as SshHistoryEntry[]
    return entries
      .filter(e => e && e.host)
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
  } catch {
    return []
  }
}

/** 添加或更新历史记录（按 host+port+user+keyPath 去重，更新 lastUsedAt）。 */
export function addSshHistoryEntry(entry: Omit<SshHistoryEntry, "lastUsedAt">): void {
  const entries = loadSshHistory()
  const key = `${entry.host}:${entry.port}:${entry.user}:${entry.keyPath}`
  const existingIndex = entries.findIndex(
    e => `${e.host}:${e.port}:${e.user}:${e.keyPath}` === key,
  )
  const newEntry: SshHistoryEntry = {
    ...entry,
    lastUsedAt: new Date().toISOString(),
  }
  if (existingIndex >= 0) {
    entries.splice(existingIndex, 1)
  }
  entries.unshift(newEntry)
  // 限制数量
  if (entries.length > MAX_ENTRIES) {
    entries.length = MAX_ENTRIES
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // localStorage 不可用时静默忽略
  }
}

/** 获取去重后的候选列表（按最近使用顺序）。 */
export function getSshHistorySuggestions(): {
  hosts: string[]
  ports: string[]
  users: string[]
  keyPaths: string[]
} {
  const entries = loadSshHistory()
  const seen = {
    hosts: new Set<string>(),
    ports: new Set<string>(),
    users: new Set<string>(),
    keyPaths: new Set<string>(),
  }
  const result: {
    hosts: string[]
    ports: string[]
    users: string[]
    keyPaths: string[]
  } = { hosts: [], ports: [], users: [], keyPaths: [] }

  for (const entry of entries) {
    if (!seen.hosts.has(entry.host)) {
      seen.hosts.add(entry.host)
      result.hosts.push(entry.host)
    }
    const port = String(entry.port)
    if (!seen.ports.has(port)) {
      seen.ports.add(port)
      result.ports.push(port)
    }
    if (entry.user && !seen.users.has(entry.user)) {
      seen.users.add(entry.user)
      result.users.push(entry.user)
    }
    if (entry.keyPath && !seen.keyPaths.has(entry.keyPath)) {
      seen.keyPaths.add(entry.keyPath)
      result.keyPaths.push(entry.keyPath)
    }
  }
  return result
}

/** 清除所有历史记录。 */
export function clearSshHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // 忽略
  }
}
