import { expect, test, vi } from "vitest"
import { effectScope, nextTick, ref } from "vue"
import { useToolRunClock, formatToolElapsed } from "@/composables/useToolRunClock"
import { chatSource } from "./fixtures/chatSources"

test("tool clocks start, stop, resume freshly and dispose independently per display boundary", async () => {
  vi.useFakeTimers()
  const left = effectScope()
  const right = effectScope()
  try {
    vi.setSystemTime(10000)
    const active = ref(false)
    let a, b
    left.run(() => {
      a = useToolRunClock(() => active.value)
    })
    right.run(() => {
      b = useToolRunClock(() => true)
    })
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(a.value).toBe(10000)
    expect(b.value).toBe(12000)
    active.value = true
    await nextTick()
    expect(a.value).toBe(12000)
    expect(vi.getTimerCount()).toBe(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(a.value).toBe(13000)
    active.value = false
    await nextTick()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(a.value).toBe(13000)
    active.value = true
    await nextTick()
    expect(a.value).toBe(15000)
    left.stop()
    expect(vi.getTimerCount()).toBe(1)
    right.stop()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    left.stop()
    right.stop()
    vi.useRealTimers()
  }
})

test("tool formatting preserves general-tool hour display and subagent cumulative minutes", () => {
  expect(formatToolElapsed(-1)).toBe("0s")
  expect(formatToolElapsed(999)).toBe("0s")
  expect(formatToolElapsed(59999)).toBe("59s")
  expect(formatToolElapsed(60000)).toBe("1m 0s")
  expect(formatToolElapsed(3600000)).toBe("1h 0m")
  expect(formatToolElapsed(3661000, false)).toBe("61m 1s")
  const blocks = chatSource("components/AssistantBlocks.vue")
  const subagents = chatSource("components/chat/SubagentToolGroup.vue")
  expect(blocks).toMatch(/ms == null \|\| ms < 1_000/)
  expect(blocks).toMatch(/ms > 120_000/)
  expect(blocks).toMatch(/ms > 30_000/)
  expect(subagents).toMatch(/formatToolElapsed\(now.value - startedAt, false\)/)
  expect(subagents).not.toMatch(/ms < 1_000|120_000|30_000/)
})

test("shared details retain conditional plain-text IO, wrapping and separate scroll limits", () => {
  const details = chatSource("components/chat/ToolRunDetails.vue")
  expect(details).toMatch(/v-if="input"/)
  expect(details).toMatch(/v-if="output"/)
  expect(details).toMatch(/viewport-class="max-h-40"/)
  expect(details).toMatch(/viewport-class="max-h-60"/)
  expect(details).toMatch(/\[overflow-wrap:anywhere\]/)
  expect(details).not.toMatch(/v-html/)
  for (const file of ["components/AssistantBlocks.vue", "components/chat/SubagentToolGroup.vue"]) {
    const source = chatSource(file)
    expect(source).toMatch(/<ToolRunDetails/)
    expect(source).not.toMatch(/<ScrollArea|setInterval/)
  }
})
