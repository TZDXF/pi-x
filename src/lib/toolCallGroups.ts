import type { Block, ToolCallBlock, ToolRun } from "@/stores/conversations"

/** Hidden, completed thinking does not split consecutive tool calls in concise mode. */
export function toolCallGroups(blocks: Block[]): Map<number, ToolCallBlock[]> {
  const groups = new Map<number, ToolCallBlock[]>()
  let group: ToolCallBlock[] | undefined
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!
    if (block.type === "toolCall") {
      if (!group) {
        group = []
        groups.set(index, group)
      }
      group.push(block)
    } else if (block.type !== "thinking" || block.streaming) {
      group = undefined
    }
  }
  return groups
}

export function toolGroupStatus(blocks: ToolCallBlock[], runs: Record<string, ToolRun>) {
  let running = false
  let errors = 0
  for (const block of blocks) {
    const state = runs[block.callId]?.state ?? "input-streaming"
    if (state === "input-streaming" || state === "input-available") running = true
    if (state === "output-error") errors++
  }
  return { running, errors }
}
