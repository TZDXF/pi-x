/** URL helpers for the built-in browser preview proxy. */

const OTHER_SCHEME = /^(?:about|blob|data|file|ftp|ftps|javascript|mailto|tel|ws|wss|chrome|vscode):/i
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

/** How the browser panel reaches the target page. */
export type AccessMode = "direct" | "proxy"

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** True when the hostname is a literal IP address (IPv4 or IPv6). */
export function isIpHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "")
  if (host.includes(":")) return true
  const match = IPV4.exec(host)
  if (!match) return false
  return match.slice(1).every(octet => {
    const value = Number(octet)
    return value <= 255 && String(value) === octet
  })
}

/**
 * Picks the default access mode. Desktop always loads pages directly in the
 * iframe; in web access an IP host means the viewing device likely cannot
 * reach dev servers running on the host machine, so the preview proxy is
 * used, while a named host goes direct.
 */
export function resolveAccessMode(isDesktop: boolean, hostname: string): AccessMode {
  if (isDesktop) return "direct"
  return isIpHostname(hostname) ? "proxy" : "direct"
}

/** FNV-1a 64-bit hash — mirrors the Rust implementation in preview_proxy.rs. */
function fnv1a(s: string): string {
  let hash = 0xcbf29ce484222325n
  for (let i = 0; i < s.length; i++) {
    hash ^= BigInt(s.charCodeAt(i))
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16)
}

/** Extracts the shared secret from a proxy base URL. */
function extractSecret(base: string): string {
  const match = base.match(/\/(?:p|api\/preview)\/([^/]+)$/)
  return match ? match[1] : ""
}

/** Builds the proxied URL: `{base-with-token}/{scheme}/{host}[:{port}]{path}{search}`.
 *  The token is `fnv1a(secret + host)` — a per-host capability that prevents
 *  a previewed page from using the same token to reach arbitrary loopback services.
 *  The base URL's secret segment is replaced with the per-host token. */
export function toProxyUrl(base: string, url: string): string {
  const target = new URL(url)
  const prefix = base.endsWith("/") ? base.slice(0, -1) : base
  const port = target.port ? `:${target.port}` : ""
  const secret = extractSecret(prefix)
  const token = secret ? fnv1a(secret + target.host) : ""
  // Replace the secret segment in the base with the per-host token.
  const tokenBase = secret ? prefix.replace(/\/[^/]+$/, `/${token}`) : prefix
  return `${tokenBase}/${target.protocol.slice(0, -1)}/${target.hostname}${port}${target.pathname}${target.search}`
}

/** Normalizes any proxy base (absolute loopback URL or remote-relative path) into a usable base. */
export function resolveProxyBase(base: string): string {
  return base.startsWith("/") ? `${window.location.origin}${base.replace(/\/$/, "")}` : base.replace(/\/$/, "")
}
