import type { ComarkPlugin, StreamMarkdownParserOptions } from "vue-stream-markdown"

/**
 * 阻止 Markdown 渲染把“像域名的文件名”自动变成链接。
 *
 * 渲染链：`<Markdown>`（vue-stream-markdown）→ @markmend/parser → comark →
 * markdown-exit。comark 默认 `linkify: true`，markdown-exit 的 core `linkify`
 * 规则用 linkify-it 的 TLD 白名单识别**无协议裸文本**；linkify-it 把 `.py`
 * （巴拉圭国家级 TLD）、`.sh`、`.rs`、`.md`、`.ai`、`.cc`、`.ml`、`.so` 等后缀
 * 也算作合法 TLD，于是 `session.py`、`config.sh`、`main.rs`、`session.py:42`
 * 会被补成 `http://session.py` 这类假链接。
 *
 * 处理方式：只保留“明确是链接”的自动链接，其余退化成纯文本。明确 = 带协议
 * 分隔的 `scheme://…`、`www.` 前缀、带路径/查询/锚点（`/`、`?`、`#`）或邮箱
 * （含 `@`）。`<https://…>` 与 `[文本](url)` 不经这条规则，始终可用。
 *
 * 只有裸域名本身（`example.com`）或“裸域名+端口”（`example.com:8080`）会退化为
 * 纯文本：它们与 `session.py:42` 这类“文件:行号”在字形上无法区分，宁可漏链也
 * 不要给文件名套上假链接；需要可点击时写成 `[example.com](http://example.com)`
 * 或补上路径（`example.com/x` 仍会自动识别）。
 */
export function isDeliberateAutoLink(text: string): boolean {
  return /^[a-z][a-z0-9.+-]*:\/\//i.test(text) || /^www\./i.test(text) || /[/?#@]/.test(text)
}

/** markdown-it Token 的最小结构，只覆盖本规则读写的字段。 */
interface AutoLinkToken {
  type: string
  content: string
  markup: string
  level: number
  children?: AutoLinkToken[] | null
}

interface AutoLinkState {
  tokens: AutoLinkToken[]
}

/** 只依赖 markdown-exit（markdown-it 兼容）的 core ruler 接口。 */
export interface AutoLinkMarkdownIt {
  core: { ruler: { after(afterName: string, ruleName: string, fn: (state: AutoLinkState) => void): void } }
}

/**
 * core 规则：排在 `linkify` 之后，把没有明确链接意图的自动链接
 * （`link_open` + `text` + `link_close` 三连）还原成一个纯文本 token，
 * 随后由 `text_join` 与相邻文本合并。
 */
function guardAutoLinks(state: AutoLinkState) {
  for (const block of state.tokens) {
    const children = block.children
    if (block.type !== "inline" || !children) continue
    for (let i = 0; i < children.length; i++) {
      const open = children[i]
      if (open.type !== "link_open" || open.markup !== "linkify") continue
      const text = children[i + 1]
      const close = children[i + 2]
      if (text?.type !== "text" || close?.type !== "link_close" || close.markup !== "linkify") continue
      if (isDeliberateAutoLink(text.content)) continue
      text.level = open.level
      children.splice(i, 3, text)
    }
  }
}

const autoLinkGuardPlugin: ComarkPlugin = {
  name: "pix-auto-link-guard",
  markdownItPlugins: [
    md => (md as unknown as AutoLinkMarkdownIt).core.ruler.after("linkify", "pix-auto-link-guard", guardAutoLinks),
  ],
}

/** 供全部 `<Markdown>` 使用方传入的 parserOptions（各处的链接渲染行为保持一致）。 */
export const markdownParserOptions: StreamMarkdownParserOptions = {
  plugins: [autoLinkGuardPlugin],
}
