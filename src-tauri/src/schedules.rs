//! Desktop-owned schedules. Claims are persisted before execution (at most once).
use crate::{
    commands, data_dir,
    errors::{pix_error, pix_error_detail},
    pi_locate, rpc, trust,
};
use chrono::{Local, TimeZone};
use cron::Schedule;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    str::FromStr,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Listener, Manager, State};
use tokio::sync::Mutex;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInput {
    pub id: Option<String>,
    pub title: String,
    pub prompt: String,
    pub project: String,
    pub provider: String,
    pub model: String,
    pub thinking: String,
    pub expression: String,
    pub enabled: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    #[serde(flatten)]
    pub input: TaskInput,
    pub next_run: i64,
    pub last_run: Option<i64>,
    pub status: String,
    pub error: Option<String>,
    pub session_file: Option<String>,
}
#[derive(Default)]
pub struct ScheduleState(Mutex<Vec<Task>>);

/// Schedule runtime 完成后的回收宽限期：若期间未被前端 attach（无任何请求），则 kill。
const SCHEDULE_RUNTIME_TTL: Duration = Duration::from_secs(600);

fn notify_schedules_changed(app: &AppHandle) {
    crate::remote::emit(app, "pi://schedules-changed", json!({}));
}

fn next_run(expression: &str, after: i64) -> Result<i64, String> {
    // UI accepts exactly five fields; explicitly prepend seconds for cron-rs.
    if expression.split_whitespace().count() != 5 {
        return Err(pix_error(
            "cronFieldCount",
            "请使用五段 cron 表达式：分钟 小时 日 月 星期（SUN-SAT）",
        ));
    }
    let schedule = Schedule::from_str(&format!("0 {expression} *"))
        .map_err(|e| pix_error_detail("cronInvalid", format!("无效的 cron 表达式: {e}"), e))?;
    let date = Local
        .timestamp_millis_opt(after)
        .single()
        .ok_or_else(|| pix_error("scheduleInvalidDate", "无效的日期"))?;
    schedule
        .after(&date)
        .next()
        .map(|d| d.timestamp_millis())
        .ok_or_else(|| pix_error("scheduleNoFutureOccurrence", "该表达式没有未来的执行时间"))
}
fn validate(input: &TaskInput) -> Result<(), String> {
    if input.title.trim().is_empty()
        || input.title.len() > 300
        || input.prompt.trim().is_empty()
        || input.prompt.len() > 100_000
        || input.provider.trim().is_empty()
        || input.model.trim().is_empty()
    {
        return Err(pix_error(
            "taskFieldsRequired",
            "标题、指令和模型必填（标题 ≤ 300 字节，指令 ≤ 100 KB）",
        ));
    }
    if !["off", "minimal", "low", "medium", "high", "xhigh", "max"]
        .contains(&input.thinking.as_str())
    {
        return Err(pix_error("invalidThinkingLevel", "无效的思考等级"));
    }
    if !std::path::Path::new(&input.project).is_absolute()
        || !std::path::Path::new(&input.project).is_dir()
    {
        return Err(pix_error("projectDirMissing", "项目目录不存在"));
    }
    next_run(&input.expression, Local::now().timestamp_millis())?;
    Ok(())
}
fn persist_to(path: &std::path::Path, tasks: &[Task]) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(tasks).map_err(|e| e.to_string())?;
    crate::atomic_write::write(path, &body).map_err(|e| e.to_string())
}

fn persist_path() -> std::path::PathBuf {
    data_dir::root().join("schedules.json")
}

/// 写盘移入 blocking 线程池：调用点持有 async Mutex 以保持
/// “检查-修改-持久化”的原子语义（不会与其他并发保存交错），
/// await 期间让出 worker，慢盘不再阻塞 tokio 运行时和其他任务。
async fn persist_at(path: &std::path::Path, tasks: &[Task]) -> Result<(), String> {
    let path = path.to_path_buf();
    let tasks = tasks.to_vec();
    tauri::async_runtime::spawn_blocking(move || persist_to(&path, &tasks))
        .await
        .map_err(|e| e.to_string())?
}

