import { fileURLToPath } from "node:url"
import path from "node:path"
import { createServer, type ViteDevServer } from "vite"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

export interface VueHarness {
  /** Full URL of the Vite-served HTML harness. */
  url: string
  close: () => Promise<void>
}

export interface VueHarnessOptions {
  /** Unique lowercase slug, used as both the middleware path and plugin name. */
  name: string
  /** Dedicated port lets specs run in parallel without colliding. */
  port: number
  html: string
  /** Optional extra middleware or Vite hooks beyond the HTML harness. */
  setup?: (server: ViteDevServer) => void | Promise<void>
}

/** Start the real Vite module graph with a small fixture-mounted Vue entry. */
export async function startVueHarness(options: VueHarnessOptions): Promise<VueHarness> {
  const route = `/__${options.name}`
  const server = await createServer({
    configFile: path.join(projectRoot, "vite.config.ts"),
    root: projectRoot,
    server: { port: options.port, strictPort: true },
    plugins: [
      {
        name: `pix-e2e-${options.name}`,
        configureServer(viteServer) {
          viteServer.middlewares.use(route, async (_request, response, next) => {
            try {
              response.setHeader("Content-Type", "text/html")
              response.end(await viteServer.transformIndexHtml(route, options.html))
            } catch (error) {
              next(error)
            }
          })
        },
      },
    ],
  })
  await server.listen()
  await options.setup?.(server)
  return {
    url: `http://localhost:${options.port}${route}`,
    close: async () => {
      await server.close()
    },
  }
}
