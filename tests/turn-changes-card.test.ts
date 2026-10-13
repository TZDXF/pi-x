import { expect, test } from "vitest"
import { parse, compileScript } from "vue/compiler-sfc"
import { transpileModule, ModuleKind, ScriptTarget } from "typescript"
import { reactive, nextTick } from "vue"
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

async function harness(
  files,
  { project = "C:/code/demo", sessionFile = "session.jsonl", artifacts = [], preview, apply, wasReverted = false } = {},
) {
  const props = reactive({ files, project, sessionFile, artifacts, wasReverted })
  const emitted = []
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
    "@/lib/fileRewind": {
      previewFileRewind: async (project, artifacts) => {
        previewCalls.push({ project, artifacts })
        return typeof preview === "function" ? preview() : (preview ?? defaultPreview)
      },
      applyFileRewind: async (project, artifacts, file) => {
        applyCalls.push({ project, artifacts, file })
        return typeof apply === "function"
          ? apply()
          : (apply ?? {
              applied: true,
              preview: preview ?? defaultPreview,
              response: "",
              revertedToolCallIds: artifacts.map(artifact => artifact.toolCallId),
            })
      },
    },
  }
  const bindings = await loadVueSetup(cardSource, props, (name, ...args) => emitted.push([name, ...args]), dependencies)
  return { props, emitted, previewCalls, applyCalls, ...bindings }
}

const file = path => ({ path, added: 1, removed: 0, unknown: false, revertible: true })
const artifact = () => ({
  version: 1,
  toolCallId: "call-artifact",
  toolName: "write",
  entryId: "entry-artifact",
  files: [{ path: "a.ts", existedBefore: true, beforeContent: "before\n", afterContent: "after\n" }],
})

test("file rows show project-relative paths but retain their original identifiers", async () => {
  const h = await harness([file("C:/code/demo/src/lib/a.ts"), file("D:/other/b.ts")])
  expect(h.rows.value.map(row => ({ display: row.display, dir: row.dir, base: row.base }))).toEqual([
    { display: "src/lib/a.ts", dir: "src/lib/", base: "a.ts" },
    { display: "D:/other/b.ts", dir: "D:/other/", base: "b.ts" },
  ])
})

test("legacy snippets are review-only; there is no Git or parameter replay fallback", async () => {
  const h = await harness([file("a.ts")])
  await h.openArtifactRewind()
  expect(h.previewCalls).toEqual([])
  expect(h.applyCalls).toEqual([])
  expect(cardSource).not.toMatch(/restoreCheckpoints|revertTurnFiles|checkpoint|confirmRevertAll/)
  expect(cardSource).toContain('v-if="hasArtifacts && !isTurnReverted"')
  expect(cardSource).toContain('t("turnChanges.readOnly")')
})

test("unsafe previews never apply", async () => {
  const preview = {
    canApply: false,
    safeFiles: [],
    unsafeFiles: [{ path: "a.ts", operationCount: 1, toolNames: ["write"], reason: "external_modified" }],
    ignoredFiles: [],
  }
  const h = await harness([file("a.ts")], { artifacts: [artifact()], preview })
  await h.openArtifactRewind()
  expect(h.rewindOpen.value).toBe(true)
  await h.confirmArtifactRewind()
  expect(h.applyCalls).toEqual([])
})

test("safe rewind submits the owning session and reports only persisted call markers", async () => {
  const h = await harness([file("a.ts")], { artifacts: [artifact()] })
  await h.openArtifactRewind()
  await h.confirmArtifactRewind()
  expect(h.applyCalls[0].file).toBe("session.jsonl")
  expect(h.isTurnReverted.value).toBe(true)
  expect(h.rewindOpen.value).toBe(false)
  expect(h.emitted).toEqual([
    ["reverted", [{ path: "a.ts", ok: true }]],
    ["revertedAll", "session.jsonl", ["call-artifact"]],
  ])
})

test("a drift detected at apply time leaves the turn active", async () => {
  const h = await harness([file("a.ts")], {
    artifacts: [artifact()],
    apply: {
      applied: false,
      preview: { canApply: false, safeFiles: [], unsafeFiles: [], ignoredFiles: [] },
      response: "",
      revertedToolCallIds: [],
    },
  })
  await h.openArtifactRewind()
  await h.confirmArtifactRewind()
  expect(h.isTurnReverted.value).toBe(false)
  expect(h.rewindError.value).toBe("turnChanges.rewindFailed")
  expect(h.emitted).toEqual([])
})

test("persisted reverted turns cannot be undone again", async () => {
  const h = await harness([file("a.ts")], { artifacts: [artifact()], wasReverted: true })
  expect(h.isTurnReverted.value).toBe(true)
  await h.openArtifactRewind()
  expect(h.previewCalls).toEqual([])
})

test("a preview arriving after a session switch cannot enable undo in another session", async () => {
  let resolve
  const pending = new Promise(done => {
    resolve = done
  })
  const h = await harness([file("a.ts")], { artifacts: [artifact()], preview: () => pending })
  const opening = h.openArtifactRewind()
  h.props.sessionFile = "other.jsonl"
  await nextTick()
  resolve({ canApply: true, safeFiles: [], unsafeFiles: [], ignoredFiles: [] })
  await opening
  expect(h.rewindPreview.value).toBe(null)
  await h.confirmArtifactRewind()
  expect(h.applyCalls).toEqual([])
})

test("apply completion after a session switch does not mark the new session reverted", async () => {
  let resolve
  const pending = new Promise(done => {
    resolve = done
  })
  const h = await harness([file("a.ts")], { artifacts: [artifact()], apply: () => pending })
  await h.openArtifactRewind()
  const applying = h.confirmArtifactRewind()
  h.props.sessionFile = "other.jsonl"
  await nextTick()
  resolve({ applied: true, preview: { safeFiles: [{ path: "a.ts" }] }, revertedToolCallIds: ["call-artifact"] })
  await applying
  expect(h.emitted).toEqual([])
  expect(h.isTurnReverted.value).toBe(false)
  expect(h.applyCalls[0].file).toBe("session.jsonl")
})
