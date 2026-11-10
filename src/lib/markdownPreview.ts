/**
 * Keep leading YAML frontmatter visible in rendered Markdown previews.
 * Comark extracts frontmatter into document metadata, which the preview does
 * not render, so present the original YAML as a code block before the body.
 */
export function withVisibleFrontmatter(source: string): string {
  const opening = /^---(\r?\n)/.exec(source)
  if (!opening) return source

  const eol = opening[1]
  const rest = source.slice(opening[0].length)
  const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(rest)
  if (!closing) return source

  const yaml = rest.slice(0, closing.index).replace(/\r?\n$/, "")
  const body = rest.slice(closing.index + closing[0].length)
  const longestBacktickRun = Math.max(0, ...[...yaml.matchAll(/`+/g)].map(match => match[0].length))
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1))

  const separator = body && !/^\r?\n/.test(body) ? eol + eol : eol
  return `${fence}yaml${eol}${yaml}${eol}${fence}${separator}${body}`
}
