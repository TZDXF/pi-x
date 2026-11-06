import { readFileSync } from "node:fs"
import { expect, test } from "vitest"

const workflows = ["release", "preview"] as const

function readJobs(workflow: string) {
  const source = readFileSync(new URL(`../.github/workflows/${workflow}.yml`, import.meta.url), "utf8")
  const jobs = source.slice(source.indexOf("\njobs:") + 1)
  return new Map(
    [...jobs.matchAll(/^  ([\w-]+):\r?\n([\s\S]*?)(?=^  [\w-]+:\r?$|(?![\s\S]))/gm)].map(match => [match[1], match[2]]),
  )
}

test.each(workflows)("%s uploads every platform to a draft without publishing from the matrix", workflow => {
  const build = readJobs(workflow).get("build")!
  expect(build).toMatch(/uses: tauri-apps\/tauri-action@/)
  expect(build).toMatch(/^          releaseDraft: true$/m)
  expect(build).not.toContain("--draft=false")
  expect(build).not.toMatch(/continue-on-error:\s*true/)
})

test.each(workflows)("%s creates its draft before starting parallel uploads", workflow => {
  const jobs = readJobs(workflow)
  const prepareJob = workflow === "release" ? "prepare" : "check"
  expect(jobs.get("build")).toMatch(new RegExp(`^    needs: ${prepareJob}$`, "m"))
  expect(jobs.get(prepareJob)).toMatch(/gh release create[\s\S]*?--draft\b/)
})

test.each(workflows)("%s publishes only after the complete build matrix succeeds", workflow => {
  const jobs = readJobs(workflow)
  const publishers = [...jobs].filter(([, job]) => job.includes("--draft=false"))
  expect(publishers).toHaveLength(1)
  const [name, publish] = publishers[0]!
  expect(name).not.toBe("build")
  expect(publish).toMatch(/^    needs: (?:build|\[[^\]\n]*\bbuild\b[^\]\n]*\])$/m)
  // Keep GitHub's default success gate: failed, cancelled or skipped builds must leave a draft.
  expect(publish).not.toMatch(/^    if:/m)
  expect(publish).not.toContain("always()")
  if (workflow === "preview") expect(publish).toContain("--prerelease")
})
