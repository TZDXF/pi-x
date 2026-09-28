<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { Markdown } from "vue-stream-markdown"
import MessageResponse from "@/components/ai-elements/message/MessageResponse.vue"

const sample = `先让这段文字完成淡入，然后继续追加下一批文字。这里混合 English streaming Markdown，观察已经显示的文字是否再次闪烁。\n\n第二段包含 **逐步补全的加粗文字**，还有 \`inline code\` 和 [链接](https://example.com)。\n\n- 列表第一项：中文文字逐步追加。\n- 列表第二项：streamingAnimationIdentifier 持续补全。\n\n最后一段：之前的内容应该保持稳定，只有新增文字需要淡入。`
const source = ref(sample)
const renderMode = ref("0")
const detailed = ref(false)
const autoScroll = ref(true)
let resizeObserver: ResizeObserver | undefined
let scrollFrame = 0
function scheduleScroll() {
  if (!autoScroll.value || scrollFrame) return
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0
    if (!autoScroll.value) return
    // Batch geometry reads before writes. Do not queue smooth-scroll animations.
    const targets = Array.from(root.value?.querySelectorAll<HTMLElement>(".output") ?? []).map(el => ({
      el,
      bottom: el.scrollHeight - el.clientHeight,
    }))
    for (const { el, bottom } of targets) el.scrollTop = Math.max(0, bottom)
  })
}
const preload = ref(false)
const metrics = ref({ frames: 0, slowFrames: 0, maxFrame: 0, longTasks: 0, maxTask: 0 })
const activeColumns = computed(() => (renderMode.value === "all" ? [0, 1, 2] : [Number(renderMode.value)]))
let measuringUntil = 0
let lastFrame = 0
let lastPublish = 0
let counters = { frames: 0, slowFrames: 0, maxFrame: 0, longTasks: 0, maxTask: 0 }
let performanceObserver: PerformanceObserver | undefined
const longTaskSupported = ref(false)

function loadPreset(size: number) {
  stop()
  const sections: string[] = []
  let length = 0
  while (length < size) {
    const section =
      "\n\n### 第 " +
      (sections.length + 1) +
      " 节：长文本更新\n\n" +
      sample +
      "\n\n| 场景 | 观察点 |\n| --- | --- |\n| 持续输出 | 已显示文字是否稳定 |\n| 分批暂停 | 淡入完成后是否闪烁 |\n" +
      '\n\n~~~typescript\nconst message = "streaming test";\nconsole.log(message);\n~~~\n'
    sections.push(section)
    length += section.length
  }
  source.value = size === 230 ? sample : sections.join("").slice(0, size)
  chunkSize.value = size === 230 ? 8 : 128
  delay.value = size === 230 ? 90 : 32
  burstPause.value = size === 230 ? 900 : 0
  void reset()
}
const content = ref("")
const chunkSize = ref(8)
const delay = ref(90)
const burstPause = ref(900)
const running = ref(false)
const finished = ref(false)
const step = ref(0)
const epoch = ref(0)
const root = ref<HTMLElement>()
const logs = ref<string[]>([])
const stats = ref([
  { drops: 0, removed: 0 },
  { drops: 0, removed: 0 },
  { drops: 0, removed: 0 },
])
const labels = ["原淡入行为 MessageResponse", "关闭文字淡入", "保留淡入 · 按字符拆分"]
let timer: ReturnType<typeof setTimeout> | undefined
let frame = 0
let observer: MutationObserver | undefined
let seen = new WeakMap<Element, { settled: boolean; text: string; column: number }>()
let started = 0
let position = 0
let chunks: string[] = []

