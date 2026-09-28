import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

test("global stylesheet is an import-only entry point with separate theme blocks", () => {
  const entry = read("src/style.css")
  assert.equal(entry.replace(/^@import.*;$/gm, "").trim(), "")
  for (const file of ["tokens", "light", "dark"]) {
    assert.ok(entry.includes(`./styles/theme/${file}.css`))
  }
  assert.doesNotMatch(read("src/styles/base.css"), /data-slot|composer|sidebar|setting-row/)
})

test("light and dark palettes expose matching tokens and native color schemes", () => {
  const light = read("src/styles/theme/light.css")
  const dark = read("src/styles/theme/dark.css")
  const tokens = css => [...css.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]).sort()
  assert.deepEqual(tokens(light), tokens(dark))
  assert.match(light, /color-scheme:\s*light/)
  assert.match(dark, /color-scheme:\s*dark/)
  for (const token of ["--composer-shadow", "--sidebar-shadow", "--selection-background"]) {
    assert.ok(tokens(light).includes(token))
  }
})

test("shared presentation components do not import themselves or require global CSS", () => {
  for (const name of readdirSync(new URL("../src/components/shared/", import.meta.url))) {
    if (!name.endsWith(".vue")) continue
    const source = read(`src/components/shared/${name}`)
    assert.ok(!source.includes(`from '@/components/shared/${name}'`), `${name} must not recurse`)
    assert.doesNotMatch(source, /<style/)
    assert.match(source, /cn\(/)
  }
  assert.match(read("src/components/shared/KeyHint.vue"), /<kbd\b/)
  assert.match(read("src/components/shared/SettingRow.vue"), /max-\[640px\]:flex-wrap/)
})

test("composer and message surfaces declare styles on their own components", () => {
  assert.match(
    read("src/components/ai-elements/prompt-input/PromptInput.vue"),
    /<InputGroup :class="cn\('overflow-hidden', props.groupClass\)"/,
  )
  assert.match(read("src/components/ChatView.vue"), /:group-class="\[/)
  assert.match(read("src/components/ai-elements/message/MessageContent.vue"), /group-\[\.is-assistant\]:w-full/)
  for (const name of ["ChatView", "WorkspaceSidebar", "SettingsPage"]) {
    const styles =
      read(`src/components/${name}.vue`)
        .match(/<style[\s\S]*?<\/style>/g)
        ?.join("") ?? ""
    assert.doesNotMatch(styles, /data-slot|:deep\(svg\)/)
  }
})
