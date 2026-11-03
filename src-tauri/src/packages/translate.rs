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
    let model = config
        .translation_model
        .clone()
        .or_else(|| config.default_model.clone());
    let Some(model) = model else {
        return Err(pix_error(
            "noTranslationModel",
            "未配置翻译模型，请在模型配置中选择",
        ));
    };
    if model.provider.trim().is_empty()
        || model.model_id.trim().is_empty()
        || content.trim().is_empty()
    {
        return Err(pix_error("noTranslationModel", "翻译模型或内容为空"));
    }
    let pi = crate::pi_locate::detect(config.pi_path).await;
    let mut cmd = crate::pi_locate::command_for(&pi)?;
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

    let output = tokio::time::timeout(std::time::Duration::from_secs(120), async {
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let mut stdin = child.stdin.take().ok_or("Missing stdin")?;
        let prompt = format!("Translate the following into {target_lang}:\n\n{content}");
        {
            use tokio::io::AsyncWriteExt;
            stdin.write_all(prompt.as_bytes()).await
        }
        .map_err(|e| e.to_string())?;
        drop(stdin);
        let mut stdout = child.stdout.take().ok_or("Missing stdout")?;
        let mut buf = Vec::new();
        tokio::io::AsyncReadExt::read_to_end(&mut stdout, &mut buf)
            .await
            .map_err(|e| e.to_string())?;
        let status = child.wait().await.map_err(|e| e.to_string())?;
        Ok::<_, String>((buf, status.success()))
    })
    .await
    .map_err(|_| pix_error("translationTimeout", "翻译超时（2 分钟）"))??;

    translation_from_output(&output.0, output.1)
}

fn translation_from_output(output: &[u8], success: bool) -> Result<String, String> {
    let mut translated = String::new();
    for line in output.split(|b| *b == b'\n') {
        let Ok(event) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        if event["type"] != "message_end" || event["message"]["role"] != "assistant" {
            continue;
        }
        if matches!(
            event["message"]["stopReason"].as_str(),
            Some("error" | "aborted")
        ) {
            return Err(pix_error("translationFailed", "翻译模型返回错误"));
        }
        if event["message"]["stopReason"] == "length" {
            return Err(pix_error(
                "translationTruncated",
                "译文达到模型输出上限，请分段翻译",
            ));
        }
        if let Some(blocks) = event["message"]["content"].as_array() {
            let text = blocks
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("");
            if !text.trim().is_empty() {
                translated = text;
            }
        }
    }
    if !success {
        return Err(pix_error("translationFailed", "翻译模型返回错误"));
    }
    if translated.trim().is_empty() {
        return Err(pix_error("translationEmpty", "翻译结果为空"));
    }
    Ok(translated)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(reason: &str, text: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "type": "message_end",
            "message": { "role": "assistant", "stopReason": reason,
                "content": [{ "type": "text", "text": text }] }
        }))
        .unwrap()
    }

    #[test]
    fn rejects_truncated_text_even_when_older_pi_exits_successfully() {
        for success in [true, false] {
            let error =
                translation_from_output(&message("length", "partial"), success).unwrap_err();
            assert!(error.contains("translationTruncated"));
        }
    }

    #[test]
    fn rejects_failed_process_even_with_usable_text() {
        assert!(translation_from_output(&message("stop", "partial"), false)
            .unwrap_err()
            .contains("translationFailed"));
    }

    #[test]
    fn rejects_provider_errors_aborts_and_empty_replies() {
        for reason in ["error", "aborted"] {
            assert!(translation_from_output(&message(reason, "partial"), true).is_err());
        }
        assert!(translation_from_output(&message("stop", " "), true)
            .unwrap_err()
            .contains("translationEmpty"));
    }

    #[test]
    fn reads_final_text_and_ignores_non_message_records() {
        let mut output = b"log line\n{\"type\":\"agent_start\"}\n".to_vec();
        output.extend(message("stop", "translated"));
        assert_eq!(
            translation_from_output(&output, true).unwrap(),
            "translated"
        );
    }
}
