import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
const source = readFileSync(new URL('../src/lib/modelAdvanced.ts', import.meta.url), 'utf8')
const js = ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 })
const { modelAdvancedJson, parseModelAdvanced } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

test('advanced fields round-trip without losing false or unknown pi options', () => {
  const extra = { compat: { supportsDeveloperRole: false, futureFlag: 'keep' }, headers: { 'X-Route': 'test' }, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, futureOption: { enabled: true } }
  assert.deepEqual(parseModelAdvanced(modelAdvancedJson({ id: 'test', api: 'openai-completions', reasoning: true, ...extra })), extra)
})
test('empty advanced settings remove overrides and inherit pi defaults', () => {
  assert.deepEqual(parseModelAdvanced(''), {})
  assert.deepEqual(parseModelAdvanced('{}'), {})
})
test('reject malformed JSON, basic field overrides and invalid common types', () => {
  for (const raw of ['{', 'null', '[]', 'true', '{"id":"other"}', '{"compat":[]}', '{"compat":{"supportsDeveloperRole":"false"}}', '{"compat":{"maxTokensField":"other"}}', '{"headers":{"x":1}}', '{"cost":null}', '{"baseUrl":false}']) {
    assert.throws(() => parseModelAdvanced(raw), raw)
  }
})
test('advanced settings are available for both add and edit forms', () => {
  const component = readFileSync(new URL('../src/components/ModelSettings.vue', import.meta.url), 'utf8')
  assert.equal((component.match(/<ModelAdvancedSettings /g) ?? []).length, 2)
  assert.match(component, /parseModelAdvanced\(f.advanced\)/)
  assert.match(component, /advanced: modelAdvancedJson\(m\)/)
})
