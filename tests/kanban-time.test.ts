import { describe, expect, test } from "vitest"
import { formatKanbanTime } from "@/lib/kanbanTime"
import zhCN from "@/i18n/locales/zh-CN"
import en from "@/i18n/locales/en"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const now = new Date(2026, 10, 4, 12, 0, 0, 0).getTime()

describe("formatKanbanTime", () => {
  test.each([
    ["zh-CN", zhCN.kanban.justNow],
    ["en", en.kanban.justNow],
  ])("%s uses the supplied just-now label below one minute, including small clock skew", (locale, justNow) => {
    for (const offset of [-59_999, -1, 0, 1, 59_999]) {
      expect(formatKanbanTime(now + offset, locale, now, justNow)).toBe(justNow)
    }
    expect(formatKanbanTime(now, locale, now, "custom label")).toBe("custom label")
  })

  test("both language packs provide the just-now label", () => {
    expect(zhCN.kanban.justNow).toBe("刚刚")
    expect(en.kanban.justNow).toBe("Just now")
  })

  test.each([
    [-MINUTE, "1分钟前", "1 minute ago"],
    [-2 * MINUTE + 1, "1分钟前", "1 minute ago"],
    [-2 * MINUTE, "2分钟前", "2 minutes ago"],
    [-HOUR + 1, "59分钟前", "59 minutes ago"],
    [-HOUR, "1小时前", "1 hour ago"],
    [-2 * HOUR + 1, "1小时前", "1 hour ago"],
    [-2 * HOUR, "2小时前", "2 hours ago"],
    [MINUTE, "1分钟后", "in 1 minute"],
    [2 * MINUTE - 1, "1分钟后", "in 1 minute"],
    [2 * MINUTE, "2分钟后", "in 2 minutes"],
    [HOUR - 1, "59分钟后", "in 59 minutes"],
    [HOUR, "1小时后", "in 1 hour"],
    [2 * HOUR, "2小时后", "in 2 hours"],
  ])("keeps direction and floors complete units at offset %i ms", (offset, chinese, english) => {
    expect(formatKanbanTime(now + offset, "zh-CN", now, "刚刚")).toBe(chinese)
    expect(formatKanbanTime(now + offset, "en", now, "Just now")).toBe(english)
  })

  test.each([
    [new Date(2026, 10, 3, 8, 5).getTime(), "昨天 08:05", "yesterday 08:05"],
    [new Date(2026, 10, 3, 23, 59).getTime(), "昨天 23:59", "yesterday 23:59"],
    [new Date(2026, 10, 3, 0, 0).getTime(), "昨天 00:00", "yesterday 00:00"],
    [new Date(2026, 10, 5, 8, 5).getTime(), "明天 08:05", "tomorrow 08:05"],
  ])("uses calendar yesterday/tomorrow and a 24-hour clock for %i", (timestamp, chinese, english) => {
    expect(formatKanbanTime(timestamp, "zh-CN", now, "刚刚")).toBe(chinese)
    expect(formatKanbanTime(timestamp, "en", now, "Just now")).toBe(english)
  })

  test("near-midnight minutes remain relative across a date boundary", () => {
    const midnightNow = new Date(2026, 10, 4, 0, 10).getTime()
    const timestamp = new Date(2026, 10, 3, 23, 50).getTime()
    expect(formatKanbanTime(timestamp, "zh-CN", midnightNow, "刚刚")).toBe("20分钟前")
    expect(formatKanbanTime(timestamp, "en", midnightNow, "Just now")).toBe("20 minutes ago")
  })

  test("yesterday follows the local calendar around daylight-saving changes", () => {
    const springNow = new Date(2026, 2, 9, 0, 30).getTime()
    const springYesterday = new Date(2026, 2, 8, 23, 0).getTime()
    const autumnNow = new Date(2026, 10, 2, 0, 30).getTime()
    const autumnYesterday = new Date(2026, 10, 1, 0, 5).getTime()
    expect(formatKanbanTime(springYesterday, "en", springNow, "Just now")).toBe("yesterday 23:00")
    expect(formatKanbanTime(autumnYesterday, "en", autumnNow, "Just now")).toBe("yesterday 00:05")
    expect(formatKanbanTime(new Date(2026, 2, 7, 23, 0).getTime(), "en", springNow, "Just now")).toBe("2 days ago")
    expect(formatKanbanTime(new Date(2026, 9, 31, 23, 0).getTime(), "en", autumnNow, "Just now")).toBe("2 days ago")
  })

  test.each([
    [new Date(2026, 10, 2, 23, 59).getTime(), "2天前", "2 days ago"],
    [new Date(2026, 9, 29, 0, 0).getTime(), "6天前", "6 days ago"],
    [new Date(2026, 10, 6, 0, 0).getTime(), "2天后", "in 2 days"],
    [new Date(2026, 10, 10, 23, 59).getTime(), "6天后", "in 6 days"],
  ])("uses calendar-day counts within a week for %i", (timestamp, chinese, english) => {
    expect(formatKanbanTime(timestamp, "zh-CN", now, "刚刚")).toBe(chinese)
    expect(formatKanbanTime(timestamp, "en", now, "Just now")).toBe(english)
  })

  test.each([
    [new Date(2026, 9, 28, 23, 59).getTime(), "10月28日", "Oct 28"],
    [new Date(2026, 10, 11, 0, 0).getTime(), "11月11日", "Nov 11"],
    [new Date(2026, 0, 2, 9, 0).getTime(), "1月2日", "Jan 2"],
    [new Date(2025, 11, 31, 23, 59).getTime(), "2025年12月31日", "Dec 31, 2025"],
    [new Date(2027, 0, 1, 0, 0).getTime(), "2027年1月1日", "Jan 1, 2027"],
  ])(
    "uses dates from seven calendar days onward and includes a different year for %i",
    (timestamp, chinese, english) => {
      expect(formatKanbanTime(timestamp, "zh-CN", now, "刚刚")).toBe(chinese)
      expect(formatKanbanTime(timestamp, "en", now, "Just now")).toBe(english)
    },
  )

  test("recent dates across New Year still use calendar yesterday and relative days", () => {
    const januaryNow = new Date(2027, 0, 1, 12, 0).getTime()
    expect(formatKanbanTime(new Date(2026, 11, 31, 8, 5).getTime(), "en", januaryNow, "Just now")).toBe(
      "yesterday 08:05",
    )
    expect(formatKanbanTime(new Date(2026, 11, 30, 8, 5).getTime(), "zh-CN", januaryNow, "刚刚")).toBe("2天前")
  })

  test.each([NaN, Infinity, -Infinity, 8_640_000_000_000_001, -8_640_000_000_000_001])(
    "returns null for an invalid timestamp or reference time: %s",
    invalid => {
      expect(formatKanbanTime(invalid, "zh-CN", now, "刚刚")).toBeNull()
      expect(formatKanbanTime(now, "en", invalid, "Just now")).toBeNull()
    },
  )

  test("accepts the Unix epoch and negative timestamps as valid millisecond values", () => {
    expect(formatKanbanTime(0, "en", 0, "Just now")).toBe("Just now")
    expect(formatKanbanTime(-MINUTE, "en", 0, "Just now")).toBe("1 minute ago")
  })
})
