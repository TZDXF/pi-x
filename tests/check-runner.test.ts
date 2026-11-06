import { expect, test, vi } from "vitest"
import { checkCommand, runChecks } from "../scripts/check.mjs"

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

test("package manager paths with spaces work for JS and native distributions", () => {
  const js = "C:/Program Files/pnpm/bin/pnpm.cjs"
  expect(checkCommand("typecheck", js)).toEqual({ command: process.execPath, args: [js, "run", "typecheck"] })
  for (const native of ["C:/Program Files/pnpm/pnpm.exe", "/opt/pnpm/pnpm"]) {
    expect(checkCommand("lint", native)).toEqual({ command: native, args: ["run", "lint"] })
  }
  expect(checkCommand("rust:remote")).toEqual({
    command: "cargo",
    args: ["check", "--manifest-path", "src-tauri/Cargo.toml", "--features", "remote-access"],
  })
})

test("independent checks start together; remote waits for both build and default Rust", async () => {
  const jobs = new Map(["lint", "typecheck", "build", "rust", "rust:remote"].map(name => [name, deferred()]))
  const run = vi.fn((name: string) => jobs.get(name)!.promise)
  const result = runChecks({ run, log: () => {} })
  expect(run.mock.calls.map(([name]) => name)).toEqual(["lint", "typecheck", "build", "rust"])
  jobs.get("build")!.resolve()
  await Promise.resolve()
  expect(run).not.toHaveBeenCalledWith("rust:remote")
  jobs.get("rust")!.resolve()
  await vi.waitFor(() => expect(run).toHaveBeenCalledWith("rust:remote"))
  for (const job of jobs.values()) job.resolve()
  expect(await result).toBe(true)
})

test.each(["build", "rust"])("%s failure skips remote and drains every running check", async failed => {
  const pending = deferred()
  const run = vi.fn((name: string) => {
    if (name === failed) return Promise.reject(new Error("failed"))
    if (name === "typecheck") return pending.promise
    return Promise.resolve()
  })
  let settled = false
  const result = runChecks({ run, log: () => {} }).then(success => {
    settled = true
    return success
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(settled).toBe(false)
  expect(run).not.toHaveBeenCalledWith("rust:remote")
  pending.resolve()
  expect(await result).toBe(false)
})

test.each(["lint", "typecheck", "rust:remote"])("%s failure fails the full check", async failed => {
  const run = vi.fn(async (name: string) => {
    if (name === failed) throw new Error("failed")
  })
  expect(await runChecks({ run, log: () => {} })).toBe(false)
  expect(run).toHaveBeenCalledWith("rust:remote")
})

test("quick mode runs lint and typecheck without build or Cargo", async () => {
  const run = vi.fn(async () => {})
  expect(await runChecks({ quick: true, run, log: () => {} })).toBe(true)
  expect(run.mock.calls).toEqual([["lint"], ["typecheck"]])
})

test("serial mode limits work to one check at a time", async () => {
  let active = 0
  const run = vi.fn(async () => {
    expect(++active).toBe(1)
    await Promise.resolve()
    active--
  })
  expect(await runChecks({ serial: true, run, log: () => {} })).toBe(true)
  expect(run.mock.calls).toHaveLength(5)
})

test("serial mode stops after a failure", async () => {
  const run = vi.fn(async (name: string) => {
    if (name === "typecheck") throw new Error("failed")
  })
  expect(await runChecks({ serial: true, run, log: () => {} })).toBe(false)
  expect(run.mock.calls).toEqual([["lint"], ["typecheck"]])
})
