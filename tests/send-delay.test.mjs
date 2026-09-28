import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { loadTsSource } from "./lib/load-ts.mjs"

const { parseSendDelay, stepSendDelayWheel } = loadTsSource(
  readFileSync(new URL("../src/lib/sendDelay.ts", import.meta.url), "utf8"),
)

test("delayed send accepts minutes:seconds with a 365-day limit", () => {
  assert.equal(parseSendDelay("10:00"), 600_000)
  assert.equal(parseSendDelay("00:01"), 1_000)
  assert.equal(parseSendDelay("60:00"), 3_600_000)
  assert.equal(parseSendDelay("525600:00"), 365 * 24 * 60 * 60 * 1000)
})

test("delayed send rejects malformed, empty, overdue, and excessive durations", () => {
  for (const value of [
    "",
    "5",
    "10:0",
    "10:60",
    "-1:00",
    "01:00:00",
    "00:00",
    "525600:01",
    "9999999999999999999999:00",
  ]) {
    assert.equal(parseSendDelay(value), null, value)
  }
})

test("composer keeps its original send control when delayed send is active", () => {
  const chat = readFileSync(new URL("../src/components/ChatView.vue", import.meta.url), "utf8")
  assert.match(chat, /<Button[^>]*type="button"[^>]*:aria-pressed="delayedSend"[^>]*>\s*<Clock3/)
  const controls = chat.slice(chat.indexOf("ml-auto flex"))
  assert.match(
    controls,
    /<div\s+v-if="delayedSend"[^>]*>[\s\S]*?<NumberFieldRoot[\s\S]*?v-model="sendDelayMinutes"[\s\S]*?<NumberFieldRoot[\s\S]*?v-model="sendDelaySeconds"[\s\S]*?<Button[\s\S]*?type="button"[\s\S]*?:aria-pressed="delayedSend"[\s\S]*?>/,
  )
  assert.match(chat, /<WorkspaceContext/)
  assert.match(chat, /sendDelayMinutes = ref<number \| null>\(10\)/)
  assert.match(chat, /sendDelaySeconds = ref<number \| null>\(0\)/)
  assert.match(
    controls,
    /<NumberFieldRoot[^>]*v-model="sendDelayMinutes"[^>]*disable-wheel-change[^>]*@wheel="onSendDelayWheel\(\$event, 'minutes'\)"/,
  )
  assert.match(
    controls,
    /<NumberFieldRoot[^>]*v-model="sendDelaySeconds"[^>]*disable-wheel-change[^>]*@wheel="onSendDelayWheel\(\$event, 'seconds'\)"/,
  )
  assert.doesNotMatch(controls, /invert-wheel-change/)
  assert.match(controls, /class="flex h-8 items-center rounded-md[^"]*px-1 text-sm font-mono/)
  assert.doesNotMatch(controls, /w-\[6ch\]/)
  assert.match(chat, /<PromptInputSubmit[^>]*:type="showStopButton \? 'button' : 'submit'"/)
  assert.doesNotMatch(chat, /chat\.addDelayedPrompt/)
  assert.match(chat, /session\.schedulePrompt\(text, delayMs!/)
})

test("hover wheel increments up and decrements down within each segment", () => {
  assert.equal(stepSendDelayWheel(10, -120, 0, 525600), 11)
  assert.equal(stepSendDelayWheel(10, 120, 0, 525600), 9)
  assert.equal(stepSendDelayWheel(0, 120, 0, 59), 0)
  assert.equal(stepSendDelayWheel(59, -120, 0, 59), 59)
  assert.equal(stepSendDelayWheel(null, -120, 0, 59), 1)
  assert.equal(stepSendDelayWheel(10, -10, 30, 59), null)
  assert.equal(stepSendDelayWheel(10, 0, 0, 59), null)
})

test("delayed send schedules backend slash commands; only desktop commands are rejected", () => {
  const chat = readFileSync(new URL("../src/components/ChatView.vue", import.meta.url), "utf8")
  const submit = chat.slice(chat.indexOf("async function onSubmit("), chat.indexOf("function thinkingLabel"))
  assert.doesNotMatch(submit, /delayedSend\.value && text\.startsWith\("\/"\)/)
  const desktop = submit.slice(submit.indexOf("desktopCommands.some(name => name === commandName)) {"))
  assert.match(
    desktop,
    /if \(delayedSend\.value\) \{\s*const error = t\(.chat\.delayedCommandUnsupported., \{\s*commands: desktopCommands\.map/,
  )
  assert.match(submit, /if \(delayedSend\.value\) \{\s*session\.schedulePrompt\(text, delayMs!/)
})