async fn persist(tasks: &[Task]) -> Result<(), String> {
    persist_at(&persist_path(), tasks).await
}
#[tauri::command]
pub async fn schedule_list(state: State<'_, ScheduleState>) -> Result<Vec<Task>, String> {
    Ok(state.0.lock().await.clone())
}
#[tauri::command]
pub async fn schedule_save(
    state: State<'_, ScheduleState>,
    mut input: TaskInput,
) -> Result<Task, String> {
    validate(&input)?;
    input.title = input.title.trim().into();
    input.project = dunce::canonicalize(&input.project)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into();
    let mut guard = state.0.lock().await;
    let mut tasks = guard.clone();
    let existing = input
        .id
        .as_ref()
        .and_then(|id| tasks.iter().position(|t| t.input.id.as_ref() == Some(id)));
    if input.id.is_some() && existing.is_none() {
        return Err(pix_error("taskNotFound", "任务不存在，可能已被删除"));
    }
    if existing.is_some_and(|i| tasks[i].status == "running") {
        return Err(pix_error("taskRunning", "任务正在运行，请稍后再试"));
    }
    let next = next_run(&input.expression, Local::now().timestamp_millis())?;
    input.id = Some(input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()));
    let mut task = Task {
        input,
        next_run: next,
        last_run: None,
        status: "idle".into(),
        error: None,
        session_file: None,
    };
    if let Some(i) = existing {
        task.last_run = tasks[i].last_run;
        task.status = tasks[i].status.clone();
        task.error = tasks[i].error.clone();
        task.session_file = tasks[i].session_file.clone();
        tasks[i] = task.clone();
    } else {
        tasks.push(task.clone());
    }
    persist(&tasks).await?;
    *guard = tasks;
    Ok(task)
}
#[tauri::command]
pub async fn schedule_delete(state: State<'_, ScheduleState>, id: String) -> Result<(), String> {
    let mut guard = state.0.lock().await;
    if guard
        .iter()
        .any(|t| t.input.id.as_ref() == Some(&id) && t.status == "running")
    {
        return Err(pix_error("taskRunning", "任务正在运行，请稍后再试"));
    }
    let mut tasks = guard.clone();
    tasks.retain(|t| t.input.id.as_ref() != Some(&id));
    persist(&tasks).await?;
    *guard = tasks;
    Ok(())
}
#[tauri::command]
pub async fn schedule_run(
    app: AppHandle,
    state: State<'_, ScheduleState>,
    id: String,
) -> Result<(), String> {
    // Claim before execution, same as the scheduler loop; manual runs keep next_run untouched.
    let task = {
        let mut guard = state.0.lock().await;
        let mut tasks = guard.clone();
        let Some(task) = tasks
            .iter_mut()
            .find(|t| t.input.id.as_deref() == Some(&id))
        else {
            return Err(pix_error("taskNotFound", "任务不存在，可能已被删除"));
        };
        if task.status == "running" {
            return Err(pix_error("taskRunning", "任务正在运行，请稍后再试"));
        }
        let claimed = task.clone();
        task.status = "running".into();
        task.session_file = None;
        task.error = None;
        task.last_run = Some(Local::now().timestamp_millis());
        persist(&tasks).await?;
        *guard = tasks;
        claimed
    };
    notify_schedules_changed(&app);
    tauri::async_runtime::spawn(async move {
        let result = execute(&app, &task).await;
        finish_task(&app, &task, result, NextRunAdvance::IfMissed).await;
    });
    Ok(())
}

/// 完成回写时 `next_run` 的推进策略：手动运行与调度领取的语义不同。
#[derive(Clone, Copy)]
enum NextRunAdvance {
    /// 手动运行可能跨越了计划时刻；仅在 next_run 已错过时推进到下一个未来槽，
    /// 避免运行结束后下个 tick 立即补跑。
    IfMissed,
    /// 调度领取：claim 时已推进过一次，完成后无条件重算，跳过运行期间错过的槽位。
    Always,
}

