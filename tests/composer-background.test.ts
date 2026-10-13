import { readFileSync } from "node:fs"
import { expect, test } from "vitest"
import { cn } from "@/lib/utils"

test("chat composer overrides the translucent input-group background in dark mode", () => {
  const composer = readFileSync(new URL("../src/components/chat/ChatComposer.vue", import.meta.url), "utf8")
  const groupClass = composer.match(/'([^']*rounded-\[22px\][^']*)'/)?.[1]

  expect(groupClass).toBeDefined()
  const classes = cn("dark:bg-input/30", groupClass).split(/\s+/)
  expect(classes).toContain("bg-card")
  expect(classes).toContain("dark:bg-card")
  expect(classes).not.toContain("dark:bg-input/30")
})
