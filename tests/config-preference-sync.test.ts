import { afterEach, expect, test, vi } from "vitest"

// 共享偏好同步的竞态与权威性契约（TZD-133 复审 P2）。
//
// 主机侧模型：`app_preference_set` 返回偏好修订号，`pi://app-config-changed` 与
// `app_config_get` 都带 `preferencesRevision`。测试覆盖：
// - 连点 0/1/0 后按序到达的三笔回执不反转最后一次选择（不能靠「值相同」判定身份）；
// - 丢失最新回执后，真实的外部变更与主动读取仍然生效；
// - 旧回执不会长期屏蔽权威读取；
// - 某笔写入失败只清理它自己，不牵连同键后续写入；
// - 严格写入「先广播、后返回」时不留幽灵记录（之后的权威读取能删掉该键）；
// - 旧后端没有修订号时退化为有界 FIFO 降级。

const host = vi.hoisted(() => ({
  preferences: {} as Record<string, string>,
  revision: 0,
  changed: undefined as undefined | ((event: { payload: Record<string, unknown> }) => void),
  failWrite: false,
  /** 主机写完先广播、命令结果后返回。 */
  echoBeforeReturn: false,
  /** 主机没有修订号（旧后端）。 */
  legacyHost: false,
  /** 让某一笔写入在主机侧失败（按 value 触发，便于只挂最老一笔）。 */
  failValue: null as string | null,
  /** 覆盖 `app_config_get`（模拟「重连读取的响应还在路上」）。 */
  getOverride: null as null | (() => Promise<{ preferences: Record<string, string>; preferencesRevision?: number }>),
  /** 让 `app_preference_set` 的完成受测试控制（模拟在途写入）。 */
  writeGate: null as null | (() => Promise<number>),
  writes: [] as { key: string; value: string }[],
}))

