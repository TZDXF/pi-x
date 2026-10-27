import { readonly, ref, type Ref } from "vue"

interface LocalPreferenceOptions<T> {
  key: string
  defaultValue: T | (() => T)
  validate?: (value: unknown) => value is T
  serialize?: (value: T) => string
  parse?: (raw: string) => unknown
  read?: (raw: string | null) => T
  onChange?: (value: T) => void
  throwOnWriteError?: boolean
}

/** A validated localStorage ref with cross-window sync and HMR cleanup. */
export function createLocalPreference<T>(options: LocalPreferenceOptions<T>) {
  const fallback = () =>
    typeof options.defaultValue === "function" ? (options.defaultValue as () => T)() : options.defaultValue

  function read(): T {
    try {
      const raw = localStorage.getItem(options.key)
      if (options.read) return options.read(raw)
      if (raw === null) return fallback()
      const value = options.parse ? options.parse(raw) : raw
      return !options.validate || options.validate(value) ? (value as T) : fallback()
    } catch {
      return fallback()
    }
  }

  const state = ref(read()) as Ref<T>

  function set(value: T) {
    try {
      localStorage.setItem(options.key, options.serialize ? options.serialize(value) : String(value))
    } catch (error) {
      if (options.throwOnWriteError) throw error
    }
    state.value = value
    options.onChange?.(value)
  }

  function sync(event: StorageEvent) {
    if (event.key !== options.key && event.key !== null) return
    state.value = read()
    options.onChange?.(state.value)
  }

  if (typeof window !== "undefined") {
    window.addEventListener("storage", sync)
    if (import.meta.hot) import.meta.hot.dispose(() => window.removeEventListener("storage", sync))
  }
  options.onChange?.(state.value)

  return { value: readonly(state), set, read }
}
