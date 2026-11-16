import { expect, test } from "vitest"
import * as vue from "vue"
import { renderToString } from "vue/server-renderer"
import { compileScript, parse } from "vue/compiler-sfc"
import ts from "typescript"
import { chatSource } from "./fixtures/chatSources"

const { descriptor } = parse(chatSource("components/ai-elements/message/MessageResponse.vue"))
const compiled = compileScript(descriptor, { id: "message-response-mode", inlineTemplate: true })
const code = ts.transpileModule(compiled.content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const imports = {
  vue,
  "@/lib/utils": { cn: () => "" },
  "@/lib/linkOptions": { markdownLinkOptions: {} },
  "vue-stream-markdown/index.css": {},
  "vue-stream-markdown": {
    Markdown: vue.defineComponent({
      props: ["mode", "content"],
      setup: props => () => vue.h("div", { "data-mode": props.mode }, props.content),
    }),
  },
}
const exports = {} as any
new Function("exports", "require", code)(exports, id => imports[id])

test("completed and historical markdown is static regardless of animation", async () => {
  for (const streaming of [undefined, false, true]) {
    for (const animate of [false, true]) {
      const html = await renderToString(
        vue.createSSRApp(exports.default, {
          content: "| 环境 | 路径 |\n| --- | --- |\n| dev | localhost |",
          streaming,
          "enable-animate": animate,
        }),
      )
      expect(html).toContain(`data-mode="${streaming ? "streaming" : "static"}"`)
      expect(html).toContain("localhost")
    }
  }
})

test("assistant turns forward completion independently of animation", () => {
  expect(chatSource("components/chat/ChatAssistantTurn.vue")).toContain(':streaming="!entry.complete"')
  expect(chatSource("components/AssistantBlocks.vue")).toContain(':streaming="props.streaming"')
})
