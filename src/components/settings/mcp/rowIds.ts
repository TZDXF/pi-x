/** Module-wide monotonically increasing ids for MCP editor rows. Shared by
 *  McpServerEditor (rows parsed from the def) and McpRowsEditor (rows added
 *  by the user) so the two generators can never collide: duplicate ids would
 *  break Vue `:key` and make id-based update/remove hit the wrong row. */
let rowSeq = 0

export function nextMcpRowId(): number {
  rowSeq += 1
  return rowSeq
}
