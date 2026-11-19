/** Append an inserted context block without overwriting the current draft. */
export function appendComposerText(existing: string, text: string): string {
  const separator = existing ? (existing.endsWith("\n") ? "\n" : "\n\n") : ""
  return existing + separator + text
}

const COMPOSER_EDITOR_SELECTOR = ".composer-dock .composer-rich-editor"

/** Focus the rich composer editor, if it is mounted. */
export function focusComposer(): void {
  document.querySelector<HTMLElement>(COMPOSER_EDITOR_SELECTOR)?.focus()
}
