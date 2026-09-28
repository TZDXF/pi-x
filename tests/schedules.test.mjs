import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { loadTsSource } from "./lib/load-ts.mjs"
const { scheduleExpression, parseScheduleExpression } = loadTsSource(
  readFileSync(new URL("../src/lib/schedules.ts", import.meta.url), "utf8"),
)
const { supportedThinkingLevels } = loadTsSource(
  readFileSync(new URL("../src/lib/thinkingLevels.ts", import.meta.url), "utf8"),
)

test("all schedule presets round trip without shifting time or weekday", () => {
  for (const [frequency, expected] of [
    ["hourly", "15 * * * *"],
    ["daily", "15 9 * * *"],
    ["weekdays", "15 9 * * MON-FRI"],
    ["weekly", "15 9 * * FRI"],
    ["monthly", "15 9 31 * *"],
  ]) {
    const expression = scheduleExpression(frequency, "09:15", "FRI", 31, "")
    assert.equal(expression, expected)
    const parsed = parseScheduleExpression(expression)
    assert.equal(parsed.frequency, frequency)
    assert.equal(
      scheduleExpression(parsed.frequency, parsed.time, parsed.weekday, parsed.day, parsed.custom),
      expression,
    )
  }
})
test("custom expressions are preserved when editing", () => {
  for (const expression of ["*/15 9-17 * * MON-FRI", "0 0 1,15 * *", "0 9 * 2 MON"]) {
    const parsed = parseScheduleExpression(expression)
    assert.equal(parsed.frequency, "custom")
    assert.equal(
      scheduleExpression(parsed.frequency, parsed.time, parsed.weekday, parsed.day, parsed.custom),
      expression,
    )
  }
})
test("rejects invalid preset values", () => {
  for (const time of ["24:00", "09:60", "", "9:00"])
    assert.throws(() => scheduleExpression("daily", time, "MON", 1, ""))
  for (const day of [0, 32, 1.5, NaN]) assert.throws(() => scheduleExpression("monthly", "09:00", "MON", day, ""))
  assert.throws(() => scheduleExpression("weekly", "09:00", "INVALID", 1, ""))
})
test("shared thinking levels respect model capability maps", () => {
  assert.deepEqual([...supportedThinkingLevels({ reasoning: false })], ["off"])
  assert.deepEqual(
    [...supportedThinkingLevels({ reasoning: true, thinkingLevelMap: { low: null, xhigh: "xhigh", max: null } })],
    ["off", "minimal", "medium", "high", "xhigh"],
  )
})

test("scheduled tasks use a workspace route and a page with the instructions last", () => {
  const app = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8")
  const sidebar = readFileSync(new URL("../src/components/WorkspaceSidebar.vue", import.meta.url), "utf8")
  const page = readFileSync(new URL("../src/components/ScheduledTasksPage.vue", import.meta.url), "utf8")
  const router = readFileSync(new URL("../src/lib/router.ts", import.meta.url), "utf8")
  assert.match(router, /name: "schedules"/)
  assert.match(app, /<ScheduledTasksPage[^>]*v-if="route.name === 'schedules'"/)
  assert.match(sidebar, /@click="emit\('schedules'\)"/)
  assert.doesNotMatch(sidebar, /ScheduledTasksDialog/)
  assert.match(page, /<TimeFieldRoot[^>]*v-model="timeValue"/)
  assert.match(page, /<SelectItem v-for="path in projects"[^>]*>\s*{{\s*workspace\.projectName\(path\)\s*}}<\/SelectItem>/)
  assert.ok(page.indexOf("schedules.prompt") > page.indexOf('id="schedule-thinking"'))
})

test("scheduled runs get unique Pix-owned runtimes and publish before prompting", () => {
  const source = readFileSync(new URL("../src-tauri/src/schedules.rs", import.meta.url), "utf8")
  assert.match(source, /let id = format!\("schedule-\{}", uuid::Uuid::new_v4\(\)\);/)
  assert.ok(
    source.indexOf('"type": "scheduled_session_created"') <
      source.indexOf('json!({"type":"prompt", "message":input.prompt})'),
  )
  assert.match(source, /current\.session_file = Some\(file\.clone\(\)\);[\s\S]*persist\(&updated\)\?;/)
  assert.match(source, /notify_schedules_changed\(app\);[\s\S]*published = true/)
})

test("scheduled workers remain visible to Pix while retaining their backend event channel", () => {
  const source = readFileSync(new URL("../src-tauri/src/rpc.rs", import.meta.url), "utf8")
  const emit = source.slice(source.indexOf("fn emit_process_event"), source.indexOf("const CREATE_NO_WINDOW"))
  assert.match(emit, /pi:\/\/schedule-/)
  assert.match(emit, /crate::remote::emit\(app, event, payload\)/)
  const list = source.slice(source.indexOf("pub async fn list"), source.indexOf("pub(crate) async fn set_session_name"))
  assert.doesNotMatch(list, /starts_with\("schedule-"\)/)
})
