import { invoke } from "./transport"

/** 用量/成本汇总（仅本地会话）：数据来自 pi 会话文件中持久化的 usage。 */
export interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number
  messages: number
}
export interface UsageDay extends UsageTotals {
  /** 本地时区 YYYY-MM-DD。 */
  day: string
}
export interface UsageProject extends UsageTotals {
  project: string
  sessions: number
}
export interface UsageModel extends UsageTotals {
  provider: string
  model: string
}
export interface UsageSummary {
  totals: UsageTotals
  /** 范围内有用量的会话数。 */
  sessionsScanned: number
  byDay: UsageDay[]
  byProject: UsageProject[]
  byModel: UsageModel[]
}

/** days 为 0 表示全部历史；project 为 null 表示全部项目。 */
export const fetchUsageSummary = (days: number, project: string | null) =>
  invoke<UsageSummary>("usage_summary", { days, project })
