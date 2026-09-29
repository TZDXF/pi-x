import { test, expect } from "vitest"
import { loadTsModule } from "./lib/load-ts.mjs"

// fileIcons.ts 依赖 vscode-icons-js（CJS），把真实包的命名空间注入 require
const vscodeIconsJs = await import("vscode-icons-js")
const fileIcons = loadTsModule(new URL("../src/lib/fileIcons.ts", import.meta.url), name =>
  name === "vscode-icons-js" ? vscodeIconsJs : undefined,
)

test("fileIcon maps extensions and special filenames to vscode-icons iconify names", () => {
  expect(fileIcons.fileIcon("foo.ts")).toBe("vscode-icons:file-type-typescript")
  expect(fileIcons.fileIcon("src/components/ChatView.vue")).toBe("vscode-icons:file-type-vue")
  expect(fileIcons.fileIcon("package.json")).toBe("vscode-icons:file-type-npm")
})

test("fileIcon matches on the basename of posix and windows paths", () => {
  expect(fileIcons.fileIcon("src/lib/fileKind.ts")).toBe("vscode-icons:file-type-typescript")
  expect(fileIcons.fileIcon("C:\\code\\pi-x\\src\\lib\\fileIcons.ts")).toBe("vscode-icons:file-type-typescript")
})

test("fileIcon falls back to the default file icon for unknown or empty names", () => {
  expect(fileIcons.fileIcon("unknownxyz")).toBe("vscode-icons:default-file")
  expect(fileIcons.fileIcon("")).toBe("vscode-icons:default-file")
})

test("folderIcon honors the open state and falls back to default folder icons", () => {
  expect(fileIcons.folderIcon("src", false)).toBe("vscode-icons:folder-type-src")
  expect(fileIcons.folderIcon("src", true)).toBe("vscode-icons:folder-type-src-opened")
  expect(fileIcons.folderIcon("unknownxyz", false)).toBe("vscode-icons:default-folder")
  expect(fileIcons.folderIcon("unknownxyz", true)).toBe("vscode-icons:default-folder-opened")
})
