import { shallowRef, watchEffect } from "vue"

/** Keep hidden panels' last value without subscribing to expensive live data. */
export function useVisibleSnapshot<T>(visible: () => boolean, read: () => T, initial: T) {
  const snapshot = shallowRef<T>(initial)
  watchEffect(() => {
    if (visible()) snapshot.value = read()
  })
  return snapshot
}
