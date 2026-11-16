export const nowMs = () => (typeof performance === "undefined" ? Date.now() : performance.now())

export interface DebouncedFunction<Args extends unknown[]> {
  (...args: Args): void
  cancel: () => void
}

export function debounce<Args extends unknown[]>(fn: (...args: Args) => void, delay: number): DebouncedFunction<Args> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const debounced = (...args: Args) => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      fn(...args)
    }, delay)
  }
  debounced.cancel = () => {
    clearTimeout(timer)
    timer = undefined
  }
  return debounced
}
