import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import { getMcpStatus, rpcRequest, type McpScope, type McpServerStatus, type McpStatusResult } from "@/api/piClient"
import { formatCodedError } from "@/lib/backendError"
import { compactNumber } from "@/lib/format"
import { normalizeSlashes } from "@/lib/paths"
import {
  estimateMcpContextUsage,
  estimateMcpLoadUsage,
  sanitizeMcpServerName,
  type McpServerLoad,
  type McpServerUsage,
} from "@/lib/mcpUsage"
import { useSessionStore } from "@/stores/conversations"

/** Connection status (state, tools, error) and usage estimates for the MCP
 *  server list. Status comes from `pi mcp list --json` and covers both
 *  scopes; it is refreshed automatically after every config change — there
 *  is no manual per-server check. Session token usage is estimated from the
 *  active session's projected context (`get_messages`); the "cost if loaded"
 *  estimate comes from each server's tool definitions (MCP `tools/list`,
 *  fetched by mcp_status for connected servers). */
export function useMcpStatus(deps: { project: () => string | undefined; scope: () => McpScope }) {
  const { t } = useI18n()

  const status = ref<McpStatusResult | null>(null)
  const statusLoading = ref(false)
  const statusError = ref("")
  const statusLoaded = ref(false)
  /** Estimated context usage per MCP server in the active session. */
  const mcpUsage = ref<Record<string, McpServerUsage> | null>(null)

  function fmt(e: unknown): string {
    return formatCodedError(t, e)
  }

  /** Live status reports keyed by "scope:name" — status covers both scopes. */
  const statusByKey = computed(() => {
    const map = new Map<string, McpServerStatus>()
    for (const server of status.value?.servers ?? []) map.set(`${server.scope}:${server.name}`, server)
    return map
  })

  /** Estimated "cost if loaded" per server, from the tool definitions fetched
   *  over MCP `tools/list`; keyed "scope:name" like the status map. */
  const loadCosts = computed<Record<string, McpServerLoad>>(() => {
    const map: Record<string, McpServerLoad> = {}
    for (const server of status.value?.servers ?? []) {
      if (!server.toolDefs?.length) continue
      const usage = estimateMcpLoadUsage(server.name, server.toolDefs)
      if (usage) map[`${server.scope}:${server.name}`] = usage
    }
    return map
  })

  /** Monotonic request id: only the latest refresh may apply its result, so a
   *  refresh triggered while an earlier one is still in flight is never
   *  silently dropped (e.g. a save issued before the mount refresh finishes). */
  let statusRequestId = 0

  async function refreshStatus() {
    const requestId = ++statusRequestId
    statusLoading.value = true
    statusError.value = ""
    try {
      const result = await getMcpStatus(deps.project())
      if (requestId !== statusRequestId) return
      status.value = result
      statusLoaded.value = true
    } catch (e) {
      if (requestId !== statusRequestId) return
      statusError.value = fmt(e)
    } finally {
      if (requestId === statusRequestId) statusLoading.value = false
    }
  }

  /** Estimated MCP context usage of the active conversation. Best effort: it
   *  needs a started session matching this settings' project (when one is set)
   *  and is simply absent otherwise. */
  async function loadUsage() {
    const session = useSessionStore()
    if (!session.started) return
    const project = deps.project()
    if (project && session.cwd && normalizeSlashes(session.cwd) !== normalizeSlashes(project)) return
    const runtimeId = session.runtimeId
    try {
      const res = await rpcRequest<{ messages?: unknown[] }>({ type: "get_messages" }, runtimeId)
      // The user may have switched sessions while the projection was in flight;
      // a stale response must not overwrite the current session's usage.
      if (!res.success || !session.started || session.runtimeId !== runtimeId) return
      mcpUsage.value = estimateMcpContextUsage(res.data?.messages ?? [])
    } catch {
      // Usage stats are decorative; a missing projection only hides them.
    }
  }

  function statusFor(name: string): McpServerStatus | undefined {
    return statusByKey.value.get(`${deps.scope()}:${name}`)
  }

  function usageFor(name: string): McpServerUsage | undefined {
    return mcpUsage.value?.[sanitizeMcpServerName(name)]
  }

  function loadUsageFor(name: string): McpServerLoad | undefined {
    return loadCosts.value[`${deps.scope()}:${name}`]
  }

  function toolLoadFor(serverName: string, tool: string): number | undefined {
    return loadUsageFor(serverName)?.tools.find(entry => entry.tool === tool)?.tokens
  }

  /** Tool calls are attributed by sanitized name; codemode-exposed servers run
   *  through the codemode tool and never surface as mcp__… calls. */
  function toolUsageFor(serverName: string, tool: string): { calls: number; tokens: number } | undefined {
    const usage = usageFor(serverName)
    return usage?.tools.find(entry => entry.tool === tool)
  }

  function toolUsageText(serverName: string, tool: string): string {
    const usage = toolUsageFor(serverName, tool)
    if (!usage?.calls) return t("mcpConfig.toolUnused")
    return `${t("mcpConfig.toolCalls", { count: usage.calls })} · ${t("mcpConfig.tokens", { count: compactNumber(usage.tokens) })}`
  }

  /** Right-hand text of one tool row: the load-cost estimate plus the session
   *  usage (calls and their context cost). */
  function toolRowText(serverName: string, tool: string): string {
    const parts: string[] = []
    const load = toolLoadFor(serverName, tool)
    if (load != null) parts.push(t("mcpConfig.tokens", { count: compactNumber(load) }))
    parts.push(toolUsageText(serverName, tool))
    return parts.join(" · ")
  }

  return {
    status,
    statusLoading,
    statusError,
    statusLoaded,
    mcpUsage,
    statusByKey,
    loadCosts,
    refreshStatus,
    loadUsage,
    statusFor,
    usageFor,
    loadUsageFor,
    toolLoadFor,
    toolUsageFor,
    toolUsageText,
    toolRowText,
  }
}