/// 按策略推进任务的 `next_run`（独立于回写，便于单测）。
fn advance_next_run(task: &mut Task, policy: NextRunAdvance, now: i64) {
    if matches!(policy, NextRunAdvance::IfMissed) && task.next_run > now {
        return;
    }
    if let Ok(next) = next_run(&task.input.expression, now) {
        task.next_run = next;
    }
}

/// 执行完成后的回写：更新状态与会话文件并持久化，由手动运行与调度循环共用。
async fn finish_task(
    app: &AppHandle,
    task: &Task,
    result: Result<String, String>,
    advance: NextRunAdvance,
) {
    let state = app.state::<ScheduleState>();
    let mut guard = state.0.lock().await;
    if let Some(current) = guard.iter_mut().find(|t| t.input.id == task.input.id) {
        // 跳过任务运行期间错过的槽位（策略见 NextRunAdvance）。
        advance_next_run(current, advance, Local::now().timestamp_millis());
        match result {
            Ok(file) => {
                current.status = "success".into();
                current.session_file = Some(file);
            }
            Err(e) => {
                current.status = "failed".into();
                current.error = Some(e);
            }
        }
        if let Err(e) = persist(&guard).await {
            eprintln!("Schedule result persistence failed: {e}");
        }
        drop(guard);
        notify_schedules_changed(app);
    }
}

async fn checked_request(state: &rpc::RpcState, id: &str, command: Value) -> Result<Value, String> {
    let response = tokio::time::timeout(
        Duration::from_secs(60),
        rpc::request(state, command, Some(id)),
    )
    .await
    .map_err(|_| pix_error("piRequestTimedOut", "请求 pi 超时"))??;
    if response["success"] != true {
        return Err(response["error"]
            .as_str()
            .map(String::from)
            .unwrap_or_else(|| pix_error("piRequestFailed", "pi 请求失败")));
    }
    Ok(response["data"].clone())
}
// Kept separate from process creation so preflight/completion ordering is testable.
async fn wait_for_completion(
    prompt: impl std::future::Future<Output = Result<Value, String>>,
    events: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
) -> Result<(), String> {
    tokio::pin!(prompt);
    let mut accepted = false;
    // Prompt replies after preflight, NOT after the agent finishes.
    loop {
        let event = tokio::select! {
            response = &mut prompt, if !accepted => { response?; accepted = true; continue; }
            event = events.recv() => event.ok_or_else(|| pix_error("piEventStreamClosed", "pi 事件流已关闭"))?,
        };
        if event["type"] == "process_exit" {
            return Err(pix_error("piExitedEarly", "pi 提前退出，任务未完成"));
        }
        if event["type"] == "agent_settled" {
            break;
        }
    }
    Ok(())
}
/// Unregisters the run's global event listeners when dropped, so every exit
/// path — normal return, error, or panic unwind — cleans up instead of
/// leaking listeners that keep firing for this runtime id forever.
struct ListenerGuard<'a> {
    app: &'a AppHandle,
    ids: Vec<tauri::EventId>,
}
impl Drop for ListenerGuard<'_> {
    fn drop(&mut self) {
        for id in self.ids.drain(..) {
            self.app.unlisten(id);
        }
    }
}

