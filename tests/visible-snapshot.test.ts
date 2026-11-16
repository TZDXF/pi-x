import { expect, test, vi } from "vitest"
import { effectScope, nextTick, ref } from "vue"
import { useVisibleSnapshot } from "@/composables/useVisibleSnapshot"

test("hidden panels skip live computation, retain selection data and catch up when reopened", async () => {
  const scope = effectScope()
  const visible = ref(false)
  const revision = ref(1)
  const read = vi.fn(() => [{ revision: revision.value }])
  const snapshot = scope.run(() => useVisibleSnapshot(() => visible.value, read, []))!
  try {
    expect(read).not.toHaveBeenCalled()
    revision.value = 2
    await nextTick()
    expect(read).not.toHaveBeenCalled()
    visible.value = true
    await nextTick()
    expect(snapshot.value).toEqual([{ revision: 2 }])
    revision.value = 3
    await nextTick()
    expect(snapshot.value).toEqual([{ revision: 3 }])
    visible.value = false
    await nextTick()
    const retained = snapshot.value
    read.mockClear()
    revision.value = 4
    await nextTick()
    expect(read).not.toHaveBeenCalled()
    expect(snapshot.value).toBe(retained)
    visible.value = true
    await nextTick()
    expect(snapshot.value).toEqual([{ revision: 4 }])
  } finally {
    scope.stop()
  }
  read.mockClear()
  revision.value = 5
  await nextTick()
  expect(read).not.toHaveBeenCalled()
})
