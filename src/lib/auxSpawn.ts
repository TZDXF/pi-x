import { killPi, spawnAuxPi, sshConnectionList } from "@/api/piClient"
import {
  auxModelMissing,
  auxModelTarget,
  auxProjectMissing,
  auxWorkspaceContext,
  type AuxModelTarget,
} from "@/lib/auxLaunch"
import { terminalConnectionId } from "@/lib/sshTrust"
import type { SessionStore } from "@/stores/session"
import {
  auxSessionExisting,
  auxTabByRuntime,
  markAuxRetrying,
  registerAuxRuntimeBridge,
  settleLateAux,
  type AuxTab,
} from "@/stores/auxChat"
import type { useWorkspaceStore } from "@/stores/workspace"

/**
 * aux 进程的启动接线（`api/client/process.ts` 的 `spawnAuxPi` 之上的薄封装）。
 *
 * 分工：
 * - **参数**全部走独立字段（Tauri 命令参数），argv 由后端 `aux_launch` 的代码常量
 *   白名单组装；前端只能选 provider/model/thinking 与父会话的 project/workspace。
 * - **失败**原样抛给 `auxChat`（`openAux` 把 coded error 记在 Tab 上、面板显示原因），
 *   这里不吞错、不改写文案。
 * - **关闭**通过注入的 bridge 调 `rpc_kill`：进程生命周期归后端，前端只负责"什么时候
 *   该关"，与 `stores/session.ts` 的进程管理边界一致。
 */
registerAuxRuntimeBridge({ kill: (runtimeId: string) => killPi(runtimeId) })

/** 启动一个 aux 实例需要从父会话带过来的上下文。 */
export interface AuxParentContext {
  /** 父（主）会话 runtimeId。 */
  runtimeId: string
  /** 父会话 cwd（远程为 `ssh://` 展示 URI）。 */
  project: string
  /** 继承的模型选择；`null` 表示父会话还没有可用模型（面板据此报 `auxModelMissing`）。 */
  model: AuxModelTarget | null
  /** 多目录工作区上下文来源（远程 P1 恒不使用）。 */
  workspace?: Pick<ReturnType<typeof useWorkspaceStore>, "projectRoot" | "projectGroups">
}

/**
 * 启动 tab 对应的 aux 进程并完成首次状态握手。
 *
 * `session.init()` 只发 `get_state`/`get_commands`/`get_available_models`/
 * `get_session_stats`/`get_available_thinking_levels`（全部在 Aux 白名单内），
 * 且不读历史（aux 无 session 文件，`--no-session`）。
 */
export async function spawnAuxRuntime(parent: AuxParentContext, tab: AuxTab): Promise<void> {
  // 入口先收一次：实例可能已经被关闭（重试/首次启动的入参在本 tick 之前就失效了）。
  // 命中就直接不再起进程 —— 否则会为一个已墓碑化的 runtime 留下第二个孤儿进程。
  if (await settleLateAux(tab.runtimeId)) return
  if (!parent.project) throw auxProjectMissing()
  if (!parent.model) throw auxModelMissing()
  // 远程项目必须带连接 id（连接选择是远程细节的唯一权威来源）；本地恒为 undefined。
  const sshConnectionId = await terminalConnectionId(parent.project, sshConnectionList)
  await spawnAuxPi({
    parentRuntimeId: parent.runtimeId,
    runtimeId: tab.runtimeId,
    project: parent.project,
    provider: parent.model.provider,
    model: parent.model.model,
    thinking: parent.model.thinking ?? null,
    workspace: auxWorkspaceContext(parent.workspace, parent.project),
    sshConnectionId,
  })
  // ---- 迟到返回的收尾（三条缺陷的根因出口之一） ----
  //
  // `spawnAuxPi` 是异步的（远程还要探测/握手），返回时实例可能已经被 `closeAux`
  // 关闭并释放了 store。这里**只查不建**（`auxSessionExisting`）+ 统一收尾
  // （`settleLateAux`：kill 进程、拆残留 store、不写任何状态），绝不"缺席即创建"。
  if (await settleLateAux(tab.runtimeId)) return
  const session = auxSessionExisting(tab.runtimeId)
  if (!session) {
    // 极窄窗口：上面判活之后、这里读之前被关闭。再走一次同一出口（幂等）。
    await settleLateAux(tab.runtimeId)
    return
  }
  // 用 aux 自己的初始化序列，而不是公共 `session.init`（后者是原子的：四段 RPC
  // 一口气发完，中间被关闭时尾部照样打到一个已 kill 的 runtime）。
  await initAuxSession(session, parent.project)
  // `init` 也可能抛错（进程已退出/超时）。抛错交给 `openAux` 的 catch，那一支同样
  // 先判"是否已关闭"，命中就走同一个收尾函数，不会漏杀。
}

