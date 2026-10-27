import { invoke, isDesktop } from "@/api/transport"
import { createLocalPreference } from "@/lib/localPreference"

export const EDITOR_OPTIONS = [
  { id: "vscode", label: "Visual Studio Code" },
  { id: "cursor", label: "Cursor" },
  { id: "windsurf", label: "Windsurf" },
  { id: "trae", label: "Trae" },
  { id: "vscodium", label: "VSCodium" },
  { id: "zed", label: "Zed" },
  { id: "sublime", label: "Sublime Text" },
  { id: "idea", label: "IntelliJ IDEA" },
  { id: "webstorm", label: "WebStorm" },
  { id: "pycharm", label: "PyCharm" },
  { id: "goland", label: "GoLand" },
  { id: "clion", label: "CLion" },
  { id: "rustrover", label: "RustRover" },
] as const
export type EditorKind = (typeof EDITOR_OPTIONS)[number]["id"] | "system" | "custom"
interface OpenWithPreference {
  kind: EditorKind
  executable: string
}
const STORAGE_KEY = "pix.openWith"
export const isEditorKind = (value: unknown): value is EditorKind =>
  value === "system" || value === "custom" || EDITOR_OPTIONS.some(option => option.id === value)
function readPreference(raw: string | null): OpenWithPreference {
  try {
    const saved = JSON.parse(raw ?? "null")
    if (saved && isEditorKind(saved.kind))
      return { kind: saved.kind, executable: typeof saved.executable === "string" ? saved.executable : "" }
  } catch {
    /* Storage is optional. */
  }
  return { kind: "vscode", executable: "" }
}
const preference = createLocalPreference<OpenWithPreference>({
  key: STORAGE_KEY,
  defaultValue: { kind: "vscode", executable: "" },
  read: readPreference,
  serialize: JSON.stringify,
  throwOnWriteError: true,
})
export const openWithPreference = preference.value
export function setOpenWith(kind: EditorKind, executable = openWithPreference.value.executable) {
  if (!isEditorKind(kind)) return
  const next = { kind, executable: executable.trim() }
  preference.set(next)
}

export const detectEditors = () => invoke<Record<string, boolean>>("detect_editors")

/** IDE 真实图标:kind → data:image/png URL(提取失败无该键或为 null) */
export type EditorIconMap = Record<string, string | null>
let iconsPromise: Promise<EditorIconMap> | null = null
/** 取 IDE 真实图标(后端从本机 exe / .app 提取并缓存;失败返回空表,前端回退纯文本展示) */
export function detectIcons(): Promise<EditorIconMap> {
  iconsPromise ??= invoke<EditorIconMap>("editor_icons").catch(() => ({}))
  return iconsPromise
}
export async function openFileInEditor(path: string, project: string) {
  if (!isDesktop) throw new Error("Opening a local editor is available only in the desktop app")
  const { kind, executable } = openWithPreference.value
  await invoke<void>("open_in_editor", { path, project, kind, executable: kind === "custom" ? executable : null })
}

/** 用指定 IDE 打开项目目录（kind 由标题栏下拉等调用方显式给定，而非默认偏好） */
export async function openProjectInEditor(
  project: string,
  kind: EditorKind,
  executable = openWithPreference.value.executable,
) {
  if (!isDesktop) throw new Error("Opening a local editor is available only in the desktop app")
  await invoke<void>("open_project_in_editor", { project, kind, executable: kind === "custom" ? executable : null })
}
