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
  /**
   * 展开被折叠裁剪的提问（TZD-138）：定位/编辑一个落在裁剪区外的引用前，先让对应消息
   * 展开正文并返回 `true`（没展开返回 `false`）。不传时退化为"裁剪区不显示徽标"。
   */
  revealClippedPrompt?: (messageId: number) => boolean
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
    // aux 面板内的划词：消息 id 属于本 aux 正文，记下来才不会被当成跨 runtime 引用。
    if (deps.auxRuntimeId) return addAuxSelection(deps.auxRuntimeId, { ...draft, sourceRuntimeId: deps.auxRuntimeId })
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
  /**
   * 该引用能否在**本面板**就近定位（TZD-103 P2-5）。
   *
   * 消息 id 只在产生它的那个会话里有意义：主会话的消息 1 与 aux 的消息 1 是两条无关
   * 内容。因此只在"来源 runtime 就是自己"时才做锚点恢复与徽标；跨 runtime（含来源未
   * 标注的旧条目）一律不猜位置 —— 宁可只在摘要里显示，也不把无关正文闪亮/加徽标。
   */
  function localTarget(item: SelectionItem) {
    const target = messageTarget(item)
    if (!target) return null
    const sourceRuntimeId = (item as Partial<PendingAuxSelection>).sourceRuntimeId
    if (deps.auxRuntimeId) return sourceRuntimeId === deps.auxRuntimeId ? target : null
    // 主会话：自己产生的引用不带来源标记；带别的 runtime 标记的属于 aux，不在主表定位。
    return sourceRuntimeId === undefined || sourceRuntimeId === session.runtimeId ? target : null
  }
  /** 浮层锚点：没有可定位的正文时（文件来源引用）退到一个可用的视口位置。 */
  function fallbackAnchor(): { left: number; top: number; bottom: number } | null {
    const rect = selectionRoot.value?.getBoundingClientRect()
    const left = rect ? Math.min(rect.right - 16, window.innerWidth - 300) : window.innerWidth / 2
    const top = rect ? rect.top + 24 : 24
    return { left: Math.max(8, left), top, bottom: top + 20 }
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
  /** 折叠态正文容器（`CollapsiblePromptText`）：只有它带这个标记。 */
  const CLIPPED_PROMPT = '[data-prompt-text][data-prompt-collapsed="true"]'
  /**
   * 该矩形是否落在折叠裁剪区。折叠只裁高度（`overflow: hidden`），所以只看竖直方向：
   * 矩形整体在可见下边界以下即"看不见"。矩形与包装元素都可能是测试替身，取不到几何
   * 时一律当作"没被裁"（宁可不收起，也不要错误地藏徽标）。
   */
  function isClippedOut(wrapper: Element | null | undefined, rect: DOMRect | null | undefined): boolean {
    if (!wrapper || !rect || typeof wrapper.querySelector !== "function") return false
    const body = wrapper.querySelector(CLIPPED_PROMPT)
    if (!body || typeof body.getBoundingClientRect !== "function") return false
    const bodyRect = body.getBoundingClientRect()
    if (!bodyRect || !bodyRect.height) return false
    return rect.top >= bodyRect.bottom - 0.5
  }
  /**
   * 定位前把被裁剪的正文展开（TZD-138 P2）：收起状态下引用位于裁剪区，徽标只能画到气泡
   * 下方空白处，滚动与闪亮也都指向看不见的行。先展开、再等一帧让布局稳定，调用方随后重算
   * 锚点。返回是否真的展开了。
   */
  async function revealClippedSelection(
    wrapper: Element | null | undefined,
    offset: number,
    messageId: number,
  ): Promise<boolean> {
    const reveal = deps.revealClippedPrompt
    if (!reveal || !wrapper || !isClippedOut(wrapper, boundaryRect(wrapper, offset))) return false
    if (!reveal(messageId)) return false
    await nextTick()
    await new Promise(resolve => requestAnimationFrame(resolve))
    return true
  }
  async function recomputeAnchors() {
    const root = selectionRoot.value
    const map = new Map<number, { id: string; index: number; left: number; top: number }[]>()
    if (root) {
      pendingSelections.value.forEach((item, index) => {
        const target = localTarget(item)
        if (!target) return
        const wrapper = root.querySelector(`[data-message-id="${target.messageId}"] [data-selection-source]`)
        if (!wrapper) return
        const rect = boundaryRect(wrapper, target.endOffset)
        const wrapperRect = wrapper.getBoundingClientRect()
        if (!rect) return
        // 裁剪区里的引用在折叠态没有可见锚点：不画徽标。否则徽标落在气泡下方空白处，
        // 看起来指向一个不存在的位。定位/编辑时先展开正文再重算（locateSelection）。
        if (isClippedOut(wrapper, rect)) return
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
    const target = localTarget(item)
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
    const target = localTarget(item)
    // 文件来源/跨 runtime 的引用没有本面板可定位的正文：不滚动、不闪亮（摘要仍可用）。
    if (!target) return
    const request = locateRequest
    const scope = selectionScope.value
    const root = selectionRoot.value
    /**
     * 把目标消息的行内正文查出来，必要时展开（TZD-138 P2）。
     *
     * 必须**每次重新查**：虚拟化（`VirtualMessage`）会把滚出视口的行整行卸载，此时
     * `[data-selection-source]` 根本不存在，收起判定无从谈起。QA 实测卸载链路只经过
     * `scrollToMessage` 重挂后就没再查一次正文，于是第一次点击只把正文重挂出来、
     * 仍是收起态且没有徽标，要再点一次才生效。
     */
    const targetMessageId = target.messageId
    const targetEndOffset = target.endOffset
    async function revealTargetIfClipped() {
      const wrapper = root?.querySelector(`[data-message-id="${targetMessageId}"] [data-selection-source]`)
      return revealClippedSelection(wrapper, targetEndOffset, targetMessageId)
    }
    // 引用落在折叠裁剪区（目标行还挂载着）：先展开正文，后面才有可定位的徽标与高亮。
    if (await revealTargetIfClipped()) {
      if (request !== locateRequest || scope !== selectionScope.value || root !== selectionRoot.value) return
      if (!pendingSelections.value.some(entry => entry.id === id)) return
      await recomputeAnchors()
    }
    const badge = selectionRoot.value?.querySelector(`[data-selection-anchor="${id}"]`)
    if (badge) {
      badge.scrollIntoView({ block: "center", behavior: "smooth" })
      flashLocatedSelection(item)
      return
    }
    // 没有徽标：目标行可能根本被虚拟化卸载了，先把它滚（重挂）出来。
    await conversation.value?.scrollToMessage(target.messageId)
    await nextTick()
    await new Promise(resolve => requestAnimationFrame(resolve))
    if (request !== locateRequest || scope !== selectionScope.value || root !== selectionRoot.value) return
    if (!pendingSelections.value.some(entry => entry.id === id)) return
    // 重挂后**重新查一次正文并判断裁剪**：卸载时那次查询拿不到元素，不能把它的结论
    // 沿用到重挂之后。这里补上展开（内部已等一帧布局稳定），保证首次点击即可定位。
    await revealTargetIfClipped()
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
    const target = localTarget(item)
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
    // 文件来源引用（无 messageId）也必须有可用的编辑锚点：否则摘要里的"编辑"点了没反应。
    if (!anchor) anchor = fallbackAnchor()
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
