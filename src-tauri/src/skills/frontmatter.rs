//! Pure SKILL.md frontmatter parsing: extract `name` / `description`.

use std::path::Path;

/// Extract `name` / `description` from a skill Markdown frontmatter block.
pub(super) fn parse_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let clean = |s: &str| {
        s.trim()
            .trim_matches('"')
            .trim_matches('\'')
            .trim()
            .to_string()
    };
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let (mut name, mut description) = (None, None);
    let mut block_lines = Vec::new();
    let mut block_style = None;
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" || trimmed == "..." {
            break;
        }
        if let Some(style) = block_style {
            if line.starts_with([' ', '\t']) || trimmed.is_empty() {
                block_lines.push(trimmed);
                continue;
            }
            description = Some(fold_description(&block_lines, style));
            block_lines.clear();
            block_style = None;
        }
        if let Some(rest) = trimmed.strip_prefix("name:") {
            let v = clean(rest);
            if !v.is_empty() {
                name = Some(v);
            }
        } else if let Some(rest) = trimmed.strip_prefix("description:") {
            let v = clean(rest);
            if let Some(style) = v.chars().next().filter(|c| *c == '>' || *c == '|') {
                block_style = Some(style);
            } else if !v.is_empty() {
                description = Some(v);
            }
        }
    }
    if let Some(style) = block_style {
        description = Some(fold_description(&block_lines, style));
    }
    (name, description)
}

/// Collapse a YAML block scalar for display, keeping paragraph breaks.
fn fold_description(lines: &[&str], style: char) -> String {
    let mut text = String::new();
    for line in lines {
        if line.is_empty() {
            if !text.is_empty() && !text.ends_with('\n') {
                text.push('\n');
            }
        } else {
            if !text.is_empty() && !text.ends_with('\n') {
                text.push(if style == '|' { '\n' } else { ' ' });
            }
            text.push_str(line);
        }
    }
    text.trim().to_string()
}

/// Read a skill Markdown file and return its frontmatter values.
pub(super) fn read_frontmatter(file: &Path) -> Result<(Option<String>, Option<String>), String> {
    let raw = std::fs::read_to_string(file).map_err(|e| format!("{}: {e}", file.display()))?;
    Ok(parse_frontmatter(&raw))
}

pub(crate) fn valid_skill_markdown(file: &Path) -> bool {
    read_frontmatter(file)
        .ok()
        .and_then(|(_, description)| description)
        .is_some_and(|description| !description.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter() {
        let (name, description) = parse_frontmatter(crate::skills::test_util::SKILL_MD);
        assert_eq!(name.as_deref(), Some("my-skill"));
        assert_eq!(description.as_deref(), Some("Does things."));
        let (name, description) = parse_frontmatter("# no frontmatter\n");
        assert_eq!(name, None);
        assert_eq!(description, None);
        let (name, description) = parse_frontmatter(
            "---\nname: find-docs\ndescription: >-\n  Retrieves up-to-date documentation\n  for developer tools.\n\n  Use it for APIs.\nmetadata: test\n---\n"
        );
        assert_eq!(name.as_deref(), Some("find-docs"));
        assert_eq!(
            description.as_deref(),
            Some("Retrieves up-to-date documentation for developer tools.\nUse it for APIs.")
        );
        let (_, description) =
            parse_frontmatter("---\ndescription: |\n  First line\n  Second line\n---\n");
        assert_eq!(description.as_deref(), Some("First line\nSecond line"));
    }
}
