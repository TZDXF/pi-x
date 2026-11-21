import type { InjectionKey, Ref } from 'vue'
import type { StickToBottomContext } from 'vue-stick-to-bottom'

/**
 * 定位（`revealMessage`）进行中的抑制计数：`VirtualMessage` 的行高补偿会**直接写**
 * `scrollTop`（重挂后 placeholder 估算高度换成真实高度时按差值补位），一次写入就能打断
 * 平滑滚动、把目标留在视口外（TZD-138 P2 实测三内核）。定位期间由 `Conversation` 持有
 * 计数，行高照常量、但不写滚动位置，交给定位流程自己校正。
 */
export interface ConversationContext extends StickToBottomContext {
  revealLock?: Ref<number>
}

export const conversationKey: InjectionKey<ConversationContext> = Symbol('Conversation')
