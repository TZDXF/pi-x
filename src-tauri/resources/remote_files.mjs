import fs from "node:fs"
import path from "node:path"

const TEXT_MAX = 512 * 1024
const IMAGE_MAX = 8 * 1024 * 1024
const mimes = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg",
  gif: "image/gif", webp: "image/webp", ico: "image/x-icon", bmp: "image/bmp", avif: "image/avif",
}
const fail = (code, fallback, params = {}) => {
  throw { code, fallback, params }
}

function read({ project, path: relative, op }) {
  const root = fs.realpathSync(project)
  if (!fs.statSync(root).isDirectory()) fail("projectDirMissing", "项目目录不存在")
  if (typeof relative !== "string" || relative.includes("\\") || relative.includes("\0") ||
      path.isAbsolute(relative) || (relative && relative.split("/").some(p => !p || p === "." || p === "..")) ||
      (!relative && op !== "list")) fail("previewPathInvalid", "无效的文件路径: {detail}", { detail: relative })
  const file = fs.realpathSync(path.join(root, relative))
  const inside = path.relative(root, file)
  if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside))
    fail("previewPathInvalid", "无效的文件路径: {detail}", { detail: relative })
  if (op === "list") {
    return fs.readdirSync(file, { withFileTypes: true })
      .filter(e => e.isDirectory() || e.isFile()).slice(0, 2000)
      .map(e => ({ name: e.name, path: relative ? `${relative}/${e.name}` : e.name, is_dir: e.isDirectory() }))
      .sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  }
  if (op !== "preview") throw new Error("Unknown file operation")
  if (!fs.statSync(file).isFile()) fail("previewPathInvalid", "无效的文件路径: {detail}", { detail: relative })
  const fd = fs.openSync(file, "r")
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) fail("previewPathInvalid", "无效的文件路径: {detail}", { detail: relative })
    const mime = mimes[path.extname(relative).slice(1).toLowerCase()]
    if (mime && stat.size > IMAGE_MAX) fail("previewImageTooLarge", "图片过大，无法预览（上限 {limit} MB）", { limit: 8 })
    const buffer = Buffer.alloc(Math.min(stat.size, mime ? IMAGE_MAX + 1 : TEXT_MAX + 1))
    let length = 0
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null)
      if (!count) break
      length += count
    }
    const bytes = buffer.subarray(0, length)
    const result = { kind: "text", text: null, truncated: false, mime: null, data: null }
    if (bytes.subarray(0, 8000).includes(0)) {
      return mime ? { ...result, kind: "image", mime, data: bytes.toString("base64") } : { ...result, kind: "binary" }
    }
    let end = Math.min(length, TEXT_MAX)
    while (end > 0 && end < length && (bytes[end] & 0xc0) === 0x80) end--
    return { ...result, text: bytes.subarray(0, end).toString("utf8"), truncated: length > TEXT_MAX }
  } finally { fs.closeSync(fd) }
}

try {
  console.log("PIX_FILES=" + JSON.stringify({ data: read(JSON.parse(process.argv[1])) }))
} catch (error) {
  console.log("PIX_FILES=" + JSON.stringify({ error: error.code && error.fallback && error.params ? error :
    { code: "previewReadFailed", fallback: "读取文件失败: {detail}", params: { detail: String(error) } } }))
}
