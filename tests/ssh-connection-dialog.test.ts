import { readFileSync } from "node:fs"
import { afterEach, expect, test, vi } from "vitest"
import * as vue from "vue"
import { compileScript, parse } from "vue/compiler-sfc"
import ts from "typescript"
import { mountBrowserComposable } from "./browserTestHarness"

const source = readFileSync(new URL("../src/components/settings/SshSettings.vue", import.meta.url), "utf8")
const { descriptor } = parse(source, { filename: "SshSettings.vue" })
const compiled = compileScript(descriptor, { id: "ssh-connection-dialog-test" })
const code = ts.transpileModule(compiled.content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const unmounts: (() => void)[] = []

afterEach(() => {
  unmounts.splice(0).forEach(unmount => unmount())
})

function harness(createOnly = false) {
  const emit = vi.fn()
  const api = {
    sshConnectionList: vi.fn(async () => []),
    sshConnectionSave: vi.fn(async (_target: unknown) => undefined),
    wslDistroList: vi.fn(async () => ({ available: false, distros: [] })),
    dockerContainerList: vi.fn(async () => ({ available: false, containers: [] })),
  }
  const imports = {
    vue,
    "vue-i18n": { useI18n: () => ({ t: key => key }) },
    "@/api/transport": { isDesktop: true },
    "@/api/piClient": api,
    "@/i18n": { tBackendError: error => error.message },
    "@/stores/conversations": { useUiStore: () => ({ pushToast: vi.fn() }) },
    "@/lib/ssh": { isWslPlatform: () => true, connectionKind: connection => connection.kind ?? "ssh" },
    "@/lib/remoteBackends": { remoteKindOptions: () => [], remoteFormFields: () => [] },
    "@/composables/useSshDeployProgress": { useSshDeployProgress: () => vue.ref(null) },
  }
  const module = { exports: {} as any }
  new Function("exports", "require", code)(module.exports, id => imports[id] ?? {})
  const mounted = mountBrowserComposable(() =>
    module.exports.default.setup(vue.reactive({ createOnly }), { expose: () => {}, emit }),
  )
  unmounts.push(mounted.unmount)
  return { ...mounted.result, api, emit }
}

// 检查真实模板的结构，防止管理列表再次落到弹窗外或遗漏仅新建模式。
function elements(root, tag: string): any[] {
  return (root.children ?? []).flatMap(child => [
    ...(child.type === 1 && child.tag === tag ? [child] : []),
    ...elements(child, tag),
  ])
}

test("项目入口挂载时直接打开新建表单，不加载设置页列表", () => {
  const h = harness(true)
  expect(h.dialogOpen.value).toBe(true)
  expect(h.editingId.value).toBeNull()
  expect(h.formKind.value).toBe("ssh")
  expect(h.form.name).toBe("")
  expect(h.api.sshConnectionList).not.toHaveBeenCalled()
  expect(h.api.wslDistroList).toHaveBeenCalledOnce()
  expect(h.api.dockerContainerList).toHaveBeenCalledOnce()

  const list = elements(descriptor.template!.ast, "div").find(element =>
    element.props.some(prop => prop.name === "class" && prop.value?.content === "space-y-5"),
  )
  expect(list.props.some(prop => prop.name === "if" && prop.exp?.content === "!props.createOnly")).toBe(true)
})

test("关闭新建弹窗会通知父组件卸载，重新打开时表单重置", () => {
  const h = harness(true)
  h.form.host = "old.example"
  h.onDialogOpenChange(false)
  expect(h.dialogOpen.value).toBe(false)
  expect(h.emit.mock.calls).toEqual([["close"]])

  const reopened = harness(true)
  expect(reopened.dialogOpen.value).toBe(true)
  expect(reopened.form.host).toBe("")
})

test("新建连接保存成功后发送刷新和关闭事件，不重复加载管理列表", async () => {
  const h = harness(true)
  Object.assign(h.form, { name: "Development", host: "dev.example" })
  await h.save()
  expect(h.api.sshConnectionSave).toHaveBeenCalledWith(
    expect.objectContaining({ name: "Development", host: "dev.example", kind: "ssh" }),
  )
  expect(h.dialogOpen.value).toBe(false)
  expect(h.emit.mock.calls).toEqual([["created"], ["close"]])
  expect(h.api.sshConnectionList).not.toHaveBeenCalled()
})

test("保存失败保留新建弹窗及错误，不发送关闭或创建事件", async () => {
  const h = harness(true)
  Object.assign(h.form, { name: "Development", host: "dev.example" })
  h.api.sshConnectionSave.mockRejectedValueOnce(new Error("save failed"))
  await h.save()
  expect(h.dialogOpen.value).toBe(true)
  expect(h.formError.value).toBe("save failed")
  expect(h.emit).not.toHaveBeenCalled()
})

test("设置页仍默认显示管理列表，新建和保存不发送父级关闭事件", async () => {
  const h = harness()
  expect(h.dialogOpen.value).toBe(false)
  expect(h.api.sshConnectionList).toHaveBeenCalledOnce()
  h.openCreate()
  expect(h.dialogOpen.value).toBe(true)
  h.onDialogOpenChange(false)
  expect(h.emit).not.toHaveBeenCalled()
  h.openCreate()
  Object.assign(h.form, { name: "Development", host: "dev.example" })
  await h.save()
  expect(h.dialogOpen.value).toBe(false)
  expect(h.api.sshConnectionList).toHaveBeenCalledTimes(2)
  expect(h.emit).not.toHaveBeenCalled()
})

test("项目弹窗在 DialogContent 内以仅新建模式挂载连接弹窗", () => {
  const projectSource = readFileSync(new URL("../src/components/CreateProjectDialog.vue", import.meta.url), "utf8")
  const project = parse(projectSource).descriptor
  const content = elements(project.template!.ast, "DialogContent")[0]
  const settings = elements(content, "SshSettings")
  expect(settings).toHaveLength(1)
  expect(settings[0].props.some(prop => prop.name === "create-only")).toBe(true)
  expect(settings[0].props.some(prop => prop.name === "if" && prop.exp?.content === "showConnectionDialog")).toBe(true)
})

test("远程连接表单关闭自动补全，不提供历史输入建议", () => {
  const template = descriptor.template!.ast
  const forms = elements(template, "form")
  expect(forms).toHaveLength(1)
  expect(forms[0].props.some(prop => prop.name === "autocomplete" && prop.value?.content === "off")).toBe(true)
  expect(elements(template, "datalist")).toHaveLength(0)
  for (const input of elements(forms[0], "Input")) {
    expect(input.props.some(prop => prop.name === "list" || (prop.name === "bind" && prop.arg?.content === "list"))).toBe(false)
  }
})

test("主机和私钥路径不显示占位文字，移除私钥存储说明", () => {
  const inputs = elements(descriptor.template!.ast, "Input")
  for (const id of ["ssh-host", "ssh-key-path"]) {
    const input = inputs.find(element => element.props.some(prop => prop.name === "id" && prop.value?.content === id))
    expect(input).toBeDefined()
    expect(
      input.props.some(prop => prop.name === "placeholder" || (prop.name === "bind" && prop.arg?.content === "placeholder")),
    ).toBe(false)
  }
  expect(descriptor.template!.content).not.toContain("ssh.keyPathHint")
})
