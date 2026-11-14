//! M0：aux runtime 的策略与 RPC 网关判定。
//!
//! 规格来源 `docs/aux-chat-spec.md`。策略随 `ProcessState` 落地，不从命令读取，
//! 因此桌面/远程客户端都无法把 aux 翻转成 Main。默认拒绝：不在允许清单内的一律
//! 拒绝（含未知 type），避免 pi 新增命令时静默放行。

use serde_json::{json, Value};

/// 每个 runtime 的运行策略。`Main` 是既有会话的默认值。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RuntimePolicy {
    /// 既有主会话/看板草稿/定时任务：不施加额外限制。
    #[default]
    Main,
    /// 辅助对话：只放行会话本体与只读查询，结构类与写全局设置类一律拒绝。
    Aux,
}

/// 允许的 `request` 类型（aux 策略下）。
///
/// 分组说明：
/// - 会话本体：`prompt`/`steer`/`follow_up`/`abort`/`clear_queue`/`compact`；
/// - 执行类：`bash`/`abort_bash`（工具同权，网关不拦）；
/// - 只读：`get_*`（含 `get_entries`/`get_tree`/`get_last_assistant_text`，无副作用）；
/// - 本进程会话态：模型与思考等级（实测不写 settings.json）。
///
/// 明确**不在**清单里的执行类之外的三组：结构类（建会话/导航/导出/改名/回滚/
/// fork 消息）、写 agent settings 的四条（`set_steering_mode`/`set_follow_up_mode`/
/// `set_auto_compaction`/`set_auto_retry`，实测落盘且有跨会话副作用）以及
/// `abort_retry`。
const AUX_ALLOWED: &[&str] = &[
    "prompt",
    "steer",
    "follow_up",
    "abort",
    "clear_queue",
    "compact",
    // 执行类：工具与主会话同权，网关不拦（M0 只拦结构类与 settings 写入类）。
    "bash",
    "abort_bash",
    "get_state",
    "get_messages",
    "get_session_stats",
    "get_commands",
    "get_available_models",
    "get_available_thinking_levels",
    "get_entries",
    "get_tree",
    "get_last_assistant_text",
    "set_model",
    "cycle_model",
    "set_thinking_level",
    "cycle_thinking_level",
];

/// 结构类与写全局设置类：既不在允许清单里，也在此显式列出以便拒绝文案与测试
/// 可读（真正的判定仍是"不在允许清单即拒绝"）。
pub const AUX_DENIED: &[&str] = &[
    "fork",
    "clone",
    "new_session",
    "switch_session",
    "export_html",
    "set_session_name",
    "rewind_prompt",
    "get_fork_messages",
    "set_steering_mode",
    "set_follow_up_mode",
    "set_auto_compaction",
    "set_auto_retry",
    "abort_retry",
];

/// `rpc_notify` 在 aux 下唯一允许的类型：作答扩展询问。
const AUX_NOTIFY_ALLOWED: &[&str] = &["extension_ui_response"];

impl RuntimePolicy {
    pub fn is_aux(self) -> bool {
        matches!(self, Self::Aux)
    }

    /// aux 的 argv 是否应当省略持久化与会话文件。
    pub fn ephemeral(self) -> bool {
        self.is_aux()
    }

    /// `rpc::request` 入口判定。`Main` 恒通过。
    pub fn guard_request(self, command: &Value) -> Result<(), String> {
        if !self.is_aux() {
            return Ok(());
        }
        let command_type = command["type"].as_str().unwrap_or("");
        if AUX_ALLOWED.contains(&command_type) {
            return Ok(());
        }
        Err(denied(command_type))
    }

    /// `rpc::notify` 入口判定。aux 只放行扩展询问的应答。
    pub fn guard_notify(self, command: &Value) -> Result<(), String> {
        if !self.is_aux() {
            return Ok(());
        }
        let command_type = command["type"].as_str().unwrap_or("");
        if AUX_NOTIFY_ALLOWED.contains(&command_type) {
            return Ok(());
        }
        Err(denied(command_type))
    }
}

