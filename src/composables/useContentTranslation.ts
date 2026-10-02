import { computed, onScopeDispose, ref, watch, type Ref, type WatchSource } from "vue"

export function useContentTranslation(options: {
  source: WatchSource<unknown>
  locale: Ref<string>
  translate: (content: string, language: string) => Promise<string>
  onError: (error: unknown) => void
}) {
  const translating = ref(false)
  const translated = ref("")
  const targetLang = computed(() => (options.locale.value === "zh-CN" ? "Simplified Chinese" : "English"))
  let request = 0
  let disposed = false

  function invalidate() {
    ++request
    translating.value = false
    translated.value = ""
  }
  // Invalidate before a queued promise can write back after a file/resource/locale change.
  watch([options.source, options.locale], invalidate, { flush: "sync" })
  onScopeDispose(() => {
    disposed = true
    invalidate()
  })

  async function translate(content: string) {
    if (disposed || !content.trim() || translating.value) return
    const current = ++request
    translating.value = true
    translated.value = ""
    try {
      const text = await options.translate(content, targetLang.value)
      if (current === request) translated.value = text
    } catch (error) {
      if (current === request) options.onError(error)
    } finally {
      if (current === request) translating.value = false
    }
  }

  return { translating, translated, translate }
}
