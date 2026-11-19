/**
 * 应用内共享的 shiki 着色器（文件预览与 diff 审查共用一个 core 与语法缓存）。
 *
 * 为什么不用 shiki 默认的 `codeToTokens`：默认构造器加载 oniguruma 的 WASM 引擎，
 * 而桌面端 Tauri 的 CSP 是 `script-src 'self'`（没有 `'wasm-unsafe-eval'`），
 * `WebAssembly.compile` 会被直接拒绝；异常被调用方的 `catch` 吞成"不着色"，
 * 于是桌面端文件预览静默退化成纯文本（浏览器 dev 下没有该 CSP，问题看不出来）。
 *
 * 这里改用纯 JavaScript 正则引擎：oniguruma-to-es 把 Oniguruma 语法翻译成 RegExp，
 * 不编译 WASM，因此在同样的 CSP 下可用；仓库里的 Markdown 渲染（comark）也走这条路。
 * 代价是首次编译某个语法的正则比 WASM 慢（大语法尤甚，如 cpp / emacs-lisp），
 * 因此语法按需加载、每种只编译一次，且只在真正预览到该语言时才付出这份开销。
 */
import { createHighlighterCore, type HighlighterCore } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import { bundledLanguages } from "shiki/langs"
import type { BundledLanguage, BundledTheme, ThemedToken } from "shiki"

/** 双主题（github-light / github-dark）分词，颜色以 CSS 变量输出给调用方切换。 */
export const HIGHLIGHT_THEMES: Record<"light" | "dark", BundledTheme> = {
  light: "github-light",
  dark: "github-dark",
}

let corePromise: Promise<HighlighterCore> | null = null
/** 已加载（编译完成）的语法；`loadLanguage` 幂等，这里省掉重复的模块导入。 */
const loadedLanguages = new Set<string>()
/** 同一个语法可能被并发请求，缓存进行中的 Promise，避免重复编译。 */
const loadingLanguages = new Map<string, Promise<boolean>>()

async function createCore(): Promise<HighlighterCore> {
  const [light, dark] = await Promise.all([
    import("shiki/themes/github-light.mjs"),
    import("shiki/themes/github-dark.mjs"),
  ])
  return createHighlighterCore({
    themes: [light.default, dark.default],
    // 语法一律按需加载：预览到哪种文件才编译哪种语法。
    langs: [],
    // forgiving：个别语法的正则无法完全翻译成 RegExp 时跳过该模式，而不是让整个语法失败。
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  })
}

function getCore(): Promise<HighlighterCore> {
  if (!corePromise) {
    // 初始化失败不要留下永久 rejected 的 Promise：下次预览重新尝试。
    corePromise = createCore().catch(error => {
      corePromise = null
      throw error
    })
  }
  return corePromise
}

/** 确保语法可用；未收录的语言返回 false（调用方回退纯文本）。 */
function ensureLanguage(core: HighlighterCore, lang: string): Promise<boolean> {
  const pending = loadingLanguages.get(lang)
  if (pending) return pending
  if (loadedLanguages.has(lang)) return Promise.resolve(true)
  const loader = bundledLanguages[lang as BundledLanguage]
  if (!loader) return Promise.resolve(false)
  const loading = (async () => {
    try {
      const module = await loader()
      await core.loadLanguage(module.default)
      loadedLanguages.add(lang)
      return true
    } catch {
      return false
    } finally {
      loadingLanguages.delete(lang)
    }
  })()
  loadingLanguages.set(lang, loading)
  return loading
}

/**
 * 整段文本按行分词；返回的第一维与 `text.split("\n")` 一一对应（含末尾空行）。
 *
 * 空串不是错误：`"".split("\n")` 是单行，shiki 对空串也返回一行空 token，
 * 所以这里保留 `[[]]` 而不是 `null`。diff 侧只要有一行内容为空（如“新增一段代码、
 * 旧侧只有一个空行”），两侧分别 join 后就会得到空串 —— 若这里返回 null，
 * 调用方会连带丢掉整个 diff 的着色（TZD-136 验收发现的 P2 回归）。
 * 语言未收录、分词失败仍返回 null，由调用方回退纯文本。
 */
export async function tokenizeLines(text: string, lang: string): Promise<ThemedToken[][] | null> {
  if (lang === "text") return null
  try {
    const core = await getCore()
    if (!(await ensureLanguage(core, lang))) return null
    const { tokens } = core.codeToTokens(text, {
      lang: lang as BundledLanguage,
      themes: HIGHLIGHT_THEMES,
      defaultColor: false,
    })
    return tokens
  } catch {
    return null
  }
}
