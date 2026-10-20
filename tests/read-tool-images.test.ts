import { expect, test } from "vitest"
import { contentImages, contentText } from "@/lib/content"
import { toolCallGroups } from "@/lib/toolCallGroups"
import type { ToolCallBlock } from "@/stores/conversations"
import { chatSource } from "./fixtures/chatSources"

test("tool images preserve order and MIME types alongside text output", () => {
  const content = [
    { type: "text", text: "Read image" },
    { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
    { type: "image", mimeType: "image/jpeg", data: "d29ybGQ=" },
  ]
  expect(contentImages(content)).toEqual(["data:image/png;base64,aGVsbG8=", "data:image/jpeg;base64,d29ybGQ="])
  expect(contentText(content)).toBe("Read image")
})

test("empty, text-only and malformed results do not produce thumbnails", () => {
  for (const content of [undefined, null, "text", [], [null, {}, { type: "text", text: "hello" }]]) {
    expect(contentImages(content)).toEqual([])
  }
  expect(
    contentImages([
      { type: "image", data: "", mimeType: "image/png" },
      { type: "image", data: 123, mimeType: "image/png" },
      { type: "image", data: "abc", mimeType: "text/html" },
      { type: "image", data: "abc", mimeType: "image/png;foo" },
    ]),
  ).toEqual([])
})

test("standalone image reads split concise groups and remain visible in order", () => {
  const blocks: ToolCallBlock[] = ["bash", "read", "read", "bash"].map((name, index) => ({
    type: "toolCall",
    callId: String(index),
    name,
    argsText: "{}",
  }))
  expect([...toolCallGroups(blocks, block => block.name === "read")]).toEqual([
    [0, [blocks[0]]],
    [3, [blocks[3]]],
  ])
  expect([...toolCallGroups(blocks)]).toEqual([[0, blocks]])
})

test("live, final and restored results retain images and image reads have no expandable IO", () => {
  const events = chatSource("stores/session/events.ts")
  expect(events).toContain("run.outputImages = contentImages(ev.partialResult.content)")
  expect(events).toContain("if (ev.result) run.outputImages = contentImages(ev.result.content)")
  expect(chatSource("stores/session/history.ts")).toContain("outputImages: contentImages(msg.content)")
  const blocks = chatSource("components/AssistantBlocks.vue")
  const imageCard = blocks.slice(
    blocks.indexOf('v-else-if="block.type === \'toolCall\' && hasReadImages(block)"'),
    blocks.indexOf("<!-- other tools:"),
  )
  expect(imageCard).toContain("<ToolImageGallery")
  expect(imageCard).toContain("<ToolStatusBadge")
  expect(imageCard).not.toMatch(/<Tool(?:Header|Content|RunDetails)\b/)
  expect(blocks).toContain('<ToolRunDetails class="p-3" :input="block.argsText" :output="runFor(block)?.outputText" />')
  const gallery = chatSource("components/chat/ToolImageGallery.vue")
  expect(gallery).toContain('@click="preview = src"')
  expect(gallery).toContain(':src="preview"')
})
