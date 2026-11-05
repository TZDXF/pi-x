import { afterEach, expect, test, vi } from "vitest"
import { effectScope, nextTick, ref } from "vue"
import { useKanbanColumnSorting } from "@/composables/useKanbanColumnSorting"
import { KANBAN_COLUMNS, moveKanbanColumn, orderKanbanColumns, type KanbanStatus } from "@/lib/kanban"

const defaults = KANBAN_COLUMNS.map(column => column.id)
const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))

function harness() {
  const columns = ref<KanbanStatus[]>([...defaults])
  const blocked = ref(false)
  const reorder = vi.fn()
  const owner = effectScope()
  scopes.push(owner)
  const sort = owner.run(() => useKanbanColumnSorting(() => columns.value, () => blocked.value, reorder))!
  return { sort, columns, blocked, reorder }
}

function dragEvent(clientX = 0) {
  return {
    clientX,
    preventDefault: vi.fn(),
    dataTransfer: { effectAllowed: "none", dropEffect: "none", setData: vi.fn() },
    currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 100 }) },
  } as unknown as DragEvent
}

test("saved column order ignores invalid and duplicate entries and appends new statuses", () => {
  expect(orderKanbanColumns()).toEqual(defaults)
  expect(orderKanbanColumns(["idle", "invalid", "idle", "todo"])).toEqual([
    "idle",
    "todo",
    "running",
    "waiting",
    "completed",
  ])
})

test("moving columns handles either side and rejects missing or unchanged positions", () => {
  expect(moveKanbanColumn(defaults, "todo", "waiting", true)).toEqual([
    "running",
    "waiting",
    "todo",
    "completed",
    "idle",
  ])
  expect(moveKanbanColumn(defaults, "idle", "todo", false)).toEqual([
    "idle",
    "todo",
    "running",
    "waiting",
    "completed",
  ])
  expect(moveKanbanColumn(defaults, "todo", "todo", true)).toBeNull()
  expect(moveKanbanColumn(defaults, "todo", "running", false)).toBeNull()
})

test("heading drags reorder by horizontal position and external drops do nothing", () => {
  const { sort, reorder } = harness()
  sort.drop(dragEvent(), "idle")
  expect(reorder).not.toHaveBeenCalled()
  sort.startDrag(dragEvent(), "todo")
  const over = dragEvent(90)
  sort.overColumn(over, "waiting")
  expect(over.preventDefault).toHaveBeenCalledOnce()
  sort.drop(dragEvent(), "waiting")
  expect(reorder).toHaveBeenCalledExactlyOnceWith(["running", "waiting", "todo", "completed", "idle"])
  expect(sort.source.value).toBeNull()
  expect(sort.target.value).toBeNull()
})

test("blocking cancels drags and Alt plus horizontal arrows provide keyboard reordering", async () => {
  const { sort, blocked, reorder } = harness()
  sort.startDrag(dragEvent(), "todo")
  blocked.value = true
  await nextTick()
  sort.drop(dragEvent(), "waiting")
  expect(reorder).not.toHaveBeenCalled()
  expect(sort.source.value).toBeNull()

  blocked.value = false
  const event = (key: string, altKey = true) => ({ key, altKey, preventDefault: vi.fn() }) as unknown as KeyboardEvent
  sort.moveWithKeyboard(event("ArrowRight", false), "todo")
  sort.moveWithKeyboard(event("ArrowLeft"), "todo")
  expect(reorder).not.toHaveBeenCalled()
  sort.moveWithKeyboard(event("ArrowRight"), "todo")
  expect(reorder).toHaveBeenCalledExactlyOnceWith(["running", "todo", "waiting", "completed", "idle"])
})
