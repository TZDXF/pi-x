import { expect, test } from "vitest"
import { readFileSync } from "node:fs"

const files = readFileSync(new URL("../src/components/ProjectFiles.vue", import.meta.url), "utf8")
const preview = readFileSync(new URL("../src/components/ProjectFilePreview.vue", import.meta.url), "utf8")
const watch = readFileSync(new URL("../src/composables/useProjectFileWatch.ts", import.meta.url), "utf8")

test("文件树不再与预览平分网格，内容区常开并支持宽度拖拽", () => {
  // 旧实现是 3fr/2fr 的网格，文件树随面板宽度按比例变化且无法单独拖拽。
  expect(files).not.toMatch(/grid-cols-\[minmax\(0,3fr\)_minmax\(0,2fr\)\]/)
  expect(files).toMatch(/data-project-files-tree/)
  expect(files).toMatch(/:style="preview \? \{ width: `\$\{treeWidth\}px` \} : undefined"/)
  // 未选文件时内容区仍在（占位提示），关闭预览只是取消选中。
  expect(files).toMatch(/t\("projectFiles\.selectFile"\)/)
  // 文件树宽度手柄有键盘与无障碍语义，宽度按记忆值持久化。
  expect(files).toMatch(/role="separator"/)
  expect(files).toMatch(/resizeTreeWithKeyboard/)
  expect(files).toMatch(/pix\.project-files-tree-width/)
})

test("选中文件的内容随磁盘变化自动刷新而无需重新打开", () => {
  expect(files).toMatch(/useProjectFileWatch/)
  expect(files).toMatch(/previewNeedsReload\(selected\.value, paths\)/)
  expect(files).toMatch(/directoriesToReload\(paths, children\.value\)/)
  expect(files).toMatch(/:revision="previewRevision"/)
  // 只有内容刷新时保留渲染/源码切换状态，切换文件才重置视图。
  expect(preview).toMatch(/async function load\(resetView = true\)/)
  expect(preview).toMatch(/watch\(\s*\(\) => props\.revision,\s*\(\) => void load\(false\)/)
})

test("监听随项目切换与组件销毁清理，远程项目不监听", () => {
  expect(watch).toMatch(/unwatchProjectFiles/)
  expect(watch).toMatch(/onScopeDispose/)
  expect(watch).toMatch(/isRemoteProject\(root\)/)
  expect(watch).toMatch(/if \(samePath\(change\.project, root\)\) onChange\(change\.paths\)/)
  expect(files).toContain('const watchRoot = computed(() => (props.files === undefined ? activeRoot.value : "")')
})
