//! 用量/成本汇总命令（本地会话文件扫描）。

use super::{handled, to_json, UNHANDLED};
use serde_json::Value;

pub(super) async fn handle(cmd: &str, a: &Value) -> Option<Result<Value, String>> {
    handled(async {
        match cmd {
            "usage_summary" => {
                let days = a["days"].as_u64().map(|d| d as u32);
                let project = a["project"].as_str().map(str::to_owned);
                let summary = crate::usage::usage_summary(days, project).await?;
                Ok(to_json(summary)?)
            }
            _ => return Err(UNHANDLED.to_owned()),
        }
    }
    .await)
}
