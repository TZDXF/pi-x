import { beforeEach, expect, test } from "vitest"
import appSource from "@/App.vue?raw"
import { clear, enterSplit, splitAtEdge as realSplitAtEdge, isMember as realIsMember } from "@/stores/splitView"

beforeEach(() => {
  clear()
})

function extractHandleSplitDrop(
  ensureSessionForSplit: (file: string, path: string) => Promise<string | null>,
  ui: { pushToast: (message: string, kind: string) => void },
  t: (key: string) => string,
  activateSession: (runtimeId: string) => void,
) {
  const code = appSource
    .slice(appSource.indexOf("async function handleSplitDrop"), appSource.indexOf("function closeSplitPane"))
    .replace("payload: { file: string; path: string },", "payload,")
    .replace('zone: "left" | "right" | "top" | "bottom",', "zone,")
    .replace("targetRuntimeId: string,", "targetRuntimeId")
  return new Function(
    "ensureSessionForSplit",
    "splitAtEdge",
    "isMember",
    "ui",
    "t",
    "activateSession",
    `${code}\nreturn handleSplitDrop`,
  )(ensureSessionForSplit, realSplitAtEdge, realIsMember, ui, t, activateSession) as (
    payload: { file: string; path: string },
    zone: "left" | "right" | "top" | "bottom",
    targetRuntimeId: string,
  ) => Promise<void>
}

test("dropping a session that already belongs to a split warns and does not activate", async () => {
  enterSplit("primary", "secondary", "horizontal")
  const calls: unknown[] = []
  const handleSplitDrop = extractHandleSplitDrop(
    async () => "secondary",
    { pushToast: (...args: unknown[]) => calls.push(["toast", ...args]) },
    key => key,
    id => calls.push(["activate", id]),
  )

  await handleSplitDrop({ file: "a.jsonl", path: "C:\\w" }, "left", "primary")

  expect(calls).toEqual([["toast", "chat.toastAlreadyInSplit", "warning"]])
  expect(realIsMember("secondary")).toBe(true)
})

test("dropping a fresh session still joins the split without a toast", async () => {
  enterSplit("primary", "secondary", "horizontal")
  const calls: unknown[] = []
  const handleSplitDrop = extractHandleSplitDrop(
    async () => "newcomer",
    { pushToast: (...args: unknown[]) => calls.push(["toast", ...args]) },
    key => key,
    id => calls.push(["activate", id]),
  )

  await handleSplitDrop({ file: "a.jsonl", path: "C:\\w" }, "left", "primary")

  expect(calls).toEqual([["activate", "newcomer"]])
})

test("a failed session load stays silent because the loader already reported the error", async () => {
  const calls: unknown[] = []
  const handleSplitDrop = extractHandleSplitDrop(
    async () => null,
    { pushToast: (...args: unknown[]) => calls.push(["toast", ...args]) },
    key => key,
    id => calls.push(["activate", id]),
  )

  await handleSplitDrop({ file: "a.jsonl", path: "C:\\w" }, "left", "primary")

  expect(calls).toEqual([])
})
