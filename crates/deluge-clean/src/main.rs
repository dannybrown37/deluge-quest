mod scanner;

use std::fs;
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process;

use clap::Parser;
use serde_json::json;

use scanner::{scan_card, CardReport};

#[derive(Parser)]
#[command(about = "Find unused samples and presets on a Deluge SD card")]
#[command(version)]
struct Cli {
    /// Path to Deluge SD card root directory
    card_root: Option<PathBuf>,

    /// Move unused samples to SAMPLES/_UNUSED/ (default: report only)
    #[arg(long)]
    r#move: bool,

    /// List files (all, samples, missing, presets)
    #[arg(long, value_name = "CATEGORY")]
    list: Option<Option<ListCategory>>,

    /// Output as JSON
    #[arg(long)]
    json: bool,
}

#[derive(Clone, Debug)]
enum ListCategory {
    All,
    Samples,
    Missing,
    Presets,
}

impl std::str::FromStr for ListCategory {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "all" => Ok(Self::All),
            "samples" => Ok(Self::Samples),
            "missing" => Ok(Self::Missing),
            "presets" => Ok(Self::Presets),
            _ => Err(format!("invalid category '{s}', expected: all, samples, missing, presets")),
        }
    }
}

fn format_bytes(n: u64) -> String {
    if n < 1024 {
        format!("{n} B")
    } else if n < 1024 * 1024 {
        format!("{:.1} KB", n as f64 / 1024.0)
    } else if n < 1024 * 1024 * 1024 {
        format!("{:.1} MB", n as f64 / (1024.0 * 1024.0))
    } else {
        format!("{:.2} GB", n as f64 / (1024.0 * 1024.0 * 1024.0))
    }
}

fn print_summary(report: &CardReport, card_root: &Path) {
    println!("\nDeluge SD Card: {}", card_root.display());
    println!("{}", "─".repeat(44));

    let total_size = format_bytes(report.total_samples_bytes);
    println!(
        "  Samples       {:>5} files   {total_size}",
        format_count(report.total_samples)
    );
    println!(
        "  Referenced    {:>5} files",
        format_count(report.total_references)
    );

    if !report.unused_samples.is_empty() {
        let reclaim = format_bytes(report.reclaimable_bytes);
        println!(
            "  Unused        {:>5} files   {reclaim} reclaimable",
            format_count(report.unused_samples.len())
        );
    } else {
        println!("  Unused            0 files");
    }

    if !report.missing_references.is_empty() {
        println!(
            "  Broken refs   {:>5} files   (referenced but missing)",
            format_count(report.missing_references.len())
        );
    }

    if !report.unused_presets.is_empty() {
        println!(
            "  Orphan presets {:>4} files   (not used by any song)",
            format_count(report.unused_presets.len())
        );
    }

    if !report.unused_samples.is_empty() {
        println!("\nRun with --move to relocate unused samples to SAMPLES/_UNUSED/");
    }
    println!("Run with --list for full file listing");
}

fn format_count(n: usize) -> String {
    if n >= 1000 {
        let thousands = n / 1000;
        let remainder = n % 1000;
        format!("{thousands},{remainder:03}")
    } else {
        n.to_string()
    }
}

fn print_list(report: &CardReport, category: Option<&ListCategory>) {
    let show_all = category.is_none() || matches!(category, Some(ListCategory::All));

    if show_all || matches!(category, Some(ListCategory::Samples)) {
        if !report.unused_samples.is_empty() {
            println!("\nUnused samples ({}):", report.unused_samples.len());
            for s in &report.unused_samples {
                println!("  {s}");
            }
        }
    }

    if show_all || matches!(category, Some(ListCategory::Missing)) {
        if !report.missing_references.is_empty() {
            println!("\nBroken references ({}):", report.missing_references.len());
            for m in &report.missing_references {
                println!("  {m}");
            }
        }
    }

    if show_all || matches!(category, Some(ListCategory::Presets)) {
        if !report.unused_presets.is_empty() {
            println!("\nOrphan presets ({}):", report.unused_presets.len());
            for p in &report.unused_presets {
                println!("  {p}");
            }
        }
    }

    let total =
        report.unused_samples.len() + report.missing_references.len() + report.unused_presets.len();
    if total == 0 {
        println!("\nNothing to list — card is clean.");
    }
}

