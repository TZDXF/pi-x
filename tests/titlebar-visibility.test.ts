import { readFileSync } from "node:fs"
import { expect, test } from "vitest"

const source = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8")
const titlebar = source.match(/<WindowTitleBar\s[\s\S]*?\/>/)![0]

function visibility(state: Record<string, unknown>) {
  const evaluate = (prop: string) => {
    const expression = titlebar.match(new RegExp(`:${prop}="([^"]+)"`))![1]
    return new Function(...Object.keys(state), `return (${expression})`)(...Object.values(state))
  }
  return {
    rightSidebar: evaluate("show-right-sidebar"),
    openInEditor: evaluate("show-open-in-editor"),
  }
}

const chat = {
  phase: "chat",
  route: { name: "session" },
  showKanban: false,
  board: { detailsOpen: false, selectedCard: null },
  boardSelectionReady: true,
}

test("ordinary chat keeps both titlebar actions available", () => {
  expect(visibility(chat)).toEqual({ rightSidebar: true, openInEditor: true })
})

test.each([
  { detailsOpen: false, selectedCard: null, ready: true, openInEditor: false },
  { detailsOpen: false, selectedCard: { id: "previous" }, ready: true, openInEditor: false },
  { detailsOpen: true, selectedCard: null, ready: true, openInEditor: false },
  { detailsOpen: true, selectedCard: { id: "selected" }, ready: false, openInEditor: false },
  { detailsOpen: true, selectedCard: { id: "selected" }, ready: true, openInEditor: true },
])("board titlebar follows the visible conversation: %j", ({ detailsOpen, selectedCard, ready, openInEditor }) => {
  expect(
    visibility({ ...chat, showKanban: true, board: { detailsOpen, selectedCard }, boardSelectionReady: ready }),
  ).toEqual({ rightSidebar: false, openInEditor })
})

test.each(["settings", "schedules"])("%s hides both titlebar actions", name => {
  expect(visibility({ ...chat, route: { name } })).toEqual({ rightSidebar: false, openInEditor: false })
})

test.each(["detecting", "pick", "no-pi", "trust", "down"])("%s hides both titlebar actions", phase => {
  expect(visibility({ ...chat, phase })).toEqual({ rightSidebar: false, openInEditor: false })
})
