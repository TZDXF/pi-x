import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { ThinkingLevel } from "@/api/protocol"
import type { SessionStore } from "@/stores/session"
import { modelKey as formatModelKey, parseModelKey } from "@/lib/modelKey"

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
      return m ? formatModelKey(m) : ""
    },
    set: (key: string) => {
      const model = parseModelKey(key)
      if (!model) return
      if (!options.connected()) {
        session.setDesiredModel(key)
        return
      }
      session.setModel(model.provider, model.id).catch(e => options.onError(e))
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
