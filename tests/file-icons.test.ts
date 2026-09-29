import { test, expect } from "vitest"
import { fileIcon, folderIcon } from "@/lib/fileIcons"

test("fileIcon maps extensions and special filenames to vscode-icons iconify names", () => {
  expect(fileIcon("foo.ts")).toBe("vscode-icons:file-type-typescript")
  expect(fileIcon("src/components/ChatView.vue")).toBe("vscode-icons:file-type-vue")
  expect(fileIcon("package.json")).toBe("vscode-icons:file-type-npm")
})

test("fileIcon matches on the basename of posix and windows paths", () => {
  expect(fileIcon("src/lib/fileKind.ts")).toBe("vscode-icons:file-type-typescript")
  expect(fileIcon("C:\\code\\pi-x\\src\\lib\\fileIcons.ts")).toBe("vscode-icons:file-type-typescript")
})

test("fileIcon falls back to the default file icon for unknown or empty names", () => {
  expect(fileIcon("unknownxyz")).toBe("vscode-icons:default-file")
  expect(fileIcon("")).toBe("vscode-icons:default-file")
})

test("folderIcon honors the open state and falls back to default folder icons", () => {
  expect(folderIcon("src", false)).toBe("vscode-icons:folder-type-src")
  expect(folderIcon("src", true)).toBe("vscode-icons:folder-type-src-opened")
  expect(folderIcon("unknownxyz", false)).toBe("vscode-icons:default-folder")
  expect(folderIcon("unknownxyz", true)).toBe("vscode-icons:default-folder-opened")
})
