import { onScopeDispose, ref, watch, type Ref } from "vue"
import { performGlobalSessionSearch, type GlobalSessionSearchHit } from "@/lib/globalSessionSearch"

const SEARCH_DEBOUNCE_MS = 250

/** Debounced global search with stale-response suppression across rapid typing. */
export function useGlobalSessionSearch(
  query: Ref<string>,
  open: Ref<boolean>,
  projects: () => string[],
  search: typeof performGlobalSessionSearch = performGlobalSessionSearch,
) {
  const results = ref<GlobalSessionSearchHit[]>([])
  const searching = ref(false)
  const failed = ref(false)
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  async function run(version: number, value: string) {
    const outcome = await search(value, projects())
    if (version !== generation) return
    results.value = outcome.results
    failed.value = outcome.failed
    searching.value = false
  }

  watch(
    [query, open],
    ([value, isOpen]) => {
      if (timer) clearTimeout(timer)
      const version = ++generation
      results.value = []
      failed.value = false
      const valueToSearch = value.trim()
      if (!isOpen || !valueToSearch) {
        searching.value = false
        return
      }
      searching.value = true
      timer = setTimeout(() => void run(version, valueToSearch), SEARCH_DEBOUNCE_MS)
    },
    { flush: "sync" },
  )

  onScopeDispose(() => {
    generation += 1
    if (timer) clearTimeout(timer)
  })
  return { results, searching, failed }
}
