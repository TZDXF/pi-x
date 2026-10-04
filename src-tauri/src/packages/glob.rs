//! Glob matching for package resource filters: the `**` / `*` / `?` matcher
//! with a compiled-regex cache, and the pi-compatible enable/disable pattern
//! semantics (`!` excludes, `+path` / `-path` force-include / force-exclude).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// Build the regex backing one glob pattern; `None` when compilation fails.
fn compile_glob(pattern: &str) -> Option<regex::Regex> {
    let mut re = String::from("^");
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next();
                    // `**/` should also match zero segments
                    if chars.peek() == Some(&'/') {
                        chars.next();
                        re.push_str("(?:.*/)?");
                    } else {
                        re.push_str(".*");
                    }
                } else {
                    re.push_str("[^/]*");
                }
            }
            '?' => re.push_str("[^/]"),
            c => re.push_str(&regex::escape(&c.to_string())),
        }
    }
    re.push('$');
    regex::Regex::new(&re).ok()
}

/// Cap on cached patterns; package filters are a handful of patterns, so this
/// never triggers in practice but keeps the cache bounded.
const GLOB_CACHE_CAP: usize = 256;

/// Simplistic glob matcher supporting `**`, `*`, `?` against posix paths.
/// Compiled regexes are cached per pattern: `glob_match` runs once per walked
/// file inside `collect_resources`, and recompiling on every call dominates
/// large package walks.
pub(crate) fn glob_match(pattern: &str, path: &str) -> bool {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<regex::Regex>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut cache = match cache.lock() {
        Ok(cache) => cache,
        // Poisoned lock: fall back to compiling on the fly.
        Err(_) => return compile_glob(pattern).is_some_and(|re| re.is_match(path)),
    };
    if !cache.contains_key(pattern) {
        if cache.len() >= GLOB_CACHE_CAP {
            cache.clear();
        }
        cache.insert(pattern.to_string(), compile_glob(pattern));
    }
    cache
        .get(pattern)
        .and_then(|re| re.clone())
        .is_some_and(|re| re.is_match(path))
}

/// Strip a leading override marker (`!`, `+`, `-`) from a filter pattern.
pub(crate) fn strip_pattern_marker(p: &str) -> &str {
    p.strip_prefix(['!', '+', '-']).unwrap_or(p)
}

/// Whether a resource is enabled under the given filter patterns
/// (mirrors pi's pattern semantics: plain patterns include, `!` excludes,
/// `+path` / `-path` force-include / force-exclude exact paths).
pub(crate) fn resource_enabled(rel: &str, patterns: Option<&[String]>) -> bool {
    let Some(pats) = patterns else { return true };
    if pats.is_empty() {
        return false; // explicit `[]` loads none of this type
    }
    let includes: Vec<&String> = pats
        .iter()
        .filter(|p| !p.starts_with(['!', '+', '-']))
        .collect();
    let mut enabled = includes.is_empty()
        || includes
            .iter()
            .any(|p| glob_match(p.trim_end_matches("/*"), rel) || glob_match(p, rel));
    for p in pats {
        let marker = p.chars().next();
        let target = strip_pattern_marker(p);
        match marker {
            Some('!') if glob_match(target, rel) => enabled = false,
            Some('+') if target == rel => enabled = true,
            Some('-') if target == rel => enabled = false,
            _ => {}
        }
    }
    enabled
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_matching() {
        assert!(glob_match("extensions/*.ts", "extensions/foo.ts"));
        assert!(!glob_match("extensions/*.ts", "extensions/sub/foo.ts"));
        assert!(glob_match("extensions/**/*.ts", "extensions/sub/foo.ts"));
        assert!(glob_match("extensions/**/*.ts", "extensions/foo.ts"));
        assert!(glob_match("skills/*/SKILL.md", "skills/demo/SKILL.md"));
        assert!(!glob_match("skills/*", "other/x"));
    }

    #[test]
    fn resource_enabled_semantics() {
        // absent key -> all enabled
        assert!(resource_enabled("a.ts", None));
        // explicit [] -> none enabled
        assert!(!resource_enabled("a.ts", Some(&[])));
        // exclusion overrides
        let pats: Vec<String> = vec!["!a.ts".into()];
        assert!(!resource_enabled("a.ts", Some(&pats)));
        assert!(resource_enabled("b.ts", Some(&pats)));
        // force-exclude beats force-include
        let pats: Vec<String> = vec!["+a.ts".into(), "-a.ts".into()];
        assert!(!resource_enabled("a.ts", Some(&pats)));
        // plain includes gate everything else
        let pats: Vec<String> = vec!["extensions/*.ts".into()];
        assert!(resource_enabled("extensions/a.ts", Some(&pats)));
        assert!(!resource_enabled("skills/x/SKILL.md", Some(&pats)));
    }
}
