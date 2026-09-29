import { onBeforeUnmount, ref, watch } from "vue"

/** 每秒跳动的墙钟时间，仅在 hasScheduled 为 true 时运行定时器。 */
export function useCountdownNow(hasScheduled: () => boolean) {
  const now = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | undefined
  watch(
    hasScheduled,
    active => {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      now.value = Date.now()
      if (active)
        timer = setInterval(() => {
          now.value = Date.now()
        }, 1000)
    },
    { immediate: true },
  )
  onBeforeUnmount(() => {
    if (timer !== undefined) clearInterval(timer)
  })
  return now
}
