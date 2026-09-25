//! Bundled tool-permission extension for pi. The template is generated per
//! (mode, locale) variant so concurrent runtimes never share mutable files.
use std::path::PathBuf;

const TEMPLATE: &str = include_str!("permission-extension.ts");
const PLACEHOLDER: &str = "const PIX_CONFIG = { mode: \"\", locale: \"\" }";

/// Render the extension source for a mode ("ask" | "highRisk") and UI locale.
pub fn render(mode: &str, locale: &str) -> Result<String, String> {
    if !matches!(mode, "ask" | "highRisk") {
        return Err(format!("Unsupported permission mode: {mode}"));
    }
    let locale = if locale.starts_with("zh") { "zh-CN" } else { "en" };
    let config = format!(
        "const PIX_CONFIG = {{ mode: {}, locale: {} }}",
        serde_json::Value::String(mode.into()),
        serde_json::Value::String(locale.into()),
    );
    if !TEMPLATE.contains(PLACEHOLDER) {
        return Err("Permission extension template lost its config placeholder".into());
    }
    Ok(TEMPLATE.replacen(PLACEHOLDER, &config, 1))
}

/// Write the (mode, locale) variant if stale and return its path for `pi -e`.
pub fn extension_file(mode: &str, locale: &str) -> Result<PathBuf, String> {
    let content = render(mode, locale)?;
    let locale = if locale.starts_with("zh") { "zh-CN" } else { "en" };
    let dir = crate::data_dir::root().join("extensions");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("pix-permission-{mode}-{locale}.ts"));
    if std::fs::read_to_string(&file).ok().as_deref() != Some(content.as_str()) {
        std::fs::write(&file, &content).map_err(|e| e.to_string())?;
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_bakes_mode_and_locale_into_the_template() {
        let zh = render("highRisk", "zh-CN").unwrap();
        assert!(zh.contains("const PIX_CONFIG = { mode: \"highRisk\", locale: \"zh-CN\" }"));
        assert!(!zh.contains(PLACEHOLDER));
        assert!(render("ask", "fr").unwrap().contains("locale: \"en\""));
        assert!(render("full", "en").is_err());
        assert!(render("ask\"; exploit", "en").is_err());
    }
}
