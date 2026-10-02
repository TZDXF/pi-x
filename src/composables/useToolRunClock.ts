import { onScopeDispose, ref, watch } from "vue"

/** 当前展示边界自己的时钟：只在有运行项时跳动，停止/销毁即清理。 */
export function useToolRunClock(running: () => boolean) {
  const now = ref(Date.now())
  let clock: ReturnType<typeof setInterval> | undefined
  function stop() {
    if (clock !== undefined) clearInterval(clock)
    clock = undefined
  }
  watch(
    running,
    active => {
      stop()
      now.value = Date.now()
      if (active)
        clock = setInterval(() => {
          now.value = Date.now()
        }, 1000)
    },
    { immediate: true },
  )
  onScopeDispose(stop)
  return now
}

/** Subagent 保留分钟累计；普通工具在一小时后切换为小时/分钟。 */
export function formatToolElapsed(ms: number, hours = true): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (!hours || minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
