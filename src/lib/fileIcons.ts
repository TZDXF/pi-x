import {
  DEFAULT_FILE,
  DEFAULT_FOLDER,
  DEFAULT_FOLDER_OPENED,
  getIconForFile,
  getIconForFolder,
  getIconForOpenFolder,
} from "vscode-icons-js"

/**
 * vscode-icons 文件/目录图标名解析，返回形如 "vscode-icons:file-type-typescript"
 * 的 iconify 图标名，配合 @iconify/vue 的 <Icon> 渲染（图标集由
 * src/lib/vscodeIcons.ts 按需注册）。映射不到时回退默认文件/目录图标。
 * 除 vscode-icons-js 外保持零依赖，便于 node:test 直接加载。
 */

const PREFIX = "vscode-icons:"

/** vscode-icons-js 的 SVG 文件名转 iconify 图标名（file_type_ts.svg -> file-type-ts） */
function toIconName(svgFileName: string): string {
  return svgFileName.replace(/\.svg$/, "").replace(/_/g, "-")
}

/** 取路径（/ 或 \ 分隔）最后一段，vscode-icons-js 按文件名匹配 */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? ""
}

/** 文件图标名（按文件名含扩展名匹配，如 foo.ts -> vscode-icons:file-type-typescript） */
export function fileIcon(path: string): string {
  return PREFIX + toIconName(getIconForFile(baseName(path)) ?? DEFAULT_FILE)
}

/** 目录图标名；open 为 true 时取展开态图标 */
export function folderIcon(path: string, open: boolean): string {
  const name = baseName(path)
  const matched = open ? getIconForOpenFolder(name) : getIconForFolder(name)
  return PREFIX + toIconName(matched ?? (open ? DEFAULT_FOLDER_OPENED : DEFAULT_FOLDER))
}
