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
  /** 每次 `app_config_get` 的记录（用于断言「一次权威读取」）。 */
  reads: [] as number[],
  /** 监听 `pi://reconnected` 的处理器（重连时主动读取）。 */
  reconnected: undefined as undefined | (() => void),

  /** 让 `app_preference_set` 的完成受测试控制（模拟在途写入）。 */
  writeGate: null as null | (() => Promise<number>),
  /** 完全接管一笔写入的主机行为（落盘、广播、收起响应各由测试决定）。 */
  writeHook: null as null | ((key: string, value: string) => Promise<number | undefined>),
  writes: [] as { key: string; value: string }[],
}))

vi.mock("@/api/transport", () => ({
  isDesktop: true,
  RECONNECTED_EVENT: "pi://reconnected",
  invoke: async (command: string, args: { key: string; value: string }) => {
    if (command === "app_config_get") {
      host.reads.push(Date.now())
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
      if (host.writeHook) return host.writeHook(args.key, args.value)
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
    if (name === "pi://reconnected") host.reconnected = () => handler({ payload: {} })
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
  host.reads = []
  host.reconnected = undefined
  host.writeGate = null
  host.writeHook = null
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
  host.reads = []
  host.reconnected = undefined
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
  host.writeHook = null
  await editor.setOpenWith("cursor")
  expect(editor.openWithPreference.value.kind).toBe("cursor")
})

test("a single-key write result never discards a older full event for another key", async () => {
  const module = await harness({ theme: "system", markdownCodeWrap: "1" }, 5)
  const theme = module.createConfigPreference({ key: "theme", defaultValue: "system" })
  const wrap = module.createConfigPreference({
    key: "markdownCodeWrap",
    defaultValue: "1",
    read: raw => raw !== "0",
    serialize: value => (value ? "1" : "0"),
  })

  // 另一端在 r6 把主题改成 dark，其全量事件还没到；本端随后写了换行键，命令返回 r7。
  host.preferences = { theme: "dark", markdownCodeWrap: "1" }
  host.revision = 6
  await wrap.set(false)
  host.preferences = { theme: "dark", markdownCodeWrap: "0" }
  host.revision = 7
  expect(wrap.value.value).toBe(false)

  // r6 的全量事件迟到：单键回执只推进了换行键，不能让它整份失效。
  broadcast(6, { theme: "dark", markdownCodeWrap: "1" })
  expect(theme.value.value).toBe("dark")
  // 该键自己仍保留本地更新值（r6 里换行还是旧的 1）。
  expect(wrap.value.value).toBe(false)

  // r7 的完整快照到齐后两边一致。
  broadcast(7, { theme: "dark", markdownCodeWrap: "0" })
  expect(theme.value.value).toBe("dark")
  expect(wrap.value.value).toBe(false)
})

test("a reconnect GET still recovers other keys after a higher single-key write result", async () => {
  const module = await harness({ theme: "system", markdownCodeWrap: "1" }, 5)
  const theme = module.createConfigPreference({ key: "theme", defaultValue: "system" })
  const wrap = module.createConfigPreference({
    key: "markdownCodeWrap",
    defaultValue: "1",
    read: raw => raw !== "0",
    serialize: value => (value ? "1" : "0"),
  })

  // 断线期间另一端在 r6 改了主题；重连读取发出但响应未回，本端写入换行键拿到 r7。
  const network = deferred<Snapshot>()
  host.getOverride = () => network.promise
  const refreshing = module.refreshFromHost()
  host.preferences = { theme: "dark", markdownCodeWrap: "1" }
  host.revision = 6
  await wrap.set(false)
  host.preferences = { theme: "dark", markdownCodeWrap: "0" }
  host.revision = 7

  network.resolve({ preferencesRevision: 6, preferences: { theme: "dark", markdownCodeWrap: "1" } })
  expect(await refreshing).toBe(true)
  // 读取里我们还没见过的主题（r6）必须被采用；换行键保留本地更新值。
  expect(theme.value.value).toBe("dark")
  expect(wrap.value.value).toBe(false)
})

test("a full snapshot older than one key still merges the keys we have not seen newer", async () => {
  const module = await harness({ theme: "system", markdownCodeWrap: "1" }, 5)
  const theme = module.createConfigPreference({ key: "theme", defaultValue: "system" })
  const wrap = module.createConfigPreference({
    key: "markdownCodeWrap",
    defaultValue: "1",
    read: raw => raw !== "0",
    serialize: value => (value ? "1" : "0"),
  })

  // 本端先应用 r7 的换行改动，再收到一份 r6 的全量快照（主题已变）。
  host.preferences = { theme: "dark", markdownCodeWrap: "1" }
  host.revision = 6
  await wrap.set(false)
  host.revision = 7
  broadcast(6, { theme: "dark", markdownCodeWrap: "1" })
  expect(theme.value.value).toBe("dark")
  expect(wrap.value.value).toBe(false)

  // 同一份 r6 里没有我们更了解的值时才保留本地（更旧快照不覆盖逐键更新）。
  broadcast(6, { theme: "light", markdownCodeWrap: "0" })
  expect(theme.value.value).toBe("light")
  expect(wrap.value.value).toBe(false)
})

test("a legacy host read supersedes all successful writes in a single pass", async () => {
  // 旧后端：写入不返回修订号，回执事件全丢；一次主动读取即以整表为准。
  const module = await harness({ theme: "system" }, 0, { legacyHost: true })
  const theme = module.createConfigPreference({ key: "theme", defaultValue: "system" })

  await theme.set("dark")
  await theme.set("system")
  await theme.set("light")
  // 主机端已被另一端改成 dark，而本端三笔回执都没到。
  host.preferences = { theme: "dark" }
  await module.refreshFromHost()
  expect(theme.value.value).toBe("dark")
  await module.refreshFromHost()
  expect(theme.value.value).toBe("dark")
})

test("an early 0 response cannot dequeue the last 0 while 1 is still pending", async () => {
  const module = await harness({ theme: "system", markdownCodeWrap: "1" }, 5)
  const wrap = module.createConfigPreference({
    key: "markdownCodeWrap",
    defaultValue: "1",
    read: raw => raw !== "0",
    serialize: value => (value ? "1" : "0"),
  })

  // 从「开启」快速点三次：关 → 开 → 关，三笔命令都排在主机侧。
  const gates = [deferred<number>(), deferred<number>(), deferred<number>()]
  host.writeGate = () => {
    const index = host.writes.length - 1
    return gates[index]!.promise
  }
  const first = wrap.set(false)
  const middle = wrap.set(true)
  const last = wrap.set(false)
  expect(wrap.value.value).toBe(false)

  // 第一笔（0）先返回：它只能按身份删除自己，后面仍在排队的 0 必须保留。
  gates[0]!.resolve(6)
  await first
  expect(wrap.value.value).toBe(false)

  // 第二笔（1）返回：第三笔（0）仍在途，显示继续跟随最新意图。
  gates[1]!.resolve(7)
  await middle
  expect(wrap.value.value).toBe(false)

  gates[2]!.resolve(8)
  await last
  expect(wrap.value.value).toBe(false)
})

test("in-flight optimism hides a value but keeps merging newer host snapshots", async () => {
  const module = await harness({ theme: "system", markdownCodeWrap: "1" }, 5)
  const theme = module.createConfigPreference({ key: "theme", defaultValue: "system" })

  // 本端写入 dark（主机已在 r6 落盘），命令响应还没回来。
  const gate = deferred<number>()
  host.writeGate = () => gate.promise
  const writing = theme.set("dark")
  await vi.waitFor(() => expect(host.writes).toEqual([{ key: "theme", value: "dark" }]))

  // 另一客户端在 r7 写成 light，整表推送先到：显示仍被在途写入遮住，但主机状态要记录 r7。
  host.preferences = { theme: "light", markdownCodeWrap: "1" }
  host.revision = 7
  broadcast(7)
  expect(theme.value.value).toBe("dark")

  // 命令返回 r6：不能把已知状态倒回 r6，显示让位给已收到的 r7/light。
  gate.resolve(6)
  await writing
  expect(theme.value.value).toBe("light")
})

test("a newer snapshot that drops a key prevents an older push from reviving it", async () => {
  const module = await harness({ theme: "system", markdownCodeWrap: "1" }, 5)
  const theme = module.createConfigPreference({ key: "theme", defaultValue: "system" })

  // 主机在 r8 的完整快照里已经没有 theme（默认值生效）。
  host.preferences = { markdownCodeWrap: "1" }
  host.revision = 8
  await module.refreshFromHost()
  expect(theme.value.value).toBe("system")

  // 迟到的 r7 推送里还有 theme=dark：更旧的证据不能让它复活。
  broadcast(7, { theme: "dark", markdownCodeWrap: "1" })
  expect(theme.value.value).toBe("system")
})

test("legacy host early echoes do not mask the next genuine external change", async () => {
  // 旧后端：每笔写入的回执快照都早于命令结果返回。
  const module = await harness({ theme: "system" }, 0, { legacyHost: true })
  const theme = module.createConfigPreference({ key: "theme", defaultValue: "system" })

  host.writeGate = async () => {
    const latest = host.writes[host.writes.length - 1]!
    host.preferences = { theme: latest.value }
    broadcast(undefined, { theme: latest.value })
    return undefined as unknown as number
  }
  await theme.set("dark")
  await theme.set("light")
  expect(theme.value.value).toBe("light")

  // 之后真正的外部变更（不是我们写入的回执）必须显示出来，而不是被 FIFO 队列吞掉。
  broadcast(undefined, { theme: "system" })
  expect(theme.value.value).toBe("system")
})

test("legacy same-key queued writes match early echoes to the dispatched request", async () => {
  // 旧后端：每笔写入先广播完整快照、再返回（无修订号），命令按序执行。
  const module = await harness({ theme: "system" }, 0, { legacyHost: true })
  const theme = module.createConfigPreference({ key: "theme", defaultValue: "system" })

  const gates = [deferred<number>(), deferred<number>()]
  host.writeGate = () => {
    const index = host.writes.length - 1
    // 真实旧端顺序：落盘 → 广播完整快照 → 返回（这里返回无修订号）。
    const value = host.writes[index]!.value
    host.preferences = { theme: value }
    broadcast(undefined, { theme: value })
    return gates[index]!.promise
  }

  const first = theme.set("dark")
  const second = theme.set("light")
  // 两笔都在排队/执行中：显示跟随最新意图 light。
  expect(theme.value.value).toBe("light")

  // 第一笔（dark）返回：它的回执已被队首匹配到，不能进 unseen 覆盖后面的 light。
  gates[0]!.resolve(undefined as unknown as number)
  await first
  expect(theme.value.value).toBe("light")

  gates[1]!.resolve(undefined as unknown as number)
  await second
  expect(theme.value.value).toBe("light")
  expect(host.preferences.theme).toBe("light")
})

test("an older unseen record never outranks a later confirmed write", async () => {
  const module = await harness({ theme: "system" }, 0, { legacyHost: true })
  const theme = module.createConfigPreference({ key: "theme", defaultValue: "system" })

  // 第一笔成功但回执没到（进 unseen 队列），第二笔成功且回执已到。
  host.writeGate = null
  host.writeHook = null
  await theme.set("dark")
  expect(theme.value.value).toBe("dark")
  // 第二笔：主机广播了它自己的快照（值 light）后再返回。
  host.preferences = { theme: "dark" }
  broadcast(undefined, { theme: "dark" })
  await theme.set("light")
  expect(theme.value.value).toBe("light")
  // 之后真正的外部变更仍可显示，旧记录不会压住它。
  broadcast(undefined, { theme: "system" })
  expect(theme.value.value).toBe("system")
})

const wrapFlag = {
  read: (raw: string) => raw !== "0",
  serialize: (value: unknown) => (value ? "1" : "0"),
}

test.each([
  // `values` 是传给 set() 的**领域值**；wrapFlag 的序列化会把它变成 "1"/"0"。
  { key: "markdownCodeWrap", values: [false, true, false], initial: "1", codec: wrapFlag, shown: false },
  { key: "theme", values: ["dark", "light", "system"], initial: "system", codec: {}, shown: "system" },
])(
  "legacy ordered echoes staggered across commands must not reverse $key",
  async ({ key, values, initial, codec, shown: finalValue }) => {
    // 旧后端：写入按序落地、每笔先广播整表快照再返回（无修订号）。回执与命令返回
    // 各自独立投递 —— 回执可能晚于「下一笔已发出的命令」到达。
    const module = await harness({ [key]: initial }, 0, { legacyHost: true })
    const preference = module.createConfigPreference<unknown>({
      key,
      defaultValue: initial,
      ...codec,
    } as never)

    const gates = [deferred<void>(), deferred<void>(), deferred<void>()]
    const sent: Record<string, string>[] = []
    host.writeHook = async (writtenKey, value) => {
      // 旧后端按序落地：每笔写入都把当前整表快照广播出去，再等测试放行响应。
      host.preferences = { ...host.preferences, [writtenKey]: value }
      sent.push({ ...host.preferences })
      const index = sent.length - 1
      await gates[index]!.promise
      return undefined
    }

    const first = preference.set(values[0] as never)
    const second = preference.set(values[1] as never)
    const third = preference.set(values[2] as never)
    const shown = [preference.value.value]

    // 第一笔返回；它的回执在第二笔已发出之后才到。
    gates[0]!.resolve()
    await first
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    // 回执按序到达 1、2、3 —— 每一次都必须被认领为「我们自己的写入」。
    broadcast(undefined, sent[0]!)
    shown.push(preference.value.value)

    gates[1]!.resolve()
    await second
    await vi.waitFor(() => expect(sent).toHaveLength(3))
    gates[2]!.resolve()
    await third
    // 末笔的原始值由 codec 决定（wrap 是 "0"，theme 是 "system"）。
    await vi.waitFor(() => expect(host.preferences[key]).toBe(sent[2]![key]))

    broadcast(undefined, sent[1]!)
    shown.push(preference.value.value)
    broadcast(undefined, sent[2]!)
    shown.push(preference.value.value)

    // 三笔回执都到齐之后，界面必须停在“主机已保存的最后一次选择”。
    await vi.waitFor(() => expect(preference.value.value).toBe(finalValue))
    expect(shown).toEqual(Array(4).fill(finalValue))
  },
)

test("a legacy echo of a finished write is claimed before the current request", async () => {
  // 已完成但待回执（unseen）的记录必须先被认领：否则匹配到正在执行的请求时
  // 会把这条合法回执当成外部变更，并清空整队。
  const module = await harness({ theme: "system" }, 0, { legacyHost: true })
  const theme = module.createConfigPreference({ key: "theme", defaultValue: "system" })

  // 第一笔成功但回执未到（进入 unseen）。
  host.writeGate = async () => undefined as unknown as number
  await theme.set("dark")
  expect(theme.value.value).toBe("dark")

  // 第二笔已发出（用 gate 拖住响应），期间到达第一笔的回执 dark。
  const gate = deferred<number>()
  host.writeGate = () => gate.promise
  const second = theme.set("light")
  await vi.waitFor(() => expect(host.writes.map(write => write.value)).toEqual(["dark", "light"]))
  broadcast(undefined, { theme: "dark" })
  // 仍在显示最新意图 light，且未把 dark 当外部状态清队。
  expect(theme.value.value).toBe("light")
  gate.resolve(undefined as unknown as number)
  await second
  broadcast(undefined, { theme: "light" })
  expect(theme.value.value).toBe("light")
})

test("legacy repeated full-snapshot broadcasts from another key never revert a saved value", async () => {
  // 旧后端：每笔写入（任意 key）都广播整表。另一客户端在本端第二笔主题写入前改了 locale，
  // 于是本端会收到一份携带自己旧主题值的重复快照 —— 它不能被当成外部主题回写。
  const module = await harness({ theme: "system", locale: "en" }, 0, { legacyHost: true })
  const theme = module.createConfigPreference({ key: "theme", defaultValue: "system" })
  const locale = module.createConfigPreference({ key: "locale", defaultValue: "en" })

  const gates = [deferred<void>(), deferred<void>(), deferred<void>()]
  const sent: Record<string, string>[] = []
  host.writeHook = async (key, value) => {
    host.preferences = { ...host.preferences, [key]: value }
    if (key === "theme" && value === "dark") host.preferences = { ...host.preferences, locale: "zh-CN" }
    sent.push({ ...host.preferences })
    await gates[sent.length - 1]!.promise
    return undefined
  }

  const first = theme.set("dark")
  const second = theme.set("light")
  const third = theme.set("system")
  const shown = [theme.value.value]
  for (const [index, write] of [first, second, third].entries()) {
    await vi.waitFor(() => expect(sent).toHaveLength(index + 1))
    gates[index]!.resolve()
    await write
    shown.push(theme.value.value)
  }
  // 四份整表推送按主机顺序到达：dark / dark（含 locale 变更）/ light / system。
  for (const snapshot of sent) {
    broadcast(undefined, snapshot)
    shown.push(theme.value.value)
  }
  // 每一刻主题都停在已保存的末值，locale 正常更新。
  expect(shown).toEqual(Array(shown.length).fill("system"))
  expect(locale.value.value).toBe("zh-CN")
})

test("an unclaimable legacy snapshot keeps the local intent and resolves via one read", async () => {
  const module = await harness({ theme: "system", locale: "en" }, 0, { legacyHost: true })
  const theme = module.createConfigPreference({ key: "theme", defaultValue: "system" })

  // 三笔主题写入都成功、回执都还没到（unseen = dark/light/system，主机已保存 system）。
  await theme.set("dark")
  await theme.set("light")
  await theme.set("system")
  expect(theme.value.value).toBe("system")
  const readsBefore = host.reads.length

  // 第一份回执（dark）被认领。
  broadcast(undefined, { theme: "dark" })
  expect(theme.value.value).toBe("system")
  // 又一份重复整表快照（另一键写入时广播的旧值 dark）：无法认领 —— 保留最新本地意图，
  // 不倒退显示，并由一次权威读取消解歧义。
  broadcast(undefined, { theme: "dark" })
  expect(theme.value.value).toBe("system")
  await vi.waitFor(() => expect(host.reads.length).toBeGreaterThan(readsBefore))
  // 权威读取以主机真值为准：主机已保存 system，因此显示仍是 system。
  await vi.waitFor(() => expect(host.reads.length).toBeGreaterThan(readsBefore))
  expect(theme.value.value).toBe("system")
})

test("a delayed authoritative read never overwrites a change adopted after it started", async () => {
  // 旧后端没有修订号：读取的响应可能比「发起之后才采纳的外部回写」更旧。
  const module = await harness({ theme: "system", locale: "en" }, 0, { legacyHost: true })
  const theme = module.createConfigPreference({ key: "theme", defaultValue: "system" })
  const locale = module.createConfigPreference({ key: "locale", defaultValue: "en" })

  // 读取发出时主机是 system；响应还没回来，期间外部把主题写成 dark 并被采纳。
  const network = deferred<Snapshot>()
  host.getOverride = () => network.promise
  const refreshing = module.refreshFromHost()
  broadcast(undefined, { theme: "dark", locale: "zh-CN" })
  expect(theme.value.value).toBe("dark")
  expect(locale.value.value).toBe("zh-CN")

  network.resolve({ preferences: { theme: "system", locale: "en" } })
  expect(await refreshing).toBe(true)
  // 旧响应不能把这些 key 盖回 system/en；其余 key 照常以主机为准。
  expect(theme.value.value).toBe("dark")
  expect(locale.value.value).toBe("zh-CN")
})

test("a single remaining pending echo still blocks a duplicate full snapshot from reverting", async () => {
  // 旧后端：只剩一笔待回执时，「别的键写入」广播的重复旧值同样不能清队、不能让显示倒退。
  const module = await harness({ theme: "system", locale: "en" }, 0, { legacyHost: true })
  const theme = module.createConfigPreference({ key: "theme", defaultValue: "system" })
  const locale = module.createConfigPreference({ key: "locale", defaultValue: "en" })

  await theme.set("dark")
  await theme.set("light")
  // 先认领第一笔（dark），只剩 light 待回执。
  broadcast(undefined, { theme: "dark", locale: "en" })
  expect(theme.value.value).toBe("light")
  // 携带旧主题 dark 的「locale 广播」：只剩一笔也要保护，不能倒退到 dark。
  broadcast(undefined, { theme: "dark", locale: "zh-CN" })
  expect(theme.value.value).toBe("light")
  expect(locale.value.value).toBe("zh-CN")
  // 最后确认 light：显示与主机一致。
  broadcast(undefined, { theme: "light", locale: "zh-CN" })
  expect(theme.value.value).toBe("light")
})

test("a superseded automatic resolution schedules exactly one serial retry", async () => {
  // 旧后端歧义契约：保持最新本地意图，并由自动读取在「读后收敛」；若本轮响应已失效，
  // 必须在它结束后合并安排一次串行补读（不能被去重锁吞掉）。
  const module = await harness({ theme: "system", locale: "en" }, 0, { legacyHost: true })
  const theme = module.createConfigPreference({ key: "theme", defaultValue: "system" })

  await theme.set("dark")
  await theme.set("light")
  // 先认领第一笔回执（dark），随后「另一键广播」里重复的旧值才构成歧义。
  broadcast(undefined, { theme: "dark", locale: "en" })

  const network = deferred<Snapshot>()
  let overrideCalls = 0
  host.getOverride = () => {
    overrideCalls += 1
    // 第一轮歧义裁决挂起；补读直接返回主机真值。
    if (overrideCalls === 1) return network.promise
    return Promise.resolve({ preferences: { ...host.preferences } })
  }
  const readsBefore = host.reads.length
  broadcast(undefined, { theme: "dark", locale: "zh-CN" })
  await vi.waitFor(() => expect(host.reads.length).toBeGreaterThan(readsBefore))

  // 这轮裁决读取挂起期间，主机被改成 system 并推送（我们从未写过 system → 真实外部变更）：
  // 读取发起后的这次采纳会让旧响应失效。
  host.preferences = { theme: "system", locale: "zh-CN" }
  broadcast(undefined, { theme: "system", locale: "zh-CN" })
  expect(theme.value.value).toBe("system")
  network.resolve({ preferences: { theme: "light", locale: "zh-CN" } })
  // 旧响应被跳过 → 串行补读一次，最终收敛到主机真值。
  await vi.waitFor(() => expect(host.reads.length).toBeGreaterThan(readsBefore + 1))
  expect(theme.value.value).toBe("system")
})

test("a same-value local write after a read starts is still protected", async () => {
  // GET 发起后成功提交的同值写入（raw 未变，但新增了待确认记录）同样不能被旧响应覆盖。
  const module = await harness({ theme: "dark" }, 0, { legacyHost: true })
  const theme = module.createConfigPreference({ key: "theme", defaultValue: "system" })

  const network = deferred<Snapshot>()
  host.getOverride = () => network.promise
  const refreshing = module.refreshFromHost()
  // 读取发起后：主机被外部改成 light（还没推送），本端成功写回 dark（与已知值同值）。
  host.preferences = { theme: "dark" }
  const write = deferred<number>()
  host.writeGate = () => write.promise
  const saving = theme.set("dark")
  expect(theme.value.value).toBe("dark")
  write.resolve(undefined as unknown as number)
  await saving

  network.resolve({ preferences: { theme: "light" } })
  expect(await refreshing).toBe(true)
  // 旧响应不得覆盖：显示仍是 dark，主机也是 dark。
  expect(theme.value.value).toBe("dark")
  expect(host.preferences.theme).toBe("dark")
})

test("a delayed legacy read missing a key cannot remove a newer value adopted meanwhile", async () => {
  // 旧后端：读取抓取时主机还没有这个 key，响应返回前另一客户端首次写入并被 WS 采纳。
  const module = await harness({ locale: "en" }, 0, { legacyHost: true })
  const theme = module.createConfigPreference({ key: "theme", defaultValue: "system", onChange: () => undefined })

  const network = deferred<Snapshot>()
  host.getOverride = () => network.promise
  const refreshing = module.refreshFromHost()
  // 期间外部首次写入 theme=dark 并被采纳。
  host.preferences = { locale: "en", theme: "dark" }
  broadcast(undefined, host.preferences)
  expect(theme.value.value).toBe("dark")

  network.resolve({ preferences: { locale: "en" } })
  expect(await refreshing).toBe(true)
  // 过期快照的「缺键」同样不能 forget 掉这个值（也不会退回默认 system）。
  expect(theme.value.value).toBe("dark")
  // 按既有机制补读收敛到主机真值。
  await vi.waitFor(() => expect(host.reads.length).toBeGreaterThan(1))
  expect(theme.value.value).toBe("dark")
})

test("the ambiguous legacy revert converges automatically without manual refresh", async () => {
  // 新契约：推送当下保持最新本地意图（light），随后自动权威读取收敛到主机真值（dark）。
  const module = await harness({ theme: "system", processDetail: "detailed" }, 0, { legacyHost: true })
  const theme = module.createConfigPreference({ key: "theme", defaultValue: "system" })
  const detail = module.createConfigPreference({ key: "processDetail", defaultValue: "detailed" })

  await theme.set("dark")
  await theme.set("light")
  expect(host.preferences.theme).toBe("light")
  broadcast(undefined, { theme: "dark", processDetail: "detailed" })
  host.preferences = { theme: "dark", processDetail: "concise" }
  broadcast(undefined, host.preferences)
  // 推送当下：主题仍保持最新本地意图，其它键正常合入。
  expect(theme.value.value).toBe("light")
  expect(detail.value.value).toBe("concise")
  // 无需手工刷新：自动读取后收敛。
  await vi.waitFor(() => expect(theme.value.value).toBe("dark"))
  expect(host.reads.length).toBeGreaterThanOrEqual(2)
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
