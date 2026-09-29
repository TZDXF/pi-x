import { afterEach, expect, test, vi } from "vitest"
import appSource from "@/App.vue?raw"

const mocks = vi.hoisted(() => ({
  desktop: true,
  directory: "C:\\exports",
  rpcSuccess: true,
  calls: [],
  invoke: async () => undefined,
  openPath: async () => undefined,
  chooseDirectory: async () => undefined,
  join: async () => undefined,
}))

vi.mock("@/stores/runtime", () => ({ activeRuntimeId: { value: "default" } }))
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: options => mocks.chooseDirectory(options) }))
vi.mock("@tauri-apps/api/path", () => ({ join: (...parts) => mocks.join(...parts) }))
vi.mock("@/api/transport", () => ({
  RECONNECTED_EVENT: "pi://reconnected",
  get isDesktop() {
    return mocks.desktop
  },
  invoke: (command, args) => mocks.invoke(command, args),
  listen: async () => () => {},
}))

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

async function harness({ desktop = true, directory = "C:\\exports", rpcSuccess = true } = {}) {
  mocks.desktop = desktop
  mocks.directory = directory
  mocks.rpcSuccess = rpcSuccess
  mocks.calls = []
  mocks.chooseDirectory = async options => {
    mocks.calls.push(["choose", options.directory, options.title])
    return directory
  }
  mocks.join = async (...parts) => {
    mocks.calls.push(["join", ...parts])
    return parts.join("/")
  }
  mocks.invoke = async (command, args) => {
    if (command === "open_path") {
      mocks.calls.push(["open", args.path])
      return
    }
    if (command === "rpc_request") {
      const payload = args.command
      mocks.calls.push(["rpc", payload.type, payload.outputPath, args.runtimeId])
      return rpcSuccess
        ? { success: true, data: { path: payload.outputPath } }
        : { success: false, error: "Nothing to export yet" }
    }
    mocks.calls.push(["invoke", command, JSON.parse(JSON.stringify(args))])
    return command === "session_export_file"
      ? args.outputPath
      : { path: "/host/project/session.html", html: "<html></html>" }
  }
  mocks.openPath = async path => mocks.calls.push(["open", path])
  vi.stubGlobal("document", {
    body: { append: link => mocks.calls.push(["append", link.download]) },
    createElement: () => ({ click: () => mocks.calls.push(["click"]), remove: () => mocks.calls.push(["remove"]) }),
  })
  const TestURL = class extends URL {}
  TestURL.createObjectURL = () => "blob:export"
  TestURL.revokeObjectURL = url => mocks.calls.push(["revoke", url])
  vi.stubGlobal("URL", TestURL)
  vi.stubGlobal("setTimeout", callback => callback())
  vi.resetModules()
  const piClient = await import("@/api/piClient")
  return { calls: mocks.calls, exportHtml: piClient.exportSessionHtml, exportFile: piClient.exportSessionFileHtml }
}

test("desktop export lets the user choose a folder and writes HTML there", async () => {
  const { calls, exportHtml } = await harness()
  expect(await exportHtml("runtime-1", "C:\\sessions\\chat.jsonl", "Choose directory")).toBe(true)
  expect(calls).toEqual([
    ["choose", true, "Choose directory"],
    ["join", "C:\\exports", "pi-session-chat.html"],
    ["rpc", "export_html", "C:\\exports/pi-session-chat.html", "runtime-1"],
    ["open", "C:\\exports/pi-session-chat.html"],
  ])
})

test("canceling directory selection does not export or claim success", async () => {
  const { calls, exportHtml } = await harness({ directory: null })
  expect(await exportHtml("runtime-1", "chat.jsonl")).toBe(false)
  expect(calls).toEqual([["choose", true, undefined]])
})

test("remote export downloads HTML instead of opening the host path", async () => {
  const { calls, exportHtml } = await harness({ desktop: false })
  expect(await exportHtml("runtime-2")).toBe(true)
  expect(calls).toEqual([
    ["invoke", "session_export_html", { runtimeId: "runtime-2" }],
    ["append", "session.html"],
    ["click"],
    ["remove"],
    ["revoke", "blob:export"],
  ])
})

test("failed desktop export does not try to open a file", async () => {
  const { calls, exportHtml } = await harness({ rpcSuccess: false })
  await expect(exportHtml("runtime-1", "chat.jsonl")).rejects.toThrow(/Nothing to export yet/)
  expect(calls.map(call => call[0])).toEqual(["choose", "join", "rpc"])
})

test("sidebar export targets a saved file without selecting or starting a runtime", async () => {
  const { calls, exportFile } = await harness()
  expect(await exportFile("C:\\sessions\\other.jsonl", "Choose directory")).toBe(true)
  expect(calls).toEqual([
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
  const { calls, exportFile } = await harness({ desktop: false })
  expect(await exportFile("/host/sessions/other.jsonl")).toBe(true)
  expect(calls).toEqual([
    ["invoke", "session_export_html", { file: "/host/sessions/other.jsonl" }],
    ["append", "session.html"],
    ["click"],
    ["remove"],
    ["revoke", "blob:export"],
  ])
})

test("sidebar export never navigates or calls resumeSession", async () => {
  const code = appSource
    .slice(appSource.indexOf("async function openSessionAction"), appSource.indexOf("async function newProjectSession"))
    .replace("file: string", "file")
    .replace('action: "export"', "action")
  const calls = []
  const exportSessionFileHtml = async file => {
    calls.push(["export", file])
    return true
  }
  const resumeSession = () => {
    throw new Error("must not select a session")
  }
  const ui = { pushToast: (...args) => calls.push(["toast", ...args]) }
  const t = key => key
  const action = await new Function(
    "exportSessionFileHtml",
    "resumeSession",
    "ui",
    "t",
    `${code}\nreturn openSessionAction`,
  )(exportSessionFileHtml, resumeSession, ui, t)
  await action("other.jsonl", "export")
  expect(calls).toEqual([
    ["export", "other.jsonl"],
    ["toast", "chat.toastExported", "info"],
  ])
})
