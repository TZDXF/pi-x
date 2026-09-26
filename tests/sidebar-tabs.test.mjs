import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')

test('right sidebar switches review, project files and terminal without unmounting terminal', () => {
  const chat = read('../src/components/ChatView.vue')
  const sidebar = read('../src/components/SessionChanges.vue')
  const terminal = read('../src/components/terminal/TerminalPanel.vue')
  assert.match(chat, /<SessionChanges v-show="changesOpen" v-model:tab="sidebarTab"/)
  assert.match(sidebar, /'review', 'files', \.\.\.\(isDesktop \? \['terminal'\]/)
  assert.match(sidebar, /<ProjectFiles v-show="tab === 'files'"/)
  assert.match(sidebar, /<TerminalPanel v-if="isDesktop"[^>]*v-show="tab === 'terminal' && visible"[^>]*embedded/)
  assert.match(terminal, /if \(!tabs\.value\.length && !props\.embedded\) emit\("close"\)/)
  assert.doesNotMatch(chat, /<TerminalPanel/)
})

test('project directory is available locally and remotely with containment checks', () => {
  const files = read('../src-tauri/src/fs_search.rs')
  assert.match(files, /relative\.components\(\)\.any/)
  assert.match(files, /!directory\.starts_with\(&root\)/)
  assert.match(files, /kind\.is_symlink\(\)/)
  assert.match(read('../src-tauri/src/lib.rs'), /commands::list_project_directory/)
  assert.match(read('../src-tauri/src/remote.rs'), /"list_project_directory" =>/)
})
