const layerSelector = "[data-dismissable-layer]"

/** Only the topmost active layer may dismiss its dialog via the overlay. */
export function isTopmostDialogLayer(content: HTMLElement | undefined): boolean {
  if (!content) return false
  const ownLayer = content.matches(layerSelector) ? content : content.querySelector<HTMLElement>(layerSelector)
  if (!ownLayer) return false

  // A modal child makes the dialog pointer-transparent, so even an inside click
  // can hit its overlay. Keep ignoring it until the child releases pointer events.
  if (content.ownerDocument.defaultView?.getComputedStyle(ownLayer).pointerEvents === "none") return false

  // Reka's portalled layers follow document order. Non-modal popovers do not
  // disable pointer events, but must still consume the first outside click.
  const layers = content.ownerDocument.querySelectorAll<HTMLElement>(layerSelector)
  for (let index = layers.length - 1; index >= 0; index--) {
    const layer = layers[index]!
    if (layer.dataset.state === "closed" || layer.getClientRects().length === 0) continue
    return layer === ownLayer
  }
  return false
}
