// Run: PI_PLAYWRIGHT_MODULE=<absolute path to playwright/index.mjs> node tests/package-market.browser.mjs
import assert from "node:assert/strict"
import { pathToFileURL } from "node:url"
import { createServer } from "vite"
const { chromium } = await import(
  process.env.PI_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PI_PLAYWRIGHT_MODULE).href : "playwright"
)
const server = await createServer({ server: { port: 1441, strictPort: true } })
await server.listen()
const executablePath = process.env.PI_BROWSER_EXECUTABLE
const browser = await chromium.launch({
  channel: executablePath ? undefined : process.env.PI_BROWSER_CHANNEL || "msedge",
  executablePath,
  headless: true,
})
const page = await browser.newPage()
const errors = []
page.on("pageerror", error => errors.push(error.message))
await page.routeWebSocket("**/api/events*", () => {})
const calls = []
const pkg = (name, description = name) => ({
  name,
  description,
  author: "Alice",
  types: ["extension"],
  downloadsMonth: 20,
  updatedMs: 0,
  source: `npm:${name}`,
  detailUrl: `https://pi.dev/packages/${name}`,
})
let failMore = true
let appConfig = {}
let releaseSlow
const slowGate = new Promise(resolve => {
  releaseSlow = resolve
})
await page.route("**/api/invoke", async route => {
  const { command, args } = route.request().postDataJSON()
  let data = {}
  if (command === "package_catalog") {
    calls.push(args)
    if (args.query === "slow") await slowGate
    if (args.page === 2 && failMore) {
      failMore = false
      return route.fulfill({ status: 500, json: { error: "Page unavailable" } })
    }
    // Search results include packages absent from the default first page and
    // matches in full descriptions/metadata that the displayed excerpt omits.
    const packages =
      args.query === "init"
        ? args.page === 2
          ? [pkg("pi-init")]
          : [pkg("pi-web-access", "Searchinfinity"), pkg("doompi-web-contracts", "Web cockpit plugin contracts")]
        : args.query === ""
          ? [pkg("alpha-tool"), pkg("beta-skill")]
          : args.query === "none"
            ? []
            : [pkg(args.query)]
    data = { packages, hasMore: args.query === "init" && args.page === 1 }
  } else if (command === "package_list" || /sessions|projects/.test(command)) data = []
  else if (command === "app_config_get") data = appConfig
  else if (command === "app_config_save") {
    appConfig = args.config
    data = null
  }
  else if (command === "rpc_running") data = false
  else if (command === "trust_status") data = { needsDecision: false }
  await route.fulfill({ json: { data } })
})
try {
  await page.goto("http://localhost:1441/#/settings/packages")
  const panel = page.locator('[data-slot="tabs-content"][data-state="active"]')
  const input = panel.locator("input")
  const names = panel.locator("h4")
  async function expectNames(expected) {
    await page.waitForFunction(expected => {
      const actual = [...document.querySelectorAll('[data-slot="tabs-content"][data-state="active"] h4')].map(
        el => el.textContent,
      )
      return JSON.stringify(actual) === JSON.stringify(expected)
    }, expected)
    assert.deepEqual(await names.allTextContents(), expected)
  }
  await expectNames(["alpha-tool", "beta-skill"])
  await input.fill("  init  ")
  await expectNames(["pi-web-access", "doompi-web-contracts"])
  assert.deepEqual(calls.at(-1), { query: "init", sort: "downloads", packageType: "", page: 1 })
  await panel.getByRole("button", { name: /加载更多|Load more/ }).click()
  await panel.getByText(/Page unavailable/).waitFor()
  await expectNames(["pi-web-access", "doompi-web-contracts"])
  await panel.getByRole("button", { name: /重试|Retry/ }).click()
  await expectNames(["pi-web-access", "doompi-web-contracts", "pi-init"])
  assert.equal(calls.at(-1).page, 2)
  assert.equal(await panel.getByRole("button", { name: /加载更多|Load more/ }).count(), 0)

  await panel.getByRole("button", { name: /^(技能|技能包|Skills?)$/ }).click()
  await expectNames(["pi-web-access", "doompi-web-contracts"])
  assert.equal(calls.at(-1).packageType, "skill")
  assert.equal(calls.at(-1).page, 1)
  await panel.getByRole("combobox").click()
  await page.getByRole("option", { name: /按更新时间|Recently updated/ }).click()
  await expectNames(["pi-web-access", "doompi-web-contracts"])
  assert.equal(calls.at(-1).sort, "recent")

  await input.fill("slow")
  await page.waitForRequest(
    request => request.url().endsWith("/api/invoke") && request.postDataJSON().args?.query === "slow",
  )
  await input.fill("newest")
  await expectNames(["newest"])
  const slowResponse = page.waitForResponse(
    response => response.url().endsWith("/api/invoke") && response.request().postDataJSON().args?.query === "slow",
  )
  releaseSlow()
  await slowResponse
  // A refresh provides another settled render after the stale response arrives.
  await page.getByRole("button", { name: /^(刷新|Refresh)$/ }).click()
  await expectNames(["newest"])
  await input.fill("none")
  await expectNames([])
  await panel.getByText(/没有匹配|No packages match/).waitFor()
  await input.fill("")
  await expectNames(["alpha-tool", "beta-skill"])

  await page.getByRole("tab", { name: /内置|Built-in/ }).click()
  await panel.getByText(/文件变更追踪|File change tracking/).waitFor()
  const toggle = panel.getByRole("switch", { name: /文件变更追踪|File change tracking/ })
  assert.equal(await toggle.isChecked(), true)
  await toggle.click()
  assert.equal(await toggle.isChecked(), false)
  assert.equal(appConfig.builtinFileChanges, false)

  assert.deepEqual(errors, [])
  console.log("Package marketplace and built-in plugin toggle passed")
} finally {
  await browser.close()
  await server.close()
}
