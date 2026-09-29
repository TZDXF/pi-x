import { expect, test, vi } from "vitest"
import { effectScope, nextTick, ref } from "vue"
import { useCountdownNow } from "../src/composables/useCountdownNow"

test("useCountdownNow ticks once per second only while scheduled", async () => {
  vi.useFakeTimers()
  try {
    const scheduled = ref(false)
    const scope = effectScope()
    let now
    scope.run(() => {
      now = useCountdownNow(() => scheduled.value)
    })
    const started = now.value
    await vi.advanceTimersByTimeAsync(2500)
    expect(now.value).toBe(started)

    scheduled.value = true
    await nextTick()
    const resumed = now.value
    expect(resumed).toBeGreaterThanOrEqual(started)
    await vi.advanceTimersByTimeAsync(2100)
    expect(now.value).toBeGreaterThan(resumed)

    scheduled.value = false
    await nextTick()
    const stopped = now.value
    await vi.advanceTimersByTimeAsync(2500)
    expect(now.value).toBe(stopped)
  } finally {
    vi.useRealTimers()
  }
})