fn denied(command_type: &str) -> String {
    crate::errors::pix_error_with(
        "auxRpcDenied",
        format!("辅助对话不支持该操作：{command_type}"),
        json!({ "type": command_type }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd(ty: &str) -> Value {
        json!({ "type": ty })
    }

    #[test]
    fn main_policy_passes_everything_including_structure_and_settings() {
        for ty in ["bash", "fork", "set_steering_mode", "unknown_type"] {
            assert!(RuntimePolicy::Main.guard_request(&cmd(ty)).is_ok(), "{ty}");
            assert!(RuntimePolicy::Main.guard_notify(&cmd(ty)).is_ok(), "{ty}");
        }
    }

    #[test]
    fn aux_allows_session_body_and_read_only() {
        for ty in [
            "prompt",
            "steer",
            "follow_up",
            "abort",
            "clear_queue",
            "compact",
            "get_state",
            "get_messages",
            "get_session_stats",
            "get_commands",
            "get_available_models",
            "get_available_thinking_levels",
            "get_entries",
            "get_tree",
            "get_last_assistant_text",
            "set_model",
            "cycle_model",
            "set_thinking_level",
            "cycle_thinking_level",
        ] {
            assert!(RuntimePolicy::Aux.guard_request(&cmd(ty)).is_ok(), "{ty}");
        }
    }

    #[test]
    fn aux_rejects_structural_commands() {
        for ty in [
            "fork",
            "clone",
            "new_session",
            "switch_session",
            "export_html",
            "set_session_name",
            "rewind_prompt",
            "get_fork_messages",
        ] {
            let err = RuntimePolicy::Aux.guard_request(&cmd(ty)).expect_err(ty);
            assert!(err.contains("auxRpcDenied"), "{ty}: {err}");
        }
    }

    #[test]
    fn aux_rejects_commands_that_write_agent_settings() {
        // 实测这四条会写 agent settings.json，跨会话改主会话行为。
        for ty in [
            "set_steering_mode",
            "set_follow_up_mode",
            "set_auto_compaction",
            "set_auto_retry",
            "abort_retry",
        ] {
            let err = RuntimePolicy::Aux.guard_request(&cmd(ty)).expect_err(ty);
            assert!(err.contains("auxRpcDenied"), "{ty}: {err}");
        }
    }

    #[test]
    fn aux_rejects_unknown_type() {
        let err = RuntimePolicy::Aux.guard_request(&cmd("aux_claim")).expect_err("unknown");
        assert!(err.contains("auxRpcDenied"));
        assert!(err.contains("aux_claim"));
    }

    #[test]
    fn aux_allows_execution_class() {
        // 工具与主会话同权：bash/abort_bash 必须放行（网关不拦执行类）。
        for ty in ["bash", "abort_bash"] {
            assert!(RuntimePolicy::Aux.guard_request(&cmd(ty)).is_ok(), "{ty}");
        }
    }

    #[test]
    fn aux_notify_only_allows_extension_ui_response() {
        assert!(RuntimePolicy::Aux.guard_notify(&cmd("extension_ui_response")).is_ok());
        for ty in ["bash", "prompt", "unknown_type"] {
            let err = RuntimePolicy::Aux.guard_notify(&cmd(ty)).expect_err(ty);
            assert!(err.contains("auxRpcDenied"), "{ty}: {err}");
        }
    }

    #[test]
    fn aux_and_main_matrix_agree_with_declared_lists() {
        for ty in AUX_ALLOWED {
            assert!(RuntimePolicy::Aux.guard_request(&cmd(ty)).is_ok(), "{ty}");
        }
        for ty in AUX_DENIED {
            assert!(
                RuntimePolicy::Aux.guard_request(&cmd(ty)).is_err(),
                "{ty} must be denied"
            );
        }
    }
}