/**
 * aux 的初始化序列：**每段之间检查实例是否已被关闭**。
 *
 * 为什么不能直接用 `session.init()`：它内部是
 * `Promise.all([refreshState, refreshCommands, refreshModels, refreshStats])` →
 * `applyConfiguredModes()` → `refreshThinkingLevels()` → `applyRememberedSelection()`，
 * 整条链一把梭。关闭落在首批请求的飞行中时，尾部两段仍会向**已 kill 的 runtime**
 * 续发 `get_available_thinking_levels`（甚至 `set_follow_up_mode`），既无意义也会
 * 在策略层拿到 `auxRpcDenied`。
 *
 * 逐段检查的代价只是多几次同步判活，收益是"关闭之后零续发 RPC"。
 *
 * 跳过的两段：
 * - `applyConfiguredModes()`：它会把 pi 全局 settings 里的 `followUpMode` 推给运行时
 *   走 `set_follow_up_mode`，而这条**在 Aux 策略里被拒**（写 agent settings 的跨会话
 *   副作用），对 aux 无意义；
 * - `applyRememberedSelection()`：aux 的 provider/model 由启动 argv 继承父会话，本来就
 *   不是"记住的选择"。
 */
export async function initAuxSession(session: SessionStore, project: string): Promise<boolean> {
  session.cwd = project
  session.started = true
  // 首批：四段并发（Aux 白名单内的只读 + 列表查询）。
  await Promise.all([
    session.refreshState(),
    session.refreshCommands(),
    session.refreshModels(),
    session.refreshStats(),
  ])
  if (await settleLateAux(session.runtimeId)) return false
  // 第二段：思考等级（`get_available_thinking_levels`）。
  await session.refreshThinkingLevels()
  if (await settleLateAux(session.runtimeId)) return false
  return true
}

/**
 * 失败重试：同一实例重走一次 spawn。
 *
 * 与 `openAux` 同一条收尾规则：`spawnAuxRuntime` 迟到返回时实例可能已被关闭，此时
 * **必须**走 `settleLateAux`（kill + 拆 store）。这里不自己补 `kill`，也不在
 * "实物例没了"时静默 return —— 那正是之前漏杀迟到进程的出口。
 */
export async function retryAuxSpawn(parent: AuxParentContext, tab: AuxTab): Promise<void> {
  // 与 `spawnAuxRuntime` 同一入口守卫：已关闭的实例不再重试（避免多起一个进程）。
  if (await settleLateAux(tab.runtimeId)) return
  markAuxRetrying(tab.runtimeId)
  try {
    await spawnAuxRuntime(parent, tab)
    if (await settleLateAux(tab.runtimeId)) return
    const current = auxTabByRuntime(tab.runtimeId)
    if (!current) {
      await settleLateAux(tab.runtimeId)
      return
    }
    current.status = "ready"
    delete current.error
  } catch (error) {
    if (await settleLateAux(tab.runtimeId)) return
    const current = auxTabByRuntime(tab.runtimeId)
    if (!current) {
      await settleLateAux(tab.runtimeId)
      return
    }
    current.status = "error"
    current.error = error instanceof Error ? error.message : String(error)
  }
}

/** 从父会话 store 提取启动上下文（首次打开与失败重试共用同一份）。 */
export function auxParentContext(
  runtimeId: string,
  project: string,
  session: Parameters<typeof auxModelTarget>[0],
  workspace?: AuxParentContext["workspace"],
): AuxParentContext {
  return { runtimeId, project, model: auxModelTarget(session), workspace }
}
