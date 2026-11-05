import { afterEach, expect, test, vi } from "vitest"
import { effectScope, nextTick, ref } from "vue"
import { useKanbanCardSorting } from "@/composables/useKanbanCardSorting"
import { groupKanbanCards, kanbanColumnOrderKey, moveKanbanCard, type KanbanCard } from "@/lib/kanban"

function card(id: string, overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id,
    project: "root",
    projectName: "Project",
    title: id,
    preview: id,
    updatedAt: 100,
    status: "todo",
    ...overrides,
  }
}
const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))

function harness() {
  const cards = ref([card("a"), card("b"), card("c"), card("running", { status: "running" })])
  const scope = ref("")
  const blocked = ref(false)
  const reorder = vi.fn()
  const startDraft = vi.fn()
  const owner = effectScope()
  scopes.push(owner)
  const sort = owner.run(() =>
    useKanbanCardSorting(
      () => groupKanbanCards(cards.value),
      () => scope.value,
      () => blocked.value,
      reorder,
      startDraft,
    ),
  )!
  return { sort, cards, scope, blocked, reorder, startDraft }
}
function dragEvent(y = 0) {
  return {
    clientY: y,
    preventDefault: vi.fn(),
    dataTransfer: { effectAllowed: "none", dropEffect: "none", setData: vi.fn() },
    currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 100 }) },
    target: { closest: () => null },
  } as unknown as DragEvent
}

test("manual order is scoped by project/column, ignores stale IDs, and gives new arrivals priority", () => {
  const cards = [card("a"), card("b"), card("new"), card("running", { status: "running" })]
  const order = { [kanbanColumnOrderKey("", "todo")]: ["removed", "b", "a"] }
  expect(groupKanbanCards(cards, order).todo.map(card => card.id)).toEqual(["new", "b", "a"])
  expect(groupKanbanCards(cards, order, "root").todo.map(card => card.id)).toEqual(["a", "b", "new"])
  expect(groupKanbanCards(cards, order).running.map(card => card.id)).toEqual(["running"])
  expect(cards.map(card => card.id)).toEqual(["a", "b", "new", "running"])
})

test("draft ordering survives binding to a real session and is unaffected by activity timestamps", () => {
  const cards = [card("session", { draftId: "one", updatedAt: 999 }), card("other")]
  const order = { [kanbanColumnOrderKey("", "todo")]: ["other", "draft:one"] }
  expect(groupKanbanCards(cards, order).todo.map(card => card.id)).toEqual(["other", "session"])
})

test("moving visible cards retains every paginated peer and rejects invalid/cross-column targets", () => {
  const cards = Array.from({ length: 65 }, (_, index) => card(String(index)))
  expect(moveKanbanCard(cards, "0", "29", true)).toEqual([
    ...cards.slice(1, 30).map(card => card.id),
    "0",
    ...cards.slice(30).map(card => card.id),
  ])
  expect(moveKanbanCard(cards, "0", "1", false)).toBeNull()
  expect(moveKanbanCard(cards, "missing", "1", true)).toBeNull()
  expect(moveKanbanCard([card("a"), card("b", { status: "idle" })], "a", "b", true)).toBeNull()
})

test("dragging within a column emits only a reordered ID list", () => {
  const { sort, cards, reorder } = harness()
  sort.startDrag(dragEvent(), cards.value[0])
  const over = dragEvent(90)
  sort.overCard(over, cards.value[1])
  expect(over.preventDefault).toHaveBeenCalledOnce()
  sort.drop(dragEvent(), "todo")
  expect(reorder).toHaveBeenCalledExactlyOnceWith("todo", ["b", "a", "c"])
  expect(sort.source.value).toBeNull()
  expect(cards.value.map(card => card.status)).toEqual(["todo", "todo", "todo", "running"])
})

test("dropping in column whitespace appends without changing other columns", () => {
  const { sort, cards, reorder } = harness()
  sort.startDrag(dragEvent(), cards.value[0])
  sort.overColumn(dragEvent(), "todo")
  sort.drop(dragEvent(), "todo")
  expect(reorder).toHaveBeenCalledExactlyOnceWith("todo", ["b", "c", "a"])
})

test("dragging a draft onto running starts it without manually changing its status or order", () => {
  const { sort, cards, reorder, startDraft } = harness()
  cards.value[0]!.draftId = "draft-a"
  sort.startDrag(dragEvent(), cards.value[0])
  const over = dragEvent()
  sort.overColumn(over, "running")
  expect(over.preventDefault).toHaveBeenCalledOnce()
  sort.drop(dragEvent(), "running")
  expect(startDraft).toHaveBeenCalledExactlyOnceWith(cards.value[0])
  expect(reorder).not.toHaveBeenCalled()
  expect(sort.source.value).toBeNull()
  expect(cards.value.map(card => card.status)).toEqual(["todo", "todo", "todo", "running"])
})

test("a draft can be dropped over a running card, but a stale source cannot start", () => {
  const { sort, cards, reorder, startDraft } = harness()
  cards.value[0]!.draftId = "draft-a"
  sort.startDrag(dragEvent(), cards.value[0])
  const over = dragEvent(90)
  sort.overCard(over, cards.value[3]!)
  expect(over.preventDefault).toHaveBeenCalledOnce()
  sort.drop(dragEvent(), "running")
  expect(startDraft).toHaveBeenCalledOnce()

  sort.startDrag(dragEvent(), cards.value[0])
  cards.value[0]!.status = "waiting"
  sort.drop(dragEvent(), "running")
  expect(startDraft).toHaveBeenCalledOnce()
  expect(reorder).not.toHaveBeenCalled()
})

test("external drops, cross-column drops, and status changes during a drag cannot reorder", () => {
  const { sort, cards, reorder } = harness()
  sort.drop(dragEvent(), "todo")
  sort.startDrag(dragEvent(), cards.value[0])
  sort.overCard(dragEvent(90), cards.value[1])
  sort.drop(dragEvent(), "running")
  sort.startDrag(dragEvent(), cards.value[0])
  sort.overCard(dragEvent(90), cards.value[1])
  cards.value[0].status = "running"
  sort.drop(dragEvent(), "todo")
  expect(reorder).not.toHaveBeenCalled()
})

test("project switches and hard navigation guards cancel pending drags", async () => {
  const { sort, cards, scope, blocked, reorder } = harness()
  sort.startDrag(dragEvent(), cards.value[0])
  sort.overCard(dragEvent(90), cards.value[1])
  scope.value = "root"
  await nextTick()
  sort.drop(dragEvent(), "todo")
  sort.startDrag(dragEvent(), cards.value[0])
  blocked.value = true
  await nextTick()
  expect(sort.source.value).toBeNull()
  sort.drop(dragEvent(), "todo")
  const event = dragEvent()
  sort.startDrag(event, cards.value[0])
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(reorder).not.toHaveBeenCalled()
})

test("Alt and arrow keys reorder peers while ordinary arrows and boundaries do nothing", () => {
  const { sort, cards, reorder } = harness()
  const event = (key: string, altKey = true) => ({ key, altKey, preventDefault: vi.fn() }) as unknown as KeyboardEvent
  sort.moveWithKeyboard(event("ArrowUp"), cards.value[0])
  sort.moveWithKeyboard(event("ArrowDown", false), cards.value[0])
  expect(reorder).not.toHaveBeenCalled()
  sort.moveWithKeyboard(event("ArrowDown"), cards.value[0])
  expect(reorder).toHaveBeenCalledExactlyOnceWith("todo", ["b", "a", "c"])
})
