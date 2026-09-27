//! Desktop-owned schedules. Claims are persisted before execution (at most once).
use crate::{commands, data_dir, pi_locate, rpc, trust};
use chrono::{Local, TimeZone};
use cron::Schedule;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{str::FromStr, time::Duration};
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

fn notify_schedules_changed(app: &AppHandle) {
    crate::remote::emit(app, "pi://schedules-changed", json!({}));
}

fn next_run(expression: &str, after: i64) -> Result<i64, String> {
    // UI accepts exactly five fields; explicitly prepend seconds for cron-rs.
    if expression.split_whitespace().count() != 5 {
        return Err("Use five cron fields: minute hour day month weekday (SUN-SAT)".into());
    }
    let schedule = Schedule::from_str(&format!("0 {expression} *")).map_err(|e| e.to_string())?;
    let date = Local
        .timestamp_millis_opt(after)
        .single()
        .ok_or("Invalid date")?;
    schedule
        .after(&date)
        .next()
        .map(|d| d.timestamp_millis())
        .ok_or("Schedule has no future occurrence".into())
}
fn validate(input: &TaskInput) -> Result<(), String> {
    if input.title.trim().is_empty()
        || input.title.len() > 300
        || input.prompt.trim().is_empty()
        || input.prompt.len() > 100_000
        || input.provider.trim().is_empty()
        || input.model.trim().is_empty()
    {
        return Err(
            "Title, prompt and model are required (title ≤ 300 bytes, prompt ≤ 100 KB)".into(),
        );
    }
    if !["off", "minimal", "low", "medium", "high", "xhigh", "max"]
        .contains(&input.thinking.as_str())
    {
        return Err("Invalid thinking level".into());
    }
    if !std::path::Path::new(&input.project).is_absolute()
        || !std::path::Path::new(&input.project).is_dir()
    {
        return Err("Project directory does not exist".into());
    }
    next_run(&input.expression, Local::now().timestamp_millis())?;
    Ok(())
}
fn persist(tasks: &[Task]) -> Result<(), String> {
    let path = data_dir::root().join("schedules.json");
    let temporary = path.with_extension("tmp");
    std::fs::write(
        &temporary,
        serde_json::to_vec_pretty(tasks).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(temporary, path).map_err(|e| e.to_string())
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
        return Err("Task no longer exists".into());
    }
    if existing.is_some_and(|i| tasks[i].status == "running") {
        return Err("Task is running".into());
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
    persist(&tasks)?;
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
        return Err("Task is running".into());
    }
    let mut tasks = guard.clone();
    tasks.retain(|t| t.input.id.as_ref() != Some(&id));
    persist(&tasks)?;
    *guard = tasks;
    Ok(())
}
#[tauri::command]
pub async fn schedule_run(app: AppHandle, state: State<'_, ScheduleState>, id: String) -> Result<(), String> {
    // Claim before execution, same as the scheduler loop; manual runs keep next_run untouched.
    let task = {
        let mut guard = state.0.lock().await;
        let mut tasks = guard.clone();
        let Some(task) = tasks.iter_mut().find(|t| t.input.id.as_deref() == Some(&id)) else {
            return Err("Task no longer exists".into());
        };
        if task.status == "running" {
            return Err("Task is running".into());
        }
        let claimed = task.clone();
        task.status = "running".into();
        task.session_file = None;
        task.error = None;
        task.last_run = Some(Local::now().timestamp_millis());
        persist(&tasks)?;
        *guard = tasks;
        claimed
    };
    notify_schedules_changed(&app);
    tauri::async_runtime::spawn(async move {
        let result = execute(&app, &task).await;
        let state = app.state::<ScheduleState>();
        let mut guard = state.0.lock().await;
        if let Some(current) = guard.iter_mut().find(|t| t.input.id == task.input.id) {
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
            if let Err(e) = persist(&guard) {
                eprintln!("Schedule result persistence failed: {e}");
            }
            drop(guard);
            notify_schedules_changed(&app);
        }
    });
    Ok(())
}

