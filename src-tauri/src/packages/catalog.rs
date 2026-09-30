//! Package catalog browsing (https://pi.dev/packages).

use serde::Serialize;

use crate::errors::pix_error_detail;

const CATALOG_URL: &str = "https://pi.dev/packages";

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPackage {
    pub name: String,
    pub description: String,
    pub author: String,
    /// Downloads in the last month (as reported by the catalog page).
    pub downloads_month: u64,
    /// Last publish time, unix epoch milliseconds.
    pub updated_ms: u64,
    /// Resource types the package ships (extension / skill / prompt / theme).
    pub types: Vec<String>,
    /// Install source, e.g. `npm:pi-mcp-adapter`.
    pub source: String,
    /// Absolute URL of the detail page on pi.dev.
    pub detail_url: String,
    pub npm_url: Option<String>,
}

fn unescape_html(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

fn strip_tags(s: &str) -> String {
    static TAGS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = TAGS.get_or_init(|| regex::Regex::new(r"<[^>]*>").unwrap());
    re.replace_all(s, "").to_string()
}

/// Precompiled catalog parsers, built once per process (parsing used to
/// recompile a regex per attribute lookup).
struct CatalogRegexes {
    name: regex::Regex,
    downloads: regex::Regex,
    date: regex::Regex,
    types: regex::Regex,
    desc: regex::Regex,
    author: regex::Regex,
    npm: regex::Regex,
    install: regex::Regex,
}

fn catalog_regexes() -> &'static CatalogRegexes {
    static RE: std::sync::OnceLock<CatalogRegexes> = std::sync::OnceLock::new();
    RE.get_or_init(|| CatalogRegexes {
        name: regex::Regex::new(r#"data-package-name="([^"]*)""#).unwrap(),
        downloads: regex::Regex::new(r#"data-package-downloads="([^"]*)""#).unwrap(),
        date: regex::Regex::new(r#"data-package-date="([^"]*)""#).unwrap(),
        types: regex::Regex::new(r#"data-package-types="([^"]*)""#).unwrap(),
        desc: regex::Regex::new(r#"(?s)<p class="packages-desc">(.*?)</p>"#).unwrap(),
        author: regex::Regex::new(r#"(?s)<div class="packages-meta">\s*<span>(.*?)</span>"#)
            .unwrap(),
        npm: regex::Regex::new(r#"href="(https://www\.npmjs\.com/package/[^"]+)""#).unwrap(),
        install: regex::Regex::new(r"pi install ([^\s<]+)").unwrap(),
    })
}

fn parse_catalog(html: &str) -> Vec<CatalogPackage> {
    let re = catalog_regexes();
    let attr_re = |r: &regex::Regex, tag: &str| -> Option<String> {
        Some(unescape_html(r.captures(tag)?.get(1)?.as_str()))
    };

    let mut out = Vec::new();
    for chunk in html.split(r#"data-package-card="true""#).skip(1) {
        let end = chunk.find("</article>").unwrap_or(chunk.len());
        let card = &chunk[..end];
        // attributes live on the opening <article> tag
        let tag_end = card.find('>').unwrap_or(0);
        let tag = &card[..tag_end];

        let Some(name) = attr_re(&re.name, tag) else {
            continue;
        };
        let description = re
            .desc
            .captures(card)
            .map(|c| {
                strip_tags(&unescape_html(c.get(1).unwrap().as_str()))
                    .trim()
                    .to_string()
            })
            .unwrap_or_default();
        let author = re
            .author
            .captures(card)
            .map(|c| strip_tags(c.get(1).unwrap().as_str()).trim().to_string())
            .unwrap_or_default();
        let downloads_month = attr_re(&re.downloads, tag)
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        let updated_ms = attr_re(&re.date, tag)
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        let mut types: Vec<String> = attr_re(&re.types, tag)
            .map(|v| v.split_whitespace().map(|s| s.to_string()).collect())
            .unwrap_or_default();
        if types.is_empty() {
            types.push("package".into());
        }
        let source = re
            .install
            .captures(card)
            .map(|c| unescape_html(c.get(1).unwrap().as_str()))
            .unwrap_or_else(|| format!("npm:{name}"));
        let npm_url = re
            .npm
            .captures(card)
            .map(|c| c.get(1).unwrap().as_str().to_string());

        out.push(CatalogPackage {
            detail_url: format!("https://pi.dev/packages/{name}"),
            name,
            description,
            author,
            downloads_month,
            updated_ms,
            types,
            source,
            npm_url,
        });
    }
    out
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPage {
    pub packages: Vec<CatalogPackage>,
    pub has_more: bool,
}

fn parse_catalog_page(html: &str) -> CatalogPage {
    static NEXT: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let next = NEXT.get_or_init(|| {
        regex::Regex::new(r#"<a\b[^>]*class="pagination-link"[^>]*>\s*Next\s*→\s*</a>"#).unwrap()
    });
    CatalogPage {
        packages: parse_catalog(html),
        has_more: next.is_match(html),
    }
}

fn catalog_request(query: &str, sort: &str, package_type: &str, page: u32) -> ureq::Request {
    ureq::get(CATALOG_URL)
        .query("name", query.trim())
        .query("sort", sort)
        .query("type", package_type)
        .query("page", &page.max(1).to_string())
        .set("User-Agent", "pi-x desktop")
        .timeout(std::time::Duration::from_secs(30))
}

/// Search the official catalog server-side; the website only returns one page.
#[tauri::command]
pub async fn package_catalog(
    query: Option<String>,
    sort: Option<String>,
    package_type: Option<String>,
    page: Option<u32>,
) -> Result<CatalogPage, String> {
    let html = tauri::async_runtime::spawn_blocking(move || {
        catalog_request(
            query.as_deref().unwrap_or(""),
            sort.as_deref().unwrap_or("downloads"),
            package_type.as_deref().unwrap_or(""),
            page.unwrap_or(1),
        )
        .call()
        .map_err(|e| pix_error_detail("marketFetchFailed", format!("获取插件市场失败: {e}"), e))?
        .into_string()
        .map_err(|e| {
            pix_error_detail(
                "marketResponseReadFailed",
                format!("读取插件市场响应失败: {e}"),
                e,
            )
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(parse_catalog_page(&html))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_search_parameters_are_encoded() {
        let request = catalog_request(" init & 中文 ", "recent", "skill", 2);
        let url = request.url();
        assert!(url.starts_with("https://pi.dev/packages?"));
        assert!(url.contains("name=init+%26+%E4%B8%AD%E6%96%87"));
        assert!(url.contains("sort=recent"));
        assert!(url.contains("type=skill"));
        assert!(url.contains("page=2"));
        assert!(catalog_request("", "downloads", "", 0)
            .url()
            .contains("page=1"));
    }

    #[test]
    fn catalog_pagination_only_counts_enabled_next_link() {
        assert!(parse_catalog_page(r#"<nav><a class="pagination-link" href="/packages?name=init&amp;page=2">Next →</a></nav>"#).has_more);
        assert!(!parse_catalog_page(r#"<a class="pagination-link" href="/packages?page=1">← Previous</a><span class="pagination-link is-disabled">Next →</span>"#).has_more);
        assert!(!parse_catalog_page("").has_more);
    }

    #[test]
    fn parses_catalog_cards() {
        let html = r#"<article class="surface-panel content-card" data-package-card="true" data-package-name="pi-mcp-adapter" data-package-search="x" data-package-types="extension skill" data-package-downloads="972000" data-package-date="1788380245174" data-package-sort-name="pi-mcp-adapter"><div class="packages-card-body"><h3 class="packages-name"><a href="/packages/pi-mcp-adapter">pi-mcp-adapter</a></h3><p class="packages-desc">MCP adapter &amp; more</p><div class="packages-meta"><span>nicopreme</span><span>972K/mo</span><span>1d ago</span></div><div class="packages-links"><a href="https://www.npmjs.com/package/pi-mcp-adapter">npm</a></div><div class="packages-install"><code><span class="prefix">$</span> pi install npm:pi-mcp-adapter</code></div></div></article>"#;
        let pkgs = parse_catalog(html);
        assert_eq!(pkgs.len(), 1);
        let p = &pkgs[0];
        assert_eq!(p.name, "pi-mcp-adapter");
        assert_eq!(p.description, "MCP adapter & more");
        assert_eq!(p.author, "nicopreme");
        assert_eq!(p.downloads_month, 972000);
        assert_eq!(p.updated_ms, 1788380245174);
        assert_eq!(p.types, vec!["extension", "skill"]);
        assert_eq!(p.source, "npm:pi-mcp-adapter");
        assert_eq!(
            p.npm_url.as_deref(),
            Some("https://www.npmjs.com/package/pi-mcp-adapter")
        );
    }

    #[test]
    fn parses_live_catalog_fixture() {
        let html = include_str!("../../tests/fixtures/packages.html");
        let pkgs = parse_catalog(html);
        assert!(
            pkgs.len() >= 50,
            "expected >= 50 packages, got {}",
            pkgs.len()
        );
        let mcp = pkgs
            .iter()
            .find(|p| p.name == "pi-mcp-adapter")
            .expect("pi-mcp-adapter");
        assert_eq!(mcp.source, "npm:pi-mcp-adapter");
        assert!(mcp.downloads_month > 0);
        assert!(!mcp.author.is_empty());
        // every card needs a usable install source and detail URL
        for p in &pkgs {
            assert!(!p.source.is_empty(), "{}: empty source", p.name);
            assert!(p.detail_url.starts_with("https://pi.dev/packages/"));
        }
    }

    #[test]
    fn empty_types_fall_back_to_package() {
        let html = r#"<article data-package-card="true" data-package-name="x" data-package-types="" data-package-downloads="0" data-package-date="0"><p class="packages-desc"></p></article>"#;
        let pkgs = parse_catalog(html);
        assert_eq!(pkgs[0].types, vec!["package"]);
    }
}