async fn execute(app: &AppHandle, task: &Task) -> Result<String, String> {
    let input = &task.input;
    validate(input)?;
    // Never change global trust; recheck on each run so revocation takes effect.
    let trust = trust::status(&input.project).await?;
    if trust["needsDecision"] == true {
        return Err(pix_error("trustDecisionRequired", "项目信任需要先做出决定"));
    }
    let approved = trust["decision"] == true;
    let pi = pi_locate::detect(commands::app_config_get(app.clone())?.pi_path).await;
    let state = app.state::<rpc::RpcState>();
    let id = format!("schedule-{}", uuid::Uuid::new_v4());
    let mut published = false;
    let mut settled = false;
    let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
    let mut listeners = ListenerGuard { app, ids: Vec::new() };
    let exit_sender = sender.clone();
    let exit_id = id.clone();
    listeners.ids.push(app.listen("pi://schedule-exit", move |event| {
        if let Ok(value) = serde_json::from_str::<Value>(event.payload()) {
            if value["runtimeId"] == exit_id {
                let _ = exit_sender.send(json!({"type":"process_exit"}));
            }
        }
    }));
    let event_id = id.clone();
    listeners.ids.push(app.listen("pi://schedule-event", move |event| {
        if let Ok(value) = serde_json::from_str::<Value>(event.payload()) {
            if value["runtimeId"] == event_id {
                let _ = sender.send(value);
            }
        }
    }));
    let args = vec![
        if approved {
            "--approve"
        } else {
            "--no-approve"
        }
        .into(),
        "--provider".into(),
        input.provider.clone(),
        "--model".into(),
        input.model.clone(),
        "--thinking".into(),
        input.thinking.clone(),
    ];
    let outcome = tokio::time::timeout(Duration::from_secs(3600), async {
        rpc::spawn(
            app.clone(),
            &state,
            &rpc::SpawnProgram::LocalPi(pi.clone()),
            &input.project,
            None,
            args,
            None,
            Some(id.clone()),
        )
        .await?;
        let levels =
            checked_request(&state, &id, json!({"type":"get_available_thinking_levels"})).await?;
        if !levels["levels"]
            .as_array()
            .is_some_and(|a| a.contains(&json!(input.thinking)))
        {
            return Err(pix_error(
                "thinkingNotSupported",
                "所选模型不支持该思考等级",
            ));
        }
        let initial = checked_request(&state, &id, json!({"type":"get_state"})).await?;
        if initial["model"]["provider"] != input.provider
            || initial["model"]["id"] != input.model
            || initial["thinkingLevel"] != input.thinking
        {
            return Err(pix_error(
                "modelApplyFailed",
                "pi 未应用所选的模型或思考等级",
            ));
        }
        let file = initial["sessionFile"]
            .as_str()
            .ok_or_else(|| pix_error("piSessionNotCreated", "pi 未创建会话"))?
            .to_owned();
        checked_request(
            &state,
            &id,
            json!({"type":"set_session_name", "name":input.title}),
        )
        .await?;
        // Publish the identity before prompting so opening it attaches to this worker.
        {
            let schedules = app.state::<ScheduleState>();
            let mut guard = schedules.0.lock().await;
            let mut updated = guard.clone();
            let current = updated
                .iter_mut()
                .find(|t| t.input.id == input.id)
                .ok_or_else(|| pix_error("taskNotFound", "任务不存在，可能已被删除"))?;
            current.session_file = Some(file.clone());
            persist(&updated).await?;
            *guard = updated;
        }
        notify_schedules_changed(app);
        published = true;
        crate::remote::emit(
            app,
            "pi://event",
            json!({
                "type": "scheduled_session_created", "runtimeId": id,
                "project": input.project, "sessionFile": file, "state": initial,
                "prompt": input.prompt,
            }),
        );
        let prompt = checked_request(
            &state,
            &id,
            json!({"type":"prompt", "message":input.prompt}),
        );
        wait_for_completion(prompt, &mut events).await?;
        settled = true;
        let messages = checked_request(&state, &id, json!({"type":"get_messages"})).await?;
        let last = messages["messages"]
            .as_array()
            .and_then(|a| a.iter().rev().find(|m| m["role"] == "assistant"))
            .ok_or_else(|| pix_error("piNoAssistantResponse", "pi 未返回助手回复"))?;
        if matches!(last["stopReason"].as_str(), Some("error" | "aborted")) {
            return Err(last["errorMessage"]
                .as_str()
                .map(String::from)
                .unwrap_or_else(|| pix_error("modelRunFailed", "模型运行失败")));
        }
        Ok(file)
    })
    .await
    .map_err(|_| pix_error("taskTimedOut", "任务超时（1 小时）"))
    .and_then(|v| v);
    // Listeners are unregistered by the guard's Drop on every path out of
    // `execute` (including panics), so no explicit unlisten is needed here.
    if !published {
        let _ = rpc::kill(&state, Some(&id)).await;
    } else if let Err(error) = &outcome {
        // Never abort a follow-up the user sent after the scheduled turn settled.
        if !settled {
            if checked_request(&state, &id, json!({"type":"abort"}))
                .await
                .is_err()
            {
                let _ = rpc::kill(&state, Some(&id)).await;
            }
            crate::remote::emit(
                app,
                "pi://event",
                json!({
                    "type": "scheduled_session_failed", "runtimeId": id, "error": error,
                }),
            );
        }
    }
    if published && settled && outcome.is_ok() {
        // 成功路径留下存活的 schedule runtime 供前端 attach；若宽限期内未被
        // 前端 attach（无任何请求），回收进程与 RpcState 条目，防止无界增长。
        let cleanup_app = app.clone();
        let cleanup_id = id.clone();
        let completed_at = Instant::now();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(SCHEDULE_RUNTIME_TTL).await;
            let state = cleanup_app.state::<rpc::RpcState>();
            if !rpc::running(&state, Some(&cleanup_id)).await {
                return;
            }
            let last = state.last_activity.lock().await.get(&cleanup_id).copied();
            if last.is_none_or(|t| t <= completed_at) {
                let _ = rpc::kill(&state, Some(&cleanup_id)).await;
            }
        });
    }
    outcome
}

