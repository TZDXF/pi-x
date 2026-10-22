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
  const viewport = {
    clientHeight: 600,
    getBoundingClientRect: bounds,
    querySelector: () => ({ getBoundingClientRect: () => ({ top: 10 }) }),
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
      ts.transpile(script + "\nglobalThis.api = { navRef, onViewportScroll, currentId }", {
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
    expect(context.api.currentId.value).toBe(1)
    context.api.onViewportScroll()
    expect(frames.size).toBe(1)
  } finally {
    cleanup.forEach(fn => fn())
    scope.stop()
  }
  expect(frames.size).toBe(0)
  expect(viewport.removeEventListener).toHaveBeenCalledWith("scroll", context.api.onViewportScroll)
})
