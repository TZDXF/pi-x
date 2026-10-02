import { afterEach, expect, test, vi } from "vitest"
import { effectScope, reactive, ref, type EffectScope } from "vue"
import { useContentTranslation } from "@/composables/useContentTranslation"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const scopes: EffectScope[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))
function harness() {
  const scope = effectScope()
  scopes.push(scope)
  const identity = reactive({ file: "README.md", resource: "one", project: "C:/one" })
  const locale = ref("zh-CN")
  const requests: ReturnType<typeof deferred<string>>[] = []
  const send = vi.fn((_content: string, _language: string) => {
    const request = deferred<string>()
    requests.push(request)
    return request.promise
  })
  const onError = vi.fn()
  const api = scope.run(() =>
    useContentTranslation({
      source: () => [identity.file, identity.resource, identity.project],
      locale,
      translate: send,
      onError,
    }),
  )!
  return { scope, identity, locale, requests, send, onError, api }
}

test("empty content and duplicate clicks do not issue translation requests", async () => {
  const h = harness()
  await h.api.translate(" \n ")
  expect(h.send).not.toHaveBeenCalled()
  const pending = h.api.translate("# Original")
  await h.api.translate("ignored")
  expect(h.send).toHaveBeenCalledExactlyOnceWith("# Original", "Simplified Chinese")
  expect(h.api.translating.value).toBe(true)
  h.requests[0].resolve("# Translated")
  await pending
  expect(h.api.translated.value).toBe("# Translated")
  expect(h.api.translating.value).toBe(false)
})

for (const field of ["file", "resource", "project"] as const) {
  test(`${field} changes synchronously invalidate old results without clearing a new request`, async () => {
    const h = harness()
    const old = h.api.translate("old")
    h.identity[field] = "new"
    expect(h.api.translating.value).toBe(false)
    const current = h.api.translate("new")
    h.requests[0].resolve("stale")
    await old
    expect(h.api.translated.value).toBe("")
    expect(h.api.translating.value).toBe(true)
    h.requests[1].resolve("current")
    await current
    expect(h.api.translated.value).toBe("current")
  })
}

test("locale changes invalidate pending and completed translations and select the new language", async () => {
  const h = harness()
  const old = h.api.translate("old")
  h.locale.value = "en"
  const current = h.api.translate("new")
  expect(h.send).toHaveBeenLastCalledWith("new", "English")
  h.requests[1].resolve("English result")
  await current
  h.requests[0].resolve("stale Chinese result")
  await old
  expect(h.api.translated.value).toBe("English result")
  h.locale.value = "zh-CN"
  expect(h.api.translated.value).toBe("")
})

test("only an active failure is reported; stale failures cannot stop the current spinner", async () => {
  const h = harness()
  const old = h.api.translate("old")
  h.identity.file = "next.md"
  const current = h.api.translate("current")
  h.requests[0].reject(new Error("stale failure"))
  await old
  expect(h.onError).not.toHaveBeenCalled()
  expect(h.api.translating.value).toBe(true)
  const failure = new Error("active failure")
  h.requests[1].reject(failure)
  await current
  expect(h.onError).toHaveBeenCalledExactlyOnceWith(failure)
  expect(h.api.translating.value).toBe(false)
})

for (const outcome of ["success", "failure"]) {
  test(`unmount ignores pending ${outcome} and prevents later requests`, async () => {
    const h = harness()
    const old = h.api.translate("old")
    h.scope.stop()
    if (outcome === "success") h.requests[0].resolve("stale")
    else h.requests[0].reject(new Error("stale"))
    await old
    await h.api.translate("after unmount")
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.onError).not.toHaveBeenCalled()
    expect(h.api.translated.value).toBe("")
    expect(h.api.translating.value).toBe(false)
  })
}
