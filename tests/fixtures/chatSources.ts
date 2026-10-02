import { readFileSync } from "node:fs"

export function chatSource(...files: string[]) {
  return files.map(file => readFileSync(new URL(`../../src/${file}`, import.meta.url), "utf8")).join("\n")
}

export const composerSources = () =>
  chatSource("composables/useChatSendControl.ts", "components/chat/ChatComposer.vue", "components/ChatView.vue")
export const turnSources = () =>
  chatSource(
    "composables/useChatTurnList.ts",
    "components/chat/ChatTurnList.vue",
    "components/chat/ChatAssistantTurn.vue",
  )
