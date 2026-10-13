import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"

const MAX_TEXT_BYTES = 2 * 1024 * 1024

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function hashText(text) {
  return hashBytes(Buffer.from(text, "utf8"))
}

function filePathFromInput(input) {
  if (!input || typeof input !== "object") return null
  for (const key of ["path", "file_path", "filePath"]) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return value
  }
  return null
}

function isFileMutation(toolName) {
  const normalized = String(toolName || "").toLowerCase()
  return normalized === "write" || normalized === "edit"
}

async function snapshot(cwd, rawPath) {
  const absolutePath = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath)
  try {
    const bytes = await readFile(absolutePath)
    if (bytes.byteLength > MAX_TEXT_BYTES) {
      return {
        path: absolutePath,
        existed: true,
        content: null,
        hash: hashBytes(bytes),
        unsupportedReason: "file_too_large",
      }
    }
    let text
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      return {
        path: absolutePath,
        existed: true,
        content: null,
        hash: hashBytes(bytes),
        unsupportedReason: "not_utf8",
      }
    }
    return { path: absolutePath, existed: true, content: text, hash: hashText(text) }
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return { path: absolutePath, existed: false, content: null, hash: null }
    }
    return {
      path: absolutePath,
      existed: false,
      content: null,
      hash: null,
      unsupportedReason: "file_read_failed",
    }
  }
}

export default function pixFileChanges(pi) {
  const pending = new Map()
  if (!pi || typeof pi.on !== "function" || typeof pi.appendEntry !== "function") return
  pi.on("tool_call", async (event, ctx) => {
    if (!isFileMutation(event.toolName)) return
    const rawPath = filePathFromInput(event.input)
    if (!rawPath) return
    try {
      pending.set(event.toolCallId, await snapshot(ctx.cwd, rawPath))
    } catch {
      // A failed preflight must not block the actual tool.
      pending.delete(event.toolCallId)
    }
  })

  pi.on("tool_result", async event => {
    const before = pending.get(event.toolCallId)
    pending.delete(event.toolCallId)
    if (!before || event.isError || !isFileMutation(event.toolName)) return
    try {
      const after = await snapshot("", before.path)
      const unsupportedReason = before.unsupportedReason || after.unsupportedReason
      pi.appendEntry("pix-file-change", {
        version: 1,
        createdAt: new Date().toISOString(),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        files: [
          {
            path: after.path,
            existedBefore: before.existed,
            beforeContent: before.content,
            beforeHash: before.hash,
            afterContent: after.content,
            afterHash: after.hash,
            ...(unsupportedReason ? { unsupportedReason } : {}),
          },
        ],
      })
    } catch {
      // File-change tracking is best-effort and never changes the tool result.
    }
  })

  pi.on("agent_settled", () => {
    pending.clear()
  })
}
