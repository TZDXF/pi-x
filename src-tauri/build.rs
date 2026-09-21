use std::{fs, path::Path};

// Remote access serves an embedded production frontend, independently of Vite.
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
    if std::env::var_os("CARGO_FEATURE_REMOTE_ACCESS").is_some() {
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
    }
    tauri_build::build()
}
