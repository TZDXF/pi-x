import { expect, test } from "vitest"
import { parse, compileScript } from "vue/compiler-sfc"
import { transpileModule, ModuleKind, ScriptTarget } from "typescript"
import { reactive } from "vue"
import * as vueRuntime from "vue"
import cardSource from "@/components/TurnChangesCard.vue?raw"
import * as paths from "@/lib/paths"
import * as sessionChanges from "@/lib/sessionChanges"
import * as turnChanges from "@/lib/turnChanges"
import * as backendError from "@/lib/backendError"

async function loadVueSetup(source, props, emit, require) {
  const { descriptor } = parse(source, { filename: "TurnChangesCard.vue" })
  const compiled = compileScript(descriptor, { id: "turn-changes-card-test" }).content
  const output = transpileModule(compiled, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  const requireModule = id => (id in require ? require[id] : {})
  new Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports,
    requireModule,
    module,
    "TurnChangesCard.vue",
    import.meta.dirname,
  )
  return module.exports.default.setup(props, { expose: () => {}, emit })
}

async function harness(files, { project = "C:/code/demo", checkpoint = null, artifacts = [], preview, apply } = {}) {
  const props = reactive({ files, project, checkpoint, artifacts })
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
  const dependencies = {
    vue: { ...vueRuntime },
    "vue-i18n": { useI18n: () => ({ t: key => key }) },
    "@/lib/paths": paths,
    "@/lib/backendError": backendError,
    "@/lib/turnChanges": turnChanges,
    "@/lib/sessionChanges": sessionChanges,
    "@/lib/revertChanges": {
      revertTurnFiles: async (revertProject, list) => {
        revertCalls.push({ project: revertProject, list })
        return list.map(file => ({
          path: file.path,
          ok: !file.path.includes("fail"),
          error: file.path.includes("fail") ? "boom" : undefined,
        }))
      },
    },
    "@/lib/checkpoints": {
      restoreCheckpoints: async (restoreProject, from, to, restorePaths) => {
        restoreCalls.push({ project: restoreProject, from, to, paths: restorePaths })
        const list = restorePaths ?? files.map(file => file.path)
        return {
          restored: list.filter(path => !path.includes("conflict")),
          conflicts: list.filter(path => path.includes("conflict")).map(path => ({ path, reason: "content-mismatch" })),
        }
      },
    },
    "@/lib/fileRewind": {
      previewFileRewind: async (rewindProject, list) => {
        previewCalls.push({ project: rewindProject, list })
        return preview ?? defaultPreview
      },
      applyFileRewind: async (rewindProject, list) => {
        applyCalls.push({ project: rewindProject, list })
        return { applied: true, preview: apply ?? preview ?? defaultPreview, response: "" }
      },
    },
  }
  const bindings = await loadVueSetup(cardSource, props, (name, payload) => emitted.push([name, payload]), dependencies)
  return {
    props,
    emitted,
    revertCalls,
    restoreCalls,
    previewCalls,
    applyCalls,
    ...bindings,
  }
}

const checkpointRecord = (state = "active") => ({
  turnIndex: 0,
  userTimestamp: 1,
  startOid: "start-oid",
  endOid: "end-oid",
  state,
  files: [],
})

const file = (path, { added = 1, removed = 0, unknown = false, revertible = true, ops = [] } = {}) => ({
  path,
  added,
  removed,
  unknown,
  revertible,
  ops,
})

// 组件 computed 返回的 Vue 对象转成纯数据后聚焦断言。
const plain = value => JSON.parse(JSON.stringify(value))

test("totals aggregate lines across files", async () => {
  const h = await harness([file("a.ts", { added: 2, removed: 1 }), file("b.ts", { added: 0, removed: 3 })])
  expect(plain(h.totals.value)).toEqual({ added: 2, removed: 4 })
})

