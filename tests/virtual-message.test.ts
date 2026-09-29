import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"
import { computed, ref, reactive, watch, nextTick, effectScope } from "vue"

const source = readFileSync(new URL("../src/components/VirtualMessage.vue", import.meta.url), "utf8")
const script = source
  .split('<script setup lang="ts">')[1]
  .split("</script>")[0]
  .replace(/^import .*$/gm, "")
function harness(initial = {}) {
  const scope = effectScope()
  const props = reactive({ enabled: true, pinned: false, live: false, ...initial })
  const mounted = [],
    cleanup = []
  let intersect
  const viewport = { scrollTop: 1000, scrollHeight: 5000, clientHeight: 600, getBoundingClientRect: () => ({ top: 0 }) }
  const context = {
    computed,
    ref,
    watch,
    nextTick,
    conversationKey: {},
    defineProps: () => props,
    withDefaults: p => p,
    inject: () => ({ scrollRef: ref(viewport) }),
    onMounted: f => mounted.push(f),
    onBeforeUnmount: f => cleanup.push(f),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    IntersectionObserver: class {
      constructor(callback) {
        intersect = callback
      }
      observe() {}
      disconnect() {}
    },
    window: { getSelection: () => null },
    document: { activeElement: null },
  }
  scope.run(() =>
    vm.runInNewContext(
      ts.transpile(script + "\nglobalThis.api = { rendered, animate, height, shell, body, reveal, measure };", {
        target: ts.ScriptTarget.ES2022,
      }),
      context,
    ),
  )
  context.api.shell.value = { getBoundingClientRect: () => ({ top: -500 }), contains: () => false }
  scope.run(() => mounted.forEach(f => f()))
  return {
    ...context.api,
    props,
    viewport,
    async enter(visible) {
      intersect([{ isIntersecting: visible }])
      await nextTick()
      await nextTick()
    },
    close() {
      cleanup.forEach(f => f())
      scope.stop()
    },
  }
}
test("offscreen history stays unmounted; viewport entry mounts without animation", async () => {
  const h = harness()
  try {
    expect(h.rendered.value).toBe(false)
    await h.enter(true)
    expect(h.rendered.value).toBe(true)
    expect(h.animate.value).toBe(false)
    await h.enter(false)
    expect(h.rendered.value).toBe(false)
  } finally {
    h.close()
  }
})
test("live output stays mounted and keeps animation policy through completion", async () => {
  const h = harness({ live: true })
  try {
    await h.enter(false)
    expect(h.rendered.value).toBe(true)
    expect(h.animate.value).toBe(true)
    h.props.pinned = true
    h.props.live = false
    await nextTick()
    expect(h.animate.value).toBe(true)
    h.props.pinned = false
    await nextTick()
    expect(h.rendered.value).toBe(false)
    await h.enter(true)
    expect(h.animate.value).toBe(false)
  } finally {
    h.close()
  }
})
test("timeline can reveal an offscreen placeholder before scrolling", async () => {
  const h = harness()
  try {
    h.reveal()
    await nextTick()
    expect(h.rendered.value).toBe(true)
    await h.enter(true)
    await h.enter(false)
    expect(h.rendered.value).toBe(false)
  } finally {
    h.close()
  }
})
test("measured height is retained and changes above viewport preserve reading position", () => {
  const h = harness()
  try {
    h.body.value = { getBoundingClientRect: () => ({ height: 240 }) }
    h.measure()
    expect(h.height.value).toBe(240)
    expect(h.viewport.scrollTop).toBe(1080)
    h.measure()
    expect(h.viewport.scrollTop).toBe(1080)
  } finally {
    h.close()
  }
})
test("small conversations are not virtualized", () => {
  const h = harness({ enabled: false })
  try {
    expect(h.rendered.value).toBe(true)
  } finally {
    h.close()
  }
})