vi.mock("@/api/transport", () => ({
  isDesktop: true,
  RECONNECTED_EVENT: "pi://reconnected",
  invoke: async (command: string, args: { key: string; value: string }) => {
    if (command === "app_config_get") {
      if (host.getOverride) return host.getOverride()
      return host.legacyHost
        ? { preferences: { ...host.preferences } }
        : { preferences: { ...host.preferences }, preferencesRevision: host.revision }
    }
    if (command === "app_preference_set") {
      host.writes.push({ key: args.key, value: args.value })
      if (host.failWrite) {
        host.writes.pop()
        throw new Error("denied")
      }
      if (host.failValue === args.value) {
        host.writes.pop()
        throw new Error("mock transient write error")
      }
      if (host.writeGate) return host.writeGate()
      host.preferences[args.key] = args.value
      if (!host.legacyHost) {
        host.revision += 1
        if (host.echoBeforeReturn) broadcast(host.revision)
      }
      return host.legacyHost ? undefined : host.revision
    }
    return undefined
  },
  listen: async (name: string, handler: (event: { payload: Record<string, unknown> }) => void) => {
    if (name === "pi://app-config-changed") host.changed = handler
    return () => {}
  },
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 推送一份主机快照（可指定修订号，模拟迟到事件）。 */
function broadcast(revision = host.revision, preferences: Record<string, string> = host.preferences) {
  host.changed?.({
    payload: host.legacyHost
      ? { preferences: { ...preferences } }
      : { preferences: { ...preferences }, preferencesRevision: revision },
  })
}

type Snapshot = { preferences: Record<string, string>; preferencesRevision?: number }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function harness(preferences: Record<string, string> = {}, revision = 0, options: { legacyHost?: boolean } = {}) {
  vi.resetModules()
  host.preferences = { ...preferences }
  host.revision = revision
  host.changed = undefined
  host.failWrite = false
  host.echoBeforeReturn = false
  host.legacyHost = options.legacyHost ?? false
  host.failValue = null
  host.getOverride = null
  host.writeGate = null
  host.writes = []
  vi.stubGlobal("localStorage", { getItem: () => null, removeItem() {} })
  // 预加载客户端配置模块：监听器用动态 import，isolate:false 下每轮 resetModules 后
  // 首次解析会慢一拍，测试不应因此偶发失败。
  await import("@/api/client/config")
  const module = await import("@/lib/configPreference")
  await module.initializeConfigPreferences()
  await vi.waitFor(() => expect(host.changed).toBeDefined())
  return module
}

test("ordered 0/1/0 echoes never revert the third local toggle", async () => {
  const module = await harness({ theme: "system", markdownCodeWrap: "1" }, 4)
  const wrap = module.createConfigPreference({
    key: "markdownCodeWrap",
    defaultValue: "1",
    read: raw => raw !== "0",
    serialize: value => (value ? "1" : "0"),
  })
  expect(wrap.value.value).toBe(true)

  // 连点「关 → 开 → 关」：UI 立刻跟着最后一次，三笔写入依次落到主机。
  void wrap.set(false)
  void wrap.set(true)
  void wrap.set(false)
  expect(wrap.value.value).toBe(false)
  await vi.waitFor(() => expect(host.writes.map(write => write.value)).toEqual(["0", "1", "0"]))
  const latest = host.revision

  // 三笔回执按序到达。第一笔的 `0` 与最终值同值，但修订号更旧，仍不得生效。
  for (const revision of [latest - 2, latest - 1, latest]) {
    broadcast(revision, { theme: "system", markdownCodeWrap: revision === latest - 1 ? "1" : "0" })
    expect(wrap.value.value).toBe(false)
  }
})

test("a missed latest echo does not hide a genuine external change", async () => {
  const module = await harness({ theme: "system", processDetail: "detailed" }, 1)
  const theme = module.createConfigPreference({ key: "theme", defaultValue: "system" })
  const detail = module.createConfigPreference({ key: "processDetail", defaultValue: "detailed" })

  await theme.set("dark")
  const firstRevision = host.revision
  await theme.set("light")
  const secondRevision = host.revision
  expect(theme.value.value).toBe("light")

  // 第一笔（dark）的回执迟到到达：更旧的修订号，整份丢弃。
  broadcast(firstRevision, { theme: "dark", processDetail: "detailed" })
  expect(theme.value.value).toBe("light")

  // 本端事件流丢了最后一笔 light 的回执，之后另一端把主题改回 dark 并动了别的键。
  host.preferences = { theme: "dark", processDetail: "concise" }
  host.revision += 1
  broadcast(host.revision)
  expect(detail.value.value).toBe("concise")
  expect(theme.value.value).toBe("dark")
  expect(host.revision).toBeGreaterThan(secondRevision)
})

test("a stale echo never blocks a later authoritative read", async () => {
  const module = await harness({ theme: "system" }, 1)
  const theme = module.createConfigPreference({ key: "theme", defaultValue: "system" })

  // 两笔写入都没有回执（事件被丢），本地保持最后一次选择。
  void theme.set("dark")
  void theme.set("light")
  await vi.waitFor(() => expect(host.writes).toHaveLength(2))
  expect(theme.value.value).toBe("light")

  // 主机被另一端改成 dark；主动读取（启动 / 重连 / 显式刷新）**无条件权威**。
  host.preferences = { theme: "dark" }
  host.revision += 1
  await module.refreshFromHost()
  expect(theme.value.value).toBe("dark")

  // 权威读取之后，推送事件照常生效。
  host.preferences = { theme: "light" }
  host.revision += 1
  broadcast(host.revision, { theme: "light" })
  expect(theme.value.value).toBe("light")
})

test("a failed write only clears its own pending record", async () => {
  const module = await harness({ theme: "dark" }, 1)
  const theme = module.createConfigPreference({ key: "theme", defaultValue: "system" })

  // 最老的一笔（system）在主机侧失败，后两笔成功。
  host.failValue = "system"
  void theme.set("system")
  void theme.set("light")
  void theme.set("dark")
  await vi.waitFor(() => expect(theme.value.value).toBe("dark"))
  await vi.waitFor(() => expect(host.writes.map(write => write.value)).toEqual(["light", "dark"]))
  const latest = host.revision

  // 中间那笔的回执到达：它比最后一次写入旧，但比它自己的修订号新 —— 不能反转。
  broadcast(latest - 1, { theme: "light" })
  expect(theme.value.value).toBe("dark")
  broadcast(latest, { theme: "dark" })
  expect(theme.value.value).toBe("dark")
})

test("a non-strict failed write keeps the choice locally but yields to host snapshots", async () => {
  const module = await harness({ theme: "system" }, 1)
  const theme = module.createConfigPreference({ key: "theme", defaultValue: "system" })

  host.failWrite = true
  await theme.set("dark")
  // 宽松写入失败：界面沿用既有乐观语义（不回退），但不产生可无限屏蔽的记录。
  expect(theme.value.value).toBe("dark")

  host.failWrite = false
  host.preferences = { theme: "system" }
  host.revision += 1
  broadcast(host.revision, { theme: "system" })
  expect(theme.value.value).toBe("system")
})

test("a strict write confirmed before the command returns leaves no phantom record", async () => {
  const module = await harness({ openWith: "vscode" }, 1)
  const editor = module.createConfigPreference({
    key: "openWith",
    defaultValue: "vscode",
    throwOnWriteError: true,
  })

  // 主机先广播新值，再返回命令结果（严格写入曾因此留下幽灵待确认记录）。
  host.echoBeforeReturn = true
  await editor.set("cursor")
  expect(editor.value.value).toBe("cursor")
  expect(host.preferences.openWith).toBe("cursor")

  // 之后该键被从权威配置里移除：主动读取必须回到默认值，而不是被旧记录挡住。
  host.preferences = {}
  host.revision += 1
  await module.refreshFromHost()
  expect(editor.value.value).toBe("vscode")
})

test("a delayed reconnect GET never replaces an already applied higher revision", async () => {
  const module = await harness({ theme: "system" }, 5)
  const theme = module.createConfigPreference({ key: "theme", defaultValue: "system" })

  // 重连读取在主机侧取到 r6/dark，但响应还在路上；期间一条独立的 r7/light 推送先到。
  const network = deferred<Snapshot>()
  host.getOverride = () => network.promise
  const refreshing = module.refreshFromHost()
  // 响应还在路上时，一条独立的 r7/light 推送先到并被应用。
  broadcast(7, { theme: "light" })
  expect(theme.value.value).toBe("light")

  network.resolve({ preferencesRevision: 6, preferences: { theme: "dark" } })
  expect(await refreshing).toBe(true)
  // 抓取时刻更早的读取整份丢弃，不能把 UI 扳回 dark。
  expect(theme.value.value).toBe("light")

  // 更新修订的读取才允许纠正丢事件：r8 覆盖后变为 dark。
  host.getOverride = null
  host.preferences = { theme: "dark" }
  host.revision = 8
  await module.refreshFromHost()
  expect(theme.value.value).toBe("dark")
})

test("a reconnect GET does not delete a newer in-flight local write", async () => {
  const module = await harness({ markdownCodeWrap: "1" }, 5)
  const wrap = module.createConfigPreference({
    key: "markdownCodeWrap",
    defaultValue: "1",
    read: raw => raw !== "0",
    serialize: value => (value ? "1" : "0"),
  })

  // 重连读取先发出（主机侧取到 r5/开启），响应还没回来；用户此时点了关闭，写入也还在路上。
  const network = deferred<Snapshot>()
  host.getOverride = () => network.promise
  const refreshing = module.refreshFromHost()
  // 用户在读取响应回来之前点了关闭；这笔写入也还停在主机侧。
  const write = deferred<number>()
  host.writeGate = () => write.promise
  const pending = wrap.set(false)
  expect(wrap.value.value).toBe(false)

  network.resolve({ preferencesRevision: 5, preferences: { markdownCodeWrap: "1" } })
  expect(await refreshing).toBe(true)
  // 读取没有覆盖这笔在途写入。
  expect(wrap.value.value).toBe(false)

  // 主机最终接受了这笔写入（r6/关闭）：保持关闭，并把主机视图并入。
  host.preferences = { markdownCodeWrap: "0" }
  write.resolve(6)
  await pending
  expect(wrap.value.value).toBe(false)
})

test("a delayed r0 full-save echo cannot override an applied r1 state", async () => {
  const module = await harness({ theme: "system", preferencesRevision: 1 }, 1)
  const theme = module.createConfigPreference({ key: "theme", defaultValue: "system" })
  host.preferences = { theme: "dark" }
  host.revision = 2
  await module.refreshFromHost()
  expect(theme.value.value).toBe("dark")

  // 旧配置升级后的全量保存（r0）迟到：新后端在线上快照里**显式**带 0，客户端必须认出
  // 它是更旧的修订并丢弃，不能退回 system。（旧后端「没有该字段」则由 snapshotRevision 兜底）
  broadcast(0, { theme: "system" })
  expect(theme.value.value).toBe("dark")
  // 完全没有修订号的快照（旧格式）在本端已见过修订号后同样按 r0 处理。
  host.changed?.({ payload: { preferences: { theme: "system" } } })
  expect(theme.value.value).toBe("dark")
})

test("a strict write never exposes the value before the host accepts it", async () => {
  const module = await harness({ openWith: JSON.stringify({ kind: "vscode", executable: "" }) }, 5)
  const editor = await import("@/lib/openWith")

  const write = deferred<number>()
  host.writeGate = () => write.promise
  const saving = editor.setOpenWith("cursor")!
  // 主机还没确认：生效值（也就是「用哪个 IDE 打开文件」读到的值）仍是 vscode。
  expect(editor.openWithPreference.value.kind).toBe("vscode")

  write.reject(new Error("mock disk denied"))
  await expect(saving).rejects.toThrow("mock disk denied")
  expect(editor.openWithPreference.value.kind).toBe("vscode")
  expect(module.createConfigPreference({ key: "openWith", defaultValue: "vscode" }).value.value).toBe(
    JSON.stringify({ kind: "vscode", executable: "" }),
  )

  // 成功时才切换：主机接受后立刻生效（且不依赖回执事件是否送达）。
  host.writeGate = null
  await editor.setOpenWith("cursor")
  expect(editor.openWithPreference.value.kind).toBe("cursor")
})

test("a legacy host without revisions degrades to bounded FIFO", async () => {
  // 旧后端：写入不返回修订号、事件也不携带 —— 从初始化起就是这种形态。
  const module = await harness({ theme: "system" }, 0, { legacyHost: true })
  const theme = module.createConfigPreference({ key: "theme", defaultValue: "system" })

  await theme.set("dark")
  await theme.set("light")
  expect(theme.value.value).toBe("light")

  // 旧后端没有修订号：快照里出现的键按 FIFO 确认最老一笔，因此这次是「确认 dark」的回执，
  // 显示值继续用最新的本地写入。
  broadcast(undefined, { theme: "dark" })
  expect(theme.value.value).toBe("light")
  // 再一份快照确认第二笔：此时显示值跟随主机视图。
  broadcast(undefined, { theme: "light" })
  expect(theme.value.value).toBe("light")
  // 之后的真实外部变更正常生效。
  broadcast(undefined, { theme: "system" })
  expect(theme.value.value).toBe("system")
})
