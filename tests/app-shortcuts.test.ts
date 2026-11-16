import { expect, test, vi } from "vitest"
import { ref } from "vue"
import { useAppShortcuts } from "@/composables/useAppShortcuts"

test("devtools shortcuts ignore missing keys and keep valid shortcuts working", () => {
  const dispatchShortcut = vi.fn()
  const toggleDevtools = vi.fn()
  const { onGlobalKeydown, disposeShortcuts } = useAppShortcuts({
    developerModeEnabled: ref(true),
    isDesktop: true,
    phase: ref("chat"),
    ui: { activeDialog: null },
    toggleDevtools,
    shortcuts: { dispatchShortcut, registerShortcutHandler: () => () => {} },
  } as unknown as Parameters<typeof useAppShortcuts>[0])

  for (const key of [undefined, null, "", 42]) {
    const event = { key, ctrlKey: true, shiftKey: true, altKey: false, preventDefault: vi.fn() }
    expect(() => onGlobalKeydown(event as unknown as KeyboardEvent)).not.toThrow()
    expect(event.preventDefault).not.toHaveBeenCalled()
  }
  expect(toggleDevtools).not.toHaveBeenCalled()
  expect(dispatchShortcut).not.toHaveBeenCalled()

  for (const key of ["F12", "i", "I"]) {
    const event = { key, ctrlKey: true, shiftKey: true, altKey: false, preventDefault: vi.fn() }
    onGlobalKeydown(event as unknown as KeyboardEvent)
    expect(event.preventDefault).toHaveBeenCalledOnce()
  }
  expect(toggleDevtools).toHaveBeenCalledTimes(3)

  const regularEvent = { key: "k", ctrlKey: true } as KeyboardEvent
  onGlobalKeydown(regularEvent)
  expect(dispatchShortcut).toHaveBeenCalledExactlyOnceWith(regularEvent)
  disposeShortcuts()
})

test("new session shortcut delegates to the layout-aware app action", () => {
  const handlers = new Map<string, () => void>()
  const newSessionFromChat = vi.fn()
  const newProjectSession = vi.fn()
  useAppShortcuts({
    phase: ref("chat"),
    newSessionFromChat,
    newProjectSession,
    shortcuts: {
      dispatchShortcut: vi.fn(),
      registerShortcutHandler: (name, handler) => {
        handlers.set(name, handler)
        return () => {}
      },
    },
  } as unknown as Parameters<typeof useAppShortcuts>[0])
  handlers.get("app.newSession")!()
  expect(newSessionFromChat).toHaveBeenCalledOnce()
  expect(newProjectSession).not.toHaveBeenCalled()
})
