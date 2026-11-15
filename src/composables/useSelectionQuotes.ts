import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref, type WatchStopHandle } from "vue"
import { useI18n } from "vue-i18n"
import type { Conversation } from "@/components/ai-elements/conversation"
import type { SelectionPopupState } from "@/components/chat/ConversationSelectionPopup.vue"
import {
  CONVERSATION_SELECTION_MAX_COUNT,
  type ConversationSelectionSource,
  type PendingConversationSelection,
} from "@/lib/conversationSelections"
import type { PendingAuxSelection } from "@/lib/auxSelection"
import { boundaryRect, flashSelection, restoreSelection, selectionEndRect } from "@/lib/selectionAnchors"
import { addAuxSelection, auxSelectionItems, removeAuxSelection, updateAuxSelection } from "@/stores/auxSelections"
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
  /**
   * aux 面板的划词（TZD-103）：指定后读写的是**该实例的桶**（`stores/auxSelections.ts`），
   * 不再碰主会话的 `conversationSelections` 单例 —— 否则 aux 里"引用到输入框"会把引用
   * 写进主会话的桶（同项目下两者 scope 相同，会真的串）。
   */
  auxRuntimeId?: string
}) {
  const { session, ui, conversation } = deps
  const { t } = useI18n()
  const selectionStore = useConversationSelectionsStore()
  const selectionScope = computed(() => session.sessionFile ?? deps.project())
  const selectionRoot = computed<HTMLElement | null>(() => (conversation.value?.$el as HTMLElement | undefined) ?? null)
  /** 两种来源的条目同形（wire 字段相同），只有定位元数据可能缺失。 */
  type SelectionItem = PendingConversationSelection | PendingAuxSelection
  const pendingSelections = computed<SelectionItem[]>(() =>
    deps.auxRuntimeId
      ? [...auxSelectionItems(deps.auxRuntimeId)]
      : selectionStore.scope === selectionScope.value
        ? selectionStore.items
        : [],
  )
  /**
   * 写入入口：主会话走单例（按 scope 归属），aux 走本实例的桶。
   * 两条路径返回同一份 `ok/reason/duplicate` 结果，提示逻辑不分叉。
   */
  function addSelection(draft: Omit<PendingConversationSelection, "id">) {
    if (deps.auxRuntimeId) return addAuxSelection(deps.auxRuntimeId, draft)
    return selectionStore.add(selectionScope.value, draft)
  }
  function updateSelection(id: string, comment: string) {
    if (deps.auxRuntimeId) updateAuxSelection(deps.auxRuntimeId, id, comment)
    else selectionStore.update(id, comment)
  }
  function removeSelection(id: string) {
    if (deps.auxRuntimeId) removeAuxSelection(deps.auxRuntimeId, id)
    else selectionStore.remove(id)
  }
  /**
   * 消息内定位所需的三元组：代码预览来源的引用没有消息 id/字符区间，跨面板定位不了，
   * 因此不渲染索引标记、也不参与定位（只作为摘要条目存在）。
   */
  function messageTarget(item: SelectionItem) {
    const { messageId, startOffset, endOffset } = item
    if (typeof messageId !== "number" || typeof startOffset !== "number" || typeof endOffset !== "number") return null
    return { messageId, startOffset, endOffset }
  }
  const selectionPopup = ref<(SelectionPopupState & { id?: string }) | null>(null)
  function pushSelectionToast(result: { ok: boolean; reason?: string; duplicate?: boolean }) {
    if (!result.ok) {
      if (result.reason === "count")
        ui.pushToast(t("chat.selectionLimitCount", { count: CONVERSATION_SELECTION_MAX_COUNT }), "error")
      else if (result.reason === "total") ui.pushToast(t("chat.selectionLimitTotal"), "error")
      else ui.pushToast(t("chat.selectionLimitSingle"), "error")
    } else if (result.duplicate) ui.pushToast(t("chat.selectionDuplicate"))
  }
  // 点击"引用到输入框"立即入库，并在当前选区末尾打开批注输入框。
  function onSelectionQuote(payload: {
    text: string
    source: ConversationSelectionSource
    messageId: number
    startOffset: number
    endOffset: number
  }) {
    const selection = window.getSelection()
    const rect = selection?.rangeCount ? selectionEndRect(selection.getRangeAt(0)) : null
    const result = addSelection({ ...payload })
    pushSelectionToast(result)
    selection?.removeAllRanges()
    if (result.ok && !result.duplicate) {
      const item = pendingSelections.value[pendingSelections.value.length - 1]!
      if (rect) {
        selectionPopup.value = {
          id: item.id,
          comment: "",
          anchor: { left: rect.right, top: rect.top, bottom: rect.bottom },
        }
      } else {
        void editSelection(item.id)
      }
    }
  }
  function onSelectionSave(comment: string) {
    const id = selectionPopup.value?.id
    if (id) updateSelection(id, comment)
    selectionPopup.value = null
    window.getSelection()?.removeAllRanges()
  }
  function onSelectionRemove() {
    const id = selectionPopup.value?.id
    if (id) removeSelection(id)
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
        const target = messageTarget(item)
        if (!target) return
        const wrapper = root.querySelector(`[data-message-id="${target.messageId}"] [data-selection-source]`)
        if (!wrapper) return
        const rect = boundaryRect(wrapper, target.endOffset)
        const wrapperRect = wrapper.getBoundingClientRect()
        if (!rect) return
        const list = map.get(target.messageId) ?? []
        list.push({
          id: item.id,
          index: index + 1,
          left: rect.right - wrapperRect.left + 2,
          // 徽标抬到划词末行上方，避免盖住正文文字。
          top: rect.top - wrapperRect.top - 16,
        })
        map.set(target.messageId, list)
      })
    }
    // DOM 观察也会收到徽标自身的更新；相同坐标不再写回，避免反馈循环。
    if (JSON.stringify([...anchorOverlays.value]) !== JSON.stringify([...map])) anchorOverlays.value = map
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
  // 虚拟正文挂载、Markdown 异步渲染不会改变 renderedEntries。
  // 仅有待发送引用时观察 DOM，并在根节点更换时重新绑定。
  watch(
    [selectionRoot, () => pendingSelections.value.length],
    ([root, count], _, onCleanup) => {
      if (!root || !count) return
      let frame: number | undefined
      const observer = new MutationObserver(() => {
        if (frame !== undefined) return
        frame = requestAnimationFrame(() => {
          frame = undefined
          void recomputeAnchors()
        })
      })
      observer.observe(root, { childList: true, subtree: true, characterData: true })
      void nextTick(recomputeAnchors)
      onCleanup(() => {
        observer.disconnect()
        if (frame !== undefined) cancelAnimationFrame(frame)
      })
    },
    { flush: "post", immediate: true },
  )
  onMounted(() => {
    window.addEventListener("resize", recomputeAnchors)
  })
  onBeforeUnmount(() => {
    window.removeEventListener("resize", recomputeAnchors)
  })
  // ---- 摘要列表动作：定位（滚动到索引标记）与编辑（回显划选后打开弹窗） ----
  let clearFlash: (() => void) | undefined
  let locateRequest = 0
  function resetFlash() {
    locateRequest++
    clearFlash?.()
    clearFlash = undefined
  }
  watch([selectionScope, selectionRoot, pendingSelections], resetFlash)
  onBeforeUnmount(resetFlash)
  function flashLocatedSelection(item: SelectionItem) {
    clearFlash?.()
    const target = messageTarget(item)
    if (!target) return
    const wrapper = selectionRoot.value?.querySelector(
      `[data-message-id="${target.messageId}"] [data-selection-source]`,
    )
    if (wrapper) clearFlash = flashSelection(wrapper, target.startOffset, target.endOffset)
  }
  async function locateSelection(id: string) {
    const item = pendingSelections.value.find(entry => entry.id === id)
    if (!item) return
    resetFlash()
    const target = messageTarget(item)
    if (!target) return
    const request = locateRequest
    const badge = selectionRoot.value?.querySelector(`[data-selection-anchor="${id}"]`)
    if (badge) {
      badge.scrollIntoView({ block: "center", behavior: "smooth" })
      flashLocatedSelection(item)
      return
    }
    const scope = selectionScope.value
    const root = selectionRoot.value
    await conversation.value?.scrollToMessage(target.messageId)
    await nextTick()
    await new Promise(resolve => requestAnimationFrame(resolve))
    if (request !== locateRequest || scope !== selectionScope.value || root !== selectionRoot.value) return
    if (!pendingSelections.value.some(entry => entry.id === id)) return
    await recomputeAnchors()
    await nextTick()
    if (request !== locateRequest) return
    root?.querySelector(`[data-selection-anchor="${id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" })
    flashLocatedSelection(item)
  }
  async function editSelection(id: string) {
    const item = pendingSelections.value.find(entry => entry.id === id)
    if (!item) return
    await locateSelection(id)
    await nextTick()
    await new Promise(resolve => requestAnimationFrame(resolve))
    const root = selectionRoot.value
    const target = messageTarget(item)
    const wrapper = target
      ? root?.querySelector(`[data-message-id="${target.messageId}"] [data-selection-source]`)
      : undefined
    let anchor: { left: number; top: number; bottom: number } | null = null
    const badge = root?.querySelector(`[data-selection-anchor="${id}"]`)
    if (wrapper && target && restoreSelection(wrapper, target.startOffset, target.endOffset)) {
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
