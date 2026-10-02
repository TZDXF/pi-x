import { expect, test, type Locator, type Page } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

let harness: VueHarness

test.beforeAll(async () => {
  harness = await startVueHarness({
    name: "pix-logo",
    port: 5199,
    html: `<!doctype html><html><body style="padding:80px"><div id="app"></div><script type="module">
      import { createApp } from 'vue'
      import { createI18n } from 'vue-i18n'
      import messages from '/src/i18n/locales/en.ts'
      import PiXLogo from '/src/components/PiXLogo.vue'
      createApp(PiXLogo).use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } })).mount('#app')
    </script></body></html>`,
  })
})
test.afterAll(async () => {
  await harness?.close()
})

// The canvas maps the wordmark grid (x: 5-35, y: 13-27) onto its surface; a
// logo pixel is a 2x2-unit block. Assertions sample the center of every unit
// cell with an alpha threshold: pixels fill their cells fully (alpha 255),
// while the half-pixel seam overdraw at block edges bleeds at most ~208 alpha
// into neighbour cells and must not count as painted.
const GRID = { x: 5, y: 13, w: 30, h: 14 }
const PI_ROWS = ["011111111", "111111110", "001100110", "001100110", "001100110", "001100110", "011000111"]
const piTargets = PI_ROWS.flatMap((row, y) =>
  [...row].flatMap((cell, x) => (cell === "1" ? [{ x: 11 + x * 2, y: 13 + y * 2 }] : [])),
)
// The wordmark pixels in the component's own enumeration (grouped P, i, X),
// which defines which wordmark pixel morphs into which pi cell.
const WORDMARK = [
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
]

type Rgb = [number, number, number]
type Cell = { x: number; y: number; rgb: Rgb }

async function readUnitCells(logo: Locator): Promise<Cell[]> {
  return logo.evaluate((el, grid) => {
    const canvas = el.querySelector("canvas")!
    const { width, height } = canvas
    const data = canvas.getContext("2d")!.getImageData(0, 0, width, height).data
    const cells: Cell[] = []
    for (let row = 0; row < grid.h; row++) {
      for (let col = 0; col < grid.w; col++) {
        const px = Math.floor(((col + 0.5) / grid.w) * width)
        const py = Math.floor(((row + 0.5) / grid.h) * height)
        const index = (py * width + px) * 4
        if (data[index + 3]! >= 224) {
          cells.push({ x: grid.x + col, y: grid.y + row, rgb: [data[index]!, data[index + 1]!, data[index + 2]!] })
        }
      }
    }
    return cells
  }, GRID)
}

/** Logo pixels sit on odd grid units, so each contributes one even-offset unit cell as its top-left corner. */
function toLogoPixels(cells: Cell[]): Cell[] {
  return cells.filter(cell => (cell.x - GRID.x) % 2 === 0 && (cell.y - GRID.y) % 2 === 0)
}

function cellKeys(cells: Cell[]): Set<string> {
  return new Set(cells.map(cell => `${cell.x},${cell.y}`))
}

function parseColor(color: string): Rgb {
  const rgb = color.match(/rgba?\((\d+), (\d+), (\d+)/)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  const hex = color.replace("#", "")
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
}

async function readThemeColors(logo: Locator): Promise<{ base: Rgb; pi: Rgb }> {
  const colors = await logo.evaluate(el => ({
    base: getComputedStyle(el).color,
    pi: getComputedStyle(el).getPropertyValue("--pi-color").trim(),
  }))
  return { base: parseColor(colors.base), pi: parseColor(colors.pi) }
}

/** Canvas compositing rounds premultiplied 8-bit channels, so allow a little drift. */
function expectRgbClose(actual: Rgb, expected: Rgb): void {
  for (let channel = 0; channel < 3; channel++) {
    expect(Math.abs(actual[channel]! - expected[channel]!)).toBeLessThanOrEqual(2)
  }
}

function toRows(pixels: Cell[]): string[] {
  return Array.from({ length: 7 }, (_, row) =>
    Array.from({ length: 9 }, (_, col) =>
      pixels.some(pixel => pixel.x === 11 + col * 2 && pixel.y === 13 + row * 2) ? "1" : "0",
    ).join(""),
  )
}

/**
 * Freeze time and capture animation frames so tests can step the canvas
 * deterministically — the canvas counterpart of pausing CSS animations and
 * seeking their currentTime.
 */
async function installManualFrameClock(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = { now: 10_000, pending: null as FrameRequestCallback | null }
    ;(window as unknown as { __frameClock: typeof state }).__frameClock = state
    window.performance.now = () => state.now
    window.requestAnimationFrame = callback => {
      state.pending = callback
      return 0
    }
    window.cancelAnimationFrame = () => {
      state.pending = null
    }
  })
}

