//! LLM-backed translation of package resource files: spawns an isolated pi
//! process (same pattern as title generation) with the configured translation
//! model and returns the translated text. Unrelated to resource management.

use serde_json::Value;

use crate::errors::pix_error;

/// Translate a package resource file's content using the configured
/// translation model. Spawns an isolated pi process (same pattern as title
/// generation) and returns the translated text.
#[tauri::command]
pub async fn package_translate(
    app: tauri::AppHandle,
    content: String,
    target_lang: String,
) -> Result<String, String> {
    let config = crate::commands::app_config_get(app)?;
    let model = config.translation_model.clone().or_else(|| config.default_model.clone());
    let Some(model) = model else {
        return Err(pix_error("noTranslationModel", "未配置翻译模型，请在模型配置中选择"));
    };
    if model.provider.trim().is_empty() || model.model_id.trim().is_empty() || content.trim().is_empty() {
        return Err(pix_error("noTranslationModel", "翻译模型或内容为空"));
    }
    let pi = crate::pi_locate::detect(config.pi_path).await;
    let mut cmd = match pi.launcher {
        Some(crate::pi_locate::Launcher::Node { node, script }) => {
            let mut c = tokio::process::Command::new(node);
            c.arg(script);
            c
        }
        Some(crate::pi_locate::Launcher::Binary { path }) => tokio::process::Command::new(path),
        None => return Err(pix_error("piNotFound", "未找到 pi，无法执行翻译")),
    };
    cmd.args([
        "--print", "--mode", "json", "--no-session", "--no-tools", "--no-extensions",
        "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
        "--provider", model.provider.trim(),
        "--model", model.model_id.trim(),
        "--append-system-prompt", "",
        "--system-prompt",
        "You are a translator. Translate the user's input into the requested language. Preserve markdown formatting, code blocks, and inline code exactly. Output only the translation, no explanations.",
    ])
    .args(crate::builtin_extensions::provider_extension_args(
        &model.provider,
    ))
    .current_dir(crate::trust::agent_dir())
    .stdin(std::process::Stdio::piped())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::null())
    .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);

    let output = tokio::time::timeout(std::time::Duration::from_secs(120), async {
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let mut stdin = child.stdin.take().ok_or("Missing stdin")?;
        let prompt = format!("Translate the following into {target_lang}:\n\n{content}");
        { use tokio::io::AsyncWriteExt; stdin.write_all(prompt.as_bytes()).await }.map_err(|e| e.to_string())?;
        drop(stdin);
        let mut stdout = child.stdout.take().ok_or("Missing stdout")?;
        let mut buf = Vec::new();
        tokio::io::AsyncReadExt::read_to_end(&mut stdout, &mut buf).await.map_err(|e| e.to_string())?;
        child.wait().await.map_err(|e| e.to_string())?;
        Ok::<_, String>(buf)
    })
    .await
    .map_err(|_| pix_error("translationTimeout", "翻译超时（2 分钟）"))??;

    // Extract text from the last assistant message_end event (same as title generation).
    let mut translated = String::new();
    for line in output.split(|b| *b == b'\n') {
        let Ok(event) = serde_json::from_slice::<Value>(line) else { continue };
        if event["type"] != "message_end" || event["message"]["role"] != "assistant" { continue; }
        if matches!(event["message"]["stopReason"].as_str(), Some("error" | "aborted")) {
            return Err(pix_error("translationFailed", "翻译模型返回错误"));
        }
        if let Some(blocks) = event["message"]["content"].as_array() {
            let text = blocks.iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("");
            if !text.trim().is_empty() {
                translated = text;
            }
        }
    }
    if translated.trim().is_empty() {
        return Err(pix_error("translationEmpty", "翻译结果为空"));
    }
    Ok(translated)
}
