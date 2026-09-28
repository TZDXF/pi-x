import type { InjectionKey, Ref } from "vue"
import { inject } from "vue"

export interface ThinkingContextValue {
  isStreaming: Ref<boolean>
  isOpen: Ref<boolean>
  /** 收起后延迟卸载标记:收起动画期间保持内容挂载,动画结束再卸载重 DOM。 */
  shouldRenderContent: Ref<boolean>
  setIsOpen: (open: boolean) => void
  duration: Ref<number | undefined>
}

export const ThinkingKey: InjectionKey<ThinkingContextValue> = Symbol("ThinkingContext")

export function useThinkingContext() {
  const ctx = inject<ThinkingContextValue>(ThinkingKey)
  if (!ctx) throw new Error("Thinking components must be used within <Thinking>")
  return ctx
}
