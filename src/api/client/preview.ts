import { invoke } from "../transport"

// ---- built-in browser preview proxy ----
export interface PreviewProxyInfo {
  /** Loopback URL (desktop) or remote-relative path prefix for proxied pages. */
  base: string
}
export const previewProxyInfo = () => invoke<PreviewProxyInfo>("preview_proxy_info")
