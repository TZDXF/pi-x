import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

/** Compile TS source to CommonJS and evaluate it in a fresh VM context. */
export function loadTsSource(source, extraContext = {}) {
  const context = vm.createContext({ exports: {}, console, ...extraContext })
  vm.runInContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }), context)
  return context.exports
}

/**
 * Load a TS entry file together with its relative TS imports (a module split
 * across sibling files): relative requires resolve to real .ts files next to
 * the importing file, everything else goes through `resolve`.
 */
export function loadTsModule(entryUrl, resolve = () => undefined, extraContext = {}) {
  const cache = new Map()
  const load = (url) => {
    const key = url.href
    if (cache.has(key)) return cache.get(key)
    const exports = {}
    cache.set(key, exports)
    const source = readFileSync(url, 'utf8')
    const context = vm.createContext({
      exports, console, ...extraContext,
      require: name => (name.startsWith('.')
        ? load(new URL(`${name}.ts`, url))
        : resolve(name)),
    })
    vm.runInContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }), context)
    return exports
  }
  return load(entryUrl)
}

/** Load the shared content helpers (src/lib/content.ts) for test harnesses. */
export function contentModule() {
  return loadTsSource(readFileSync(new URL('../../src/lib/content.ts', import.meta.url), 'utf8'))
}

/** Load the shared path helpers (src/lib/paths.ts) for harness require maps. */
export function pathsModule() {
  return loadTsSource(readFileSync(new URL('../../src/lib/paths.ts', import.meta.url), 'utf8'))
}