function record(column: number, message: string) {
  logs.value = [
    `${((performance.now() - started) / 1000).toFixed(2)}s [${labels[column]}] ${message}`,
    ...logs.value,
  ].slice(0, 70)
}
function sampleOpacity(now: number) {
  if (now <= measuringUntil && !document.hidden && lastFrame) {
    const gap = now - lastFrame
    counters.frames++
    if (gap > 50) counters.slowFrames++
    counters.maxFrame = Math.max(counters.maxFrame, gap)
  }
  lastFrame = document.hidden ? 0 : now
  if (now - lastPublish > 500) {
    metrics.value = { ...counters }
    lastPublish = now
  }
  if (detailed.value)
    root.value?.querySelectorAll<HTMLElement>("[data-column]").forEach(column => {
      const index = Number(column.dataset.column)
      column
        .querySelectorAll<HTMLElement>(
          '[data-stream-markdown="text"], [data-stream-markdown="text-char"], [data-stream-markdown="text-word"]',
        )
        .forEach(el => {
          const opacity = Number(getComputedStyle(el).opacity)
          const text = el.textContent ?? ""
          const previous = seen.get(el)
          // A newly inserted node fading in is normal, not a regression.
          if (previous?.settled && previous.text === text && opacity < 0.9) {
            stats.value[index]!.drops++
            record(index, `已显示节点透明度回落到 ${opacity.toFixed(2)}：${text.slice(0, 32)}`)
          }
          seen.set(el, { settled: opacity >= 0.98, text, column: index })
        })
    })
  frame = requestAnimationFrame(sampleOpacity)
}
function stop() {
  clearTimeout(timer)
  running.value = false
  measuringUntil = performance.now() + 1000
  metrics.value = { ...counters }
}
function tick() {
  if (!running.value) return
  const count = Math.max(1, Math.min(2048, Math.floor(Number(chunkSize.value) || 8)))
  content.value += chunks.slice(position, position + count).join("")
  position += count
  step.value++
  if (position >= chunks.length) {
    stop()
    finished.value = true
    return
  }
  // Let the fade finish before the next burst: matches the reported symptom.
  timer = setTimeout(tick, step.value % 5 === 0 && burstPause.value > 0 ? burstPause.value : delay.value)
}
async function reset() {
  stop()
  content.value = ""
  finished.value = false
  step.value = 0
  position = 0
  epoch.value++
  await nextTick()
  seen = new WeakMap()
  stats.value = labels.map(() => ({ drops: 0, removed: 0 }))
  logs.value = []
  started = performance.now()
  measuringUntil = 0
  lastFrame = 0
  counters = { frames: 0, slowFrames: 0, maxFrame: 0, longTasks: 0, maxTask: 0 }
  metrics.value = { ...counters }
}
async function replay() {
  await reset()
  chunkSize.value = Math.max(1, Math.min(2048, Math.floor(Number(chunkSize.value) || 8)))
  delay.value = Math.max(16, Number(delay.value) || 90)
  burstPause.value = Math.max(0, Number(burstPause.value) || 0)
  chunks = Array.from(source.value)
  if (preload.value) {
    position = Math.floor(chunks.length * 0.8)
    content.value = chunks.slice(0, position).join("")
    await nextTick()
  }
  measuringUntil = Infinity
  running.value = true
  lastFrame = 0
  tick()
}
function resume() {
  if (finished.value || !step.value) {
    void replay()
    return
  }
  measuringUntil = Infinity
  running.value = true
  tick()
}
onMounted(() => {
  // Observe actual Markdown layout, including asynchronous parsing and code blocks.
  resizeObserver = new ResizeObserver(scheduleScroll)
  watch(
    [epoch, renderMode],
    () => {
      resizeObserver?.disconnect()
      root.value?.querySelectorAll<HTMLElement>(".output, .output-body").forEach(el => resizeObserver?.observe(el))
      scheduleScroll()
    },
    { immediate: true, flush: "post" },
  )
  watch(autoScroll, scheduleScroll)
  longTaskSupported.value = PerformanceObserver.supportedEntryTypes?.includes("longtask") ?? false
  if (longTaskSupported.value) {
    performanceObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (entry.startTime < started || entry.startTime > measuringUntil) continue
        counters.longTasks++
        counters.maxTask = Math.max(counters.maxTask, entry.duration)
      }
    })
    performanceObserver.observe({ entryTypes: ["longtask"] })
  }
  observer = new MutationObserver(records => {
    if (!detailed.value) return
    for (const mutation of records)
      for (const node of mutation.removedNodes) {
        if (!(node instanceof Element)) continue
        for (const el of [
          node,
          ...node.querySelectorAll(
            '[data-stream-markdown="text"], [data-stream-markdown="text-char"], [data-stream-markdown="text-word"]',
          ),
        ]) {
          const previous = seen.get(el)
          if (previous?.settled && previous.text.trim()) {
            stats.value[previous.column]!.removed++
            record(previous.column, `已显示节点被移除（格式变化也可能导致）：${previous.text.slice(0, 32)}`)
          }
        }
      }
  })
  watch(
    detailed,
    enabled => {
      observer?.disconnect()
      seen = new WeakMap()
      if (enabled && root.value) observer?.observe(root.value, { childList: true, subtree: true })
    },
    { immediate: true },
  )
  frame = requestAnimationFrame(sampleOpacity)
})
onBeforeUnmount(() => {
  stop()
  cancelAnimationFrame(frame)
  observer?.disconnect()
  performanceObserver?.disconnect()
  resizeObserver?.disconnect()
  cancelAnimationFrame(scrollFrame)
})
</script>

