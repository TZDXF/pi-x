import { expect, test } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import AboutSettings from '/src/components/settings/AboutSettings.vue'
import messages from '/src/i18n/locales/en.ts'
import '/src/style.css'
createApp({ render: () => h('main', { class: 'p-6' }, [h(AboutSettings)]) })
  .use(createPinia()).use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } })).mount('#app')
</script></body></html>`

const releaseNotes = [
  "### Release details",
  ...Array.from(
    { length: 180 },
    (_, index) =>
      `- **Change ${index}**: updated \`configuration\` and improved session handling with more reliable progress. See [documentation](https://example.invalid/docs/${index}).`,
  ),
  "Release details end.",
].join("\n\n")

let harness: VueHarness

test.beforeAll(async () => {
  harness = await startVueHarness({ name: "about-update", port: 1544, html })
})

test.afterAll(async () => harness?.close())

// Animation scanning and its effect on modal painting require a real browser.
test("long release notes keep the update confirmation and page interactive", async ({ page }) => {
  test.setTimeout(90_000)
  const errors: string[] = []
  const commands: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/*", async route => {
    const url = new URL(route.request().url())
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      await route.abort()
      return
    }
    if (url.pathname !== "/api/invoke") {
      await route.continue()
      return
    }
    const { command } = route.request().postDataJSON()
    commands.push(command)
    let data: unknown = {}
    if (command === "app_version_get") data = "1.0.0"
    if (command === "app_config_get") data = { updateChannel: "stable" }
    if (command === "pi_detect") data = { found: true, version: "1.0.0", path: "pi" }
    if (command === "app_update_check") {
      data = {
        channel: "stable",
        currentVersion: "1.0.0",
        updateAvailable: true,
        waitingStable: false,
        version: "1.1.0",
        releaseNotes,
      }
    }
    if (command === "pi_update_check") {
      data = { currentVersion: "1.0.0", latestVersion: "1.1.0", updateAvailable: true, releaseNotes }
    }
    await route.fulfill({ json: { data } })
  })
  await page.goto(harness.url)
  const notes = page.getByRole("region", { name: "Release notes", exact: true })
  await expect(notes).toHaveCount(2)
  for (let index = 0; index < 2; index++) {
    await expect(notes.nth(index)).toContainText("Release details end.")
  }

  const install = page.getByRole("button", { name: "Download & install", exact: true })
  const dialog = page.getByRole("dialog")
  await install.click({ timeout: 5000 })
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await install.click({ timeout: 5000 })
  await expect(dialog).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  expect(commands).not.toContain("app_update_install")

  const checks = commands.filter(command => command === "app_update_check").length
  await page.getByRole("button", { name: "Check for updates", exact: true }).first().click()
  await expect.poll(() => commands.filter(command => command === "app_update_check").length).toBe(checks + 1)
  expect(errors).toEqual([])
})
