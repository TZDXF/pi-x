import { expect, test } from "@playwright/test"
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

test("pixels assemble on click and replay from the keyboard without changing layout", async ({ page }) => {
  await page.goto(harness.url)
  const logo = page.getByRole("button", { name: "PiX · Click to reassemble pixels" })
  await expect(logo.locator(".pix-pixel")).toHaveCount(37)
  const bounds = await logo.boundingBox()
  expect(await logo.evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0)
  await logo.click()
  await expect(logo.locator(".pix-assembling")).toHaveCount(1)
  expect(await logo.evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(74)
  await logo.evaluate(async el => {
    await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished))
  })
  expect(await logo.boundingBox()).toEqual(bounds)
  for (const key of ["Enter", "Space"]) {
    await logo.press(key)
    expect(await logo.evaluate(el => el.getAnimations({ subtree: true }).some(a => a.playState === "running"))).toBe(
      true,
    )
  }
})

test("reduced motion keeps all pixels visible without animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(harness.url)
  const logo = page.getByRole("button")
  await logo.click()
  expect(await logo.evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0)
  await expect(logo.locator(".pix-pixel").first()).toHaveCSS("opacity", "1")
})

test("pixels move directly into pi, then restore their original positions and colors", async ({ page }) => {
  await page.goto(harness.url)
  const logo = page.getByRole("button")
  // Pixels are laid out in percentages at 2x the wordmark units, whose grid starts at (5, 13).
  const original = await logo.locator(".pix-pixel").evaluateAll(cells =>
    cells.map(rawCell => {
      const cell = rawCell as HTMLElement
      const glow = getComputedStyle(cell, "::after")
      return {
        x: cell.offsetLeft / 2 + 5,
        y: cell.offsetTop / 2 + 13,
        fill: getComputedStyle(cell).backgroundColor,
        glowColor: glow.backgroundColor,
        glowOpacity: glow.opacity,
      }
    }),
  )
  await logo.click()
  const sample = async (time: number) =>
    logo.evaluate(async (el, time) => {
      for (const animation of el.getAnimations({ subtree: true })) {
        animation.pause()
        animation.currentTime = time
      }
      // Composited animations report their effect to computed style a frame later.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      return [...el.querySelectorAll<HTMLElement>(".pix-pixel")].map(cell => {
        const style = getComputedStyle(cell)
        const matrix = new DOMMatrix(style.transform)
        const glow = getComputedStyle(cell, "::after")
        return {
          x: cell.offsetLeft / 2 + 5 + matrix.e / 2,
          y: cell.offsetTop / 2 + 13 + matrix.f / 2,
          fill: style.backgroundColor,
          glowColor: glow.backgroundColor,
          glowOpacity: glow.opacity,
        }
      })
    }, time)
  const halfway = await sample(300)
  const pi = await sample(900)
  for (const [index, cell] of halfway.entries()) {
    expect(cell.x).toBeCloseTo((original[index]!.x + pi[index]!.x) / 2)
    expect(cell.y).toBeCloseTo((original[index]!.y + pi[index]!.y) / 2)
  }
  const rows = Array.from({ length: 7 }, (_, row) =>
    Array.from({ length: 9 }, (_, col) =>
      pi.some(cell => cell.x === 11 + col * 2 && cell.y === 13 + row * 2) ? "1" : "0",
    ).join(""),
  )
  expect(rows).toEqual(["011111111", "111111110", "001100110", "001100110", "001100110", "001100110", "011000111"])
  // The left foot extends left of its stem; the right foot extends right, not inward.
  const foot = pi.filter(cell => cell.y === 25).map(cell => cell.x)
  expect(foot).toEqual([13, 15, 23, 25, 27])
  // At the pi formation every pixel is fully covered by the uniform glow overlay.
  expect(new Set(pi.map(cell => cell.glowColor)).size).toBe(1)
  for (const cell of pi) expect(cell.glowOpacity).toBe("1")
  expect(await sample(2000)).toEqual(original)
})
