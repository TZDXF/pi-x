import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"
import { pathsModule } from "./lib/load-ts.mjs"

const source = readFileSync(new URL("../src/api/piClient.ts", import.meta.url), "utf8")
const exportSource = source
  .slice(source.indexOf("async function chooseExportPath"), source.indexOf("// ---- RPC bridge ----"))
  .replaceAll("export async function", "async function")
const script = ts.transpile(
  `${exportSource}\nglobalThis.exportSessionHtml = exportSessionHtml; globalThis.exportSessionFileHtml = exportSessionFileHtml`,
  {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.None,
  },
)

function harness({ desktop = true, directory = "C:\\exports", rpcSuccess = true } = {}) {
  const calls = []
  const document = {
    body: { append: link => calls.push(["append", link.download]) },
    createElement: () => ({ click: () => calls.push(["click"]), remove: () => calls.push(["remove"]) }),
  }
  const context = vm.createContext({
    activeRuntimeId: { value: "default" },
    isDesktop: desktop,
    document,
    Blob,
    baseName: pathsModule().baseName,
    URL: { createObjectURL: () => "blob:export", revokeObjectURL: url => calls.push(["revoke", url]) },
    setTimeout: callback => callback(),
    chooseDirectory: async options => {
      calls.push(["choose", options.directory, options.title])
      return directory
    },
    join: async (...parts) => {
      calls.push(["join", ...parts])
      return parts.join("/")
    },
    rpcRequest: async (command, runtimeId) => {
      calls.push(["rpc", command.type, command.outputPath, runtimeId])
      return rpcSuccess
        ? { success: true, data: { path: command.outputPath } }
        : { success: false, error: "Nothing to export yet" }
    },
    openPath: async path => calls.push(["open", path]),
    invoke: async (command, args) => {
      calls.push(["invoke", command, JSON.parse(JSON.stringify(args))])
      return command === "session_export_file"
        ? args.outputPath
        : { path: "/host/project/session.html", html: "<html></html>" }
    },
  })
  vm.runInContext(script, context)
  return { calls, exportHtml: context.exportSessionHtml, exportFile: context.exportSessionFileHtml }
}

test("desktop export lets the user choose a folder and writes HTML there", async () => {
  const { calls, exportHtml } = harness()
  assert.equal(await exportHtml("runtime-1", "C:\\sessions\\chat.jsonl", "Choose directory"), true)
  assert.deepEqual(calls, [
    ["choose", true, "Choose directory"],
    ["join", "C:\\exports", "pi-session-chat.html"],
    ["rpc", "export_html", "C:\\exports/pi-session-chat.html", "runtime-1"],
    ["open", "C:\\exports/pi-session-chat.html"],
  ])
})

test("canceling directory selection does not export or claim success", async () => {
  const { calls, exportHtml } = harness({ directory: null })
  assert.equal(await exportHtml("runtime-1", "chat.jsonl"), false)
  assert.deepEqual(calls, [["choose", true, undefined]])
})

test("remote export downloads HTML instead of opening the host path", async () => {
  const { calls, exportHtml } = harness({ desktop: false })
  assert.equal(await exportHtml("runtime-2"), true)
  assert.deepEqual(calls, [
    ["invoke", "session_export_html", { runtimeId: "runtime-2" }],
    ["append", "session.html"],
    ["click"],
    ["remove"],
    ["revoke", "blob:export"],
  ])
})

test("failed desktop export does not try to open a file", async () => {
  const { calls, exportHtml } = harness({ rpcSuccess: false })
  await assert.rejects(exportHtml("runtime-1", "chat.jsonl"), /Nothing to export yet/)
  assert.deepEqual(
    calls.map(call => call[0]),
    ["choose", "join", "rpc"],
  )
})

test("sidebar export targets a saved file without selecting or starting a runtime", async () => {
  const { calls, exportFile } = harness()
  assert.equal(await exportFile("C:\\sessions\\other.jsonl", "Choose directory"), true)
  assert.deepEqual(calls, [
    ["choose", true, "Choose directory"],
    ["join", "C:\\exports", "pi-session-other.html"],
    [
      "invoke",
      "session_export_file",
      { file: "C:\\sessions\\other.jsonl", outputPath: "C:\\exports/pi-session-other.html" },
    ],
    ["open", "C:\\exports/pi-session-other.html"],
  ])
})

test("remote sidebar export downloads the requested file, not the current runtime", async () => {
  const { calls, exportFile } = harness({ desktop: false })
  assert.equal(await exportFile("/host/sessions/other.jsonl"), true)
  assert.deepEqual(calls, [
    ["invoke", "session_export_html", { file: "/host/sessions/other.jsonl" }],
    ["append", "session.html"],
    ["click"],
    ["remove"],
    ["revoke", "blob:export"],
  ])
})

test("sidebar export never navigates or calls resumeSession", async () => {
  const app = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8")
  const code = app.slice(
    app.indexOf("async function openSessionAction"),
    app.indexOf("async function newProjectSession"),
  )
  const calls = []
  const context = vm.createContext({
    exportSessionFileHtml: async file => {
      calls.push(["export", file])
      return true
    },
    resumeSession: () => {
      throw new Error("must not select a session")
    },
    ui: { pushToast: (...args) => calls.push(["toast", ...args]) },
    t: key => key,
  })
  vm.runInContext(
    ts.transpile(code + "\nglobalThis.action = openSessionAction", { target: ts.ScriptTarget.ES2022 }),
    context,
  )
  await context.action("other.jsonl", "export")
  assert.deepEqual(calls, [
    ["export", "other.jsonl"],
    ["toast", "chat.toastExported", "info"],
  ])
})
