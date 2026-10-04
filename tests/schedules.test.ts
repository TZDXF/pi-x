import { test, expect } from "vitest"
import { scheduleExpression, parseScheduleExpression } from "@/lib/schedules"
import { supportedThinkingLevels } from "@/lib/thinkingLevels"
import { readFileSync } from "node:fs"

test("all schedule presets round trip without shifting time or weekday", () => {
  for (const [frequency, expected] of [
    ["hourly", "15 * * * *"],
    ["daily", "15 9 * * *"],
    ["weekdays", "15 9 * * MON-FRI"],
    ["weekly", "15 9 * * FRI"],
    ["monthly", "15 9 31 * *"],
  ]) {
    const expression = scheduleExpression(frequency, "09:15", "FRI", 31, "")
    expect(expression).toBe(expected)
    const parsed = parseScheduleExpression(expression)
    expect(parsed.frequency).toBe(frequency)
    expect(scheduleExpression(parsed.frequency, parsed.time, parsed.weekday, parsed.day, parsed.custom)).toBe(
      expression,
    )
  }
})
test("custom expressions are preserved when editing", () => {
  for (const expression of ["*/15 9-17 * * MON-FRI", "0 0 1,15 * *", "0 9 * 2 MON"]) {
    const parsed = parseScheduleExpression(expression)
    expect(parsed.frequency).toBe("custom")
    expect(scheduleExpression(parsed.frequency, parsed.time, parsed.weekday, parsed.day, parsed.custom)).toBe(
      expression,
    )
  }
})
test("rejects invalid preset values", () => {
  for (const time of ["24:00", "09:60", "", "9:00"])
    expect(() => scheduleExpression("daily", time, "MON", 1, "")).toThrow()
  for (const day of [0, 32, 1.5, NaN]) expect(() => scheduleExpression("monthly", "09:00", "MON", day, "")).toThrow()
  expect(() => scheduleExpression("weekly", "09:00", "INVALID", 1, "")).toThrow()
})
test("shared thinking levels respect model capability maps", () => {
  expect([...supportedThinkingLevels({ reasoning: false })]).toEqual(["off"])
  expect([
    ...supportedThinkingLevels({ reasoning: true, thinkingLevelMap: { low: null, xhigh: "xhigh", max: null } }),
  ]).toEqual(["off", "minimal", "medium", "high", "xhigh"])
})

test("scheduled tasks use a workspace route and a page with the instructions last", () => {
  const app = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8")
  const sidebar = readFileSync(new URL("../src/components/WorkspaceSidebar.vue", import.meta.url), "utf8")
  const page = readFileSync(new URL("../src/components/ScheduledTasksPage.vue", import.meta.url), "utf8")
  const router = readFileSync(new URL("../src/lib/router.ts", import.meta.url), "utf8")
  expect(router).toMatch(/name: "schedules"/)
  expect(app).toMatch(/<ScheduledTasksPage[^>]*v-if="route.name === 'schedules'"/)
  expect(sidebar).toMatch(/@click="emit\('schedules'\)"/)
  expect(sidebar).not.toMatch(/ScheduledTasksDialog/)
  expect(page).toMatch(/<TimeFieldRoot[^>]*v-model="timeValue"/)
  expect(page).toMatch(
    /<SelectItem v-for="path in projects"[^>]*>\s*{{\s*workspace\.projectName\(path\)\s*}}<\/SelectItem>/,
  )
  expect(page.indexOf("schedules.prompt") > page.indexOf('id="schedule-thinking"')).toBeTruthy()
})

test("scheduled runs get unique Pix-owned runtimes and publish before prompting", () => {
  const source = readFileSync(new URL("../src-tauri/src/schedules.rs", import.meta.url), "utf8")
  expect(source).toMatch(/let id = format!\("schedule-\{}", uuid::Uuid::new_v4\(\)\);/)
  expect(
    source.indexOf('"type": "scheduled_session_created"') <
      source.indexOf('json!({"type":"prompt", "message":input.prompt})'),
  ).toBeTruthy()
  expect(source).toMatch(/current\.session_file = Some\(file\.clone\(\)\);[\s\S]*persist\(&updated\)\.await\?;/)
  expect(source).toMatch(/notify_schedules_changed\(app\);[\s\S]*published = true/)
})

test("scheduled workers remain visible to Pix while retaining their backend event channel", () => {
  const source = readFileSync(new URL("../src-tauri/src/rpc.rs", import.meta.url), "utf8")
  const emit = source.slice(source.indexOf("fn emit_process_event"), source.indexOf("const CREATE_NO_WINDOW"))
  expect(emit).toMatch(/pi:\/\/schedule-/)
  expect(emit).toMatch(/crate::remote::emit\(app, event, payload\)/)
  const list = source.slice(source.indexOf("pub async fn list"), source.indexOf("pub(crate) async fn set_session_name"))
  expect(list).not.toMatch(/starts_with\("schedule-"\)/)
})
