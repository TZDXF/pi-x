// 文件预览的代码着色：复用共享着色器（纯 JS 正则引擎，见 lib/codeHighlight）的
// 双主题分词与 reviewHighlight 的行内 HTML 拼接（github-light / github-dark
// 变量由使用方的 CSS 切换），整文件着色后按行返回；超过阈值或语言未收录时
// 返回 null，调用方回退纯文本渲染。
import { tokenizeLines } from "@/lib/codeHighlight"
import { diffLangOf, tokensToLineHtml } from "@/lib/reviewHighlight"

/** 超过该字符数跳过着色，保留纯文本渲染（与 diff 审查的 MAX_CHARS 同口径）。 */
const MAX_HIGHLIGHT_CHARS = 200_000

/** 返回逐行着色 HTML（与源码按 \n 拆行一一对齐）；null 表示不着色。 */
export async function highlightFileLines(text: string, path: string): Promise<string[] | null> {
  if (!text || text.length > MAX_HIGHLIGHT_CHARS) return null
  const lang = diffLangOf(path)
  if (lang === "text") return null
  const tokens = await tokenizeLines(text, lang)
  return tokens?.map(line => tokensToLineHtml(line)) ?? null
}