/** Advance the frozen clock and render the animation frame scheduled for that timestamp. */
async function stepAnimation(logo: Locator, atMs: number): Promise<void> {
  await logo.evaluate((_el, at) => {
    const state = (window as unknown as { __frameClock: { now: number; pending: FrameRequestCallback | null } })
      .__frameClock
    state.now = at
    const pending = state.pending
    state.pending = null
    pending?.(at)
  }, atMs)
}

test("renders the wordmark, assembles pi on click and replay, and restores the layout", async ({ page }) => {
  await page.goto(harness.url)
  await installManualFrameClock(page)
  const logo = page.getByRole("button", { name: "PiX · Click to reassemble pixels" })
  const bounds = await logo.boundingBox()
  const { base, pi } = await readThemeColors(logo)

  const wordmark = toLogoPixels(await readUnitCells(logo))
  expect(wordmark).toHaveLength(37)
  for (const cell of wordmark) expectRgbClose(cell.rgb, cell.x >= 25 ? pi : base)

  const start = 10_000
  await logo.evaluate(el => (el as HTMLElement).click())
  await stepAnimation(logo, start + 900)
  const formed = await readUnitCells(logo)
  // Every pixel is fully covered by the uniform glow overlay in the pi formation.
  expect(formed).toHaveLength(37 * 4)
  for (const cell of formed) expectRgbClose(cell.rgb, pi)
  expect(toRows(toLogoPixels(formed))).toEqual(PI_ROWS)
  // The left foot extends left of its stem; the right foot extends right, not inward.
  expect(
    toLogoPixels(formed)
      .filter(pixel => pixel.y === 25)
      .map(pixel => pixel.x),
  ).toEqual([13, 15, 23, 25, 27])

  await stepAnimation(logo, start + 2000)
  const restored = toLogoPixels(await readUnitCells(logo))
  expect(cellKeys(restored)).toEqual(cellKeys(wordmark))
  for (const cell of restored) expectRgbClose(cell.rgb, cell.x >= 25 ? pi : base)
  expect(await logo.boundingBox()).toEqual(bounds)

  // A click mid-playback is ignored: the running morph keeps its timeline and
  // still settles back into the wordmark.
  await logo.evaluate(el => (el as HTMLElement).click())
  await stepAnimation(logo, 12_900)
  expect(toRows(toLogoPixels(await readUnitCells(logo)))).toEqual(PI_ROWS)
  await logo.evaluate(el => (el as HTMLElement).click())
  await stepAnimation(logo, 13_950)
  const stillOnFirstTimeline = toLogoPixels(await readUnitCells(logo))
  expect(cellKeys(stillOnFirstTimeline)).toEqual(cellKeys(wordmark))
  for (const cell of stillOnFirstTimeline) expectRgbClose(cell.rgb, cell.x >= 25 ? pi : base)

  // Once the run has finished, clicking replays the morph from the wordmark.
  await stepAnimation(logo, 14_000)
  await logo.evaluate(el => (el as HTMLElement).click())
  await stepAnimation(logo, 14_900)
  expect(toRows(toLogoPixels(await readUnitCells(logo)))).toEqual(PI_ROWS)
})

test("pixels move directly into pi, halfway between wordmark and formation", async ({ page }) => {
  await page.goto(harness.url)
  await installManualFrameClock(page)
  const logo = page.getByRole("button")
  const { base, pi } = await readThemeColors(logo)

  const start = 10_000
  await logo.evaluate(el => (el as HTMLElement).click())
  // 300ms into the 2000ms timeline is exactly half of the first segment;
  // the eased progress there is 0.5, so pixels sit at their midpoints and the
  // glow has faded halfway in.
  await stepAnimation(logo, start + 300)
  const halfway = await readUnitCells(logo)
  const midpoints = WORDMARK.map(([x, y], index) => ({
    x: (x + piTargets[index]!.x) / 2,
    y: (y + piTargets[index]!.y) / 2,
  }))
  const expected = new Set<string>()
  for (const midpoint of midpoints) {
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      expected.add(`${midpoint.x + dx!},${midpoint.y + dy!}`)
    }
  }
  expect(cellKeys(halfway)).toEqual(expected)
  // The half-faded glow tints pixels at least halfway toward the pi color;
  // overlapping blocks may composite further toward pure pi.
  const halfBlend = base.map((c, i) => (c + pi[i]!) / 2) as Rgb
  for (const cell of halfway) {
    for (let channel = 0; channel < 3; channel++) {
      expect(cell.rgb[channel]!).toBeGreaterThanOrEqual(halfBlend[channel]! - 2)
      expect(cell.rgb[channel]!).toBeLessThanOrEqual(pi[channel]! + 2)
    }
  }
})

test("reduced motion keeps the wordmark static on click", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(harness.url)
  const logo = page.getByRole("button")
  const before = await readUnitCells(logo)
  expect(before).toHaveLength(37 * 4)
  await logo.click()
  await page.waitForTimeout(600)
  expect(await readUnitCells(logo)).toEqual(before)
})
