import { test, expect } from "vitest"
import { readFileSync } from "node:fs"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const panel = read("../src/components/browser/BrowserPanel.vue")
const navigation = read("../src/composables/browser/useBrowserNavigation.ts")
const bridge = read("../src/composables/browser/useBrowserBridge.ts")
const drawers = read("../src/composables/browser/useBrowserDrawers.ts")
const drawerShell = read("../src/components/browser/BrowserDrawer.vue")

// Structure/wiring guards only. Deterministic runtime coverage lives in
// browser-navigation/bridge/annotations/canvas.test.ts; these do not pretend
// that a function must remain in BrowserPanel to preserve its behavior.
test("browser drawers wire their shared resize shell to the drawer controller", () => {
  for (const drawer of ["annotations", "console"]) {
    expect(panel, `${drawer} drawer needs its own resize state`).toMatch(
      new RegExp(`onDrawerResizeStart\\('${drawer}', `),
    )
    expect(panel).toMatch(new RegExp(`drawerHeights\\.${drawer}`))
  }
  expect(panel).toMatch(/@resize-move="onDrawerResizeMove"/)
  expect(panel).toMatch(/@resize-end="onDrawerResizeEnd"/)
  expect(drawers).toMatch(/setPointerCapture/)
  expect(drawers).toMatch(/DRAWER_MIN_HEIGHT/)
  expect(drawers).toMatch(/stageRef\.value\?\.clientHeight/)
  expect(drawerShell).toMatch(/cursor-row-resize touch-none/)
  expect(drawerShell).toMatch(/@pointercancel="\$emit\('resize-end'\)"/)
})

test("drawer heights use the shell height prop rather than fixed tailwind sizes", () => {
  for (const drawer of ["annotations", "console"]) {
    expect(panel).toMatch(
      new RegExp(
        `<BrowserDrawer[\\s\\S]*?v-if="show${drawer[0].toUpperCase()}${drawer.slice(1)}"[\\s\\S]*?:height="drawerHeights\\.${drawer}"`,
      ),
    )
  }
  expect(drawerShell).toMatch(/:style="\{ height: `\$\{height\}px` \}"/)
  expect(drawerShell).not.toMatch(/\bh-(?:40|48)\b/)
})

test("navigation controller initializes its promise before the immediate visible watcher", () => {
  const initIndex = navigation.indexOf("let initPromise")
  const watchIndex = navigation.indexOf("watch(")
  expect(initIndex >= 0, "initPromise must be declared").toBeTruthy()
  expect(watchIndex >= 0, "visible watcher must exist").toBeTruthy()
  expect(initIndex < watchIndex, "immediate watcher must not call initProxy before initPromise exists").toBeTruthy()
  expect(panel).toMatch(/visible: \(\) => props\.visible/)
})

test("iframe bridge restricts commands to the proxy origin with an opaque sandbox exception", () => {
  expect(bridge).toMatch(/const targetOrigin = opaqueOrigin\(\) \? "\*" : new URL\(options\.proxyBase\.value\)\.origin/)
  expect(bridge).toMatch(/event\.source !== iframeRef\.value\.contentWindow/)
  expect(bridge).toMatch(/event\.origin !== origin/)
  expect(bridge).toMatch(/postMessage\(JSON\.parse\(JSON\.stringify\(message\)\), targetOrigin\)/)
})

test("direct access bypasses the proxy and hides bridge-only UI while keeping its navigation stack", () => {
  expect(navigation).toMatch(/const directMode = computed/)
  expect(navigation).toMatch(/if \(directMode\.value\) return undefined/)
  expect(navigation).toMatch(/if \(useProxy\.value\) await initProxy\(\)/)
  expect(navigation).toMatch(/if \(useProxy\.value\) initProxy\(\)/)
  expect(bridge.match(/if \(options\.directMode\.value \|\| !options\.proxyBase\.value\) return/g)).toHaveLength(2)
  for (const feature of ["inspect", "console", "annotations"]) {
    expect(panel).toMatch(new RegExp(`v-if="!directMode"[\\s\\S]*?:title="t\\('browser\\.${feature}'\\)"`))
  }
  expect(panel).toMatch(/if \(mode\.value !== "inspect"\) return/)
  expect(navigation).toMatch(/directHistory\.value\[directIndex\.value\]/)
  expect(navigation).toMatch(/iframeKey\.value\+\+/)
})

test("proxy is the default and direct fallback toggle remains available on every platform", () => {
  expect(navigation).toMatch(/accessPref\.value === "direct" \? "direct" : "proxy"/)
  expect(navigation).toMatch(/stored === "direct" \? "direct" : "auto"/)
  expect(panel).toMatch(/@click="cycleAccessMode"/)
  expect(panel).not.toMatch(/v-if="!isDesktop"/)
  expect(navigation).not.toMatch(/resolveAccessMode/)
  expect(panel).toMatch(/direct iframe loading as a manual\s+\* fallback/)
})
