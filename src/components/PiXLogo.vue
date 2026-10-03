<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"

const { t } = useI18n()
const buttonRef = ref<HTMLButtonElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)

// 37 cells, matching the wordmark one-to-one: every pixel participates in the morph.
const piPixels = ["011111111", "111111110", "001100110", "001100110", "001100110", "001100110", "011000111"].flatMap(
  (row, y) => [...row].flatMap((cell, x) => (cell === "1" ? [{ x: 11 + x * 2, y: 13 + y * 2 }] : [])),
)
// Grid spans x: 5-35, y: 13-27 in wordmark units; the canvas maps that box onto its surface.
const pixels = (
  [
    [5, 13],
    [7, 13],
    [9, 13],
    [11, 13],
    [5, 15],
    [13, 15],
    [5, 17],
    [13, 17],
    [5, 19],
    [7, 19],
    [9, 19],
    [11, 19],
    [5, 21],
    [5, 23],
    [5, 25],
    [19, 13],
    [17, 17],
    [19, 17],
    [19, 19],
    [19, 21],
    [19, 23],
    [17, 25],
    [19, 25],
    [21, 25],
    [25, 13],
    [33, 13],
    [25, 15],
    [33, 15],
    [27, 17],
    [31, 17],
    [29, 19],
    [27, 21],
    [31, 21],
    [25, 23],
    [33, 23],
    [25, 25],
    [33, 25],
  ] as const
).map(([x, y], index) => {
  const target = piPixels[index]!
  return {
    x,
    y,
    // Each pixel is 2 units square, so the translation in units is the plain delta.
    accent: x >= 25,
    stopsX: [0, target.x - x, target.x - x, 0, 0],
    stopsY: [0, target.y - y, target.y - y, 0, 0],
  }
})

// Keyframe structure of the morph: move out, hold the pi formation, move
// back, hold the wordmark. Each segment is eased smoothly — the previous
// steps(8) timing only repainted ~13 times per second, which read as lag.
const DURATION = 2000
const STOPS = [0, 0.3, 0.65, 0.92, 1]
const GLOW_STOPS = [0, 1, 1, 0, 0]

function easeInOutCubic(p: number): number {
  return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2
}

function sampleStops(t: number, values: readonly number[]): number {
  let i = 0
  while (i < STOPS.length - 2 && t > STOPS[i + 1]!) i++
  const p = Math.min(1, Math.max(0, (t - STOPS[i]!) / (STOPS[i + 1]! - STOPS[i]!)))
  return values[i]! + (values[i + 1]! - values[i]!) * easeInOutCubic(p)
}

// Which keyframe segment a timestamp falls into. Values are constant inside
// the hold segments, so consecutive frames there need no repaint at all.
function segmentKey(t: number | null): string {
  if (t === null) return "static"
  if (t <= STOPS[1]!) return "out"
  if (t <= STOPS[2]!) return "hold1"
  if (t <= STOPS[3]!) return "back"
  return "hold2"
}

const GRID = { x: 5, y: 13, w: 30, h: 14 } as const

let ctx: CanvasRenderingContext2D | null = null
let rafId = 0
let startedAt = 0
let playing = false
let currentT: number | null = null // null = static wordmark
let lastPaintedSegment: string | null = null
let baseRgb: readonly number[] = [0, 0, 0]
let piRgb: readonly number[] = [40, 118, 91]
let cssWidth = 0
let cssHeight = 0
let dpr = 1

function syncSize() {
  const button = buttonRef.value
  const canvas = canvasRef.value
  if (!button || !canvas) return
  // Cached once per resize instead of reading layout on every frame; reading
  // it inside the rAF loop forces style/layout recalc each frame and stutters
  // whenever the app invalidates DOM elsewhere.
  cssWidth = button.clientWidth
  cssHeight = button.clientHeight
  dpr = window.devicePixelRatio || 1
  const deviceWidth = Math.round(cssWidth * dpr)
  const deviceHeight = Math.round(cssHeight * dpr)
  if (canvas.width !== deviceWidth) canvas.width = deviceWidth
  if (canvas.height !== deviceHeight) canvas.height = deviceHeight
}

function parseRgb(color: string, fallback: readonly number[]): readonly number[] {
  const rgb = color.match(/rgba?\((\d+)[, ](\d+)[, ](\d+)/)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  const hex = color.replace(/^#/, "")
  if (hex.length === 6) return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16))
  if (hex.length === 3) return [0, 1, 2].map(i => parseInt(hex[i]! + hex[i]!, 16))
  return fallback
}

function refreshColors() {
  const button = buttonRef.value
  if (!button) return
  const style = getComputedStyle(button)
  baseRgb = parseRgb(style.color, baseRgb)
  const pi = style.getPropertyValue("--pi-color").trim()
  if (pi) piRgb = parseRgb(pi, piRgb)
}

