import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref, type WatchStopHandle } from "vue"
import { useI18n } from "vue-i18n"
import type { Conversation } from "@/components/ai-elements/conversation"
import type { SelectionPopupState } from "@/components/chat/ConversationSelectionPopup.vue"
import { CONVERSATION_SELECTION_MAX_COUNT, type ConversationSelectionSource } from "@/lib/conversationSelections"
import { boundaryRect, restoreSelection, selectionEndRect } from "@/lib/selectionAnchors"
import { useConversationSelectionsStore } from "@/stores/conversationSelections"
import type { SessionStore } from "@/stores/session"
import type { UiStore } from "@/stores/ui"

/** 对话划词引用（对齐 ZCode conversation selections）：选中文本暂存 composer，
 *  随下一条消息以 "# userselect:" 尾块发出。引用按会话归属；
 *  提交后在划词结束处渲染索引数字标记，支持定位与回显编辑。 ----
 *  依赖会话（引用按 sessionFile 归属）、列表根元素（锚点定位）与
 *  renderedEntries（布局变化时惰性重算锚点）。 */
export function useSelectionQuotes(deps: {
  session: SessionStore
  ui: UiStore
  /** 当前项目路径 getter：引用作用域的回退键（无文件会话时）。 */
  project: () => string
  /** 列表投影 getter：锚点深监听只在有引用时挂载（见 syncSelectionAnchors）。 */
  renderedEntries: () => unknown
  conversation: Ref<InstanceType<typeof Conversation> | null>
}) {
  const { session, ui, conversation } = deps
  const { t } = useI18n()
  const selectionStore = useConversationSelectionsStore()
  const selectionScope = computed(() => session.sessionFile ?? deps.project())
  const selectionRoot = computed<HTMLElement | null>(() => (conversation.value?.$el as HTMLElement | undefined) ?? null)
  const pendingSelections = computed(() => (selectionStore.scope === selectionScope.value ? selectionStore.items : []))
  const selectionPopup = ref<(SelectionPopupState & { id?: string }) | null>(null)
  function pushSelectionToast(result: { ok: boolean; reason?: string; duplicate?: boolean }) {
    if (!result.ok) {
      if (result.reason === "count")
        ui.pushToast(t("chat.selectionLimitCount", { count: CONVERSATION_SELECTION_MAX_COUNT }), "error")
      else if (result.reason === "total") ui.pushToast(t("chat.selectionLimitTotal"), "error")
      else ui.pushToast(t("chat.selectionLimitSingle"), "error")
    } else if (result.duplicate) ui.pushToast(t("chat.selectionDuplicate"))
  }
  // 点击"引用到输入框"立即入库：批注可选，稍后通过索引标记或摘要列表补充。
  function onSelectionQuote(payload: {
    text: string
    source: ConversationSelectionSource
    messageId: number
    startOffset: number
    endOffset: number
  }) {
    const result = selectionStore.add(selectionScope.value, { ...payload })
    pushSelectionToast(result)
    window.getSelection()?.removeAllRanges()
  }
  function onSelectionSave(comment: string) {
    const id = selectionPopup.value?.id
    if (id) selectionStore.update(id, comment)
    selectionPopup.value = null
    window.getSelection()?.removeAllRanges()
  }
  function onSelectionRemove() {
    const id = selectionPopup.value?.id
    if (id) selectionStore.remove(id)
    selectionPopup.value = null
    window.getSelection()?.removeAllRanges()
  }
  function onSelectionCancel() {
    selectionPopup.value = null
    window.getSelection()?.removeAllRanges()
  }
  // ---- 索引标记覆盖层：按引用在列表中的序号渲染到划词结束处（布局变化时重算） ----
  const anchorOverlays = ref<Map<number, { id: string; index: number; left: number; top: number }[]>>(new Map())
  async function recomputeAnchors() {
    const root = selectionRoot.value
    const map = new Map<number, { id: string; index: number; left: number; top: number }[]>()
    if (root) {
      pendingSelections.value.forEach((item, index) => {
        const wrapper = root.querySelector(`[data-message-id="${item.messageId}"] [data-selection-source]`)
        if (!wrapper) return
        const rect = boundaryRect(wrapper, item.endOffset)
        const wrapperRect = wrapper.getBoundingClientRect()
        if (!rect) return
        const list = map.get(item.messageId) ?? []
        list.push({
          id: item.id,
          index: index + 1,
          left: rect.right - wrapperRect.left + 2,
          // 徽标抬到划词末行上方，避免盖住正文文字。
          top: rect.top - wrapperRect.top - 16,
        })
        map.set(item.messageId, list)
      })
    }
    anchorOverlays.value = map
  }
  /** 划词引用存在时才随布局变化重算锚点。深度监听 renderedEntries 会在流式
   *  回复的每个 chunk 上触发对整个列表的深遍历；没有引用时零开销，因此仅在
   *  pendingSelections 非空时才挂载该深监听，清空后立即卸载。 */
  function syncSelectionAnchors() {
    // 编辑态弹窗对应的引用被删除/清空时同步关闭。
    const popup = selectionPopup.value
    if (popup?.id && !pendingSelections.value.some(item => item.id === popup.id)) selectionPopup.value = null
    void nextTick(recomputeAnchors)
  }
  let anchorsWatcher: WatchStopHandle | undefined
  onBeforeUnmount(() => anchorsWatcher?.())
  watch(
    () => pendingSelections.value.length,
    count => {
      if (count > 0 && anchorsWatcher === undefined) {
        anchorsWatcher = watch([deps.renderedEntries, pendingSelections], syncSelectionAnchors, {
          deep: true,
          immediate: true,
        })
      } else if (count === 0 && anchorsWatcher !== undefined) {
        anchorsWatcher()
        anchorsWatcher = undefined
        // 引用已清空：同步关闭弹窗并直接丢弃锚点覆盖层。
        const popup = selectionPopup.value
        if (popup?.id) selectionPopup.value = null
        anchorOverlays.value = new Map()
      }
    },
    { immediate: true },
  )
  onMounted(() => {
    window.addEventListener("resize", recomputeAnchors)
  })
  onBeforeUnmount(() => {
    window.removeEventListener("resize", recomputeAnchors)
  })
  // ---- 摘要列表动作：定位（滚动到索引标记）与编辑（回显划选后打开弹窗） ----
  function locateSelection(id: string) {
    const item = pendingSelections.value.find(entry => entry.id === id)
    if (!item) return
    const badge = selectionRoot.value?.querySelector(`[data-selection-anchor="${id}"]`)
    if (badge) {
      badge.scrollIntoView({ block: "center", behavior: "smooth" })
      return
    }
    conversation.value?.scrollToMessage(item.messageId)
    void nextTick(recomputeAnchors)
  }
  async function editSelection(id: string) {
    const item = pendingSelections.value.find(entry => entry.id === id)
    if (!item) return
    locateSelection(id)
    await nextTick()
    await new Promise(resolve => requestAnimationFrame(resolve))
    const root = selectionRoot.value
    const wrapper = root?.querySelector(`[data-message-id="${item.messageId}"] [data-selection-source]`)
    let anchor: { left: number; top: number; bottom: number } | null = null
    const badge = root?.querySelector(`[data-selection-anchor="${id}"]`)
    if (wrapper && restoreSelection(wrapper, item.startOffset, item.endOffset)) {
      const selection = window.getSelection()
      if (selection?.rangeCount) {
        const endRect = selectionEndRect(selection.getRangeAt(0))
        if (endRect) anchor = { left: endRect.right, top: endRect.top, bottom: endRect.bottom }
      }
    }
    if (!anchor && badge) {
      const badgeRect = badge.getBoundingClientRect()
      anchor = { left: badgeRect.right, top: badgeRect.top, bottom: badgeRect.bottom }
    }
    if (!anchor) return
    selectionPopup.value = {
      id: item.id,
      comment: item.comment ?? "",
      anchor,
    }
  }
  return {
    selectionRoot,
    pendingSelections,
    selectionPopup,
    anchorOverlays,
    recomputeAnchors,
    locateSelection,
    editSelection,
    onSelectionQuote,
    onSelectionSave,
    onSelectionRemove,
    onSelectionCancel,
  }
}
