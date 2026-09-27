/** Message contract between the BrowserPanel and the bridge script injected by the preview proxy. */

export interface PreviewRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PreviewPin {
  selector: string
  text: string
  rect: PreviewRect
}

export interface PreviewArea {
  rect: PreviewRect
}

/** Messages the injected bridge sends to the panel. */
export type BridgeInbound =
  | { source: "pix-preview"; type: "ready" }
  | { source: "pix-preview"; type: "navigated"; url: string; title: string }
  | { source: "pix-preview"; type: "console"; level: "log" | "info" | "warn" | "error" | "debug"; text: string }
  | { source: "pix-preview"; type: "selected"; pin?: PreviewPin; area?: PreviewArea }

/** Commands the panel sends into the page. */
export type BridgeOutbound =
  | { target: "pix-preview-page"; type: "back" }
  | { target: "pix-preview-page"; type: "forward" }
  | { target: "pix-preview-page"; type: "reload" }
  | { target: "pix-preview-page"; type: "inspect"; enabled: boolean }
  | { target: "pix-preview-page"; type: "clear-markers" }
  | {
      target: "pix-preview-page"
      type: "add-marker"
      annotation: {
        id: string
        kind: "pin" | "area"
        number: number
        rect: PreviewRect
        pin?: PreviewPin
      }
    }

export function isBridgeInbound(data: unknown): data is BridgeInbound {
  return typeof data === "object" && data !== null && (data as { source?: unknown }).source === "pix-preview"
}

export function bridgeInspect(enabled: boolean): BridgeOutbound {
  return { target: "pix-preview-page", type: "inspect", enabled }
}

export function bridgeAddMarker(
  annotation: Extract<BridgeOutbound, { type: "add-marker" }>["annotation"],
): BridgeOutbound {
  return { target: "pix-preview-page", type: "add-marker", annotation }
}

export function bridgeCommand(type: "back" | "forward" | "reload" | "clear-markers"): BridgeOutbound {
  return { target: "pix-preview-page", type }
}
