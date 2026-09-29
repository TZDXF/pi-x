import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { ThinkingLevel } from "@/api/protocol"
import type { SessionStore } from "@/stores/session"

/** Conversation model and thinking-level selection; deferred while pi starts lazily. */
export function useConversationModel(
  session: SessionStore,
  options: { connected: () => boolean; onError: (error: unknown) => void },
) {
  const { t, te } = useI18n()

  const modelKey = computed({
    get: () => {
      if (session.desiredModelKey) return session.desiredModelKey
      if (!options.connected() && session.offlineDefaultModelKey) return session.offlineDefaultModelKey
      const m = session.currentModel
      return m ? `${m.provider}/${m.id}` : ""
    },
    set: (key: string) => {
      const [provider, ...rest] = key.split("/")
      if (!options.connected()) {
        session.setDesiredModel(key)
        return
      }
      session.setModel(provider, rest.join("/")).catch(e => options.onError(e))
    },
  })

  function thinkingLabel(lv: string) {
    const key = `chat.thinkingLevels.${lv}`
    return te(key) ? t(key) : lv
  }

  function onThinkingChange(v: unknown) {
    if (typeof v !== "string") return
    if (!options.connected()) {
      session.setDesiredThinkingLevel(v as ThinkingLevel)
      return
    }
    session.setThinkingLevel(v as ThinkingLevel).catch(e => options.onError(e))
  }

  return { modelKey, thinkingLabel, onThinkingChange }
}
