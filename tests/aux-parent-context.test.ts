import { useAimock } from "@copilotkit/aimock/vitest"
import { expect, test } from "vitest"
import {
  AUX_PARENT_CONTEXT_EMPTY_NOTICE,
  AUX_PARENT_CONTEXT_MAX_CHARS,
  AUX_PARENT_CONTEXT_TRUNCATED_NOTE,
  activeBranchEntries,
  auxMessagesFromEntries,
  auxMessagesFromMessages,
  buildAuxParentContext,
  groupAuxContextMessages,
  stripAuxParentContextBlock,
  truncateAuxContextGroups,
  withAuxParentContext,
  withoutAuxParentContext,
  type AuxContextMessage,
} from "@/lib/auxParentContext"
import { collectAuxParentContext } from "@/lib/auxContextCollect"
import { parseComposerPromptContexts, serializeComposerPromptContexts } from "@/lib/promptContexts"

/**
 * aux 父上下文取材与注入的核心契约（`docs/aux-chat-spec.md` §3/§4）。
 *
 * 三件必须能**失败**的事：
 * 1. 流式中父会话的"半轮"绝不进上下文（按已提交 entry 身份 + 本轮 realUser 锚点）；
 * 2. 三源（`get_entries` / `get_messages` / `session_history`）用同一套截断规则；
 * 3. 32k 上限按"最旧轮次组"整组丢弃，工具调用与结果不被拆散。
 *
 * 父会话的回答由 `@copilotkit/aimock` 的本机夹具产出（`tests/fixtures/ai/aux-context.json`），
 * 不访问任何真实模型服务。
 */
const getAi = useAimock({ fixtures: "tests/fixtures/ai" })

