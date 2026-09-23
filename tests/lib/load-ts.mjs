import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

/** Compile TS source to CommonJS and evaluate it in a fresh VM context. */
export function loadTsSource(source, extraContext = {}) {
  const context = vm.createContext({ exports: {}, console, ...extraContext })
  vm.runInContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }), context)
  return context.exports
}

/** Load the shared content helpers (src/lib/content.ts) for test harnesses. */
export function contentModule() {
  return loadTsSource(readFileSync(new URL('../../src/lib/content.ts', import.meta.url), 'utf8'))
}
