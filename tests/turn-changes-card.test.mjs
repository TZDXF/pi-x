import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import { loadTsModule, loadTsSource } from "./lib/load-ts.mjs"

const source = readFileSync(new URL("../src/components/TurnChangesCard.vue", import.meta.url), "utf8")
const paths = loadTsSource(readFileSync(new URL("../src/lib/paths.ts", import.meta.url), "utf8"))
const sessionChanges = loadTsSource(readFileSync(new URL("../src/lib/sessionChanges.ts", import.meta.url), "utf8"), {
  require: () => paths,
})
const turnChanges = loadTsModule(new URL("../src/lib/turnChanges.ts", import.meta.url), id =>
  id === "@/lib/sessionChanges" ? sessionChanges : undefined,
)
const backendError = loadTsSource(readFileSync(new URL("../src/lib/backendError.ts", import.meta.url), "utf8"))

const checkpointRecord = (state = "active") => ({
  turnIndex: 0,
  userTimestamp: 1,
  startOid: "start-oid",
  endOid: "end-oid",
  state,
  files: [],
})

function harness(files, { project = "C:/code/demo", checkpoint = null, artifacts = [], preview, apply } = {}) {
  const props = { files, project, checkpoint, artifacts }
  const emitted = []
  const revertCalls = []
  const restoreCalls = []
  const previewCalls = []
  const applyCalls = []
  const defaultPreview = {
    canApply: true,
    safeFiles: artifacts.flatMap(artifact =>
      artifact.files.map(file => ({ path: file.path, operationCount: 1, toolNames: [artifact.toolName] })),
    ),
    unsafeFiles: [],
    ignoredFiles: [],
  }
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  const module = loadTsSource(
    script +
      "\nexport { totals, rows, revertibleFiles, hasArtifacts, revert, expanded, busy, reverted, gitRevertible, turnReverted, isTurnReverted, rewindPreview, rewindOpen, openArtifactRewind, confirmArtifactRewind }",
    {
      defineProps: () => props,
      defineEmits: () => (name, payload) => emitted.push([name, payload]),
      require: id => {
        if (id === "vue")
          return {
            ref: value => ({ value }),
            computed: get => ({
              get value() {
                return get()
              },
            }),
          }
        if (id === "vue-i18n") return { useI18n: () => ({ t: key => key }) }
        if (id === "@/lib/revertChanges")
          return {
            revertTurnFiles: async (project, list) => {
              revertCalls.push({ project, list })
              return list.map(file => ({
                path: file.path,
                ok: !file.path.includes("fail"),
                error: file.path.includes("fail") ? "boom" : undefined,
              }))
            },
          }
        if (id === "@/lib/checkpoints")
          return {
            restoreCheckpoints: async (project, from, to, paths) => {
              restoreCalls.push({ project, from, to, paths })
              const list = paths ?? files.map(file => file.path)
              return {
                restored: list.filter(path => !path.includes("conflict")),
                conflicts: list
                  .filter(path => path.includes("conflict"))
                  .map(path => ({ path, reason: "content-mismatch" })),
              }
            },
          }
        if (id === "@/lib/fileRewind")
          return {
            previewFileRewind: async (project, list) => {
              previewCalls.push({ project, list })
              return preview ?? defaultPreview
            },
            applyFileRewind: async (project, list) => {
              applyCalls.push({ project, list })
              return { applied: true, preview: apply ?? preview ?? defaultPreview, response: "" }
            },
          }
        if (id === "@/lib/turnChanges") return turnChanges
        if (id === "@/lib/paths") return paths
        if (id === "@/lib/backendError") return backendError
        return {}
      },
    },
  )
  return { props, emitted, revertCalls, restoreCalls, previewCalls, applyCalls, ...module }
}

const file = (path, { added = 1, removed = 0, unknown = false, revertible = true, ops = [] } = {}) => ({
  path,
  added,
  removed,
  unknown,
  revertible,
  ops,
})

// VM 内创建的对象原型与测试环境不同，deepStrictEqual 会因原型差异而失败。
const plain = value => JSON.parse(JSON.stringify(value))

test("totals aggregate lines across files", () => {
  const h = harness([file("a.ts", { added: 2, removed: 1 }), file("b.ts", { added: 0, removed: 3 })])
  expect(plain(h.totals.value)).toEqual({ added: 2, removed: 4 })
})

test("rows show project files as relative paths with a dimmed directory part", () => {
  const h = harness([file("C:/code/demo/src/lib/a.ts"), file("D:/other/b.ts")])
  expect(plain(h.rows.value.map(row => ({ display: row.display, dir: row.dir, base: row.base })))).toEqual([
    { display: "src/lib/a.ts", dir: "src/lib/", base: "a.ts" },
    { display: "D:/other/b.ts", dir: "D:/other/", base: "b.ts" },
  ])
  // 行内保留原始路径作为审查定位与回滚的标识。
  expect(h.rows.value.map(row => row.file.path)).toEqual(["C:/code/demo/src/lib/a.ts", "D:/other/b.ts"])
})

