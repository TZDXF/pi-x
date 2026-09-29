import path from "node:path"
import process from "node:process"
import { defineConfig } from "vitest/config"

// Keep the previous runner's serial semantics while reusing one worker.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(process.cwd(), "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/*.test.ts"],
    exclude: ["tests/*.browser.mjs"],
    isolate: false,
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
  },
})
