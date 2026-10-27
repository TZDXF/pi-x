import { beforeEach, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), list: vi.fn(), connection: vi.fn() }))
vi.mock("@/api/transport", () => ({ invoke: mocks.invoke }))
vi.mock("@/api/client/ssh", () => ({ sshConnectionList: mocks.list }))
vi.mock("@/lib/sshTrust", () => ({ terminalConnectionId: mocks.connection }))
import { invokeProjectFile } from "@/api/client/projectFiles"

beforeEach(() => vi.resetAllMocks())
test.each(["ssh://dev@host/work", "wsl://Ubuntu/work", "docker://app/work"])(
  "file reads forward the saved connection for %s",
  async project => {
    mocks.connection.mockResolvedValue("saved-connection")
    mocks.invoke.mockResolvedValue({ kind: "text", text: "hello" })
    expect(await invokeProjectFile("read_file_preview", project, "hello.txt")).toEqual({ kind: "text", text: "hello" })
    expect(mocks.connection).toHaveBeenCalledWith(project, mocks.list)
    expect(mocks.invoke).toHaveBeenCalledWith("read_file_preview", {
      project,
      path: "hello.txt",
      sshConnectionId: "saved-connection",
    })
  },
)
test("missing remote connections fail before invoking file access", async () => {
  mocks.connection.mockRejectedValue(new Error("missing connection"))
  await expect(invokeProjectFile("list_project_directory", "ssh://host/work", "")).rejects.toThrow("missing connection")
  expect(mocks.invoke).not.toHaveBeenCalled()
})
test("local directory reads do not require a remote connection", async () => {
  mocks.connection.mockResolvedValue(undefined)
  await invokeProjectFile("list_project_directory", "C:/work", "src")
  expect(mocks.invoke).toHaveBeenCalledWith("list_project_directory", {
    project: "C:/work",
    path: "src",
    sshConnectionId: undefined,
  })
})
