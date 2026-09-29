import { test, expect } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

type PackageFixture = {
  name: string
  description: string
  author: string
  types: string[]
  downloadsMonth: number
  updatedMs: number
  source: string
  detailUrl: string
}

type CatalogArgs = {
  query?: string
  sort?: string
  packageType?: string
  page?: number
}

type InvokeCall = CatalogArgs

let harness: VueHarness

test.beforeAll(async () => {
  harness = await startVueHarness({
    name: "package-market",
    port: 1452,
    html: `<!doctype html>
<html lang="zh-CN" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script src="/theme-init.js"></script>
    <title>PiX package market E2E</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>`,
    setup: async server => {
      await server.warmupRequest("/src/main.ts")
    },
  })
})

test.afterAll(async () => {
  await harness?.close()
})

test("package marketplace pagination, filters, stale search, and built-in settings", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))

  await page.routeWebSocket("**/api/events*", () => {})
  const calls: InvokeCall[] = []
  const pkg = (name: string, description = name): PackageFixture => ({
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
  let appConfig: Record<string, unknown> = {}
  let releaseSlow: () => void = () => {}
  const slowGate = new Promise<void>(resolve => {
    releaseSlow = resolve
  })

  await page.route("**/api/invoke", async route => {
    const { command, args } = route.request().postDataJSON() as { command: string; args: CatalogArgs }
    let data: unknown = {}
    if (command === "package_catalog") {
      calls.push(args)
      if (args.query === "slow") await slowGate
      if (args.page === 2 && failMore) {
        failMore = false
        await route.fulfill({ status: 500, json: { error: "Page unavailable" } })
        return
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
              : [pkg(args.query ?? "")]
      data = { packages, hasMore: args.query === "init" && args.page === 1 }
    } else if (command === "package_list" || /sessions|projects/.test(command)) data = []
    else if (command === "app_config_get") data = appConfig
    else if (command === "app_config_save") {
      appConfig = (route.request().postDataJSON() as { args: { config: Record<string, unknown> } }).args.config
      data = null
    } else if (command === "rpc_running") data = false
    else if (command === "trust_status") data = { needsDecision: false }
    await route.fulfill({ json: { data } })
  })

  await page.goto(`${harness.url}#/settings/packages`)
  const panel = page.locator('[data-slot="tabs-content"][data-state="active"]')
  const input = panel.locator("input")
  const names = panel.locator("h4")

  const expectNames = async (expected: string[]) => {
    await expect(names).toHaveText(expected)
  }

  await expectNames(["alpha-tool", "beta-skill"])
  await input.fill("  init  ")
  await expectNames(["pi-web-access", "doompi-web-contracts"])
  expect(calls[calls.length - 1]).toEqual({ query: "init", sort: "downloads", packageType: "", page: 1 })

  await panel.getByRole("button", { name: /加载更多|Load more/ }).click()
  await expect(panel.getByText(/Page unavailable/)).toBeVisible()
  await expectNames(["pi-web-access", "doompi-web-contracts"])
  await panel.getByRole("button", { name: /重试|Retry/ }).click()
  await expectNames(["pi-web-access", "doompi-web-contracts", "pi-init"])
  expect(calls[calls.length - 1]?.page).toBe(2)
  await expect(panel.getByRole("button", { name: /加载更多|Load more/ })).toHaveCount(0)

  await panel.getByRole("button", { name: /^(技能|skill)$/i }).click()
  await expectNames(["pi-web-access", "doompi-web-contracts"])
  expect(calls[calls.length - 1]?.packageType).toBe("skill")
  expect(calls[calls.length - 1]?.page).toBe(1)
  await panel.getByRole("combobox").click()
  await page.getByRole("option", { name: /按更新时间|Recently updated/ }).click()
  await expectNames(["pi-web-access", "doompi-web-contracts"])
  expect(calls[calls.length - 1]?.sort).toBe("recent")

  await input.fill("slow")
  await page.waitForRequest(
    request =>
      request.url().endsWith("/api/invoke") && (request.postDataJSON() as { args: CatalogArgs }).args?.query === "slow",
  )
  await input.fill("newest")
  await expectNames(["newest"])
  const slowResponse = page.waitForResponse(
    response =>
      response.url().endsWith("/api/invoke") &&
      (response.request().postDataJSON() as { args: CatalogArgs }).args?.query === "slow",
  )
  releaseSlow()
  await slowResponse
  // A refresh provides another settled render after the stale response arrives.
  await page.getByRole("button", { name: /^(刷新|Refresh)$/ }).click()
  await expectNames(["newest"])
  await input.fill("none")
  await expectNames([])
  await expect(panel.getByText(/没有匹配|No packages match/)).toBeVisible()
  await input.fill("")
  await expectNames(["alpha-tool", "beta-skill"])

  await page.getByRole("tab", { name: /内置|Built-in/ }).click()
  await expect(panel.getByText(/文件变更追踪|File change tracking/)).toBeVisible()
  const toggle = panel.getByRole("switch", { name: /文件变更追踪|File change tracking/ })
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  expect(appConfig.builtinFileChanges).toBe(false)

  expect(errors).toEqual([])
})