fn claim_due(tasks: &mut [Task], now: i64) -> (Vec<Task>, bool) {
    let mut claimed = Vec::new();
    let mut changed = false;
    for task in tasks {
        if !task.input.enabled || task.status == "running" || task.next_run > now {
            continue;
        }
        changed = true;
        match next_run(&task.input.expression, now) {
            Ok(next) => task.next_run = next,
            Err(e) => {
                task.input.enabled = false;
                task.status = "failed".into();
                task.error = Some(e);
                continue;
            }
        }
        task.status = "running".into();
        task.session_file = None;
        task.error = None;
        task.last_run = Some(now);
        claimed.push(task.clone());
    }
    (claimed, changed)
}

pub fn start(app: AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let path = data_dir::root().join("schedules.json");
    let mut tasks: Vec<Task> = match std::fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(tasks) => tasks,
            Err(e) => {
                eprintln!("Failed to parse schedules.json, starting with empty list: {e}");
                let backup = path.with_extension("corrupt");
                let _ = std::fs::rename(&path, &backup);
                Vec::new()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e.into()),
    };
    let now = Local::now().timestamp_millis();
    for task in &mut tasks {
        if task.status == "running" {
            task.status = "failed".into();
            task.error = Some(pix_error("interruptedByShutdown", "因应用关闭而中断"));
        }
        match next_run(&task.input.expression, now) {
            Ok(next) => task.next_run = next,
            Err(e) => {
                task.input.enabled = false;
                task.status = "failed".into();
                task.error = Some(e);
            }
        }
    }
    persist_to(&persist_path(), &tasks)?;
    *app.state::<ScheduleState>().0.blocking_lock() = tasks;
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;
            let state = app.state::<ScheduleState>();
            let mut guard = state.0.lock().await;
            let mut updated = guard.clone();
            let now = Local::now().timestamp_millis();
            let (claimed, changed) = claim_due(&mut updated, now);
            if !changed {
                continue;
            }
            if let Err(e) = persist(&updated).await {
                eprintln!("Schedule claim failed: {e}");
                continue;
            }
            *guard = updated;
            drop(guard);
            notify_schedules_changed(&app);
            for task in claimed {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let result = execute(&app, &task).await;
                    finish_task(&app, &task, result, NextRunAdvance::Always).await;
                });
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Task {
        Task {
            input: TaskInput {
                id: Some("test".into()),
                title: "Test".into(),
                prompt: "Work".into(),
                project: "unused".into(),
                provider: "test".into(),
                model: "test".into(),
                thinking: "off".into(),
                expression: "* * * * *".into(),
                enabled: true,
            },
            next_run: 0,
            last_run: None,
            status: "idle".into(),
            error: None,
            session_file: None,
        }
    }
    #[test]
    fn legacy_permission_fields_do_not_restore_schedule_permissions() {
        let old = serde_json::json!({
            "id": "old", "title": "Old task", "prompt": "Work", "project": "unused",
            "permission": "trust", "toolPermission": "readonly", "provider": "test",
            "model": "test", "thinking": "off", "expression": "* * * * *", "enabled": true,
        });
        let task: TaskInput = serde_json::from_value(old).unwrap();
        let saved = serde_json::to_value(task).unwrap();
        assert!(saved.get("permission").is_none());
        assert!(saved.get("toolPermission").is_none());
    }
    #[test]
    fn claims_once_and_never_overlaps_or_runs_paused_tasks() {
        let now = Local::now().timestamp_millis();
        let mut tasks = vec![fixture(), fixture()];
        tasks[0].session_file = Some("previous-run.jsonl".into());
        tasks[1].input.enabled = false;
        let (claimed, changed) = claim_due(&mut tasks, now);
        assert!(changed);
        assert_eq!(claimed.len(), 1);
        assert_eq!(tasks[0].last_run, Some(now));
        assert!(tasks[0].next_run > now);
        assert_eq!(tasks[0].status, "running");
        assert!(tasks[0].session_file.is_none());
        let (claimed, changed) = claim_due(&mut tasks, now + 3_600_000);
        assert!(!changed);
        assert!(claimed.is_empty());
    }
    #[test]
    fn invalid_saved_schedule_is_disabled_and_persisted_without_running() {
        let mut tasks = vec![fixture()];
        tasks[0].input.expression = "invalid".into();
        let (claimed, changed) = claim_due(&mut tasks, Local::now().timestamp_millis());
        assert!(changed);
        assert!(claimed.is_empty());
        assert!(!tasks[0].input.enabled);
        assert_eq!(tasks[0].status, "failed");
    }
    #[tokio::test]
    async fn preflight_ack_is_not_completion() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let wait = wait_for_completion(async { Ok(Value::Null) }, &mut rx);
        tokio::pin!(wait);
        assert!(tokio::time::timeout(Duration::from_millis(10), &mut wait)
            .await
            .is_err());
        // An attempt ending may be followed by automatic retries.
        tx.send(json!({"type":"agent_end"})).unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(10), &mut wait)
            .await
            .is_err());
        tx.send(json!({"type":"agent_settled"})).unwrap();
        assert!(wait.await.is_ok());
    }
    #[tokio::test]
    async fn exit_fails_even_before_preflight_ack() {
        for event in [json!({"type":"process_exit"})] {
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            tx.send(event).unwrap();
            assert!(wait_for_completion(std::future::pending(), &mut rx)
                .await
                .is_err());
        }
    }
    #[tokio::test]
    async fn interactive_requests_wait_for_the_pix_user() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let wait = wait_for_completion(async { Ok(Value::Null) }, &mut rx);
        tokio::pin!(wait);
        tx.send(json!({"type":"extension_ui_request", "method":"confirm"}))
            .unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(10), &mut wait)
            .await
            .is_err());
        tx.send(json!({"type":"agent_settled"})).unwrap();
        assert!(wait.await.is_ok());
    }
    #[tokio::test]
    async fn rejected_prompts_and_closed_streams_fail() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        assert!(
            wait_for_completion(async { Err("Model unavailable".into()) }, &mut rx)
                .await
                .is_err()
        );
        drop(tx);
        assert!(wait_for_completion(std::future::pending(), &mut rx)
            .await
            .is_err());
    }
    #[test]
    fn validates_cron_fields_and_impossible_dates() {
        let now = Local::now().timestamp_millis();
        for expression in ["bad", "* * * * * *", "60 * * * *", "0 9 31 2 *"] {
            assert!(next_run(expression, now).is_err(), "{expression}");
        }
        for expression in [
            "0 * * * *",
            "0 9 * * *",
            "0 9 * * MON-FRI",
            "0 9 * * MON",
            "0 9 1 * *",
        ] {
            assert!(next_run(expression, now).unwrap() > now);
        }
    }
    #[test]
    fn advances_strictly_past_claim_and_skips_short_months() {
        let now = Local
            .with_ymd_and_hms(2026, 4, 1, 0, 0, 0)
            .unwrap()
            .timestamp_millis();
        let next = next_run("0 9 31 * *", now).unwrap();
        let expected = Local
            .with_ymd_and_hms(2026, 5, 31, 9, 0, 0)
            .unwrap()
            .timestamp_millis();
        assert_eq!(next, expected);
        assert!(next_run("0 9 31 * *", next).unwrap() > next);
    }

    #[test]
    fn completion_advance_follows_policy() {
        let now = Local::now().timestamp_millis();
        let mut task = fixture();
        // 手动路径：next_run 仍在未来时不推进。
        task.next_run = now + 3_600_000;
        advance_next_run(&mut task, NextRunAdvance::IfMissed, now);
        assert_eq!(task.next_run, now + 3_600_000);
        // 已错过的槽位推进到下一个未来槽。
        task.next_run = now - 1;
        advance_next_run(&mut task, NextRunAdvance::IfMissed, now);
        assert!(task.next_run > now);
        // 调度路径：无条件重算为 now 之后的下一个槽位。
        let expected = next_run(&task.input.expression, now).unwrap();
        task.next_run = now + 3_600_000;
        advance_next_run(&mut task, NextRunAdvance::Always, now);
        assert_eq!(task.next_run, expected);
    }

    #[test]
    fn persist_to_writes_complete_json_and_overwrites_previous_content() {
        let dir = std::env::temp_dir().join(format!("pix-persist-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("schedules.json");
        persist_to(&path, &[fixture()]).unwrap();
        let loaded: Vec<Task> = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(loaded.len(), 1);
        persist_to(&path, &[fixture(), fixture()]).unwrap();
        let loaded: Vec<Task> = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(loaded.len(), 2);
        // 原子写不留临时文件。
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// 持久化走 spawn_blocking：await 期间其他任务仍可在同一 runtime 上推进，
    /// 且并发写入各自使用随机临时名，最终文件始终是某个完整快照。
    #[tokio::test(flavor = "multi_thread")]
    async fn persist_at_yields_to_runtime_and_keeps_snapshots_complete() {
        let dir = std::env::temp_dir().join(format!("pix-persist-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("schedules.json");
        persist_at(&path, &[fixture()]).await.unwrap();
        let loaded: Vec<Task> = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(loaded.len(), 1);

        // 模拟慢盘：写盘期间 runtime 上的其他任务持续推进。
        let slow_path = path.clone();
        let slow = tokio::task::spawn_blocking(move || {
            std::thread::sleep(Duration::from_millis(100));
            persist_to(&slow_path, &[fixture(), fixture()])
        });
        let mut ticks = 0u32;
        while !slow.is_finished() {
            tokio::time::sleep(Duration::from_millis(5)).await;
            ticks += 1;
        }
        slow.await.unwrap().unwrap();
        assert!(ticks > 1, "runtime stalled while persisting");

        // 并发持久化互不干扰：每个结果都是完整的 JSON 快照。
        let mut handles = Vec::new();
        for _ in 0..4 {
            let p = path.clone();
            handles.push(tokio::spawn(async move {
                persist_at(&p, &[fixture(), fixture()]).await
            }));
        }
        for handle in handles {
            handle.await.unwrap().unwrap();
        }
        let final_tasks: Vec<Task> =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(final_tasks.len(), 2);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
