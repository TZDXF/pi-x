import { test, expect } from "vitest"
import { readFileSync } from "node:fs"

const read = path => readFileSync(new URL(path, import.meta.url), "utf8")

// NOTE: 当前测试为源码正则断言，不验证运行时行为。
// BrowserPanel.vue 是 Vue 组件，行为测试需要挂载实例（@vue/test-utils），
// 项目未引入该依赖，故暂以源码断言作为回归防护。
// 局限：重命名函数/调整类名会导致断言失败，但不保证运行时逻辑正确。
test("browser drawers resize by dragging their top handles", () => {
  const panel = read("../src/components/browser/BrowserPanel.vue")
  // 两个抽屉都由 drawerHeights 驱动高度,顶部把手按抽屉名启动拖拽。
  for (const drawer of ["annotations", "console"]) {
    expect(panel, `${drawer} drawer needs a resize handle`).toMatch(new RegExp(`onDrawerResizeStart\\('${drawer}', `))
    expect(panel).toMatch(new RegExp(`drawerHeights\\.${drawer}`))
  }
  // 拖拽用指针捕获保证移出把手后仍跟手,并有最小高度与舞台空间约束。
  expect(panel).toMatch(/setPointerCapture/)
  expect(panel).toMatch(/DRAWER_MIN_HEIGHT/)
  expect(panel).toMatch(/stageRef\.value\?\.clientHeight/)
  // 把手禁用触摸滚动,远程触屏设备也能拖拽。
  expect(panel).toMatch(/cursor-row-resize touch-none/)
})

test("drawer heights are no longer fixed tailwind sizes", () => {
  const panel = read("../src/components/browser/BrowserPanel.vue")
  for (const drawer of ["annotations", "console"]) {
    const root = panel.match(
      new RegExp(
        `v-if="show${drawer[0].toUpperCase()}${drawer.slice(1)}"[\\s\\S]*?class="([^"]*)"\\n[\\s\\S]*?:style="\\{ height:`,
      ),
    )
    expect(root, `${drawer} drawer must bind its height via :style`).toBeTruthy()
    expect(root[1]).not.toMatch(/\bh-(?:40|48)\b/)
  }
})

test("proxy initialization does not touch TDZ state", () => {
  const panel = read("../src/components/browser/BrowserPanel.vue")
  const initIndex = panel.indexOf("let initPromise")
  const watchIndex = panel.indexOf("watch(")
  expect(initIndex >= 0, "initPromise must be declared").toBeTruthy()
  expect(watchIndex >= 0, "visible watcher must exist").toBeTruthy()
  expect(initIndex < watchIndex, "immediate watcher must not call initProxy before initPromise exists").toBeTruthy()
})

test("panel posts bridge commands to the proxy origin", () => {
  const panel = read("../src/components/browser/BrowserPanel.vue")
  expect(panel).toMatch(/const targetOrigin = proxyBase\.value \? new URL\(proxyBase\.value\)\.origin : "\*"/)
  expect(panel).not.toMatch(/targetOrigin = proxyBase\.value \?\? "\*"/)
})

test("direct access mode bypasses the proxy and degrades bridge features", () => {
  const panel = read("../src/components/browser/BrowserPanel.vue")
  // 直连模式不使用沙箱属性,也不启动/调用预览代理。
  expect(panel).toMatch(/const directMode = computed/)
  expect(panel).toMatch(/if \(directMode\.value\) return undefined/)
  expect(panel).toMatch(/if \(useProxy\.value\) await initProxy\(\)/)
  expect(panel).toMatch(/if \(useProxy\.value\) initProxy\(\)/)
  // bridge 消息在直连模式下被忽略(跨源页面无法注入 bridge)。
  expect(panel).toMatch(/if \(directMode\.value\) return\n  postToPage/)
  expect(panel).toMatch(/if \(directMode\.value\) return\n  const data = event\.data/)
  // inspect 与控制台属于 bridge 专属功能,直连模式下隐藏。
  expect(panel).toMatch(/v-if="!directMode"\n\s+variant="ghost"\n\s+size="icon-xs"\n\s+:title="t\('browser\.inspect'\)"/)
  // 直连模式用自维护历史栈支持后退/前进。
  expect(panel).toMatch(/directHistory\.value\[directIndex\.value\]/)
  expect(panel).toMatch(/iframeKey\.value\+\+/)
})

test("proxy access is the default and direct is a manual fallback", () => {
  const panel = read("../src/components/browser/BrowserPanel.vue")
  // auto 即代理:仅在手动选择 direct 时才直连,检查/控制台等 bridge 功能默认可用。
  expect(panel).toMatch(/accessPref\.value === "direct" \? "direct" : "proxy"/)
  // 历史存储值 "proxy" 已并入 auto(代理就是默认)。
  expect(panel).toMatch(/stored === "direct" \? "direct" : "auto"/)
  // 访问方式切换按钮在桌面端同样可用(直连是所有端共用的回退)。
  expect(panel).toMatch(/@click="cycleAccessMode"/)
  expect(panel).not.toMatch(/v-if="!isDesktop"/)
  // 基于主机名的自动探测已被移除。
  expect(panel).not.toMatch(/resolveAccessMode/)
})
