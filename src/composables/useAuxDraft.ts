import { onBeforeUnmount, ref, watch, type Ref } from "vue"
import type PromptInputBridge from "@/components/PromptInputBridge.vue"
import { auxDraftFor, saveAuxDraft } from "@/stores/auxDrafts"

/**
 * aux 面板的草稿接线：**仅内存**（`stores/auxDrafts.ts`），不写 `pix.composerDrafts`、
 * 也不走 `useComposerDraftSync` 的公共键。
 *
 * 附件只保留原始 `File`：预览用的 blob URL 归 `PromptInput` 所有（它的
 * `onBeforeUnmount` 会 revoke），把 URL 存进 Map 会在重挂载后指向已撤销的 blob。
 */
export function useAuxDraft(runtimeId: string, bridge: Ref<InstanceType<typeof PromptInputBridge> | null>) {
  const initialDraft = auxDraftFor(runtimeId).text
  /** 已把原始 File 放回输入框（每次挂载只做一次，避免重复添加同一批附件）。 */
  const restored = ref(false)

  function persist() {
    const current = bridge.value
    if (!current) return
    const files = (current.files ?? []).map(file => file.file).filter((file): file is File => !!file)
    saveAuxDraft(runtimeId, { text: current.textInput ?? "", files })
  }

  const stopText = watch(
    () => bridge.value?.textInput,
    (text, previous) => {
      if (previous === undefined) return
      if (typeof text !== "string") return
      persist()
    },
  )
  const stopFiles = watch(
    () => (bridge.value?.files ?? []).map(file => file.id).join("|"),
    (next, previous) => {
      if (previous === undefined || next === previous) return
      persist()
    },
  )
  const stopBridge = watch(bridge, current => {
    if (!current || restored.value) return
    const files = auxDraftFor(runtimeId).files
    if (!files.length) return
    restored.value = true
    // `addFiles` 会为每个 File 生成新的 blob URL（旧 URL 只属于上一份挂载的组件）。
    current.addFiles(files)
  })

  onBeforeUnmount(() => {
    persist()
    stopText()
    stopFiles()
    stopBridge()
  })

  return { initialDraft, persist }
}
