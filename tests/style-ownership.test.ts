import { test, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

test("global stylesheet is an import-only entry point with separate theme blocks", () => {
  const entry = read("src/style.css")
  const entryWithoutImports = entry.replace(/^@import.*;$/gm, "").trim()
  // The entry may self-host fonts, but all non-import CSS must be a local
  // @font-face block and may never fetch a remote stylesheet or font.
  expect(entryWithoutImports.replace(/^\/\*.*?\*\/\s*@font-face\s*\{[\s\S]*\}\s*$/, "")).toBe("")
  expect(entryWithoutImports).toMatch(/^\/\* .* \*\/\s*@font-face\s*\{[\s\S]*\.woff2/)
  expect(entry).not.toMatch(/url\(["']?https?:\/\//i)
  for (const file of ["tokens", "light", "dark"]) {
    expect(entry.includes(`./styles/theme/${file}.css`)).toBeTruthy()
  }
  expect(read("src/styles/base.css")).not.toMatch(/data-slot|composer|sidebar|setting-row/)
})

test("light and dark palettes expose matching tokens and native color schemes", () => {
  const light = read("src/styles/theme/light.css")
  const dark = read("src/styles/theme/dark.css")
  const tokens = css => [...css.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]).sort()
  expect(tokens(light)).toEqual(tokens(dark))
  expect(light).toMatch(/color-scheme:\s*light/)
  expect(dark).toMatch(/color-scheme:\s*dark/)
  for (const token of ["--composer-shadow", "--sidebar-shadow", "--selection-background"]) {
    expect(tokens(light).includes(token)).toBeTruthy()
  }
})

test("shared presentation components do not import themselves or require global CSS", () => {
  for (const name of readdirSync(new URL("../src/components/shared/", import.meta.url))) {
    if (!name.endsWith(".vue")) continue
    const source = read(`src/components/shared/${name}`)
    expect(source.includes(`from '@/components/shared/${name}'`), `${name} must not recurse`).toBeFalsy()
    expect(source).not.toMatch(/<style/)
    expect(source).toMatch(/cn\(/)
  }
  expect(read("src/components/shared/KeyHint.vue")).toMatch(/<kbd\b/)
  expect(read("src/components/shared/SettingRow.vue")).toMatch(/max-\[640px\]:flex-wrap/)
})

test("composer and message surfaces declare styles on their own components", () => {
  expect(read("src/components/ai-elements/prompt-input/PromptInput.vue")).toMatch(
    /<InputGroup :class="cn\('overflow-hidden', props.groupClass\)"/,
  )
  expect(read("src/components/chat/ChatComposer.vue")).toMatch(/:group-class="\[/)
  expect(read("src/components/ai-elements/message/MessageContent.vue")).toMatch(/group-\[\.is-assistant\]:w-full/)
  for (const name of ["ChatView", "WorkspaceSidebar", "SettingsPage"]) {
    const styles =
      read(`src/components/${name}.vue`)
        .match(/<style[\s\S]*?<\/style>/g)
        ?.join("") ?? ""
    expect(styles).not.toMatch(/data-slot|:deep\(svg\)/)
  }
})
