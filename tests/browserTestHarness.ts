import { createRenderer, defineComponent } from "vue"

// Mount composables with real Vue lifecycle hooks, but no browser/DOM/network.
interface HostNode {
  parent: HostNode | null
  children: HostNode[]
}
const node = (): HostNode => ({ parent: null, children: [] })
const renderer = createRenderer<HostNode, HostNode>({
  createElement: node,
  createText: node,
  createComment: node,
  insert(child, parent) {
    child.parent = parent
    parent.children.push(child)
  },
  remove(child) {
    const siblings = child.parent?.children
    if (siblings) siblings.splice(siblings.indexOf(child), 1)
    child.parent = null
  },
  parentNode: child => child.parent,
  nextSibling: () => null,
  setText() {},
  setElementText() {},
  patchProp() {},
})

export function mountBrowserComposable<T>(setup: () => T) {
  let result!: T
  const app = renderer.createApp(
    defineComponent({
      setup() {
        result = setup()
        return () => null
      },
    }),
  )
  app.mount(node())
  return { result, unmount: () => app.unmount() }
}
