import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8")

test("browser drawers resize by dragging their top handles", () => {
  const panel = read("../src/components/browser/BrowserPanel.vue")
  // 两个抽屉都由 drawerHeights 驱动高度,顶部把手按抽屉名启动拖拽。
  for (const drawer of ["annotations", "console"]) {
    assert.match(panel, new RegExp(`onDrawerResizeStart\\('${drawer}', `), `${drawer} drawer needs a resize handle`)
    assert.match(panel, new RegExp(`drawerHeights\\.${drawer}`))
  }
  // 拖拽用指针捕获保证移出把手后仍跟手,并有最小高度与舞台空间约束。
  assert.match(panel, /setPointerCapture/)
  assert.match(panel, /DRAWER_MIN_HEIGHT/)
  assert.match(panel, /stageRef\.value\?\.clientHeight/)
  // 把手禁用触摸滚动,远程触屏设备也能拖拽。
  assert.match(panel, /cursor-row-resize touch-none/)
})

test("drawer heights are no longer fixed tailwind sizes", () => {
  const panel = read("../src/components/browser/BrowserPanel.vue")
  for (const drawer of ["annotations", "console"]) {
    const root = panel.match(new RegExp(`v-if="show${drawer[0].toUpperCase()}${drawer.slice(1)}"[\\s\\S]*?class="([^"]*)"\\n[\\s\\S]*?:style="\\{ height:`))
    assert.ok(root, `${drawer} drawer must bind its height via :style`)
    assert.doesNotMatch(root[1], /\bh-(?:40|48)\b/)
  }
})
