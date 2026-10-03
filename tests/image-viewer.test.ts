import { afterEach, expect, test, vi } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"
import * as vue from "vue"

const scopes: vue.EffectScope[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))

// 与 resource-markdown-browser.test.ts 相同的源码级 harness：剥离 import，
// 用真实 Vue 响应式跑 <script setup>，通过 api 暴露指定顶层绑定（ref 自动解包）。
function setup(fields: string, props: Record<string, unknown> = {}) {
  const source = readFileSync(new URL("../src/components/ImageViewer.vue", import.meta.url), "utf8")
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]
    .replace(/^import[\s\S]*?from\s+["'][^"']+["']\n/gm, "")
    .replace(/^import\s+["'][^"']+["']\n/gm, "")
  const scope = vue.effectScope()
  scopes.push(scope)
  const context = vm.createContext({
    ...vue,
    defineProps: () => props,
    defineEmits: () => vi.fn(),
    useI18n: () => ({ t: (key: string) => key, locale: vue.ref("en") }),
  })
  scope.run(() =>
    vm.runInContext(
      ts.transpile(source + `\nglobalThis.api = { ${fields} };`, { target: ts.ScriptTarget.ES2022 }),
      context,
    ),
  )
  const raw = (context as { api: Record<string, unknown> }).api
  const api: Record<string, any> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (vue.isRef(value)) {
      Object.defineProperty(api, key, {
        get: () => value.value,
        set: next => {
          value.value = next
        },
      })
    } else {
      api[key] = value
    }
  }
  return api
}

test("image dimensions feed fit-to-window scale without upscaling past 1:1", () => {
  const api = setup("dims, vpW, vpH, fitScale, onImgLoad")
  api.onImgLoad({ target: { naturalWidth: 800, naturalHeight: 600 } })
  expect(api.dims).toEqual({ w: 800, h: 600 })
  // 视口足够大时不放大
  api.vpW = 1200
  api.vpH = 900
  expect(api.fitScale).toBe(1)
  // 视口较窄时等比取最小轴
  api.vpW = 400
  expect(api.fitScale).toBeCloseTo(0.5)
  // svg 未写尺寸时浏览器报 0，dims 置空等待 viewBox 回退
  api.onImgLoad({ target: { naturalWidth: 0, naturalHeight: 0 } })
  expect(api.dims).toBeNull()
})

test("wheel zoom keeps the cursor point anchored and clamps pan to the overflow", () => {
  const api = setup(
    "dims, scale, tx, ty, vpW, vpH, viewport, zoomAt, setFit, showActual, clampPan, pannable, onImgLoad",
  )
  api.onImgLoad({ target: { naturalWidth: 400, naturalHeight: 200 } })
  api.vpW = 200
  api.vpH = 200
  api.viewport = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 200 }) }

  // 适应窗口 0.5 → 中心放大 2 倍到 1:1：光标在中心，平移不动
  api.zoomAt(100, 100, 2)
  expect(api.scale).toBe(1)
  expect(api.tx).toBe(0)
  expect(api.ty).toBe(0)

  // 1:1 下继续放大：宽 400 超出视口 200，光标点下的图像位置保持不动
  api.zoomAt(0, 0, 2)
  expect(api.scale).toBe(2)
  expect(api.tx).toBe(100)
  expect(api.ty).toBe(100)
  expect(api.pannable).toBe(true)

  // 拖拽把图像拖远后，clampPan 只允许拖回溢出半宽内
  api.tx = 500
  api.ty = -500
  api.clampPan()
  expect(api.tx).toBe(300)
  expect(api.ty).toBe(-100)

  // 双击/工具条：适应窗口清空平移与缩放
  api.setFit()
  expect(api.scale).toBeNull()
  expect(api.tx).toBe(0)
  expect(api.pannable).toBe(false)
  // 实际大小回到 1:1（图像超出视口，可平移）
  api.showActual()
  expect(api.scale).toBe(1)
  expect(api.pannable).toBe(true)
})
