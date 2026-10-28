import { invoke, listen } from "./transport"
import type { ThinkingLevel } from "./protocol"

export interface ScheduledTaskInput {
  id: string | null
  title: string
  prompt: string
  project: string
  provider: string
  model: string
  thinking: ThinkingLevel
  expression: string
  enabled: boolean
}
export interface ScheduledTaskRun {
  startedAt: number
  finishedAt: number | null
  trigger: "scheduled" | "manual" | "unknown"
  status: "running" | "success" | "failed"
  error: string | null
  sessionFile: string | null
  durationMs: number | null
}
export interface ScheduledTask extends ScheduledTaskInput {
  nextRun: number
  lastRun: number | null
  status: "idle" | "running" | "success" | "failed"
  error: string | null
  sessionFile: string | null
  /** 最近若干次运行记录（旧后端或从未运行时缺省）。 */
  runs?: ScheduledTaskRun[]
}
export const listScheduledTasks = () => invoke<ScheduledTask[]>("schedule_list")
export const saveScheduledTask = (input: ScheduledTaskInput) => invoke<ScheduledTask>("schedule_save", { input })
export const deleteScheduledTask = (id: string) => invoke<void>("schedule_delete", { id })
export const runScheduledTask = (id: string) => invoke<void>("schedule_run", { id })

/** Schedule rows change outside this component when a run starts or publishes its session. */
export const onScheduledTasksChanged = (handler: () => void) => listen("pi://schedules-changed", () => handler())
