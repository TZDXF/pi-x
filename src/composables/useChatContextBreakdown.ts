import { computed, ref } from "vue"
import type { RpcResponse } from "@/api/protocol"
import type { SessionStore } from "@/stores/session"
import { averageCacheRate } from "@/lib/cacheRate"
import { contextBreakdownParts, estimateContextBreakdown, type ContextBreakdownPart } from "@/lib/contextBreakdown"
import { formatPercent } from "@/lib/format"

/** Context usage, session-wide weighted cache hit rate and the breakdown popover data. */
export function useChatContextBreakdown(
  session: SessionStore,
  rpcRequest: <T = unknown>(command: Record<string, unknown>) => Promise<RpcResponse<T>>,
) {
  const contextUsage = computed(() => session.stats?.contextUsage ?? null)
  const cacheRate = computed(() => averageCacheRate(session.stats?.tokens))
  const cacheRateText = computed(() => (cacheRate.value === null ? "—" : formatPercent(cacheRate.value)))

  const contextBreakdown = ref<ContextBreakdownPart[] | null>(null)
  let fetchedKey: string | null = null
  let loading = false
  async function refreshContextBreakdown() {
    const key = `${session.stats?.sessionId ?? ""}:${contextUsage.value?.tokens ?? ""}`
    if (loading || fetchedKey === key) return
    loading = true
    contextBreakdown.value = null
    try {
      const res = await rpcRequest<{ messages: any[] }>({ type: "get_messages" })
      if (!res.success) return
      if (key !== `${session.stats?.sessionId ?? ""}:${contextUsage.value?.tokens ?? ""}`) return
      fetchedKey = key
      contextBreakdown.value = contextBreakdownParts(
        estimateContextBreakdown(res.data?.messages ?? []),
        contextUsage.value?.tokens,
      )
    } finally {
      loading = false
    }
  }

  return { contextUsage, cacheRateText, contextBreakdown, refreshContextBreakdown }
}
