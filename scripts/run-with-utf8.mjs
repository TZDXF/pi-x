#!/usr/bin/env node
// 在 Windows 上以 UTF-8（控制台代码页 65001）运行一个命令，其他平台原样转发。
//
// 起因：中文 Windows 的控制台默认代码页是 CP936，MSVC 的本地化诊断会以 GBK 字节写进
// build script 的 stdout。mbx 只接受 UTF-8，读不了就丢掉该 build script 的结果，并让
// 下游编译无法命中缓存（`build-script stdout is not UTF-8` /
// `build-script result was not stored`）。Cargo 及其 build script 继承父进程所在控制台
// 的代码页，所以这里只在子命令运行期间把控制台代码页切到 65001，结束后恢复原值：
// 不改 PATH、不改 PowerShell profile、不动系统/用户环境变量。
//
// 命令本身仍由调用者的 PATH 决定（`cargo` 是否落到 mbx 的 shim 不由本脚本干预），
// 参数原样透传，退出码原样返回。
//
// 用法：node scripts/run-with-utf8.mjs <命令> [参数...]

import { spawnSync } from "node:child_process"

const CHCP = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\chcp.com`
const UTF8_CODE_PAGE = 65001

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error("用法: node scripts/run-with-utf8.mjs <命令> [参数...]")
  process.exit(2)
}

// 先按可执行文件直接解析（PATH + PATHEXT 由 libuv 处理）；.cmd / .bat / .ps1 形态的
// 包装在 Windows 上不能直接 spawn（EINVAL），ENOENT 也会落到这里，两者都改用 shell
// 转一手，这样 Cargo 装成 `.cmd` 时脚本照样能跑。
// 只给含空白或引号的参数加引号：cmd /c 收到以引号开头的整串会把它当成程序名。
function runCommand() {
  const direct = spawnSync(args[0], args.slice(1), { stdio: "inherit" })
  const needsShell = direct.error && (direct.error.code === "EINVAL" || direct.error.code === "ENOENT")
  if (needsShell && process.platform === "win32") {
    const quote = argument => (/[\s"]/.test(argument) ? `"${argument.replace(/"/g, '""')}"` : argument)
    const line = args.map(quote).join(" ")
    return spawnSync("cmd.exe", ["/d", "/c", line], { stdio: "inherit" }).status ?? 1
  }
  return direct.status ?? 1
}

// chcp 的输出是本地化的，但末尾的代码页数字始终是 ASCII，按字节截取即可。
function readCodePage() {
  const result = spawnSync(CHCP, [], { encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] })
  if (result.error || !result.stdout) return null
  const match = result.stdout.toString("latin1").match(/(\d{3,5})\s*$/)
  return match ? Number(match[1]) : null
}

function setCodePage(codePage) {
  const result = spawnSync(CHCP, [String(codePage)], { stdio: "ignore" })
  return !result.error && result.status === 0
}

if (process.platform !== "win32") {
  process.exit(runCommand())
}

const originalCodePage = readCodePage()
const switched = originalCodePage !== null && originalCodePage !== UTF8_CODE_PAGE && setCodePage(UTF8_CODE_PAGE)
const status = runCommand()
if (switched) setCodePage(originalCodePage)
process.exit(status)
