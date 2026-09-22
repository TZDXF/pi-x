import type { InjectionKey } from 'vue'
import type { StickToBottomContext } from 'vue-stick-to-bottom'

export const conversationKey: InjectionKey<StickToBottomContext> = Symbol('Conversation')
