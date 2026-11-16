/**
 * Split leading YAML frontmatter from the Markdown body without reformatting it.
 * Comark extracts frontmatter into document metadata, which the preview does
 * not render, so the preview presents the original YAML and body separately.
 */
export function splitMarkdownFrontmatter(source: string): { frontmatter: string | null; body: string } {
  const opening = /^---[ \t]*(\r?\n)/.exec(source)
  if (!opening) return { frontmatter: null, body: source }

  const rest = source.slice(opening[0].length)
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(rest)
  if (!closing) return { frontmatter: null, body: source }

  const frontmatter = rest.slice(0, closing.index).replace(/\r?\n$/, "")
  const body = rest.slice(closing.index + closing[0].length)
  return { frontmatter, body }
}
