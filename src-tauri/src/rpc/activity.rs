//! Generation-scoped, backend-owned run identity and reconnectable UI requests.
//! Updates and broadcasts share one lock so every client sees the same identity.

use super::child::EventSink;
use super::{EVENT, EXIT_EVENT};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;
use tokio::time::Instant;

// Replacements use a fresh ProcessState. Preserve timestamp ordering across
// workers too, including a restart within the same wall-clock millisecond.
static LAST_UPDATED_AT: AtomicU64 = AtomicU64::new(0);

struct PendingUi {
    value: Value,
    token: u64,
    deadline: Option<Instant>,
}

#[derive(Default)]
pub(super) struct RuntimeActivity {
    generation: u64,
    runtime_id: String,
    project: String,
    sink: Option<Arc<dyn EventSink>>,
    run: Option<Value>,
    session_file: Option<String>,
    failed: bool,
    aborted: bool,
    pending: Vec<PendingUi>,
    next_token: u64,
}

impl RuntimeActivity {
    pub(super) fn reset(
        &mut self,
        generation: u64,
        runtime_id: &str,
        project: &str,
        session_file: Option<String>,
        sink: Arc<dyn EventSink>,
    ) {
        self.clear_pending();
        *self = Self {
            generation,
            runtime_id: runtime_id.into(),
            project: project.into(),
            session_file,
            sink: Some(sink),
            ..Self::default()
        };
    }

    pub(super) fn is_current(&self, generation: u64) -> bool {
        self.generation == generation
    }

    fn running(&self) -> bool {
        self.run
            .as_ref()
            .is_some_and(|run| run["status"] == "running")
    }

    fn timestamp(&self) -> u64 {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        // A settled status must sort after its start, even within one millisecond
        // or if the wall clock moved backwards.
        let mut previous = LAST_UPDATED_AT.load(Ordering::Relaxed);
        loop {
            let next = now.max(previous.saturating_add(1));
            match LAST_UPDATED_AT.compare_exchange_weak(
                previous,
                next,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => return next,
                Err(actual) => previous = actual,
            }
        }
    }

    fn start(&mut self) {
        if !self.running() {
            self.run = Some(json!({
                "status": "running",
                "runId": uuid::Uuid::new_v4().to_string(),
                "updatedAt": self.timestamp(),
            }));
        }
        self.failed = false;
        self.aborted = false;
    }

    fn finish(&mut self, status: &str) {
        if self.running() {
            let updated_at = self.timestamp();
            if let Some(run) = self.run.as_mut() {
                run["status"] = json!(status);
                run["updatedAt"] = json!(updated_at);
            }
        }
        self.clear_pending();
    }

    pub(super) fn stamp(&self, value: &mut Value) {
        value["runtimeId"] = json!(self.runtime_id);
        value["pixProject"] = json!(self.project);
        // Never trust upstream pix metadata: PiX is the sole authority.
        if let Some(object) = value.as_object_mut() {
            for key in [
                "pixRunId",
                "pixRunUpdatedAt",
                "pixRunStatus",
                "pixSessionFile",
            ] {
                object.remove(key);
            }
        }
        if let Some(run) = &self.run {
            value["pixRunId"] = run["runId"].clone();
            value["pixRunUpdatedAt"] = run["updatedAt"].clone();
            value["pixRunStatus"] = run["status"].clone();
        }
        if let Some(file) = &self.session_file {
            value["pixSessionFile"] = json!(file);
        }
    }

    fn emit(&self, mut value: Value) {
        self.stamp(&mut value);
        if let Some(sink) = &self.sink {
            sink.emit(EVENT, &self.runtime_id, value);
        }
    }

    pub(super) fn resolve(&mut self, id: &str) {
        if let Some(index) = self.pending.iter().position(|p| p.value["id"] == id) {
            self.pending.remove(index);
            self.emit(json!({"type": "extension_ui_resolved", "id": id}));
        }
    }

    fn clear_pending(&mut self) {
        for request in std::mem::take(&mut self.pending) {
            self.emit(json!({"type": "extension_ui_resolved", "id": request.value["id"]}));
        }
    }

    fn expire(&mut self, now: Instant) {
        let expired: Vec<_> = self
            .pending
            .iter()
            .filter(|p| p.deadline.is_some_and(|deadline| deadline <= now))
            .filter_map(|p| p.value["id"].as_str().map(str::to_owned))
            .collect();
        for id in expired {
            self.resolve(&id);
        }
    }

    pub(super) fn snapshot(&mut self, snapshot: &mut Value) {
        self.expire(Instant::now());
        if let Some(run) = &self.run {
            snapshot["activity"] = run.clone();
        }
        snapshot["pendingUiRequests"] =
            Value::Array(self.pending.iter().map(|p| p.value.clone()).collect());
        if snapshot["state"].is_object() {
            if let Some(file) = &self.session_file {
                snapshot["state"]["sessionFile"] = json!(file);
            }
        }
    }

