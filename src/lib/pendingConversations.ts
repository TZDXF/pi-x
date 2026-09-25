/** Pending new sessions may already have a file path, but no history row yet. */
export function pendingConversations<T extends { cwd: string; sessionFile: string | null; promptQueue: { text: string }[] }>(
  conversations: T[], folders: string[], knownFiles: string[], query: string,
): T[] {
  const normalize = (path: string) => path.replace(/\\/g, "/")
  const files = new Set(knownFiles.map(normalize))
  return conversations.filter(item => item.promptQueue.length > 0
    && folders.some(folder => normalize(folder) === normalize(item.cwd))
    && (!item.sessionFile || !files.has(normalize(item.sessionFile)))
    && item.promptQueue.some(prompt => prompt.text.toLowerCase().includes(query.toLowerCase())))
}
