/** URL helpers for the built-in browser preview proxy. */

const OTHER_SCHEME = /^(?:about|blob|data|file|javascript|mailto|tel|ws|wss|chrome|vscode):/i
// Dev-server addresses ("localhost:5173", "127.0.0.1:3000/app") are the most
// common input here and must become http, not https.
const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)(?::\d+)?(?:[/?#]|$)/i

/**
 * Normalizes what the user typed into a previewable URL. Returns null when
 * the input is empty or uses a scheme the proxy cannot serve (file:, …).
 */
export function normalizeInputUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (LOOPBACK.test(trimmed)) return `http://${trimmed}`
  if (OTHER_SCHEME.test(trimmed)) return null
  return `https://${trimmed}`
}

export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/** Builds the proxied URL: `{base}/{scheme}/{host}[:{port}]{path}{search}`. */
export function toProxyUrl(base: string, url: string): string {
  const target = new URL(url)
  const prefix = base.endsWith("/") ? base.slice(0, -1) : base
  const port = target.port ? `:${target.port}` : ""
  return `${prefix}/${target.protocol.slice(0, -1)}/${target.hostname}${port}${target.pathname}${target.search}`
}

/** Normalizes any proxy base (absolute loopback URL or remote-relative path) into a usable base. */
export function resolveProxyBase(base: string): string {
  return base.startsWith("/") ? `${window.location.origin}${base.replace(/\/$/, "")}` : base.replace(/\/$/, "")
}
