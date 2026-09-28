import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

const source = path => readFileSync(new URL(path, import.meta.url), "utf8")
const lib = ts.transpile(source("../src/lib/bottomPin.ts").replace(/export /g, ""), { target: ts.ScriptTarget.ES2022 })
const context = vm.createContext({})
vm.runInContext(lib + "\nglobalThis.pinToBottom = pinToBottom", context)
const { pinToBottom } = context

test("pinToBottom glues the scroller to the bottom while content grows", () => {
  const viewport = { scrollTop: 900, scrollHeight: 1000, clientHeight: 100 }
  assert.equal(pinToBottom(viewport, true, false), false) // already at the bottom
  viewport.scrollHeight = 1200 // a streaming chunk arrives before paint
  assert.equal(pinToBottom(viewport, true, false), true)
  assert.equal(viewport.scrollTop, 1100)
  viewport.scrollHeight = 1500
  assert.equal(pinToBottom(viewport, true, false), true)
  assert.equal(viewport.scrollTop, 1400)
})

test("pinToBottom leaves readers who scrolled up or escaped alone", () => {
  const viewport = { scrollTop: 900, scrollHeight: 1200, clientHeight: 100 }
  assert.equal(pinToBottom(viewport, false, false), false)
  assert.equal(pinToBottom(viewport, true, true), false)
  assert.equal(viewport.scrollTop, 900)
})

test("pinToBottom ignores content shorter than the viewport", () => {
  const viewport = { scrollTop: 0, scrollHeight: 80, clientHeight: 100 }
  assert.equal(pinToBottom(viewport, true, false), false)
  assert.equal(viewport.scrollTop, 0)
})

test("conversation pins synchronously in a ResizeObserver for instant resize", () => {
  const conversation = source("../src/components/ai-elements/conversation/Conversation.vue")
  assert.match(conversation, /props\.resize !== 'instant'\) return/)
  assert.match(conversation, /new ResizeObserver\(pin\)/)
  assert.match(conversation, /pinToBottom\(scroll, context\.isAtBottom\.value, context\.escapedFromLock\.value\)/)
})
