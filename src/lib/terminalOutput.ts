/** Client-side routing for globally broadcast PTY output. Owner tokens identify
 *  a creation request before its terminal id returns; they are not authorization. */
export interface TerminalOutput {
  id: number
  owner?: string | null
  data: string
}

export function createTerminalOutputRouter(write: (id: number, data: string) => boolean) {
  const requests = new Map<string, { id: number | null; chunks: string[] }>()

  function begin() {
    const owner =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `terminal-${Date.now()}-${Math.random().toString(36).slice(2)}`
    requests.set(owner, { id: null, chunks: [] })
    return owner
  }

  function accept(output: TerminalOutput) {
    const request = output.owner ? requests.get(output.owner) : undefined
    if (!request || (request.id !== null && request.id !== output.id)) return
    request.id = output.id
    if (!write(output.id, output.data)) request.chunks.push(output.data)
  }

  function bind(owner: string, id: number) {
    const request = requests.get(owner)
    if (!request || (request.id !== null && request.id !== id)) return false
    request.id = id
    return true
  }

  function flush(id: number) {
    for (const request of requests.values()) {
      if (request.id !== id) continue
      // Preserve order and retain the buffer if the xterm instance is not ready.
      let flushed = 0
      while (flushed < request.chunks.length && write(id, request.chunks[flushed])) flushed++
      if (flushed) request.chunks.splice(0, flushed)
      return
    }
  }

  function cancel(owner: string) {
    const id = requests.get(owner)?.id ?? null
    requests.delete(owner)
    return id
  }

  function release(id: number) {
    for (const [owner, request] of requests) {
      if (request.id === id) requests.delete(owner)
    }
  }

  function clear() {
    const ids = [...requests.values()].flatMap(request => (request.id === null ? [] : [request.id]))
    requests.clear()
    return ids
  }

  return {
    begin,
    accept,
    bind,
    flush,
    cancel,
    release,
    clear,
    get bufferedChunkCount() {
      return [...requests.values()].reduce((count, request) => count + request.chunks.length, 0)
    },
  }
}