async fn checked_request(state: &rpc::RpcState, id: &str, command: Value) -> Result<Value, String> {
    let response = tokio::time::timeout(
        Duration::from_secs(60),
        rpc::request(state, command, Some(id)),
    )
    .await
    .map_err(|_| "Pi request timed out".to_string())??;
    if response["success"] != true {
        return Err(response["error"]
            .as_str()
            .unwrap_or("Pi request failed")
            .into());
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
            event = events.recv() => event.ok_or("Pi event stream closed")?,
        };
        if event["type"] == "process_exit" {
            return Err("Pi exited before completing the task".into());
        }
        if event["type"] == "agent_settled" {
            break;
        }
    }
    Ok(())
}
async fn execute(app: &AppHandle, task: &Task) -> Result<String, String> {
    let input = &task.input;
    validate(input)?;
    // Never change global trust; recheck on each run so revocation takes effect.
    let trust = trust::status(&input.project).await?;
    if trust["needsDecision"] == true {
        return Err("Project trust requires a decision".into());
    }
    let approved = trust["decision"] == true;
    let pi = pi_locate::detect(commands::app_config_get(app.clone())?.pi_path).await;
    let state = app.state::<rpc::RpcState>();
    let id = format!("schedule-{}", uuid::Uuid::new_v4());
    let mut published = false;
    let mut settled = false;
    let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
    let exit_sender = sender.clone();
    let exit_id = id.clone();
    let exit_listener = app.listen("pi://schedule-exit", move |event| {
        if let Ok(value) = serde_json::from_str::<Value>(event.payload()) {
            if value["runtimeId"] == exit_id {
                let _ = exit_sender.send(json!({"type":"process_exit"}));
            }
        }
    });
    let event_id = id.clone();
    let listener = app.listen("pi://schedule-event", move |event| {
        if let Ok(value) = serde_json::from_str::<Value>(event.payload()) {
            if value["runtimeId"] == event_id {
                let _ = sender.send(value);
            }
        }
    });
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
            &pi,
            &input.project,
            None,
            args,
            Some(id.clone()),
        )
        .await?;
        let levels =
            checked_request(&state, &id, json!({"type":"get_available_thinking_levels"})).await?;
        if !levels["levels"]
            .as_array()
            .is_some_and(|a| a.contains(&json!(input.thinking)))
        {
            return Err("Selected model does not support the thinking level".into());
        }
        let initial = checked_request(&state, &id, json!({"type":"get_state"})).await?;
        if initial["model"]["provider"] != input.provider
            || initial["model"]["id"] != input.model
            || initial["thinkingLevel"] != input.thinking
        {
            return Err("Pi did not apply the selected model or thinking level".into());
        }
        let file = initial["sessionFile"].as_str()
            .ok_or("Pi did not create a session")?.to_owned();
        checked_request(&state, &id, json!({"type":"set_session_name", "name":input.title})).await?;
        // Publish the identity before prompting so opening it attaches to this worker.
        {
            let schedules = app.state::<ScheduleState>();
            let mut guard = schedules.0.lock().await;
            let mut updated = guard.clone();
            let current = updated.iter_mut().find(|t| t.input.id == input.id)
                .ok_or("Task no longer exists")?;
            current.session_file = Some(file.clone());
            persist(&updated)?;
            *guard = updated;
        }
        notify_schedules_changed(app);
        published = true;
        crate::remote::emit(app, "pi://event", json!({
            "type": "scheduled_session_created", "runtimeId": id,
            "project": input.project, "sessionFile": file, "state": initial,
            "prompt": input.prompt,
        }));
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
            .ok_or("Pi returned no assistant response")?;
        if matches!(last["stopReason"].as_str(), Some("error" | "aborted")) {
            return Err(last["errorMessage"]
                .as_str()
                .unwrap_or("Model run failed")
                .into());
        }
        Ok(file)
    })
    .await
    .map_err(|_| "Task timed out after one hour".to_string())
    .and_then(|v| v);
    app.unlisten(listener);
    app.unlisten(exit_listener);
    if !published {
        let _ = rpc::kill(&state, Some(&id)).await;
    } else if let Err(error) = &outcome {
        // Never abort a follow-up the user sent after the scheduled turn settled.
        if !settled {
            if checked_request(&state, &id, json!({"type":"abort"})).await.is_err() {
                let _ = rpc::kill(&state, Some(&id)).await;
            }
            crate::remote::emit(app, "pi://event", json!({
                "type": "scheduled_session_failed", "runtimeId": id, "error": error,
            }));
        }
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
    let mut tasks: Vec<Task> = match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e.into()),
    };
    let now = Local::now().timestamp_millis();
    for task in &mut tasks {
        if task.status == "running" {
            task.status = "failed".into();
            task.error = Some("Interrupted by application shutdown".into());
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
    persist(&tasks)?;
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
            if let Err(e) = persist(&updated) {
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
                    let state = app.state::<ScheduleState>();
                    let mut guard = state.0.lock().await;
                    if let Some(current) = guard.iter_mut().find(|t| t.input.id == task.input.id) {
                        // Skip slots missed while this task was running.
                        if let Ok(next) =
                            next_run(&current.input.expression, Local::now().timestamp_millis())
                        {
                            current.next_run = next;
                        }
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
                        if let Err(e) = persist(&guard) {
                            eprintln!("Schedule result persistence failed: {e}");
                        }
                        drop(guard);
                        notify_schedules_changed(&app);
                    }
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
        tx.send(json!({"type":"extension_ui_request", "method":"confirm"})).unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(10), &mut wait).await.is_err());
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
}
