import type { ToolCallBlock, ToolRun } from "@/stores/session/types"

/** Prefer the execution snapshot to an incomplete streaming preview.
 * Validation/coercion belongs to pi, not the UI: RPC may still carry raw args. */
export function toolInput(block: ToolCallBlock, run?: ToolRun): string {
  return run?.argsText || block.argsText
}

export function toolDuration(run: ToolRun | undefined, now: number): number | null {
  if (!run) return null
  if (run.durationMs !== undefined && Number.isFinite(run.durationMs) && run.durationMs >= 0) return run.durationMs
  if (run.startedAt === undefined) return null
  return Math.max(0, (run.completedAt ?? now) - run.startedAt)
}
