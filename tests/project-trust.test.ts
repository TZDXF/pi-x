import { afterEach, expect, test, vi } from "vitest"
import { nextTick, ref } from "vue"
import { readFileSync } from "node:fs"
import { useProjectTrust } from "@/composables/useProjectTrust"
import type { TrustStatus } from "@/api/piClient"
import { mountBrowserComposable } from "./browserTestHarness"

const disposers: (() => void)[] = []
afterEach(() => disposers.splice(0).forEach(dispose => dispose()))

function status(decision: boolean | null = false, policy = "ask"): TrustStatus {
  return {
    projectPath: "D:\\canonical\\project",
    parentPath: "D:\\canonical",
    hasTrustRequiringResources: true,
    decision,
    policy,
    needsDecision: decision === null && policy === "ask",
  }
}

function setup(initial = status(), path = "D:/project", open = true) {
  const active = ref(open)
  const project = ref(path)
  const api = {
    trustStatus: vi.fn().mockResolvedValue(initial),
    trustSave: vi.fn().mockResolvedValue(undefined),
    sshTrustStatus: vi.fn().mockResolvedValue(initial),
    sshTrustSave: vi.fn().mockResolvedValue(undefined),
  }
  const connections = [{ id: "remote-1", host: "host", port: 22, user: "dev" }]
  const mounted = mountBrowserComposable(() =>
    useProjectTrust({
      project: () => project.value,
      active: () => active.value,
      connections: () => connections,
      api,
    }),
  )
  disposers.push(mounted.unmount)
  return { ...mounted.result, api, active, project, unmount: mounted.unmount }
}

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

test("previously denied projects can be trusted using Pi's canonical path and refreshed", async () => {
  const state = setup()
  await flush()
  expect(state.trusted.value).toBe(false)
  state.api.trustStatus.mockResolvedValue(status(true))
  await state.trust()
  expect(state.api.trustSave).toHaveBeenCalledWith("D:\\canonical\\project", true, false)
  expect(state.api.trustStatus).toHaveBeenCalledTimes(2)
  expect(state.trusted.value).toBe(true)
  expect(state.saved.value).toBe(true)
  expect(state.saving.value).toBe(false)
  await state.trust()
  expect(state.api.trustSave).toHaveBeenCalledTimes(1)
})

test.each([
  [true, "ask", true],
  [null, "always", true],
  [false, "always", false],
  [null, "ask", false],
  [null, "never", false],
] as const)("trust display respects decision %s with policy %s", async (decision, policy, expected) => {
  const state = setup(status(decision, policy))
  await flush()
  expect(state.trusted.value).toBe(expected)
})

test("failed saves preserve the untrusted state and allow retry without duplicate writes", async () => {
  const state = setup()
  await flush()
  const pending = deferred<unknown>()
  state.api.trustSave.mockReturnValueOnce(pending.promise)
  const saving = state.trust()
  await state.trust()
  expect(state.api.trustSave).toHaveBeenCalledTimes(1)
  expect(state.saving.value).toBe(true)
  pending.reject(new Error("write failed"))
  await saving
  expect(state.error.value).toEqual(new Error("write failed"))
  expect(state.saved.value).toBe(false)
  expect(state.trusted.value).toBe(false)
  state.api.trustStatus.mockResolvedValue(status(true))
  await state.trust()
  expect(state.trusted.value).toBe(true)
  expect(state.error.value).toBe(null)
})

test("closed editors do not query or change trust; reopening reads the current decision", async () => {
  const state = setup(status(), "D:/project", false)
  await state.trust()
  expect(state.api.trustStatus).not.toHaveBeenCalled()
  expect(state.api.trustSave).not.toHaveBeenCalled()
  state.active.value = true
  await flush()
  state.active.value = false
  state.api.trustStatus.mockResolvedValue(status(true))
  state.active.value = true
  await flush()
  expect(state.trusted.value).toBe(true)
  expect(state.api.trustStatus).toHaveBeenCalledTimes(2)
})

test("read failures are retryable and cannot enable trust before the directory is known", async () => {
  const state = setup(status(), "D:/project", false)
  state.api.trustStatus.mockRejectedValueOnce(new Error("read failed"))
  state.active.value = true
  await flush()
  await state.trust()
  expect(state.status.value).toBe(null)
  expect(state.api.trustSave).not.toHaveBeenCalled()
  expect(state.error.value).toEqual(new Error("read failed"))
  await state.refresh()
  expect(state.status.value?.decision).toBe(false)
  expect(state.error.value).toBe(null)
})

test("late reads and saves never replace another directory's state", async () => {
  const state = setup()
  await flush()
  const save = deferred<unknown>()
  state.api.trustSave.mockReturnValueOnce(save.promise)
  const saving = state.trust()
  const read = deferred<TrustStatus>()
  state.api.trustStatus.mockReturnValueOnce(read.promise)
  state.project.value = "D:/second"
  state.project.value = "D:/third"
  await flush()
  save.resolve(undefined)
  read.resolve(status(true))
  await saving
  await flush()
  expect(state.status.value?.decision).toBe(false)
  expect(state.saved.value).toBe(false)
  expect(state.saving.value).toBe(false)
  expect(state.loading.value).toBe(false)
})

test("remote projects read and save on the matching host only", async () => {
  const uri = "ssh://dev@host/home/dev/project"
  const state = setup({ ...status(), projectPath: "/real/project" }, uri)
  await flush()
  state.api.sshTrustStatus.mockResolvedValue(status(true))
  await state.trust()
  expect(state.api.sshTrustStatus).toHaveBeenCalledWith(uri, "remote-1")
  expect(state.api.sshTrustSave).toHaveBeenCalledWith(uri, "remote-1", true, false)
  expect(state.api.trustStatus).not.toHaveBeenCalled()
  expect(state.api.trustSave).not.toHaveBeenCalled()
  expect(state.trusted.value).toBe(true)
})

test("a failed refresh after saving still reports persistence and can recover", async () => {
  const state = setup()
  await flush()
  state.api.trustStatus.mockRejectedValueOnce(new Error("refresh failed"))
  await state.trust()
  expect(state.saved.value).toBe(true)
  expect(state.error.value).toEqual(new Error("refresh failed"))
  state.api.trustStatus.mockResolvedValue(status(true))
  await state.refresh()
  expect(state.trusted.value).toBe(true)
  expect(state.api.trustSave).toHaveBeenCalledTimes(1)
})

test("both locales include all project trust labels", () => {
  const control = readFileSync(new URL("../src/components/ProjectTrustControl.vue", import.meta.url), "utf8")
  for (const locale of ["zh-CN", "en"]) {
    const messages = readFileSync(new URL(`../src/i18n/locales/${locale}.ts`, import.meta.url), "utf8")
    for (const key of control.matchAll(/"projectDialog\.(\w+)"/g)) {
      expect(messages).toContain(`${key[1]}:`)
    }
    expect(messages).toMatch(/retry:/)
  }
})
