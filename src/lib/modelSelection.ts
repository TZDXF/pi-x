export interface SelectableModel {
  provider: string
  id: string
  name?: string
}

/** Preserve provider and model order from the caller, without mutating its list. */
export function groupModelsByProvider<T extends SelectableModel>(models: readonly T[]) {
  const grouped = new Map<string, T[]>()
  for (const model of models) {
    const list = grouped.get(model.provider) ?? []
    list.push(model)
    grouped.set(model.provider, list)
  }
  return [...grouped.entries()].map(([provider, models]) => ({ provider, models }))
}
