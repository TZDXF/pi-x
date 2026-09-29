import { test, expect } from "vitest"
import { parseSendDelay, stepSendDelayWheel } from "@/lib/sendDelay"
import { readFileSync } from "node:fs"

test("delayed send accepts minutes:seconds with a 365-day limit", () => {
  expect(parseSendDelay("10:00")).toBe(600_000)
  expect(parseSendDelay("00:01")).toBe(1_000)
  expect(parseSendDelay("60:00")).toBe(3_600_000)
  expect(parseSendDelay("525600:00")).toBe(365 * 24 * 60 * 60 * 1000)
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
    expect(parseSendDelay(value), value).toBe(null)
  }
})

test("composer keeps its original send control when delayed send is active", () => {
  const chat = readFileSync(new URL("../src/components/ChatView.vue", import.meta.url), "utf8")
  expect(chat).toMatch(/<Button[^>]*type="button"[^>]*:aria-pressed="delayedSend"[^>]*>\s*<Clock3/)
  const controls = chat.slice(chat.indexOf("ml-auto flex"))
  expect(controls).toMatch(
    /<div\s+v-if="delayedSend"[^>]*>[\s\S]*?<NumberFieldRoot[\s\S]*?v-model="sendDelayMinutes"[\s\S]*?<NumberFieldRoot[\s\S]*?v-model="sendDelaySeconds"[\s\S]*?<Button[\s\S]*?type="button"[\s\S]*?:aria-pressed="delayedSend"[\s\S]*?>/,
  )
  expect(chat).toMatch(/<WorkspaceContext/)
  expect(chat).toMatch(/sendDelayMinutes = ref<number \| null>\(10\)/)
  expect(chat).toMatch(/sendDelaySeconds = ref<number \| null>\(0\)/)
  expect(controls).toMatch(
    /<NumberFieldRoot[^>]*v-model="sendDelayMinutes"[^>]*disable-wheel-change[^>]*@wheel="onSendDelayWheel\(\$event, 'minutes'\)"/,
  )
  expect(controls).toMatch(
    /<NumberFieldRoot[^>]*v-model="sendDelaySeconds"[^>]*disable-wheel-change[^>]*@wheel="onSendDelayWheel\(\$event, 'seconds'\)"/,
  )
  expect(controls).not.toMatch(/invert-wheel-change/)
  expect(controls).toMatch(/class="flex h-8 items-center rounded-md[^"]*px-1 text-sm font-mono/)
  expect(controls).not.toMatch(/w-\[6ch\]/)
  expect(chat).toMatch(/<PromptInputSubmit[^>]*:type="showStopButton \? 'button' : 'submit'"/)
  expect(chat).not.toMatch(/chat\.addDelayedPrompt/)
  expect(chat).toMatch(/session\.schedulePrompt\(text, delayMs!/)
})

test("hover wheel increments up and decrements down within each segment", () => {
  expect(stepSendDelayWheel(10, -120, 0, 525600)).toBe(11)
  expect(stepSendDelayWheel(10, 120, 0, 525600)).toBe(9)
  expect(stepSendDelayWheel(0, 120, 0, 59)).toBe(0)
  expect(stepSendDelayWheel(59, -120, 0, 59)).toBe(59)
  expect(stepSendDelayWheel(null, -120, 0, 59)).toBe(1)
  expect(stepSendDelayWheel(10, -10, 30, 59)).toBe(null)
  expect(stepSendDelayWheel(10, 0, 0, 59)).toBe(null)
})

test("delayed send schedules backend slash commands; only desktop commands are rejected", () => {
  const chat = readFileSync(new URL("../src/components/ChatView.vue", import.meta.url), "utf8")
  const submit = chat.slice(chat.indexOf("async function onSubmit("), chat.indexOf("function thinkingLabel"))
  expect(submit).not.toMatch(/delayedSend\.value && text\.startsWith\("\/"\)/)
  const desktop = submit.slice(submit.indexOf("desktopCommands.some(name => name === commandName)) {"))
  expect(desktop).toMatch(
    /if \(delayedSend\.value\) \{\s*const error = t\(.chat\.delayedCommandUnsupported., \{\s*commands: desktopCommands\.map/,
  )
  expect(submit).toMatch(/if \(delayedSend\.value\) \{\s*session\.schedulePrompt\(text, delayMs!/)
})
