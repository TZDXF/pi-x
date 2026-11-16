import type { BoardDraft } from "@/lib/workspaceState"
import type { SessionStore } from "@/stores/session"
import { dataUrlToImage, isImageAttachment, isImageUrl } from "@/lib/attachments"
import { desktopCommands, withSessionReferences, type KnownSession } from "@/lib/completion"
import { runningBehavior } from "@/lib/runningBehavior"

/** Submit a durable todo without mounting or activating a conversation editor. */
export async function submitBoardDraft(
  draft: BoardDraft,
  owner: SessionStore,
  deps: {
    ensureStarted: () => Promise<boolean>
    knownSessions: () => KnownSession[]
    translate: (key: string) => string
  },
) {
  const text = draft.message.trim()
  const files = draft.attachments ?? []
  if (files.some(file => !isImageAttachment(file))) throw new Error(deps.translate("chat.imageAttachmentsOnly"))
  const images = files
    .filter(file => isImageUrl(file.url))
    .map(file => dataUrlToImage(file.url))
    .filter(image => image !== null)
  if (!text && !images.length) throw new Error(deps.translate("kanban.createDescription"))
  if (!(await deps.ensureStarted())) throw new Error(deps.translate("completion.startFailed"))
  const commandName = /^\/([^\s/]+)/.exec(text)?.[1]
  if (commandName) {
    await owner.refreshCommands()
    if (
      !owner.commands.some(command => command.name === commandName) &&
      desktopCommands.some(name => name === commandName)
    ) {
      const args = text.slice(commandName.length + 1).trim()
      if (images.length || (args && commandName !== "compact"))
        throw new Error(deps.translate("completion.invalidArguments"))
      if (commandName === "new") await owner.newSession()
      else if (commandName === "compact") await owner.send(text, undefined, undefined, runningBehavior.value)
      return
    }
  }
  const extensionCommand =
    commandName && owner.commands.some(command => command.name === commandName && command.source === "extension")
  const expandedText = extensionCommand ? text : withSessionReferences(text, deps.knownSessions())
  await owner.send(text, images.length ? images : undefined, expandedText, runningBehavior.value)
}
