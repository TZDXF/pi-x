//! Thin adapter to the user's installed Pi SDK. No duplicate agent state.
use serde_json::Value;
use std::{
    fs::File,
    io::{Seek, SeekFrom, Write},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub fn call(request: Value) -> Result<Value, String> {
    let config_path = crate::data_dir::root().join("config.json");
    let config: Value = match std::fs::read_to_string(config_path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| e.to_string())?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Value::Null,
        Err(e) => return Err(e.to_string()),
    };
    let (node, dist) = crate::pi_locate::sdk_launcher(config["piPath"].as_str())?;
    let mut command = Command::new(node);
    command
        .args([
            "--input-type=module",
            "--eval",
            include_str!("../resources/pi_data.mjs"),
        ])
        .arg(dist);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(crate::process::CREATE_NO_WINDOW);
    }
    let output = run_with_timeout(
        &mut command,
        request.to_string().into_bytes(),
        Duration::from_secs(30),
    )?;
    if !output.status.success() {
        return Err(format!(
            "Pi SDK: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    serde_json::from_slice(&output.stdout).map_err(|e| format!("Invalid Pi SDK response: {e}"))
}

// Windows Tokio child pipes use blocking worker threads, so dropping an async
// read cannot cancel a descendant holding the pipe. Temporary files
// avoid pipes and worker threads altogether. Input is seekable, as required by
// pi_data.mjs (readFileSync(0)); output is snapshotted as soon as the direct
// child exits, independently of descendants inheriting its handles.
fn run_with_timeout(
    command: &mut Command,
    input: Vec<u8>,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let mut stdin = tempfile::tempfile().map_err(|e| e.to_string())?;
    stdin.write_all(&input).map_err(|e| e.to_string())?;
    stdin.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let stdout = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    let stderr = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    command
        .stdin(Stdio::from(stdin))
        .stdout(Stdio::from(stdout.reopen().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(stderr.reopen().map_err(|e| e.to_string())?));
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.to_string());
            }
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Pi SDK call timed out".into());
        }
        std::thread::sleep(remaining.min(Duration::from_millis(10)));
    };
    Ok(std::process::Output {
        status,
        stdout: read_snapshot(stdout.as_file()).map_err(|e| e.to_string())?,
        stderr: read_snapshot(stderr.as_file()).map_err(|e| e.to_string())?,
    })
}

// Reopened output handles have independent cursors, including on Windows where
// seek_read changes the cursor. The initial length bounds the snapshot even
// when a descendant continues writing.
fn read_snapshot(file: &File) -> std::io::Result<Vec<u8>> {
    #[cfg(unix)]
    use std::os::unix::fs::FileExt;
    #[cfg(windows)]
    use std::os::windows::fs::FileExt;

    let length = file.metadata()?.len();
    let mut out = Vec::new();
    let mut buffer = [0u8; 16 * 1024];
    while (out.len() as u64) < length {
        let count = ((length - out.len() as u64).min(buffer.len() as u64)) as usize;
        #[cfg(unix)]
        let read = file.read_at(&mut buffer[..count], out.len() as u64)?;
        #[cfg(windows)]
        let read = file.seek_read(&mut buffer[..count], out.len() as u64)?;
        if read == 0 {
            break;
        }
        out.extend_from_slice(&buffer[..read]);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kills_hung_child_without_waiting_for_input() {
        let mut command = Command::new("node");
        command.args(["-e", "setInterval(() => {}, 1000)"]);
        let started = Instant::now();
        let err = run_with_timeout(
            &mut command,
            vec![b'x'; 4 * 1024 * 1024],
            Duration::from_millis(300),
        )
        .unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn forwards_input_and_captures_output() {
        let mut command = Command::new("node");
        command.args([
            "-e",
            "process.stdout.write(require('node:fs').readFileSync(0))",
        ]);
        let output =
            run_with_timeout(&mut command, b"hello".to_vec(), Duration::from_secs(5)).unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"hello");
    }

    #[test]
    fn does_not_wait_for_descendant_holding_inherited_output() {
        let mut command = Command::new("node");
        command.args([
            "-e",
            r#"
            const { spawn } = require('node:child_process');
            const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'],
              { detached: true, stdio: 'inherit' });
            child.unref();
            process.stdout.write('parent done');
        "#,
        ]);
        let started = Instant::now();
        let output = run_with_timeout(&mut command, vec![], Duration::from_secs(2)).unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"parent done");
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn timeout_does_not_wait_for_descendant_holding_output() {
        let mut command = Command::new("node");
        command.args([
            "-e",
            r#"
            const { spawn } = require('node:child_process');
            spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'],
              { detached: true, stdio: 'inherit' }).unref();
            setInterval(() => {}, 1000);
        "#,
        ]);
        let started = Instant::now();
        let err = run_with_timeout(&mut command, vec![], Duration::from_millis(600)).unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn drains_stdout_and_stderr_without_deadlocking() {
        let mut command = Command::new("node");
        command.args([
            "-e",
            "process.stdout.write('x'.repeat(200000)); process.stderr.write('y'.repeat(200000))",
        ]);
        let output = run_with_timeout(&mut command, vec![], Duration::from_secs(10)).unwrap();
        assert_eq!(output.stdout.len(), 200000);
        assert_eq!(output.stderr.len(), 200000);
    }
}