    fn session(&mut self, file: Option<&str>) {
        if self.session_file.as_deref() == file {
            return;
        }
        // The first get_state can discover a file reserved during the active run.
        // A subsequent navigation must not attach the old run to a different file.
        if self.session_file.is_some() {
            self.clear_pending();
            self.run = None;
            self.failed = false;
            self.aborted = false;
        }
        self.session_file = file.map(str::to_owned);
    }

    pub(super) fn response(&mut self, value: &Value) {
        if value["success"] != true {
            return;
        }
        if matches!(
            value["command"].as_str(),
            Some("new_session" | "switch_session" | "fork" | "clone")
        ) && value["data"]["cancelled"] != true
        {
            self.clear_pending();
            self.run = None;
            self.failed = false;
            self.aborted = false;
            self.session_file = value["data"]["sessionFile"].as_str().map(str::to_owned);
        } else if let Some(file) = value["data"].get("sessionFile") {
            self.session(file.as_str());
        }
    }

    /// Called only after stdin accepted the command. In particular, failed
    /// writes must leave an extension request available for another client.
    pub(super) fn command(&mut self, value: &Value) {
        match value["type"].as_str() {
            Some("extension_ui_response") => {
                if let Some(id) = value["id"].as_str() {
                    self.resolve(id);
                }
            }
            // Older workers may settle without an aborted flag or a message.
            Some("abort") if self.running() => self.aborted = true,
            _ => {}
        }
    }

    /// Expiry and acceptance use the same lock. A queued response must not
    /// answer a later request that reused the same extension id.
    pub(super) fn response_token(&mut self, value: &Value) -> Option<u64> {
        self.expire(Instant::now());
        let id = value["id"].as_str()?;
        self.pending
            .iter()
            .find(|p| p.value["id"] == id)
            .map(|p| p.token)
    }
    /// Returns a request timer token. Tokens prevent an old timer from deleting
    /// a later request if an extension reuses an id within the same worker.
    pub(super) fn event(&mut self, mut value: Value) -> Option<(u64, Instant)> {
        self.expire(Instant::now());
        if let Some(file) = value.get("sessionFile") {
            self.session(file.as_str());
        }
        match value["type"].as_str() {
            Some("agent_start") => self.start(),
            Some("message_end") if value["message"]["role"] == "assistant" => {
                self.failed = value["message"]["stopReason"] == "error";
                self.aborted |= value["message"]["stopReason"] == "aborted";
            }
            Some("auto_retry_end") => self.failed = value["success"] != true,
            Some("agent_settled") => {
                self.aborted |= value["aborted"] == true;
                self.finish(if self.aborted {
                    "idle"
                } else if self.failed {
                    "error"
                } else {
                    "completed"
                });
            }
            Some("extension_ui_resolved") => {
                if let Some(id) = value["id"].as_str() {
                    self.resolve(id);
                }
                return None;
            }
            _ => {}
        }
        self.stamp(&mut value);
        let mut timer = None;
        if value["type"] == "extension_ui_request"
            && matches!(
                value["method"].as_str(),
                Some("select" | "confirm" | "input" | "editor")
            )
        {
            if let Some(id) = value["id"].as_str() {
                self.resolve(id);
                self.next_token += 1;
                let deadline = value["timeout"]
                    .as_u64()
                    .filter(|ms| *ms > 0)
                    .and_then(|ms| Instant::now().checked_add(Duration::from_millis(ms)));
                timer = deadline.map(|deadline| (self.next_token, deadline));
                self.pending.push(PendingUi {
                    value: value.clone(),
                    token: self.next_token,
                    deadline,
                });
            }
        }
        if let Some(sink) = &self.sink {
            sink.emit(EVENT, &self.runtime_id, value);
        }
        timer
    }

    /// Stop invalidates both stdout readers and per-request timers atomically.
    /// Unexpected EOF fails an active run; an explicit stop is an abort/idle.
    pub(super) fn stop(&mut self, generation: u64, unexpected: bool) -> Value {
        self.finish(if unexpected { "error" } else { "idle" });
        self.generation = generation;
        let mut exit = json!({"runtimeId": self.runtime_id});
        self.stamp(&mut exit);
        exit
    }

    pub(super) fn stop_and_emit(&mut self, generation: u64, unexpected: bool) {
        let exit = self.stop(generation, unexpected);
        if let Some(sink) = &self.sink {
            sink.emit(EXIT_EVENT, &self.runtime_id, exit);
        }
    }

