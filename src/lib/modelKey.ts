export interface ModelKeyRef {
  provider: string
  id: string
}

export function modelKey(model: ModelKeyRef): string {
  return `${model.provider}/${model.id}`
}

/** Provider IDs cannot contain `/`; model IDs may, so split only at the first separator. */
export function parseModelKey(key: string): ModelKeyRef | null {
  const separator = key.indexOf("/")
  if (separator <= 0 || separator === key.length - 1) return null
  return { provider: key.slice(0, separator), id: key.slice(separator + 1) }
}
