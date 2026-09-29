const COMPOSER_EDITOR_SELECTOR = ".composer-dock .composer-rich-editor"

/** Focus the rich composer editor, if it is mounted. */
export function focusComposer(): void {
  document.querySelector<HTMLElement>(COMPOSER_EDITOR_SELECTOR)?.focus()
}
