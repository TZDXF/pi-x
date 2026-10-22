import { expect, test } from "vitest"
import { revealEditorCaret } from "../src/lib/composerCaret"

function fixture(rects = [{ top: 210, bottom: 230, height: 20 }]) {
  const node = { nodeType: 1, childNodes: [{}] }
  const range = {
    setStart() {},
    collapse() {},
    selectNode() { rects = [{ top: 210, bottom: 230, height: 20 }] },
    getClientRects: () => rects,
  }
  const root = {
    ownerDocument: {
      activeElement: null as unknown,
      getSelection: () => ({ focusNode: node, focusOffset: 0 }),
      createRange: () => range,
    },
    contains: () => true,
    getBoundingClientRect: () => ({ top: 0 }),
    clientTop: 0,
    clientHeight: 192,
    scrollTop: 100,
  }
  root.ownerDocument.activeElement = root
  return root
}

test("reveals the caret after a paste below the viewport", () => {
  const root = fixture()
  revealEditorCaret(root as unknown as HTMLElement)
  expect(root.scrollTop).toBe(146)
})

test("measures the next BR for a collapsed caret on an empty line", () => {
  const root = fixture([])
  revealEditorCaret(root as unknown as HTMLElement)
  expect(root.scrollTop).toBe(146)
})

test("reveals a caret above the viewport rather than jumping to the end", () => {
  const root = fixture([{ top: -12, bottom: 8, height: 20 }])
  revealEditorCaret(root as unknown as HTMLElement)
  expect(root.scrollTop).toBe(80)
})

test("leaves visible carets and unfocused editors alone", () => {
  const root = fixture([{ top: 20, bottom: 40, height: 20 }])
  revealEditorCaret(root as unknown as HTMLElement)
  expect(root.scrollTop).toBe(100)
  root.ownerDocument.activeElement = null
  revealEditorCaret(root as unknown as HTMLElement)
  expect(root.scrollTop).toBe(100)
})