function render(t: number | null) {
  const canvas = canvasRef.value
  if (!canvas || !ctx) return
  const segment = segmentKey(t)
  // Holds and the static wordmark paint identical frames; skip the repaint.
  if (segment === lastPaintedSegment && (segment === "hold1" || segment === "hold2" || segment === "static")) return
  lastPaintedSegment = segment
  currentT = t
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssWidth, cssHeight)
  const unitX = cssWidth / GRID.w
  const unitY = cssHeight / GRID.h
  const pixelW = 2 * unitX
  const pixelH = 2 * unitY
  // The glow overlay is pre-blended into one opaque fill per pixel instead of
  // stacking a translucent rect on top: the half-pixel seam overdraw would
  // otherwise re-composite the overlap and darken shared edges.
  const glow = t === null ? 0 : sampleStops(t, GLOW_STOPS)
  const shade = (i: number) => Math.round(baseRgb[i]! + (piRgb[i]! - baseRgb[i]!) * glow)
  const glowFill = `rgb(${shade(0)},${shade(1)},${shade(2)})`
  const accentFill = `rgb(${piRgb.join(",")})`
  let fill = ""
  for (const pixel of pixels) {
    const tx = t === null ? 0 : sampleStops(t, pixel.stopsX)
    const ty = t === null ? 0 : sampleStops(t, pixel.stopsY)
    const x = (pixel.x - GRID.x + tx) * unitX
    const y = (pixel.y - GRID.y + ty) * unitY
    // Overdraw half a pixel on each side to hide hairline seams between
    // adjacent pixels at fractional device pixel ratios (e.g. Windows at 125%).
    const color = pixel.accent ? accentFill : glowFill
    if (color !== fill) {
      ctx.fillStyle = color
      fill = color
    }
    ctx.fillRect(x - 0.5, y - 0.5, pixelW + 1, pixelH + 1)
  }
}

function rerender() {
  refreshColors()
  syncSize()
  lastPaintedSegment = null
  render(currentT)
}

function play() {
  cancelAnimationFrame(rafId)
  refreshColors()
  syncSize()
  playing = true
  startedAt = performance.now()
  const frame = (now: number) => {
    const t = Math.min(1, (now - startedAt) / DURATION)
    render(t)
    if (t < 1) rafId = requestAnimationFrame(frame)
    else playing = false
  }
  rafId = requestAnimationFrame(frame)
}

function onClick() {
  // Clicks during playback are ignored so a running morph always completes.
  if (playing) return
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
  play()
}

let resizeObserver: ResizeObserver | undefined
let themeObserver: MutationObserver | undefined
// Re-arming media query that fires when the display's pixel density changes
// (e.g. the window moves between monitors with different scale factors).
let dprWatcher: MediaQueryList | undefined
let dprListener: (() => void) | undefined

function watchDpr() {
  dprWatcher?.removeEventListener("change", dprListener!)
  dprWatcher = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
  dprListener = () => {
    watchDpr()
    rerender()
  }
  dprWatcher.addEventListener("change", dprListener)
}

onMounted(() => {
  ctx = canvasRef.value?.getContext("2d") ?? null
  rerender()
  resizeObserver = new ResizeObserver(rerender)
  resizeObserver.observe(buttonRef.value!)
  // Colors come from CSS custom properties that flip with the theme class.
  themeObserver = new MutationObserver(rerender)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  watchDpr()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
  resizeObserver?.disconnect()
  themeObserver?.disconnect()
  dprWatcher?.removeEventListener("change", dprListener!)
})
</script>

<template>
  <button ref="buttonRef" type="button" class="pix-wordmark" :aria-label="t('logo.reassemble')" @click="onClick">
    <canvas ref="canvasRef" class="pix-canvas" aria-hidden="true" />
  </button>
</template>

<style scoped>
.pix-wordmark {
  display: inline-block;
  width: 60px;
  height: 28px;
  padding: 0;
  border: 0;
  background: transparent;
  flex-shrink: 0;
  vertical-align: middle;
  color: var(--foreground);
  --pi-color: #28765b;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.pix-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
.pix-wordmark:focus-visible {
  outline: 2px solid #28765b;
  outline-offset: 8px;
  border-radius: 2px;
}
/* :global must wrap the whole selector; a bare ":global(.dark) .descendant"
   prefix compiles to just ".dark" in scoped styles.
   暗色有系统偏好与显式选择两条来源（见 styles/theme/dark.css），这里两条都要覆盖。 */
@media (prefers-color-scheme: dark) {
  :global(html:not(.light) .pix-wordmark) {
    --pi-color: #9ae5c6;
  }
  :global(html:not(.light) .pix-wordmark:focus-visible) {
    outline-color: #9ae5c6;
  }
}
:global(.dark .pix-wordmark) {
  --pi-color: #9ae5c6;
}
:global(.dark .pix-wordmark:focus-visible) {
  outline-color: #9ae5c6;
}
</style>
