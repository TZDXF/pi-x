// Read or write an independent session snapshot on SSH, WSL and Docker hosts.
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const request = JSON.parse(fs.readFileSync(0, "utf8"))
const root = fs.realpathSync(path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "sessions"))
const source = fs.realpathSync(request.file)
const relative = path.relative(root, source)
if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !source.endsWith(".jsonl")) {
  throw new Error("Invalid session path")
}
let result
if (request.op === "read") {
  result = { content: fs.readFileSync(source, "utf8") }
} else if (request.op === "write") {
  if (typeof request.name !== "string" || !/^[\w.-]+\.jsonl$/.test(request.name)) {
    throw new Error("Invalid session filename")
  }
  const target = path.join(path.dirname(source), request.name)
  fs.writeFileSync(target, request.content, { flag: "wx" })
  const sidecar = target.slice(0, -6) + ".pix.json"
  try {
    fs.writeFileSync(sidecar, JSON.stringify({ archived: false, title_generation_attempted: false }), { flag: "wx" })
  } catch (error) {
    fs.unlinkSync(target)
    throw error
  }
  result = { file: target }
} else {
  throw new Error("Unsupported session snapshot operation")
}
process.stdout.write("PIX_SESSION_SNAPSHOT=" + JSON.stringify(result) + "\n")
