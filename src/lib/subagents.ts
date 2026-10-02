/**
 * Client adaptation for the `npm:pi-subagents` extension.
 *
 * This module is the ONLY place that knows about the plugin's conventions —
 * its widget line prefix, snapshot shape and delegation tool names. Generic
 * components (ChatView, AssistantBlocks, ui store) stay plugin-agnostic and
 * go through the helpers exported here.
 *
 * The plugin reports async subagent run status through `setWidget`, mixing a
 * machine-readable snapshot line (`PI_SUBAGENT_ASYNC_JSON:{...}`) in with
 * plain text lines. The client parses the snapshot to render a status panel
 * instead of raw JSON.
 */

import type { Component } from "vue"
import { CircleCheck, CircleDashed, CircleX, Clock3 } from "@lucide/vue"

export interface SubagentStepStatus {
  id: string
  kind: string
  label: string
  state: string
}

export interface SubagentRunStatus {
  id: string
  kind: string
  label: string
  state: string
  startedAt: number
  updatedAt: number
  children: SubagentStepStatus[]
}

export interface SubagentSnapshot {
  kind: string
  version: number
  generatedAt: number
  runs: SubagentRunStatus[]
}

export const SUBAGENT_WIDGET_PREFIX = "PI_SUBAGENT_ASYNC_JSON:"
const SNAPSHOT_KIND = "pi-subagents.async-status-snapshot"

/** Parse one widget line; null when the line is not a valid snapshot. */
export function parseSubagentSnapshotLine(line: string): SubagentSnapshot | null {
  if (!line.startsWith(SUBAGENT_WIDGET_PREFIX)) return null
  try {
    const parsed = JSON.parse(line.slice(SUBAGENT_WIDGET_PREFIX.length)) as SubagentSnapshot | null
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.kind === SNAPSHOT_KIND &&
      Array.isArray(parsed.runs) &&
      parsed.runs.every(
        run =>
          run &&
          typeof run.id === "string" &&
          typeof run.label === "string" &&
          typeof run.state === "string" &&
          typeof run.startedAt === "number",
      )
    ) {
      return {
        ...parsed,
        runs: parsed.runs.map(run => ({ ...run, children: Array.isArray(run.children) ? run.children : [] })),
      }
    }
  } catch {
    // Truncated or non-JSON payload: fall back to raw rendering.
  }
  return null
}

export interface WidgetContent {
  /** Last valid snapshot found among the lines, if any. */
  snapshot: SubagentSnapshot | null
  /** Lines that are not a snapshot line, rendered as before. */
  plainLines: string[]
}

/** Split widget lines into a subagent snapshot and the remaining plain lines. */
export function parseSubagentWidget(lines: string[]): WidgetContent {
  const plainLines: string[] = []
  let snapshot: SubagentSnapshot | null = null
  for (const line of lines) {
    const parsed = parseSubagentSnapshotLine(line)
    // The extension replaces the whole widget each update; the last valid
    // snapshot wins and earlier ones are stale.
    if (parsed) snapshot = parsed
    else plainLines.push(line)
  }
  return { snapshot, plainLines }
}

// ---- run state presentation ----
// The plugin's snapshot states and pi's tool-run states use different
// vocabularies; both normalize to the views below so the widget panel and the
// conversation group render identically.

/** Normalized subagent run states shared by panel and conversation group. */
export type SubagentState = "running" | "queued" | "completed" | "failed" | "canceled" | "unknown"

const STATE_VIEWS: Record<SubagentState, { icon: Component | null; class: string; labelKey: string } | undefined> = {
  running: { icon: null, class: "text-primary", labelKey: "piSubagents.state.running" },
  queued: { icon: Clock3, class: "text-muted-foreground", labelKey: "piSubagents.state.queued" },
  completed: {
    icon: CircleCheck,
    class: "text-green-600 dark:text-green-400",
    labelKey: "piSubagents.state.completed",
  },
  failed: { icon: CircleX, class: "text-red-600 dark:text-red-400", labelKey: "piSubagents.state.failed" },
  canceled: { icon: CircleX, class: "text-muted-foreground", labelKey: "piSubagents.state.canceled" },
  unknown: { icon: CircleDashed, class: "text-muted-foreground", labelKey: "" },
}

/** Map a snapshot state or a pi tool-run state to its normalized view. */
export function subagentStateView(state: string): SubagentState {
  switch (state) {
    // snapshot vocabulary (pi-subagents)
    case "running":
    // pi tool-run vocabulary
    case "input-available":
      return "running"
    case "queued":
    case "input-streaming":
      return "queued"
    // snapshot aliases across plugin versions
    case "completed":
    case "complete":
    case "done":
    case "success":
    case "succeeded":
    case "output-available":
      return "completed"
    case "failed":
    case "error":
    case "output-error":
      return "failed"
    case "canceled":
    case "cancelled":
    case "cancel":
    case "aborted":
    case "output-denied":
      return "canceled"
    default:
      return "unknown"
  }
}

/** Label for a run state: localized when known, the raw state otherwise. */
export function subagentStateLabel(state: string, t: (key: string) => string): string {
  const normalized = subagentStateView(state)
  const view = STATE_VIEWS[normalized]
  return normalized === "unknown" || !view ? state : t(view.labelKey)
}

/** Icon and color for a run state; `running` renders a spinner instead of an icon. */
export function subagentStateVisual(state: string): { icon: Component | null; class: string } {
  const view = STATE_VIEWS[subagentStateView(state)]
  return { icon: view?.icon ?? CircleDashed, class: view?.class ?? "text-muted-foreground" }
}

// ---- delegation tools ----

/** Tool names registered by the plugin (compared on the name after any prefix). */
const SUBAGENT_TOOLS = new Set(["subagent", "subagents_enable"])

/** True when a tool call belongs to the plugin's delegation tools. */
export function isSubagentTool(toolName: string): boolean {
  const base = toolName.toLowerCase().split(/[.:/]/).pop()!
  return SUBAGENT_TOOLS.has(base)
}

function parseToolArgs(argsText: string | undefined): Record<string, unknown> | null {
  if (!argsText) return null
  try {
    return JSON.parse(argsText)
  } catch {
    // Still-streaming (unterminated) arguments: no title yet.
    return null
  }
}

const TOOL_TITLE_MAX = 120

/**
 * Header title for a delegation tool call: the action, the delegated task or a
 * localized label for workflow scripts. Empty string falls back to the tool
 * name. `workflowLabel` is the caller-localized workflow wording.
 */
export function subagentToolTitle(argsText: string | undefined, workflowLabel: string): string {
  const args = parseToolArgs(argsText)
  if (!args) return ""
  if (typeof args.action === "string" && args.action) return args.action
  if (typeof args.task === "string" && args.task) {
    const task = args.task.replace(/\s+/g, " ").trim()
    return task.length > TOOL_TITLE_MAX ? task.slice(0, TOOL_TITLE_MAX) + "…" : task
  }
  if (typeof args.workflowScript === "string" && args.workflowScript) return workflowLabel
  return ""
}
