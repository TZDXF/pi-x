use std::{fs, path::Path};

// Bundle the same production frontend in debug and release builds. Tauri's
// debug asset resolver otherwise points at the local Vite development server.
fn embed_assets(root: &Path, dir: &Path, code: &mut String) {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .expect("Missing frontend assets: run npm run build first")
        .map(|entry| entry.unwrap().path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            embed_assets(root, &path, code);
        } else {
            let key = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            code.push_str(&format!("{key:?} => Some(include_bytes!({:?})),\n", path));
        }
    }
}

fn main() {
    println!("cargo:rerun-if-changed=../dist");
    let root = Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("../dist");
    let mut code =
        String::from("fn embedded_asset(path: &str) -> Option<&'static [u8]> { match path {\n");
    embed_assets(&root, &root, &mut code);
    code.push_str("_ => None, } }\n");
    fs::write(
        Path::new(&std::env::var("OUT_DIR").unwrap()).join("web_assets.rs"),
        code,
    )
    .unwrap();
    tauri_build::build()
}
