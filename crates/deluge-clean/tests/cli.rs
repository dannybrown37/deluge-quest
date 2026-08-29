use std::fs;
use std::path::Path;
use std::process::Command;

use tempfile::TempDir;

fn binary() -> Command {
    Command::new(env!("CARGO_BIN_EXE_deluge-clean"))
}

fn make_card(tmp: &TempDir) -> std::path::PathBuf {
    let root = tmp.path().to_path_buf();
    fs::create_dir_all(root.join("SONGS")).unwrap();
    fs::create_dir_all(root.join("KITS")).unwrap();
    fs::create_dir_all(root.join("SYNTHS")).unwrap();
    fs::create_dir_all(root.join("SAMPLES/RECORD")).unwrap();
    root
}

fn write_xml(path: &Path, content: &str) {
    fs::write(path, content.trim()).unwrap();
}

fn setup_card_with_unused(root: &Path) {
    fs::write(root.join("SAMPLES/RECORD/USED.WAV"), vec![0u8; 100]).unwrap();
    fs::write(root.join("SAMPLES/RECORD/UNUSED.WAV"), vec![0u8; 200]).unwrap();
    write_xml(
        &root.join("SONGS/S.XML"),
        r#"<song><osc fileName="SAMPLES/RECORD/USED.WAV" /></song>"#,
    );
}

#[test]
fn version_flag() {
    let out = binary().arg("--version").output().unwrap();
    assert!(out.status.success());
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("0.1.0"), "expected version in: {stdout}");
}

#[test]
fn summary_default() {
    let tmp = TempDir::new().unwrap();
    let root = make_card(&tmp);
    setup_card_with_unused(&root);

    let out = binary().arg(root.to_str().unwrap()).output().unwrap();
    assert!(out.status.success());
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("Deluge SD Card:"), "missing header in: {stdout}");
    assert!(stdout.contains("Samples"), "missing Samples in: {stdout}");
    assert!(stdout.contains("Referenced"), "missing Referenced in: {stdout}");
    assert!(stdout.contains("1 files"), "missing unused count in: {stdout}");
    assert!(stdout.contains("reclaimable"), "missing reclaimable in: {stdout}");
    assert!(!stdout.contains("UNUSED.WAV"), "should not list files in summary");
}

#[test]
fn summary_clean_card() {
    let tmp = TempDir::new().unwrap();
    let root = make_card(&tmp);
    fs::write(root.join("SAMPLES/RECORD/A.WAV"), b"").unwrap();
    write_xml(
        &root.join("SONGS/S.XML"),
        r#"<song><osc fileName="SAMPLES/RECORD/A.WAV" /></song>"#,
    );

    let out = binary().arg(root.to_str().unwrap()).output().unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("Unused            0 files"), "expected clean card in: {stdout}");
}

#[test]
fn list_shows_filenames() {
    let tmp = TempDir::new().unwrap();
    let root = make_card(&tmp);
    setup_card_with_unused(&root);

    let out = binary()
        .args([root.to_str().unwrap(), "--list"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("SAMPLES/RECORD/UNUSED.WAV"), "missing filename in: {stdout}");
}

#[test]
fn list_samples_only() {
    let tmp = TempDir::new().unwrap();
    let root = make_card(&tmp);
    setup_card_with_unused(&root);
    write_xml(
        &root.join("KITS/ORPHAN.XML"),
        r#"<kit><osc fileName="SAMPLES/y.wav" /></kit>"#,
    );

    let out = binary()
        .args([root.to_str().unwrap(), "--list", "samples"])
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("UNUSED.WAV"), "missing UNUSED.WAV in: {stdout}");
    assert!(!stdout.contains("ORPHAN.XML"), "should not show presets in: {stdout}");
}

#[test]
fn json_output() {
    let tmp = TempDir::new().unwrap();
    let root = make_card(&tmp);
    setup_card_with_unused(&root);

    let out = binary()
        .args([root.to_str().unwrap(), "--json"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let stdout = String::from_utf8_lossy(&out.stdout);
    let data: serde_json::Value = serde_json::from_str(&stdout).expect("valid JSON");
    let unused = data["unused_samples"].as_array().unwrap();
    assert!(unused.iter().any(|v| v == "SAMPLES/RECORD/UNUSED.WAV"));
    assert_eq!(data["reclaimable_bytes"], 200);
    assert_eq!(data["total_samples_bytes"], 300);
}

#[test]
fn invalid_card() {
    let tmp = TempDir::new().unwrap();
    let out = binary().arg(tmp.path().to_str().unwrap()).output().unwrap();
    assert!(!out.status.success());
}

#[test]
fn no_args_non_tty() {
    let out = binary()
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert!(!out.status.success());
}

#[test]
fn move_flag_non_interactive() {
    let tmp = TempDir::new().unwrap();
    let root = make_card(&tmp);
    setup_card_with_unused(&root);

    let out = binary()
        .args([root.to_str().unwrap(), "--move", "--json"])
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert!(out.status.success());
    assert!(root.join("SAMPLES/_UNUSED/RECORD/UNUSED.WAV").exists());
    assert!(!root.join("SAMPLES/RECORD/UNUSED.WAV").exists());
    assert!(root.join("SAMPLES/RECORD/USED.WAV").exists());
}