test("rows show project files as relative paths with a dimmed directory part", async () => {
  const h = await harness([file("C:/code/demo/src/lib/a.ts"), file("D:/other/b.ts")])
  expect(plain(h.rows.value.map(row => ({ display: row.display, dir: row.dir, base: row.base })))).toEqual([
    { display: "src/lib/a.ts", dir: "src/lib/", base: "a.ts" },
    { display: "D:/other/b.ts", dir: "D:/other/", base: "b.ts" },
  ])
  // 行内保留原始路径作为审查定位与回滚的标识。
  expect(h.rows.value.map(row => row.file.path)).toEqual(["C:/code/demo/src/lib/a.ts", "D:/other/b.ts"])
})

test("git snapshot revert takes precedence and swaps the checkpoint direction", async () => {
  const h = await harness([file("src/a.ts", { added: 2, removed: 1 }), file("conflict.ts")], {
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
  const h = await harness([file("src/a.ts")], { checkpoint: checkpointRecord("active") })
  await h.revert(h.revertibleFiles.value, true)
  expect(h.emitted.some(([name]) => name === "revertedAll")).toBeTruthy()

  await h.revert([h.props.files[0]], false)
  expect(h.restoreCalls.at(-1).paths).toEqual(["src/a.ts"])
})

test("turn without a checkpoint falls back to content replay", async () => {
  const h = await harness([file("a.ts", { ops: [{ kind: "replace", before: "x", after: "y" }] })])
  expect(h.gitRevertible.value).toBe(false)
  await h.revert(h.revertibleFiles.value, true)
  expect(h.restoreCalls.length).toBe(0)
  expect(h.revertCalls.length).toBe(1)
  expect(h.revertCalls[0].list[0].ops).toEqual([{ kind: "replace", before: "x", after: "y" }])
  expect(h.emitted.some(([name]) => name === "revertedAll")).toBeTruthy()
})

test("reverted turns keep the badge and drop the undo affordances", async () => {
  const h = await harness([file("a.ts")], { checkpoint: checkpointRecord("reverted") })
  expect(h.turnReverted.value).toBe(true)
  expect(h.gitRevertible.value).toBe(false)
  expect(h.revertibleFiles.value.length).toBe(1)
  // 模板：已回滚徽标 + 头部按钮隐藏 + 行内显示成功图标。
  expect(cardSource.includes(`v-if="(revertibleFiles.length || hasArtifacts) && !isTurnReverted"`)).toBeTruthy()
  expect(cardSource.includes(`v-if="isTurnReverted || reverted.has(row.file.path)"`)).toBeTruthy()
})

test("template wires expand toggle, review opening and per-file actions", async () => {
  expect(cardSource.includes(':aria-expanded="expanded"')).toBeTruthy()
  expect(cardSource.includes(`emit('openReview', row.file.path)`)).toBeTruthy()
  expect(cardSource.includes("confirmOpen = true")).toBeTruthy()
  expect(cardSource.includes('@click="confirmRevertAll"')).toBeTruthy()
  expect(cardSource.includes("revert([row.file], false)")).toBeTruthy()
  expect(cardSource.includes(':disabled="busy || !row.file.revertible"')).toBeTruthy()
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
  const h = await harness([file("a.ts")], { artifacts: [artifact()], preview: unsafe })
  expect(h.hasArtifacts.value).toBe(true)
  await h.openArtifactRewind()
  expect(h.rewindOpen.value).toBe(true)
  expect(h.rewindPreview.value.canApply).toBe(false)
  expect(h.previewCalls.length).toBe(1)
  await h.confirmArtifactRewind()
  expect(h.applyCalls.length).toBe(0)
  expect(cardSource.includes('t("turnChanges.rewindUnsafe")')).toBeTruthy()
  expect(cardSource.includes('t("turnChanges.rewindReasonExternalModified")')).toBeTruthy()
})

test("artifact preview applies safe files and persists the reverted state", async () => {
  const h = await harness([file("a.ts")], { artifacts: [artifact()] })
  await h.openArtifactRewind()
  expect(h.rewindPreview.value.canApply).toBe(true)
  await h.confirmArtifactRewind()
  expect(h.applyCalls.length).toBe(1)
  expect(h.isTurnReverted.value).toBe(true)
  expect(h.emitted.some(([name]) => name === "revertedAll")).toBeTruthy()
  expect(cardSource.includes('t("turnChanges.rewindApply")')).toBeTruthy()
})