fn move_unused(card_root: &Path, report: &CardReport) -> io::Result<usize> {
    let unused_dir = card_root.join("SAMPLES").join("_UNUSED");
    let mut moved = 0;
    for rel in &report.unused_samples {
        let src = card_root.join(rel);
        if !src.exists() {
            continue;
        }
        let dest_rel = rel.strip_prefix("SAMPLES/").unwrap_or(rel);
        let dest = unused_dir.join(dest_rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(&src, &dest)?;
        moved += 1;
    }
    Ok(moved)
}

fn browse_for_folder() -> Option<PathBuf> {
    let ps = which("powershell.exe")?;
    let ps_cmd = concat!(
        "Add-Type -AssemblyName System.Windows.Forms; ",
        "$d = New-Object System.Windows.Forms.FolderBrowserDialog; ",
        "$d.Description = 'Select Deluge SD card root folder'; ",
        "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { exit 1 }",
    );
    let result = std::process::Command::new(ps)
        .args(["-NoProfile", "-Command", ps_cmd])
        .output()
        .ok()?;
    if !result.status.success() {
        return None;
    }
    let win_path = String::from_utf8_lossy(&result.stdout).trim().to_string();
    if win_path.is_empty() {
        return None;
    }
    let wsl = std::process::Command::new("wslpath")
        .args(["-u", &win_path])
        .output()
        .ok()?;
    if !wsl.status.success() {
        return None;
    }
    let unix_path = String::from_utf8_lossy(&wsl.stdout).trim().to_string();
    let p = PathBuf::from(unix_path);
    if p.exists() { Some(p) } else { None }
}

fn which(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH")?
        .to_string_lossy()
        .split(':')
        .map(|dir| Path::new(dir).join(name))
        .find(|p| p.is_file())
}

fn prompt_for_card() -> PathBuf {
    if !io::stdin().is_terminal() {
        eprintln!(
            "error: no card path given and stdin is not a TTY\n\
             usage: deluge-clean <path-to-sd-card>"
        );
        process::exit(1);
    }

    eprintln!("No path given. Opening folder picker...");
    if let Some(selected) = browse_for_folder() {
        eprintln!("Selected: {}", selected.display());
        return selected;
    }
    eprintln!("Folder picker cancelled or unavailable.");

    eprint!("Enter path to Deluge SD card root: ");
    io::stderr().flush().ok();
    let mut line = String::new();
    io::stdin().read_line(&mut line).unwrap_or(0);
    let trimmed = line.trim();
    if trimmed.is_empty() {
        eprintln!("error: no path given");
        process::exit(1);
    }
    let p = PathBuf::from(trimmed);
    if !p.exists() {
        eprintln!("error: {} does not exist", p.display());
        process::exit(1);
    }
    p
}

fn run(args: Cli) {
    let card_root = args.card_root.unwrap_or_else(|| prompt_for_card());

    let progress_fn = |msg: &str| {
        if !args.json {
            eprint!("  {msg}\r");
        }
    };

    let report = match scan_card(&card_root, Some(&progress_fn)) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error: {e}");
            process::exit(1);
        }
    };

    if args.json {
        let j = json!({
            "total_samples": report.total_samples,
            "total_samples_bytes": report.total_samples_bytes,
            "total_references": report.total_references,
            "unused_samples": report.unused_samples,
            "missing_references": report.missing_references,
            "unused_presets": report.unused_presets,
            "reclaimable_bytes": report.reclaimable_bytes,
        });
        println!("{}", serde_json::to_string_pretty(&j).unwrap());
    } else if let Some(ref list_arg) = args.list {
        print_list(&report, list_arg.as_ref());
    } else {
        print_summary(&report, &card_root);
    }

    if args.r#move && !report.unused_samples.is_empty() {
        if io::stdin().is_terminal() && !args.json {
            eprint!(
                "\nMove {} unused samples to SAMPLES/_UNUSED/? [y/N] ",
                report.unused_samples.len()
            );
            io::stderr().flush().ok();
            let mut answer = String::new();
            io::stdin().read_line(&mut answer).unwrap_or(0);
            if answer.trim().to_lowercase() != "y" {
                println!("Aborted.");
                return;
            }
        }
        match move_unused(&card_root, &report) {
            Ok(moved) => {
                let reclaimed = format_bytes(report.reclaimable_bytes);
                println!("\nMoved {moved} files to SAMPLES/_UNUSED/ ({reclaimed} reclaimed)");
            }
            Err(e) => {
                eprintln!("error moving files: {e}");
                process::exit(1);
            }
        }
    }
}

fn main() {
    let args = Cli::parse();
    run(args);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn make_card(tmp: &TempDir) -> PathBuf {
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
    fn test_format_bytes() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(1024), "1.0 KB");
        assert_eq!(format_bytes(1024 * 1024), "1.0 MB");
        assert_eq!(format_bytes(1024 * 1024 * 1024), "1.00 GB");
    }

    #[test]
    fn test_format_count() {
        assert_eq!(format_count(0), "0");
        assert_eq!(format_count(999), "999");
        assert_eq!(format_count(1000), "1,000");
        assert_eq!(format_count(12345), "12,345");
    }

    #[test]
    fn test_move_unused() {
        let tmp = TempDir::new().unwrap();
        let root = make_card(&tmp);
        setup_card_with_unused(&root);

        let report = scan_card(&root, None).unwrap();
        let moved = move_unused(&root, &report).unwrap();

        assert_eq!(moved, 1);
        assert!(root.join("SAMPLES/_UNUSED/RECORD/UNUSED.WAV").exists());
        assert!(!root.join("SAMPLES/RECORD/UNUSED.WAV").exists());
        assert!(root.join("SAMPLES/RECORD/USED.WAV").exists());
    }
}