test("git snapshot revert takes precedence and swaps the checkpoint direction", async () => {
  const h = harness([file("src/a.ts", { added: 2, removed: 1 }), file("conflict.ts")], {
    checkpoint: checkpointRecord("active"),
  })
  expect(h.gitRevertible.value).toBe(true)
  await h.revert(h.revertibleFiles.value, true)
  expect(h.restoreCalls.length).toBe(1)
  expect(h.restoreCalls[0].project).toBe("C:/code/demo")
  // 回滚 = 从结束态恢复到轮开始前的快照；整轮回滚不传路径子集。
  expect(h.restoreCalls[0].from).toBe("end-oid")
  expect(h.restoreCalls[0].to).toBe("start-oid")
  expect(h.restoreCalls[0].paths).toBe(undefined)
  const event = h.emitted.find(([name]) => name === "reverted")
  expect(event[1].length).toBe(2)
  expect(event[1][0].ok).toBe(true)
  expect(event[1][1].ok).toBe(false)
  // 存在冲突时不发 revertedAll（未完全回滚）。
  expect(h.emitted.some(([name]) => name === "revertedAll")).toBe(false)
})

test("full git revert success emits revertedAll; single file passes a path subset", async () => {
  const h = harness([file("src/a.ts")], { checkpoint: checkpointRecord("active") })
  await h.revert(h.revertibleFiles.value, true)
  expect(h.emitted.some(([name]) => name === "revertedAll")).toBeTruthy()

  await h.revert([h.props.files[0]], false)
  expect(h.restoreCalls.at(-1).paths).toEqual(["src/a.ts"])
})

test("turn without a checkpoint falls back to content replay", async () => {
  const h = harness([file("a.ts", { ops: [{ kind: "replace", before: "x", after: "y" }] })])
  expect(h.gitRevertible.value).toBe(false)
  await h.revert(h.revertibleFiles.value, true)
  expect(h.restoreCalls.length).toBe(0)
  expect(h.revertCalls.length).toBe(1)
  expect(h.revertCalls[0].list[0].ops).toEqual([{ kind: "replace", before: "x", after: "y" }])
  expect(h.emitted.some(([name]) => name === "revertedAll")).toBeTruthy()
})

test("reverted turns keep the badge and drop the undo affordances", () => {
  const h = harness([file("a.ts")], { checkpoint: checkpointRecord("reverted") })
  expect(h.turnReverted.value).toBe(true)
  expect(h.gitRevertible.value).toBe(false)
  expect(h.revertibleFiles.value.length).toBe(1)
  // 模板：已回滚徽标 + 头部按钮隐藏 + 行内显示成功图标。
  expect(source.includes(`v-if="(revertibleFiles.length || hasArtifacts) && !isTurnReverted"`)).toBeTruthy()
  expect(source.includes(`v-if="isTurnReverted || reverted.has(row.file.path)"`)).toBeTruthy()
})

test("template wires expand toggle, review opening and per-file actions", () => {
  expect(source.includes(':aria-expanded="expanded"')).toBeTruthy()
  expect(source.includes(`emit('openReview', row.file.path)`)).toBeTruthy()
  expect(source.includes("confirmOpen = true")).toBeTruthy()
  expect(source.includes('@click="confirmRevertAll"')).toBeTruthy()
  expect(source.includes("revert([row.file], false)")).toBeTruthy()
  expect(source.includes(':disabled="busy || !row.file.revertible"')).toBeTruthy()
})

const artifact = () => ({
  version: 1,
  toolCallId: "call-artifact",
  toolName: "write",
  entryId: "entry-artifact",
  files: [{ path: "a.ts", existedBefore: true, beforeContent: "before\n", afterContent: "after\n" }],
})

test("artifact preview blocks apply when any file is unsafe", async () => {
  const unsafe = {
    canApply: false,
    safeFiles: [{ path: "a.ts", operationCount: 1, toolNames: ["write"] }],
    unsafeFiles: [{ path: "a.ts", operationCount: 1, toolNames: ["write"], reason: "external_modified" }],
    ignoredFiles: [],
  }
  const h = harness([file("a.ts")], { artifacts: [artifact()], preview: unsafe })
  expect(h.hasArtifacts.value).toBe(true)
  await h.openArtifactRewind()
  expect(h.rewindOpen.value).toBe(true)
  expect(h.rewindPreview.value.canApply).toBe(false)
  expect(h.previewCalls.length).toBe(1)
  await h.confirmArtifactRewind()
  expect(h.applyCalls.length).toBe(0)
  expect(source.includes('t("turnChanges.rewindUnsafe")')).toBeTruthy()
  expect(source.includes('t("turnChanges.rewindReasonExternalModified")')).toBeTruthy()
})

test("artifact preview applies safe files and persists the reverted state", async () => {
  const h = harness([file("a.ts")], { artifacts: [artifact()] })
  await h.openArtifactRewind()
  expect(h.rewindPreview.value.canApply).toBe(true)
  await h.confirmArtifactRewind()
  expect(h.applyCalls.length).toBe(1)
  expect(h.isTurnReverted.value).toBe(true)
  expect(h.emitted.some(([name]) => name === "revertedAll")).toBeTruthy()
  expect(source.includes('t("turnChanges.rewindApply")')).toBeTruthy()
})
