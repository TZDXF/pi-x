/**
 * PiX tool-permission extension. pi loads a generated variant of this file via
 * `-e <path>`; PiX rewrites the PIX_CONFIG line with the mode and UI locale.
 * Keep it dependency-light — pi loads it standalone inside the agent process.
 */
import path from "node:path"

// PiX rewrites this exact line per generated variant; keep the shape intact.
const PIX_CONFIG = { mode: "", locale: "" }

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"])
const SHELL_TOOLS = new Set(["bash", "powershell"])
const WRITE_TOOLS = new Set(["write", "edit"])

/** Shell commands that count as high-risk in "highRisk" mode. */
const DANGEROUS_SHELL = [
  /\brm\s+(-\S+\s+)*-\S*[rf]\S*/i, // rm with recursive/force flags
  /\b(sudo|doas|runas|pkexec|runuser|setpriv)\b/i,
  /\bsu\s+-/i,
  /\bmkfs\b/i,
  /\bdd\s+[^|\n]*\bof=\/dev\//i,
  />\s*\/dev\//, // writes to device files
  /\b(format|diskpart|fdisk|parted)\b/i,
  /\b(shutdown|reboot|poweroff|halt)\b/i,
  /\binit\s+[0-6]\b/i,
  /:\(\)\s*\{/, // fork bomb
  /\bchmod\s+(-R\s+)?777\b/,
  /\bgit\s+push\b[^|\n]*--force/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-\S*[fd]/i,
  /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(bash|sh|zsh|powershell|pwsh)\b/i, // curl | sh
  /\b(Stop-Computer|Restart-Computer|Clear-Disk|Format-Volume|Remove-Computer)\b/i,
  /\bRemove-Item\b[^|\n]*-Recurse\b[^|\n]*-Force\b/i,
  /\bbcdedit\b/i,
  /\breg\s+(delete|add|import)\b/i,
  /\bnet\s+(user|localgroup)\b/i,
]

export function pixIsDangerousShell(command) {
  return DANGEROUS_SHELL.some(pattern => pattern.test(command))
}

/** True when `target` resolves outside `cwd` (case-insensitive on Windows). */
export function pixIsOutsideCwd(target, cwd) {
  if (typeof target !== "string" || !target || !cwd) return false
  const windows = process.platform === "win32"
  let base = path.resolve(cwd)
  let dest = path.resolve(cwd, target)
  if (windows) { base = base.toLowerCase(); dest = dest.toLowerCase() }
  return dest !== base && !dest.startsWith(base + path.sep)
}

/**
 * Whether a model tool call needs user approval.
 * - ask: every non-read-only tool call.
 * - highRisk: dangerous shell commands, writes outside the project, and any
 *   unknown extension tools.
 */
export function pixShouldAsk(mode, toolName, input, cwd) {
  if (mode !== "ask" && mode !== "highRisk") return false
  if (READ_ONLY_TOOLS.has(toolName)) return false
  if (mode === "ask") return true
  if (SHELL_TOOLS.has(toolName)) return pixIsDangerousShell(String(input?.command ?? ""))
  if (WRITE_TOOLS.has(toolName)) return pixIsOutsideCwd(input?.path ?? input?.file_path, cwd)
  return true
}

const TEXT = {
  "zh-CN": {
    titleAsk: "批准工具调用？",
    titleRisk: "高风险操作，确认执行？",
    denied: "用户拒绝了该工具调用",
    noUi: "没有可用的确认界面，已按权限设置阻止该操作",
  },
  en: {
    titleAsk: "Approve tool call?",
    titleRisk: "High-risk operation, proceed?",
    denied: "Tool call denied by the user",
    noUi: "Blocked by permission settings: no UI available to confirm",
  },
}

function describeCall(toolName, input) {
  const detail = typeof input?.command === "string" ? input.command
    : typeof input?.path === "string" ? input.path
    : JSON.stringify(input ?? {})
  const text = detail ? `${toolName}: ${detail}` : toolName
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text
}

export default function pixToolPermission(pi) {
  const mode = PIX_CONFIG.mode
  if (mode !== "ask" && mode !== "highRisk") return
  const text = TEXT[PIX_CONFIG.locale] ?? TEXT.en
  pi.on("tool_call", async (event, ctx) => {
    if (!pixShouldAsk(mode, event.toolName, event.input, ctx.cwd)) return
    // Fail closed when no dialog-capable UI is connected.
    if (!ctx.hasUI) return { block: true, reason: text.noUi }
    let approved = false
    try {
      approved = await ctx.ui.confirm(
        mode === "highRisk" ? text.titleRisk : text.titleAsk,
        describeCall(event.toolName, event.input),
      )
    } catch { approved = false }
    if (!approved) return { block: true, reason: text.denied }
  })
}
