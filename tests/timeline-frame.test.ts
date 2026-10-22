import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"
import { computed, effectScope, nextTick, reactive, ref, watch } from "vue"
import { expect, test, vi } from "vitest"
import { appendPartial } from "@/lib/conversationTimeline"

test("stream updates and scrolling share a frame, and unmount cancels pending layout reads", async () => {
  const source = readFileSync(new URL("../src/components/ConversationTimeline.vue", import.meta.url), "utf8")
  const script = source
    .split('<script setup lang="ts">')[1]
    .split("</script>")[0]
    .replace(/^import .*$/gm, "")
  const props = reactive({ turns: [{ id: 1, entryId: 1, question: "question", answer: "" }], partial: [] })
  const scope = effectScope()
  const mounted = [],
    cleanup = []
  const frames = new Map()
  let sequence = 0
  const bounds = vi.fn(() => ({ top: 0 }))
  let positions = [10]
  const viewport = {
    clientHeight: 600,
    getBoundingClientRect: bounds,
    querySelector: selector => {
      const id = Number(selector.match(/"(\d+)"/)[1])
      const top = positions[id - 1]
      return top == null ? null : { getBoundingClientRect: () => ({ top }) }
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
  const context = {
    computed,
    ref,
    watch,
    appendPartial,
    defineProps: () => props,
    defineEmits: () => vi.fn(),
    useI18n: () => ({ t: key => key }),
    onMounted: fn => mounted.push(fn),
    onBeforeUnmount: fn => cleanup.push(fn),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: fn => {
      frames.set(++sequence, fn)
      return sequence
    },
    cancelAnimationFrame: id => frames.delete(id),
  }
  scope.run(() =>
    vm.runInNewContext(
      ts.transpile(script + "\nglobalThis.api = { navRef, onViewportScroll, currentIds }", {
        target: ts.ScriptTarget.ES2022,
      }),
      context,
    ),
  )
  context.api.navRef.value = { clientHeight: 600, parentElement: { querySelector: () => viewport } }
  mounted.forEach(fn => fn())
  try {
    props.partial = [{ type: "text", text: "stream" }]
    context.api.onViewportScroll()
    context.api.onViewportScroll()
    await nextTick()
    expect(frames.size).toBe(1)
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach(fn => fn())
    expect(bounds).toHaveBeenCalledOnce()
    expect([...context.api.currentIds.value]).toEqual([1])
    const checkVisible = async (tops, expected) => {
      positions = tops
      props.turns = tops.map((_, index) => ({ id: index + 1, entryId: index + 1, question: "q", answer: "" }))
      await nextTick()
      context.api.onViewportScroll()
      const callbacks = [...frames.values()]
      frames.clear()
      callbacks.forEach(fn => fn())
      expect([...context.api.currentIds.value]).toEqual(expected)
    }
    // Multiple questions in one viewport, including a short final answer at the bottom.
    await checkVisible([-200, 150, 500], [1, 2, 3])
    // A long answer remains visible even after its question leaves the viewport.
    await checkVisible([-900, 700], [1])
    // Exact viewport boundaries do not mark the previous or next offscreen turn.
    await checkVisible([-200, 0, 600], [2])
    // Scrolling back up removes the last turn's marker.
    await checkVisible([10, 650, 900], [1])
    // Unmaterialized anchors are safely skipped.
    await checkVisible([null, -100, 450], [2, 3])
    context.api.onViewportScroll()
    expect(frames.size).toBe(1)
  } finally {
    cleanup.forEach(fn => fn())
    scope.stop()
  }
  expect(frames.size).toBe(0)
  expect(viewport.removeEventListener).toHaveBeenCalledWith("scroll", context.api.onViewportScroll)
})
