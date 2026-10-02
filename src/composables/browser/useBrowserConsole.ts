import { ref } from "vue"

export interface ConsoleEntry {
  id: number
  level: "log" | "info" | "warn" | "error" | "debug"
  text: string
}

/** A bounded console capture buffer, independent of navigation/history. */
export function useBrowserConsole() {
  const consoleEntries = ref<ConsoleEntry[]>([])
  let consoleSeq = 0

  function pushConsole(level: ConsoleEntry["level"], text: string) {
    consoleEntries.value.push({ id: ++consoleSeq, level, text })
    if (consoleEntries.value.length > 200) consoleEntries.value.splice(0, consoleEntries.value.length - 200)
  }

  return { consoleEntries, pushConsole }
}
