import { afterEach, expect, test, vi } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"
import * as vue from "vue"
import { createTerminalOutputRouter, type TerminalOutput } from "@/lib/terminalOutput"
import { terminalConnectionId } from "@/lib/sshTrust"

const scopes: vue.EffectScope[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))

const source = readFileSync(new URL("../src/components/terminal/TerminalPanel.vue", import.meta.url), "utf8")
function harness(create = async (_args: Record<string, any>) => 12) {
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .*$/gm, "")
  const handlers = new Map<string, (event: { payload: any }) => void>()
  const unsubscribe = vi.fn()
  const invoke = vi.fn(async (command: string, args: Record<string, any>) =>
    command === "term_create" ? create(args) : undefined,
  )
  let unmount = () => {}
  class Terminal {
    options: any = {}
    write = vi.fn()
    writeln = vi.fn()
    dispose = vi.fn()
    focus = vi.fn()
    onInput = (_data: string) => {}
    onSize = (_size: { cols: number; rows: number }) => {}
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onData(fn: typeof this.onInput) {
      this.onInput = fn
    }
    onResize(fn: typeof this.onSize) {
      this.onSize = fn
    }
  }
  const context = vm.createContext({
    ...vue,
    createTerminalOutputRouter,
    terminalConnectionId,
    sshConnectionList: async () => [],
    tBackendError: (error: unknown) => String(error),
    useUiStore: () => ({ pushToast: vi.fn() }),
    defineProps: () => ({ project: "repo", visible: false, embedded: true }),
    defineEmits: () => vi.fn(),
    defineExpose: () => {},
    useI18n: () => ({ t: (key: string) => key }),
    terminalTheme: vue.ref({ colors: {} }),
    invoke,
    listen: async (name: string, fn: (event: { payload: any }) => void) => {
      handlers.set(name, fn)
      return unsubscribe
    },
    Terminal,
    FitAddon: class {
      fit() {}
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    onBeforeUnmount: (fn: () => void) => {
      unmount = fn
    },
    window: { removeEventListener() {}, addEventListener() {} },
    atob,
    console: { error: vi.fn() },
  })
  const scope = vue.effectScope()
  scopes.push(scope)
  scope.run(() =>
    vm.runInContext(
      ts.transpile(script + "\nglobalThis.api = { openTerminal, closeTab, setTabEl, tabs, instances, outputRouter };", {
        target: ts.ScriptTarget.ES2022,
      }),
      context,
    ),
  )
  const api = context.api as {
    openTerminal(): Promise<void>
    closeTab(id: number): Promise<void>
    setTabEl(id: number, element: unknown): void
    tabs: vue.Ref<{ id: number }[]>
    instances: Map<number, { term: Terminal }>
    outputRouter: ReturnType<typeof createTerminalOutputRouter>
  }
  return {
    api,
    invoke,
    unsubscribe,
    unmount: () => unmount(),
    output: (payload: TerminalOutput) => handlers.get("term://output")?.({ payload }),
  }
}

function gate<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test("terminal commands use the remote-capable transport including startup output before the id returns", async () => {
  expect(source).toContain('import { invoke, listen } from "@/api/transport"')
  expect(source).not.toContain("@tauri-apps/api/core")
  const creation = gate<number>()
  const h = harness(() => creation.promise)
  h.api.setTabEl(12, { offsetParent: {} })
  const opening = h.api.openTerminal()
  await tick()
  const args = h.invoke.mock.calls[0][1]
  expect(args).toMatchObject({ cwd: "repo", cols: 80, rows: 24, owner: expect.any(String) })
  h.output({ id: 12, owner: args.owner, data: btoa("welcome") })
  expect(h.api.outputRouter.bufferedChunkCount).toBe(1)
  creation.resolve(12)
  await opening
  const terminal = h.api.instances.get(12)!.term
  expect([...terminal.write.mock.calls[0][0]]).toEqual([...new TextEncoder().encode("welcome")])
  expect(h.api.outputRouter.bufferedChunkCount).toBe(0)
  terminal.onInput("ls\r")
  terminal.onSize({ cols: 100, rows: 30 })
  await h.api.closeTab(12)
  expect(h.invoke.mock.calls.map(([command]) => command)).toEqual([
    "term_create",
    "term_write",
    "term_resize",
    "term_kill",
  ])
  h.output({ id: 12, owner: args.owner, data: btoa("late") })
  expect(h.api.outputRouter.bufferedChunkCount).toBe(0)
  h.unmount()
})

test("foreign broadcasts never allocate buffers even while this panel is creating a terminal", () => {
  const write = vi.fn(() => false)
  const router = createTerminalOutputRouter(write)
  const owner = router.begin()
  for (let i = 0; i < 10_000; i++) {
    router.accept({ id: 2, owner: "another-panel", data: "x".repeat(8192) })
    router.accept({ id: 3, data: "legacy-client" })
  }
  expect(router.bufferedChunkCount).toBe(0)
  expect(write).not.toHaveBeenCalled()
  router.accept({ id: 1, owner, data: "own-startup" })
  expect(router.bufferedChunkCount).toBe(1)
  expect(router.bind(owner, 1)).toBe(true)
})

test("concurrent creations are isolated and preserve startup chunk order", () => {
  const written: [number, string][] = []
  const mounted = new Set<number>()
  const router = createTerminalOutputRouter((id, data) => {
    if (!mounted.has(id)) return false
    written.push([id, data])
    return true
  })
  const first = router.begin(),
    second = router.begin()
  router.accept({ id: 1, owner: first, data: "a" })
  router.accept({ id: 2, owner: second, data: "other" })
  router.accept({ id: 1, owner: first, data: "b" })
  expect(router.bind(first, 1)).toBe(true)
  mounted.add(1)
  router.flush(1)
  expect(written).toEqual([
    [1, "a"],
    [1, "b"],
  ])
  expect(router.bufferedChunkCount).toBe(1)
  router.release(1)
  router.accept({ id: 1, owner: first, data: "closed" })
  expect(router.cancel(second)).toBe(2)
  expect(router.bufferedChunkCount).toBe(0)
  expect(router.bind(second, 2)).toBe(false)
})

test("unmounting during creation discards early output and kills the late terminal without adding tabs", async () => {
  const creation = gate<number>()
  const h = harness(() => creation.promise)
  const opening = h.api.openTerminal()
  await tick()
  const owner = h.invoke.mock.calls[0][1].owner
  h.output({ id: 12, owner, data: btoa("early") })
  h.unmount()
  expect(h.api.outputRouter.bufferedChunkCount).toBe(0)
  creation.resolve(12)
  await opening
  expect(h.api.tabs.value).toEqual([])
  expect(h.invoke).toHaveBeenCalledWith("term_kill", { id: 12 })
  expect(h.unsubscribe).toHaveBeenCalledTimes(2)
  h.output({ id: 12, owner, data: btoa("late") })
  expect(h.api.outputRouter.bufferedChunkCount).toBe(0)
})

test("a failed creation clears its early output and closes an already identified shell", async () => {
  const creation = gate<number>()
  const h = harness(() => creation.promise)
  const opening = h.api.openTerminal()
  await tick()
  const owner = h.invoke.mock.calls[0][1].owner
  h.output({ id: 12, owner, data: btoa("early") })
  creation.reject(Error("creation response lost"))
  await opening
  expect(h.api.outputRouter.bufferedChunkCount).toBe(0)
  expect(h.invoke).toHaveBeenCalledWith("term_kill", { id: 12 })
  expect(h.api.tabs.value).toEqual([])
  h.unmount()
})