<template>
  <main class="demo">
    <header>
      <span class="eyebrow">PI-X / STREAMING LAB</span>
      <h1>流式文字闪烁诊断</h1>
      <p>长文本压力测试：默认单组件渲染、关闭逐节点扫描，减少测试工具自身干扰。无需连接 AI。</p>
    </header>
    <section class="controls">
      <button @click="loadPreset(230)">短样例</button>
      <button @click="loadPreset(20000)">2 万字符</button>
      <button @click="loadPreset(50000)">5 万字符</button>
      <button @click="loadPreset(100000)">10 万字符</button>
      <label
        >渲染组
        <select v-model="renderMode" :disabled="running" @change="reset">
          <option value="0">原淡入行为（单组）</option>
          <option value="1">关闭淡入（单组）</option>
          <option value="2">字符淡入（单组）</option>
          <option value="all">三组同时（负载叠加）</option>
        </select></label
      >
      <label><input v-model="autoScroll" type="checkbox" />自动滚动到底（取消后可查看上文）</label>
      <label><input v-model="preload" type="checkbox" :disabled="running" />预填 80%，只流式追加尾部</label>
      <label><input v-model="detailed" type="checkbox" :disabled="running" />逐节点诊断（大文本会显著增加开销）</label>
    </section>
    <section class="controls">
      <label>每批字符 <input v-model.number="chunkSize" type="number" min="1" max="2048" :disabled="running" /></label>
      <label>批间隔 ms <input v-model.number="delay" type="number" min="16" :disabled="running" /></label>
      <label>段间暂停 ms <input v-model.number="burstPause" type="number" min="0" :disabled="running" /></label>
      <button @click="replay">重新播放</button
      ><button @click="running ? stop() : resume()">{{ running ? "暂停" : "继续" }}</button>
      <span role="status"
        >{{ finished ? "播放完成" : running ? "流式输出中" : "已暂停" }} · {{ step }} 批 ·
        {{ content.length }} 字符</span
      >
    </section>
    <section class="performance" aria-label="性能统计">
      <span>源文本 {{ source.length.toLocaleString() }} 字符</span>
      <span>采样帧 {{ metrics.frames }}</span
      ><span>帧间隔 &gt;50ms：{{ metrics.slowFrames }}</span>
      <span>最大帧间隔 {{ metrics.maxFrame.toFixed(1) }}ms</span>
      <span>长任务 {{ longTaskSupported ? metrics.longTasks : "浏览器不支持" }}</span>
      <span>最长任务 {{ metrics.maxTask.toFixed(1) }}ms</span>
      <p>
        帧间隔只在播放期间及停止后 1
        秒、页面前台时统计；长任务是整页主线程指标，不等于渲染器耗时。预填本身也有初始渲染成本；三组同跑不能做独立性能比较。
      </p>
    </section>
    <details>
      <summary>编辑测试内容（可粘贴实际出现闪烁的回复）</summary>
      <textarea v-model="source" :disabled="running" />
    </details>
    <div ref="root" class="columns" :class="{ single: activeColumns.length === 1 }">
      <section v-for="index in activeColumns" :key="index" class="panel">
        <h2>{{ labels[index] }}</h2>
        <p>默认自动跟随输出末尾；取消自动滚动可查看上文。先从 2 万字符开始，避免直接加载 10 万字符。</p>
        <p v-if="detailed" class="metrics">
          透明度回落 <b>{{ stats[index]!.drops }}</b> · 已显示节点移除 <b>{{ stats[index]!.removed }}</b>
        </p>
        <div :key="epoch" :data-column="index" class="output">
          <div class="output-body">
            <MessageResponse v-if="index === 0" :content="content" :enable-animate="true" />
            <Markdown v-else-if="index === 1" :content="content" :enable-animate="false" />
            <Markdown v-else :content="content" animation-split="char" />
          </div>
        </div>
      </section>
    </div>
    <section class="events">
      <h2>诊断记录</h2>
      <p>
        只观察当前节点自身的透明度和已显示节点移除；节点移除不一定等于闪烁，父级样式与布局抖动也可能漏检。请结合肉眼对比。
      </p>
      <pre>{{
        detailed
          ? logs.join("\n") || "暂无异常事件。点击「重新播放」开始。"
          : "逐节点诊断已关闭，当前仅进行低开销性能采样。"
      }}</pre>
    </section>
  </main>
