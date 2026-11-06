import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { performance } from "node:perf_hooks"

const root = fileURLToPath(new URL("../", import.meta.url))

// Support both JS package managers and standalone pnpm executables, without a shell.
export function checkCommand(name, packageManager = process.env.npm_execpath) {
  if (name.startsWith("rust")) {
    return {
      command: "cargo",
      args: [
        "check",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        ...(name === "rust:remote" ? ["--features", "remote-access"] : []),
      ],
    }
  }
  if (!packageManager) throw new Error("请通过 pnpm run check 或 pnpm run check:quick 运行检查")
  return /\.[cm]?js$/i.test(packageManager)
    ? { command: process.execPath, args: [packageManager, "run", name] }
    : { command: packageManager, args: ["run", name] }
}

function runCommand(name) {
  return new Promise((resolve, reject) => {
    const { command, args } = checkCommand(name)
    const child = spawn(command, args, { cwd: root, stdio: "inherit", shell: false })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(signal ? `signal ${signal}` : `exit ${code}`))
    })
  })
}

export async function runChecks({ quick = false, serial = false, run = runCommand, log = console.log } = {}) {
  const started = performance.now()
  async function task(name) {
    const start = performance.now()
    log(`[check] ${name} ...`)
    try {
      await run(name)
      log(`[check] ${name} OK (${((performance.now() - start) / 1000).toFixed(1)}s)`)
      return true
    } catch (error) {
      log(`[check] ${name} FAILED (${((performance.now() - start) / 1000).toFixed(1)}s): ${error.message}`)
      return false
    }
  }

  const tasks = []
  if (serial) {
    for (const name of quick ? ["lint", "typecheck"] : ["lint", "typecheck", "build", "rust", "rust:remote"]) {
      const success = await task(name)
      tasks.push(success)
      if (!success) break
    }
  } else {
    tasks.push(task("lint"), task("typecheck"))
  }
  if (!quick && !serial) {
    const build = task("build")
    const rust = task("rust")
    tasks.push(
      build,
      rust,
      // Remote embeds dist, and both Cargo invocations share the same target directory.
      Promise.all([build, rust]).then(([built, checked]) => {
        if (built && checked) return task("rust:remote")
        log("[check] rust:remote SKIPPED (build/rust failed)")
        return false
      }),
    )
  }
  // Drain running checks even on failure; never leave a build writing dist in the background.
  const results = await Promise.all(tasks)
  const success = results.every(Boolean)
  log(`[check] ${success ? "OK" : "FAILED"} (${((performance.now() - started) / 1000).toFixed(1)}s)`)
  return success
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.some(arg => arg !== "--quick" && arg !== "--serial")) {
    console.error("用法：pnpm run check [--serial] 或 pnpm run check:quick [--serial]")
    process.exitCode = 1
  } else {
    process.exitCode = (await runChecks({ quick: args.includes("--quick"), serial: args.includes("--serial") })) ? 0 : 1
  }
}
