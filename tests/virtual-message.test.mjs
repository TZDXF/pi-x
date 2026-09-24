import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { computed, ref, reactive, watch, nextTick, effectScope } from 'vue'

const source = readFileSync(new URL('../src/components/VirtualMessage.vue', import.meta.url), 'utf8')
const script = source.split('<script setup lang="ts">')[1].split('</script>')[0].replace(/^import .*$/gm, '')
function harness(initial = {}) {
  const scope = effectScope()
  const props = reactive({ enabled: true, pinned: false, live: false, ...initial })
  const mounted = [], cleanup = []
  let intersect
  const viewport = { scrollTop: 1000, scrollHeight: 5000, clientHeight: 600, getBoundingClientRect: () => ({ top: 0 }) }
  const context = {
    computed, ref, watch, nextTick, conversationKey: {},
    defineProps: () => props, withDefaults: p => p,
    inject: () => ({ scrollRef: ref(viewport) }),
    onMounted: f => mounted.push(f), onBeforeUnmount: f => cleanup.push(f),
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { constructor(callback) { intersect = callback } observe() {} disconnect() {} },
    window: { getSelection: () => null }, document: { activeElement: null },
  }
  scope.run(() => vm.runInNewContext(ts.transpile(script + '\nglobalThis.api = { rendered, animate, height, shell, body, reveal, measure };', { target: ts.ScriptTarget.ES2022 }), context))
  context.api.shell.value = { getBoundingClientRect: () => ({ top: -500 }), contains: () => false }
  scope.run(() => mounted.forEach(f => f()))
  return { ...context.api, props, viewport, async enter(visible) { intersect([{ isIntersecting: visible }]); await nextTick(); await nextTick() }, close() { cleanup.forEach(f => f()); scope.stop() } }
}
test('offscreen history stays unmounted; viewport entry mounts without animation', async () => {
  const h = harness()
  try {
    assert.equal(h.rendered.value, false)
    await h.enter(true)
    assert.equal(h.rendered.value, true)
    assert.equal(h.animate.value, false)
    await h.enter(false)
    assert.equal(h.rendered.value, false)
  } finally { h.close() }
})
test('live output stays mounted and keeps animation policy through completion', async () => {
  const h = harness({ live: true })
  try {
    await h.enter(false)
    assert.equal(h.rendered.value, true)
    assert.equal(h.animate.value, true)
    h.props.pinned = true
    h.props.live = false
    await nextTick()
    assert.equal(h.animate.value, true)
    h.props.pinned = false
    await nextTick()
    assert.equal(h.rendered.value, false)
    await h.enter(true)
    assert.equal(h.animate.value, false)
  } finally { h.close() }
})
test('timeline can reveal an offscreen placeholder before scrolling', async () => {
  const h = harness()
  try {
    h.reveal()
    await nextTick()
    assert.equal(h.rendered.value, true)
    await h.enter(true)
    await h.enter(false)
    assert.equal(h.rendered.value, false)
  } finally { h.close() }
})
test('measured height is retained and changes above viewport preserve reading position', () => {
  const h = harness()
  try {
    h.body.value = { getBoundingClientRect: () => ({ height: 240 }) }
    h.measure()
    assert.equal(h.height.value, 240)
    assert.equal(h.viewport.scrollTop, 1080)
    h.measure()
    assert.equal(h.viewport.scrollTop, 1080)
  } finally { h.close() }
})
test('small conversations are not virtualized', () => {
  const h = harness({ enabled: false })
  try { assert.equal(h.rendered.value, true) } finally { h.close() }
})
