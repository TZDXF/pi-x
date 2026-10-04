/** Discovery of provider-advertised models via the provider "/models" endpoint. */
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { fetchProviderModels, type FetchedModel, type ProviderEntry } from "@/api/piClient"
import { resolveModelsListBaseUrl } from "@/lib/providerBaseUrl"

export function useModelFetch(provider: () => ProviderEntry | undefined) {
  const { t } = useI18n()

  /** Models discovered via the endpoint (null = not fetched yet). */
  const fetched = ref<FetchedModel[] | null>(null)
  const fetching = ref(false)
  const fetchError = ref<string | null>(null)
  const query = ref("")

  /** Fetched models filtered by the in-popover search box. */
  const filtered = computed(() => {
    const list = fetched.value
    if (!list) return []
    const q = query.value.trim().toLowerCase()
    if (!q) return list
    return list.filter(m => m.id.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q))
  })

  /** Load the provider-advertised model list (once unless forced). */
  async function load(force = false) {
    const p = provider()
    if (!p || fetching.value) return
    if (!force && fetched.value !== null) return
    if (!p.baseUrl?.trim()) {
      fetched.value = null
      fetchError.value = t("settings.modelFetchNoBaseUrl")
      return
    }
    fetching.value = true
    fetchError.value = null
    try {
      // The provider URL may be a gateway root; the listing endpoint always
      // needs the version-segment prefix for the API style.
      const baseUrl = resolveModelsListBaseUrl(p.baseUrl, p.api ?? "openai-completions")
      fetched.value = await fetchProviderModels({ ...p, baseUrl })
    } catch (e) {
      fetched.value = null
      fetchError.value = String(e)
    } finally {
      fetching.value = false
    }
  }

  /** Reset transient state when switching providers. */
  watch(provider, () => {
    fetched.value = null
    fetching.value = false
    fetchError.value = null
    query.value = ""
  })

  return { fetched, fetching, fetchError, query, filtered, load }
}
