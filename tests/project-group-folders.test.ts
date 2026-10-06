import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

// 多目录项目（ProjectGroup.folders）适配回归：侧栏状态聚合、复制会话刷新、
// 文件树切换目录、跨目录预览/批注，以及新会话保持主目录默认。

const sidebar = readFileSync(new URL("../src/components/WorkspaceSidebar.vue", import.meta.url), "utf8")
const group = readFileSync(
  new URL("../src/components/workspace/sidebar/SidebarProjectGroup.vue", import.meta.url),
  "utf8",
)
const app = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8")
const files = readFileSync(new URL("../src/components/ProjectFiles.vue", import.meta.url), "utf8")
const preview = readFileSync(new URL("../src/components/ProjectFilePreview.vue", import.meta.url), "utf8")
const context = readFileSync(new URL("../src/components/WorkspaceContext.vue", import.meta.url), "utf8")

function runSlice(source: string, from: string, to: string, extra: Record<string, unknown>, outExpr: string) {
  const code = source.slice(source.indexOf(from), source.indexOf(to))
  const vmContext = vm.createContext({ ...extra, Promise })
  vm.runInNewContext(ts.transpile(code) + `\n__out = ${outExpr}`, vmContext)
  return vmContext
}

test("duplicate sessions refresh the source session's own folder, not just the primary", () => {
  expect(sidebar).toMatch(/await refresh\(normalizeProjectPath\(s\.cwd\) \|\| props\.project\)/)
})

test("grouped sidebar state aggregates every folder before hiding the session list", () => {
  const stateOf = (
    folders: string[],
    errors: Record<string, string>,
    loading: Record<string, boolean>,
    histories: Record<string, unknown[]>,
    path = "C:/repo",
  ) => {
    const vmContext = runSlice(
      sidebar,
      "function groupState(",
      "async function refreshGroup",
      {
        workspace: { projectFolders: () => folders, histories },
        errors: { value: errors },
        loading: { value: loading },
        isSshProject: (value: string) => value.startsWith("ssh://"),
      },
      "groupState",
    )
    return (vmContext as { __out: (query: string) => Record<string, unknown> }).__out(path)
  }
  // 主目录缺失但组内其他目录健康：列表仍然显示，仅保留目录缺失警告。
  const partial = stateOf(["C:/repo", "C:/b"], { "C:/repo": "missing" }, {}, { "C:/b": [{}] })
  expect(partial).toMatchObject({ error: "missing", hidden: false, hasHistory: true, listError: "" })
  // 所有目录都缺失时才隐藏整组列表。
  const allMissing = stateOf(["C:/repo", "C:/b"], { "C:/repo": "missing", "C:/b": "missing" }, {}, {})
  expect(allMissing).toMatchObject({ error: "missing", hidden: true, hasHistory: false })
  // 远程项目标记 remote（P2 起会话历史经 ssh_sessions 可用，契约 §2.4）。
  const remote = stateOf(["ssh://dev@host/proj"], {}, {}, {}, "ssh://dev@host/proj")
  expect(remote).toMatchObject({ remote: true, hidden: false, hasHistory: false })
  // 全部目录加载失败才显示整组重试入口。
  const allFailed = stateOf(["C:/repo", "C:/b"], { "C:/repo": "failed", "C:/b": "failed" }, {}, { "C:/repo": [] })
  expect(allFailed).toMatchObject({ listError: "failed", hidden: false })
  const partialFailure = stateOf(["C:/repo", "C:/b"], { "C:/repo": "", "C:/b": "failed" }, {}, { "C:/repo": [] })
  expect(partialFailure).toMatchObject({ listError: "" })
  // 加载与历史状态覆盖组内任意目录。
  const loading = stateOf(["C:/repo", "C:/b"], {}, { "C:/b": true }, {})
  expect(loading).toMatchObject({ loading: true })
})

test("new sessions keep defaulting to the project primary directory", () => {
  // 侧栏组：+ 按钮直接在主目录开新会话，不提供组内目录选择。
  expect(group).toMatch(/@click="emit\('newSession', path\)"/)
  expect(group).not.toMatch(/folders\.length > 1/)
  // ChatView 的新会话归到项目主目录：包装已提为具名处理器，两处 ChatView
  // 共用同一个处理器，其内部仍然走项目主目录路由。
  const chatHandler = app.match(/function newSessionFromChat\(\)[\s\S]*?\n\}/)?.[0]
  expect(chatHandler).toBeTruthy()
  expect(chatHandler).toMatch(
    /requestConversationNavigation\(\s*projectRoute\(workspace\.projectRoot\(project\.value\)\),\s*\(\) => newProjectSession\(workspace\.projectRoot\(project\.value\)\),\s*\)/,
  )
  expect(app.match(/@new-session="newSessionFromChat"/g)?.length).toBeGreaterThanOrEqual(2)
  // 顶栏项目下拉不列出组内目录。
  expect(context).not.toMatch(/groupFolders/)
})

test("the project file tree switches roots across the group folders", () => {
  expect(files).toMatch(/v-if="roots\.length > 1"/)
  expect(files).toMatch(/@select="activeRoot = root"/)
  expect(files).toMatch(/invoke<Entry\[\]>\("list_project_directory", \{ project: activeRoot\.value, path \}\)/)
  // 切换目录后预览与批注归属跟随所选目录，批注 key 仍是会话目录。
  expect(files).toMatch(/:project="activeRoot"/)
  expect(files).toMatch(/:comment-project="props\.project"/)
})

test("file previews and code comments address files outside the session folder", () => {
  expect(preview).toMatch(/commentProject\?: string/)
  expect(preview).toMatch(/const commentProject = computed\(\(\) => props\.commentProject \?\? props\.project\)/)
  expect(preview).toMatch(/codeComments\.add\(commentProject\.value/)
  expect(preview).toMatch(/\(c\.root \?\? props\.project\) === props\.project/)
})