    pub(super) fn rebind_project(&mut self, project: &str, path: &str) -> Option<Value> {
        if self.project == project {
            return None;
        }
        let previous = std::mem::replace(&mut self.project, project.to_string());
        let mut value = json!({
            "runtimeId": self.runtime_id,
            "project": project,
            "previousProject": previous,
            "path": path,
        });
        self.stamp(&mut value);
        Some(value)
    }
}

pub(super) fn schedule_timeout(
    activity: Weak<Mutex<RuntimeActivity>>,
    generation: u64,
    token: u64,
    deadline: Instant,
) {
    tokio::spawn(async move {
        tokio::time::sleep_until(deadline).await;
        let Some(activity) = activity.upgrade() else {
            return;
        };
        let mut activity = activity.lock().await;
        if activity.is_current(generation) && activity.pending.iter().any(|p| p.token == token) {
            activity.expire(Instant::now());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    #[derive(Default)]
    struct Sink(StdMutex<Vec<Value>>);
    impl EventSink for Sink {
        fn emit(&self, _: &'static str, _: &str, value: Value) {
            self.0.lock().unwrap().push(value);
        }
    }

    fn setup() -> (RuntimeActivity, Arc<Sink>) {
        let sink = Arc::new(Sink::default());
        let mut activity = RuntimeActivity::default();
        activity.reset(
            1,
            "test",
            "project",
            Some("session.jsonl".into()),
            sink.clone(),
        );
        (activity, sink)
    }

    fn event(activity: &mut RuntimeActivity, ty: &str) {
        activity.event(json!({"type": ty}));
    }

    fn pending(activity: &mut RuntimeActivity, id: &str) {
        activity.event(json!({"type": "extension_ui_request", "id": id, "method": "confirm"}));
    }

    #[test]
    fn run_identity_survives_retry_and_settled_matches_every_client_snapshot() {
        let (mut activity, sink) = setup();
        event(&mut activity, "agent_start");
        let first = activity.run.clone().unwrap();
        event(&mut activity, "agent_end");
        event(&mut activity, "agent_start");
        event(&mut activity, "agent_settled");
        let settled = activity.run.clone().unwrap();
        assert_eq!(settled["runId"], first["runId"]);
        assert_eq!(settled["status"], "completed");
        assert!(settled["updatedAt"].as_u64() > first["updatedAt"].as_u64());
        let mut snapshot = json!({});
        activity.snapshot(&mut snapshot);
        assert_eq!(snapshot["activity"], settled);
        for value in sink.0.lock().unwrap().iter() {
            assert_eq!(value["pixRunId"], first["runId"]);
            assert_eq!(value["pixSessionFile"], "session.jsonl");
            assert_eq!(value["pixProject"], "project");
        }
        event(&mut activity, "agent_settled");
        assert_eq!(activity.run, Some(settled));
        event(&mut activity, "agent_start");
        assert_ne!(activity.run.as_ref().unwrap()["runId"], first["runId"]);
    }

    #[test]
    fn failed_recovered_and_aborted_runs_have_correct_terminal_status() {
        for (reason, recovered, aborted, expected) in [
            ("error", false, false, "error"),
            ("error", true, false, "completed"),
            ("aborted", false, false, "idle"),
            ("stop", false, true, "idle"),
        ] {
            let (mut activity, _) = setup();
            event(&mut activity, "agent_start");
            activity.event(
                json!({"type":"message_end", "message":{"role":"assistant", "stopReason":reason}}),
            );
            if recovered {
                activity.event(json!({"type":"auto_retry_end", "success":true}));
            }
            pending(&mut activity, "pending");
            activity.event(json!({"type":"agent_settled", "aborted":aborted}));
            assert_eq!(activity.run.as_ref().unwrap()["status"], expected);
            assert!(activity.pending.is_empty());
        }
    }

    #[test]
    fn only_blocking_requests_survive_and_response_resolves_exactly_once() {
        let (mut activity, sink) = setup();
        for method in [
            "select",
            "confirm",
            "input",
            "editor",
            "notify",
            "setStatus",
            "setWidget",
        ] {
            activity.event(json!({"type":"extension_ui_request", "method":method, "id":method}));
        }
        assert_eq!(activity.pending.len(), 4);
        activity.command(&json!({"type":"extension_ui_response", "id":"select", "value":"ok"}));
        activity.command(&json!({"type":"extension_ui_response", "id":"select", "value":"ok"}));
        assert_eq!(activity.pending.len(), 3);
        let emitted = sink.0.lock().unwrap();
        let resolved: Vec<_> = emitted
            .iter()
            .filter(|v| v["type"] == "extension_ui_resolved")
            .collect();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0]["id"], "select");
        assert_eq!(resolved[0]["runtimeId"], "test");
        assert_eq!(resolved[0]["pixProject"], "project");
    }

    #[test]
    fn accepted_abort_without_assistant_message_settles_idle() {
        let (mut activity, _) = setup();
        event(&mut activity, "agent_start");
        let run_id = activity.run.as_ref().unwrap()["runId"].clone();
        activity.command(&json!({"type":"abort"}));
        event(&mut activity, "agent_settled");
        assert_eq!(activity.run.as_ref().unwrap()["runId"], run_id);
        assert_eq!(activity.run.as_ref().unwrap()["status"], "idle");
    }

    #[test]
    fn navigation_without_a_session_file_does_not_reuse_the_previous_identity() {
        let (mut activity, _) = setup();
        event(&mut activity, "agent_start");
        pending(&mut activity, "old-session");
        let old_run = activity.run.clone().unwrap();
        activity
            .response(&json!({"command":"new_session", "success":true, "data":{"cancelled":true}}));
        assert_eq!(activity.run, Some(old_run.clone()));
        activity.response(
            &json!({"command":"new_session", "success":true, "data":{"cancelled":false}}),
        );
        assert!(activity.pending.is_empty());
        assert!(activity.session_file.is_none());
        event(&mut activity, "agent_start");
        let new_run = activity.run.clone().unwrap();
        assert_ne!(new_run["runId"], old_run["runId"]);
        activity.response(&json!({"success":true, "data":{"sessionFile":"new.jsonl"}}));
        assert_eq!(activity.run, Some(new_run));
        assert_eq!(activity.session_file.as_deref(), Some("new.jsonl"));
    }

    #[test]
    fn timeout_snapshot_removes_expired_requests_without_external_services() {
        let (mut activity, sink) = setup();
        activity.event(
            json!({"type":"extension_ui_request", "id":"expires", "method":"input", "timeout":50}),
        );
        pending(&mut activity, "stays");
        activity.expire(Instant::now() + Duration::from_millis(51));
        let mut snapshot = json!({});
        activity.snapshot(&mut snapshot);
        assert_eq!(snapshot["pendingUiRequests"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["pendingUiRequests"][0]["id"], "stays");
        assert!(sink
            .0
            .lock()
            .unwrap()
            .iter()
            .any(|v| v["type"] == "extension_ui_resolved" && v["id"] == "expires"));
    }

    #[test]
    fn exit_respawn_and_session_switch_clear_invalid_requests() {
        let (mut activity, sink) = setup();
        event(&mut activity, "agent_start");
        pending(&mut activity, "old");
        let exit = activity.stop(2, true);
        assert_eq!(exit["pixRunStatus"], "error");
        assert!(!activity.is_current(1));
        assert!(activity.pending.is_empty());
        activity.reset(3, "test", "project", None, sink);
        assert!(activity.run.is_none());
        event(&mut activity, "agent_start");
        activity.response(&json!({"success":true, "data":{"sessionFile":"new.jsonl"}}));
        assert!(
            activity.running(),
            "discovering the first file preserves the active run"
        );
        pending(&mut activity, "navigation");
        activity.response(&json!({"success":true, "data":{"sessionFile":"different.jsonl"}}));
        assert!(activity.run.is_none());
        assert!(activity.pending.is_empty());
        event(&mut activity, "agent_start");
        assert_eq!(activity.stop(4, false)["pixRunStatus"], "idle");
    }

    #[test]
    fn realpath_rebind_stamps_future_events_with_the_new_project() {
        let (mut activity, _) = setup();
        event(&mut activity, "agent_start");
        let rebound = activity
            .rebind_project("ssh://host/physical", "/physical")
            .unwrap();
        assert_eq!(rebound["previousProject"], "project");
        assert_eq!(rebound["pixProject"], "ssh://host/physical");
        assert_eq!(rebound["pixSessionFile"], "session.jsonl");
        let exit = activity.stop(2, true);
        assert_eq!(exit["pixProject"], "ssh://host/physical");
        assert!(activity
            .rebind_project("ssh://host/physical", "/physical")
            .is_none());
    }

    #[tokio::test]
    async fn timeout_broadcasts_and_stale_generation_cannot_resolve_reused_id() {
        let (initial, sink) = setup();
        let activity = Arc::new(Mutex::new(initial));
        let (token, deadline) = activity
            .lock()
            .await
            .event(
                json!({"type":"extension_ui_request", "id":"old", "method":"input", "timeout":1}),
            )
            .unwrap();
        schedule_timeout(Arc::downgrade(&activity), 1, token, deadline);
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if activity.lock().await.pending.is_empty() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let mut guard = activity.lock().await;
        guard.reset(2, "test", "project", None, sink);
        pending(&mut guard, "old");
        drop(guard);
        schedule_timeout(Arc::downgrade(&activity), 1, token, Instant::now());
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(activity.lock().await.pending.len(), 1);
    }
}
