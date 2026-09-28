import type { LinkOptions } from "vue-stream-markdown"

/**
 * Links rendered by vue-stream-markdown: skip the built-in "Open external
 * link?" prompt for common protocols so they open in the system browser
 * directly (the Tauri new-window handler routes window.open there). Uncommon
 * protocols such as javascript: or data: keep the built-in confirmation.
 */
export const markdownLinkOptions: LinkOptions = {
  isTrusted: url => /^(https?:|mailto:|tel:)/i.test(url),
}