</template>

<style scoped>
.demo {
  max-width: 1500px;
  margin: auto;
  padding: 32px;
  color: #e4e4e7;
  background: #111318;
  min-height: 100vh;
  font-family: system-ui, sans-serif;
}
.eyebrow {
  color: #7dd3fc;
  font-size: 12px;
  letter-spacing: 2px;
}
h1 {
  font-size: 28px;
  margin: 8px 0;
  font-weight: 650;
}
h2 {
  font-size: 16px;
  font-weight: 600;
}
p,
summary {
  color: #a1a1aa;
  font-size: 13px;
}
.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
  margin: 24px 0;
  font-size: 13px;
}
input {
  width: 75px;
  margin-left: 8px;
  padding: 6px;
}
input,
textarea,
button {
  border: 1px solid #3f4552;
  border-radius: 6px;
  background: #20242d;
  color: #fafafa;
}
button {
  padding: 8px 16px;
  cursor: pointer;
}
button:first-of-type {
  background: #155e75;
}
textarea {
  width: 100%;
  min-height: 150px;
  padding: 12px;
  margin-top: 12px;
}
.columns.single {
  grid-template-columns: minmax(0, 1fr);
}
.performance {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  padding: 14px;
  background: #20242d;
  border-radius: 8px;
  font-size: 13px;
}
.performance p {
  flex-basis: 100%;
}
select {
  background: #20242d;
  color: white;
  padding: 6px;
}
input[type="checkbox"] {
  width: auto;
}
.columns {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  margin: 20px 0;
}
.panel {
  border: 1px solid #343945;
  border-radius: 12px;
  padding: 18px;
  min-width: 0;
  background: #181b22;
}
.metrics {
  margin: 8px 0 20px;
}
.metrics b {
  color: #7dd3fc;
}
.output-body {
  display: flow-root;
}
.output {
  overflow-anchor: none;
  scroll-behavior: auto;
  scrollbar-gutter: stable;
  min-height: 330px;
  max-height: 55vh;
  overflow-y: auto;
  font-size: 14px;
  overflow-wrap: anywhere;
  color-scheme: dark;
}
.events pre {
  white-space: pre-wrap;
  max-height: 260px;
  overflow: auto;
  font-size: 12px;
  padding-top: 12px;
}
.events p {
  margin-top: 8px;
}
@media (max-width: 900px) {
  .columns {
    grid-template-columns: 1fr;
  }
  .demo {
    padding: 16px;
  }
}
</style>
