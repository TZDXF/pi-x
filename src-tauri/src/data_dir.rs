use std::path::PathBuf;

pub fn root() -> PathBuf {
    dirs::home_dir()
        .expect("Cannot locate user home directory")
        .join(".pix")
}

pub fn initialize() -> Result<(), std::io::Error> {
    let root = root();
    std::fs::create_dir_all(root.join("agent"))?;
    Ok(())
}
