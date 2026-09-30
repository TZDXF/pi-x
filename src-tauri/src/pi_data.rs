//! Thin adapter to the user's installed Pi SDK. No duplicate agent state.
use serde_json::Value;
use std::{
    io::Write,
    process::{Command, Stdio},
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
        .arg(dist)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    child
        .stdin
        .take()
        .ok_or("Missing Pi SDK stdin")?
        .write_all(request.to_string().as_bytes())
        .map_err(|e| e.to_string())?;
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Pi SDK: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    serde_json::from_slice(&output.stdout).map_err(|e| format!("Invalid Pi SDK response: {e}"))
}
