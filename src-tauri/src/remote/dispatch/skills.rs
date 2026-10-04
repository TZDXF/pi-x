//! Skills commands (hosted and discovered skills).

use super::{handled, string_list, text, to_json, UNHANDLED};
use serde_json::{json, Value};

pub(super) async fn handle(cmd: &str, a: &Value) -> Option<Result<Value, String>> {
    handled(async {
        match cmd {
            "skills_hosted_list" => Ok(to_json(crate::skills::skills_hosted_list().await?)?),
            "skills_hosted_delete" => {
                crate::skills::skills_hosted_delete(text(a, "path")?).await?;
                Ok(Value::Null)
            }
            "skills_hosted_set_enabled" => {
                let paths = string_list(&a["paths"]).unwrap_or_default();
                crate::skills::skills_hosted_set_enabled(paths).await?;
                Ok(Value::Null)
            }
            "skills_discovered_list" => Ok(to_json(crate::skills::skills_discovered_list().await?)?),
            "skills_list_files" => Ok(json!(crate::skills::skills_list_files(text(a, "path")?).await?)),
            "skills_read_file" => Ok(json!(crate::skills::skills_read_file(
                text(a, "path")?,
                text(a, "relPath")?
            )
            .await?)),
            _ => return Err(UNHANDLED.to_owned()),
        }
    }
    .await)
}
