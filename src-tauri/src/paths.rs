use std::path::Path;

/// Compare already-normalized paths, including Windows-shaped paths when the
/// backend runs on another OS (remote state can contain either kind).
pub fn eq_norm(left: &str, right: &str) -> bool {
    let windows = |path: &str| {
        path.starts_with("//")
            || (path.len() >= 3
                && path.as_bytes()[0].is_ascii_alphabetic()
                && &path.as_bytes()[1..3] == b":/")
    };
    if windows(left) || windows(right) {
        left.to_lowercase() == right.to_lowercase()
    } else {
        left == right
    }
}

pub fn eq_norm_path(left: &Path, right: &Path) -> bool {
    eq_norm(
        &left.to_string_lossy().replace('\\', "/"),
        &right.to_string_lossy().replace('\\', "/"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_windows_paths_case_insensitively_on_every_host() {
        assert!(eq_norm("C:/Work/PiX", "c:/work/pix"));
        assert!(!eq_norm("/home/PiX", "/home/pix"));
    }
}
