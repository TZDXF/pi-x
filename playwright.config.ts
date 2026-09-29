import { defineConfig, devices } from "@playwright/test"

// Browser regressions run against the real Vue module graph. Each spec owns a
// dedicated Vite harness so fixture middleware cannot leak across files.
export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never", outputFolder: "temp/playwright/report" }]]
    : [["list"]],
  outputDir: "temp/playwright/results",
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          headless: true,
          // PI_BROWSER_CHANNEL keeps compatibility with the old local Edge
          // runner; omit it to use Playwright's managed Chromium.
          channel: process.env.PI_BROWSER_CHANNEL,
        },
      },
    },
  ],
})