/** 向本机 aimock 请求一条父会话回答（确定性、无真实模型）。 */
async function mockParentReply(prompt: string): Promise<string> {
  const response = await fetch(`${getAi().url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "pix-test-model", messages: [{ role: "user", content: prompt }] }),
  })
  expect(response.ok).toBe(true)
  const completion = await response.json()
  return completion.choices[0].message.content
}

/** 父会话已提交的三轮（第三轮的 assistant 尚在流式 → 不在 entries 里）。 */
async function committedParentTurns() {
  const questions = ["父会话第一轮提问", "父会话第二轮提问", "父会话第三轮提问"]
  const answers = await Promise.all(questions.map(mockParentReply))
  return { questions, answers }
}

const user = (text: string, entryId?: string): AuxContextMessage => ({
  role: "user",
  text,
  ...(entryId ? { entryId } : {}),
})
const assistant = (text: string, entryId?: string): AuxContextMessage => ({
  role: "assistant",
  text,
  ...(entryId ? { entryId } : {}),
})

// ---- 1. 折叠块格式：组装 / 剥离互逆，且只认"整块" ----

test("the parent-context block sits before the question and strips back to the same bytes", () => {
  const prompt = serializeComposerPromptContexts("本轮的提问", {
    comments: [],
    selections: [],
    parentContext: "父会话内容",
  })
  expect(prompt.startsWith("<aux_parent_context>\n父会话内容\n</aux_parent_context>\n\n本轮的提问")).toBe(true)
  const parsed = parseComposerPromptContexts(prompt)
  expect(parsed.visibleContent).toBe("本轮的提问")
  expect(parsed.parentContext).toBe("父会话内容")
  expect(parsed.parentContextBlock).toBe("<aux_parent_context>\n父会话内容\n</aux_parent_context>")
  // 序列化与解析互逆：拿剥出来的原文再拼一次，字节必须一致。
  expect(withAuxParentContext(parsed.parentContextBlock, parsed.visibleContent)).toBe(prompt)
})

test("tail context blocks survive under the parent-context block", () => {
  const prompt = serializeComposerPromptContexts("提问", {
    comments: [{ path: "src/a.ts", startLine: 3, endLine: 4, selectedText: "code", comment: "这里" }],
    selections: [{ text: "引用" }],
    parentContext: "父会话内容",
  })
  const parsed = parseComposerPromptContexts(prompt)
  expect(parsed.visibleContent).toBe("提问")
  expect(parsed.parentContext).toBe("父会话内容")
  expect(parsed.selections).toHaveLength(1)
  expect(parsed.comments).toHaveLength(1)
})

test("only a whole leading block counts; inline mentions stay untouched", () => {
  // 正文里恰好写了标签（例如贴了一段文档）不能被当成块吞掉。
  expect(stripAuxParentContextBlock("提到 <aux_parent_context> 的文字")).toMatchObject({
    block: null,
    inner: "",
    rest: "提到 <aux_parent_context> 的文字",
  })
  // 开标签没有闭合标签：同样不算块。
  expect(stripAuxParentContextBlock("<aux_parent_context>\n没有闭合").block).toBeNull()
  // 空正文：只做 trim，不改变内容语义。
  expect(withoutAuxParentContext("普通提问")).toBe("普通提问")
})

// ---- 2. 三源同一：锚点排除"本轮之后"，身份过滤未提交条目 ----

test("三源同一: the last committed realUser is the anchor, later assistant/toolResult are excluded", () => {
  const messages: AuxContextMessage[] = [
    user("第一轮提问", "e1"),
    assistant("第一轮回答", "e2"),
    user("第二轮提问（本轮）", "e3"),
    // 半轮：流式中的助手回复与工具结果，还没有 entry 身份。
    assistant("还没提交的半截回答"),
    { role: "toolResult", text: "还没提交的工具结果", toolCallId: "call-x" },
  ]
  const streaming = buildAuxParentContext({ messages, streaming: true })
  expect(streaming.inner).toContain("第一轮回答")
  expect(streaming.inner).toContain("第二轮提问（本轮）")
  expect(streaming.inner).not.toContain("半截回答")
  expect(streaming.inner).not.toContain("还没提交的工具结果")
  // 可失败性：关掉 streaming 后同一份输入里那些消息就会被算进去（说明上一条断言
  // 真的依赖锚点逻辑，而不是"本来就为空"）。
  const idle = buildAuxParentContext({ messages, streaming: false })
  expect(idle.inner).toContain("半截回答")
})

test("三源同一: messages without an accepted entry identity are dropped even when live:false", () => {
  const messages: AuxContextMessage[] = [
    user("已提交提问", "e1"),
    assistant("已提交回答", "e2"),
    assistant("未接纳的回答", "e9"),
  ]
  const committedIds = new Set(["e1", "e2"])
  const result = buildAuxParentContext({ messages, streaming: false, committedIds })
  expect(result.inner).toContain("已提交回答")
  expect(result.inner).not.toContain("未接纳的回答")
})

test("三源同一: the three collectors produce byte-identical blocks for the same committed branch", async () => {
  const { questions, answers } = await committedParentTurns()
  // get_entries 的条目形状（pi 只追加已提交条目；第三轮 assistant 尚在流式，所以缺席）。
  const entries = [
    { id: "e1", type: "message", parentId: null, message: { role: "user", content: questions[0] } },
    {
      id: "e2",
      type: "message",
      parentId: "e1",
      message: { role: "assistant", content: [{ type: "text", text: answers[0] }] },
    },
    { id: "e3", type: "message", parentId: "e2", message: { role: "user", content: questions[1] } },
    {
      id: "e4",
      type: "message",
      parentId: "e3",
      message: { role: "assistant", content: [{ type: "text", text: answers[1] }] },
    },
    { id: "e5", type: "message", parentId: "e4", message: { role: "user", content: questions[2] } },
  ]
  const requests: string[] = []
  const deps = {
    request: async (command: Record<string, unknown>, runtimeId: string) => {
      requests.push(`${runtimeId}:${String(command.type)}`)
      if (command.type === "get_entries") return { success: true, data: { entries, leafId: "e5" } }
      // 投影（get_messages）里同样带着流式中的半轮，必须被锚点排除掉。
      return {
        success: true,
        data: {
          messages: [
            { role: "user", content: questions[0], _entryId: "e1" },
            { role: "assistant", content: [{ type: "text", text: answers[0] }], _entryId: "e2" },
            { role: "user", content: questions[1], _entryId: "e3" },
            { role: "assistant", content: [{ type: "text", text: answers[1] }], _entryId: "e4" },
            { role: "user", content: questions[2], _entryId: "e5" },
            { role: "assistant", content: [{ type: "text", text: "流式中半轮" }] },
          ],
        },
      }
    },
  }
  const input = { parentRuntimeId: "parent", streaming: true }
  const fromEntries = await collectAuxParentContext(deps, input)
  expect(fromEntries.source).toBe("entries")
  expect(fromEntries.inner).not.toContain("流式中半轮")
  // 父会话没有 sessionFile：兜底路径不参与，但主路径已经拿到内容。
  const fromFile = await collectAuxParentContext(
    {
      request: async () => ({ success: false, error: "get_entries unavailable" }),
      readHistory: async () => [
        { role: "user", content: questions[0] },
        { role: "assistant", content: [{ type: "text", text: answers[0] }] },
        { role: "user", content: questions[1] },
        { role: "assistant", content: [{ type: "text", text: answers[1] }] },
        { role: "user", content: questions[2] },
      ],
    },
    { ...input, sessionFile: "parent.jsonl" },
  )
  expect(fromFile.source).toBe("history")
  // 三源同一：同一份已提交分支渲染出的块**逐字节**一致（只有来源不同）。
  const entriesOnly = buildAuxParentContext({ messages: auxMessagesFromEntries(entries), streaming: true })
  const historyOnly = buildAuxParentContext({
    messages: auxMessagesFromMessages([
      { role: "user", content: questions[0] },
      { role: "assistant", content: [{ type: "text", text: answers[0] }] },
      { role: "user", content: questions[1] },
      { role: "assistant", content: [{ type: "text", text: answers[1] }] },
      { role: "user", content: questions[2] },
    ]),
    streaming: true,
  })
  expect(entriesOnly.inner).toBe(historyOnly.inner)
  // 取材只打父 runtime，绝不经过别的 runtime（aux 侧没有父会话）。
  expect(requests.every(call => call.startsWith("parent:"))).toBe(true)
})

test("已提交但文件暂不可读 / 读取竞态回落 get_entries，不降级为未取到父上下文", async () => {
  const { questions, answers } = await committedParentTurns()
  const collected = await collectAuxParentContext(
    {
      request: async (command: Record<string, unknown>) => {
        if (command.type === "get_entries")
          return {
            success: true,
            data: {
              entries: [
                { id: "e1", type: "message", parentId: null, message: { role: "user", content: questions[0] } },
                {
                  id: "e2",
                  type: "message",
                  parentId: "e1",
                  message: { role: "assistant", content: [{ type: "text", text: answers[0] }] },
                },
                { id: "e3", type: "message", parentId: "e2", message: { role: "user", content: questions[1] } },
              ],
              leafId: "e3",
            },
          }
        return { success: false, error: "projection unavailable" }
      },
      // 文件读取竞态：调用方拿到的 sessionFile 此刻还读不出来。
      readHistory: async () => {
        throw new Error("sessionFileReadFailed")
      },
    },
    { parentRuntimeId: "parent", streaming: false, sessionFile: "parent.jsonl" },
  )
  expect(collected.hasContext).toBe(true)
  expect(collected.source).toBe("entries")
  expect(collected.inner).not.toContain(AUX_PARENT_CONTEXT_EMPTY_NOTICE)
  expect(collected.inner).toContain(answers[0])
})

test("父会话刚创建（尚无已提交输入）: 空提示而不是报错", async () => {
  const collected = await collectAuxParentContext(
    { request: async () => ({ success: true, data: { entries: [], leafId: null } }) },
    { parentRuntimeId: "parent", streaming: false },
  )
  expect(collected.source).toBe("none")
  expect(collected.hasContext).toBe(false)
  expect(collected.inner).toBe(AUX_PARENT_CONTEXT_EMPTY_NOTICE)
  // 块本身仍是合法格式（拼到 prompt 里不会破坏解析）。
  const parsed = parseComposerPromptContexts(
    serializeComposerPromptContexts("提问", { comments: [], selections: [], parentContext: collected.inner }),
  )
  expect(parsed.visibleContent).toBe("提问")
  expect(parsed.parentContext).toBe(AUX_PARENT_CONTEXT_EMPTY_NOTICE)
})

// ---- 3. 32k 护栏：按最旧轮次组整组丢弃 ----

test("32k guard drops the oldest whole turns and never splits a tool call pair", () => {
  const call: AuxContextMessage = { role: "assistant", text: "→ bash(ls)", entryId: "a1" }
  const result: AuxContextMessage = { role: "toolResult", text: "输出", toolCallId: "call-1", entryId: "a2" }
  const groups = groupAuxContextMessages([
    user("第一轮提问", "u1"),
    call,
    result,
    assistant("第一轮回答", "a3"),
    user("第二轮提问", "u2"),
    assistant("第二轮回答", "a4"),
    user("第三轮提问", "u3"),
    assistant("第三轮回答", "a5"),
  ])
  expect(groups).toHaveLength(3)
  // 上限刚好装不下第一组 → 整组丢弃，工具调用与结果一起走，不按字符切。
  const maxChars = groups[1].chars + groups[2].chars + 40
  const truncated = truncateAuxContextGroups(groups, maxChars)
  expect(truncated.omittedGroups).toBe(1)
  expect(truncated.kept).toHaveLength(2)
  expect(truncated.kept[0].text).toContain("第二轮提问")
  // 第一组的工具调用与结果是被**整组**丢弃的：两者都不在保留部分里。
  expect(truncated.kept.map(group => group.text).join("\n")).not.toContain("bash(ls)")
  expect(truncated.kept.map(group => group.text).join("\n")).not.toContain("【工具结果】")
  // 保留的第 2/3 组内部结构完整（配对仍在组内）。
  const withTool = groupAuxContextMessages([user("提问", "u9"), call, result])
  expect(withTool[0].messages).toHaveLength(3)
  expect(withTool[0].text).toContain("bash(ls)")
  expect(withTool[0].text).toContain("【工具结果】")
})

test("32k guard keeps a single oversized turn intact and marks it", () => {
  const groups = groupAuxContextMessages([user("超长提问", "u1"), assistant("超长回答", "a1")])
  const truncated = truncateAuxContextGroups(groups, 10)
  expect(truncated.kept).toHaveLength(1)
  expect(truncated.overLimit).toBe(true)
  // 即便超限也不切：整组内容仍在。
  expect(truncated.kept[0].text).toContain("超长回答")
  const built = buildAuxParentContext({
    messages: [user("超长提问", "u1"), assistant("超长回答", "a1")],
    maxChars: 10,
  })
  expect(built.overLimit).toBe(true)
  expect(built.hasContext).toBe(true)
})

test("the default guard is 32k and the tail note names the omitted turn count", () => {
  expect(AUX_PARENT_CONTEXT_MAX_CHARS).toBe(32_000)
  const filler = "x".repeat(17_000)
  const built = buildAuxParentContext({
    messages: [
      user(`第一轮 ${filler}`, "u1"),
      assistant("回答一", "a1"),
      user(`第二轮 ${filler}`, "u2"),
      assistant("回答二", "a2"),
      user(`第三轮 ${filler}`, "u3"),
      assistant("回答三", "a3"),
    ],
    streaming: false,
  })
  expect(built.inner.length).toBeLessThanOrEqual(AUX_PARENT_CONTEXT_MAX_CHARS)
  expect(built.omittedGroups).toBe(2)
  expect(built.inner).toContain(AUX_PARENT_CONTEXT_TRUNCATED_NOTE.replace("{count}", "2"))
  expect(built.inner).toContain("第三轮")
  expect(built.inner).not.toContain("第一轮")
})

// ---- 4. 活动分支：leafId → parentId 回溯 ----

test("active branch walks leafId→parentId and ignores forked siblings", () => {
  const entries = [
    { id: "a", parentId: null },
    { id: "b", parentId: "a" },
    // 旁支（编辑/fork 后遗留），不是当前分支。
    { id: "c", parentId: "b" },
    { id: "d", parentId: "c" },
    { id: "e", parentId: "d" },
  ]
  expect(activeBranchEntries(entries, "d").map(entry => (entry as { id: string }).id)).toEqual(["a", "b", "c", "d"])
  // 没有 leafId 时退回最后一个条目（与 pi 的 getLeafId 语义一致）。
  expect(activeBranchEntries(entries, null).map(entry => (entry as { id: string }).id)).toEqual([
    "a",
    "b",
    "c",
    "d",
    "e",
  ])
})
