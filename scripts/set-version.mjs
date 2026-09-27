// 同步更新 package.json 与 src-tauri/tauri.conf.json 的版本号
// 用法：node scripts/set-version.mjs <version>
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const version = process.argv[2]

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(version)) {
  console.error(`无效的语义化版本号: ${version ?? '(未提供)'}`)
  process.exit(1)
}

for (const file of ['package.json', 'src-tauri/tauri.conf.json']) {
  const path = join(root, file)
  const json = JSON.parse(readFileSync(path, 'utf8'))
  json.version = version
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`)
  console.log(`${file} -> ${version}`)
}
