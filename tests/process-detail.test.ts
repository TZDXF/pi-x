import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

const source = path => readFileSync(new URL(path, import.meta.url), "utf8")
const run = (code, context) =>
  vm.runInContext(ts.transpile(code, { target: ts.ScriptTarget.ES2022 }), vm.createContext(context))

function harness(storage) {
  const code =
    source("../src/lib/processDetail.ts")
      .replace(/^import .*$/gm, "")
      .replace(/^export /gm, "")
      // The HMR disposal block needs the real module runtime; it is irrelevant here.
      .replace(/if \(import\.meta\.hot\) \{[\s\S]*$/, "") +
    "\nglobalThis.processDetail = processDetail\n" +
    "globalThis.setProcessDetail = setProcessDetail\n"
  const context = {
    ref: value => ({ value }),
    readonly: value => value,
    localStorage: storage,
    window: { addEventListener() {} },
  }
  run(code, context)
  return context
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
  }
}

test("process detail defaults to detailed when nothing is stored", () => {
  const ctx = harness(memoryStorage())
  expect(ctx.processDetail.value).toBe("detailed")
})

test("a stored preference is picked up and writes persist it", () => {
  const storage = memoryStorage({ "pix.processDetail": "concise" })
  const ctx = harness(storage)
  expect(ctx.processDetail.value).toBe("concise")

  ctx.setProcessDetail("detailed")
  expect(ctx.processDetail.value).toBe("detailed")
  expect(storage.getItem("pix.processDetail")).toBe("detailed")

  ctx.setProcessDetail("concise")
  expect(ctx.processDetail.value).toBe("concise")
  expect(storage.getItem("pix.processDetail")).toBe("concise")
})

test("invalid values are ignored", () => {
  const storage = memoryStorage()
  const ctx = harness(storage)
  ctx.setProcessDetail("minimal")
  expect(ctx.processDetail.value).toBe("detailed")
  expect(storage.getItem("pix.processDetail")).toBe(null)
})

test("storage failures do not break the in-memory preference", () => {
  const ctx = harness({
    getItem: () => null,
    setItem: () => {
      throw new Error("quota")
    },
  })
  ctx.setProcessDetail("concise")
  expect(ctx.processDetail.value).toBe("concise")
})

test("concise mode hides thinking blocks in AssistantBlocks; detailed keeps them", () => {
  const blocks = source("../src/components/AssistantBlocks.vue")
  expect(blocks).toMatch(/block\.type === 'thinking' && displayDetail === 'detailed'/)

  const settings = source("../src/components/settings/RunConfigSettings.vue")
  expect(settings).toMatch(/:model-value="processDetail"/)
  expect(settings).toMatch(/setProcessDetail\(v as ProcessDetail\)/)
  expect(settings).toMatch(/<SelectItem value="detailed">/)
  expect(settings).toMatch(/<SelectItem value="concise">/)
})

test("concise mode shows a thinking status indicator only while thinking streams", () => {
  const blocks = source("../src/components/AssistantBlocks.vue")
  // Streaming thinking still surfaces a shimmer status so the run does not look idle;
  // completed thinking renders nothing in concise mode.
  expect(blocks).toMatch(/block\.type === 'thinking' && block\.streaming/)
})

test("concise tool groups precede all specialized renderers and expand with a local detailed override", () => {
  const blocks = source("../src/components/AssistantBlocks.vue")
  expect(blocks).toMatch(/props\.detail \?\? processDetail\.value/)
  expect(blocks).toMatch(/displayDetail === 'concise' && conciseGroups\.has\(i\)/)
  expect(blocks).toMatch(/<template v-else-if="block\.type === 'toolCall' && displayDetail === 'concise'"/)
  expect(blocks.indexOf("<ToolCallGroup")).toBeLessThan(blocks.indexOf("&& isBash(block)"))
  expect(blocks).toMatch(/detail="detailed"/)
  expect(blocks).toMatch(/@open-review="emit\('openReview', \$event\)"/)

  const group = source("../src/components/chat/ToolCallGroup.vue")
  expect(group).toMatch(/const expanded = ref\(false\)/)
  expect(group).toMatch(/:aria-expanded="expanded"/)
  expect(group).toMatch(/@click="expanded = !expanded"/)
  expect(group).toMatch(/<div v-if="expanded"[^>]*>\s*<slot \/>/)
  expect(group).toMatch(/v-if="status\.running"/)
  expect(group).toMatch(/v-if="status\.errors"/)
})
