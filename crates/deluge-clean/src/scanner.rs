use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::reader::Reader;
use walkdir::WalkDir;

const AUDIO_EXTENSIONS: &[&str] = &["wav", "aif", "aiff"];
const XML_DIRS: &[&str] = &["SONGS", "KITS", "SYNTHS"];
const FILE_ATTRS: &[&[u8]] = &[b"fileName", b"filePath"];

#[derive(Debug, Clone)]
pub struct MissingRef {
    pub sample: String,
    pub referenced_by: Vec<String>,
}

#[derive(Debug, Default)]
pub struct CardReport {
    pub total_samples: usize,
    pub total_samples_bytes: u64,
    pub total_references: usize,
    pub unused_samples: Vec<String>,
    pub missing_references: Vec<MissingRef>,
    pub unused_presets: Vec<String>,
    pub reclaimable_bytes: u64,
}

fn is_audio_ext(ext: &OsStr) -> bool {
    let s = ext.to_string_lossy();
    AUDIO_EXTENSIONS.iter().any(|e| s.eq_ignore_ascii_case(e))
}

fn walk_xml_files(dir: &Path) -> Vec<std::path::PathBuf> {
    if !dir.is_dir() {
        return Vec::new();
    }
    WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| {
            e.path()
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("xml"))
        })
        .map(|e| e.into_path())
        .collect()
}

fn extract_file_refs(xml_path: &Path) -> HashSet<String> {
    let mut refs = HashSet::new();
    let Ok(contents) = std::fs::read(xml_path) else {
        return refs;
    };
    let mut reader = Reader::from_reader(contents.as_slice());
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e) | Event::Empty(e)) => {
                for attr_name in FILE_ATTRS {
                    if let Some(val) = get_attr(&e, attr_name) {
                        let trimmed = val.trim().to_string();
                        if !trimmed.is_empty() {
                            refs.insert(trimmed);
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    refs
}

fn extract_preset_refs(xml_path: &Path) -> HashSet<String> {
    let mut names = HashSet::new();
    let Ok(contents) = std::fs::read(xml_path) else {
        return names;
    };
    let mut reader = Reader::from_reader(contents.as_slice());
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e) | Event::Empty(ref e)) => {
                if let Some(pname) = get_attr(e, b"presetName") {
                    let trimmed = pname.trim().to_string();
                    if !trimmed.is_empty() {
                        names.insert(trimmed);
                    }
                }
                if let Some(pslot) = get_attr(e, b"presetSlot") {
                    let tag = e.name();
                    let tag_bytes = tag.as_ref();
                    if tag_bytes == b"kit" || tag_bytes == b"sound" {
                        let sub = get_attr(e, b"presetSubSlot").unwrap_or_default();
                        let folder = if tag_bytes == b"kit" { "KITS" } else { "SYNTHS" };
                        names.insert(format!("{folder}/{pslot}/{sub}"));
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    names
}

fn get_attr(e: &quick_xml::events::BytesStart, name: &[u8]) -> Option<String> {
    for attr in e.attributes().flatten() {
        if attr.key.as_ref() == name {
            return String::from_utf8(attr.value.to_vec()).ok();
        }
    }
    None
}

pub fn scan_xml_references(card_root: &Path) -> HashMap<String, Vec<String>> {
    let mut refs: HashMap<String, Vec<String>> = HashMap::new();
    for dirname in XML_DIRS {
        let dir = card_root.join(dirname);
        for xml_path in walk_xml_files(&dir) {
            let source = xml_path
                .strip_prefix(card_root)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| xml_path.to_string_lossy().to_string());
            for r in extract_file_refs(&xml_path) {
                refs.entry(r).or_default().push(source.clone());
            }
        }
    }
    refs
}

pub fn find_all_samples(card_root: &Path) -> HashMap<String, u64> {
    let samples_dir = card_root.join("SAMPLES");
    if !samples_dir.is_dir() {
        return HashMap::new();
    }
    let mut result = HashMap::new();
    for entry in WalkDir::new(&samples_dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| e.path().extension().is_some_and(|ext| is_audio_ext(ext)))
    {
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if let Ok(rel) = entry.path().strip_prefix(card_root) {
            let rel_str = rel.to_string_lossy().to_string();
            result.insert(rel_str, size);
        }
    }
    result
}

pub fn scan_card(
    card_root: &Path,
    on_progress: Option<&dyn Fn(&str)>,
) -> Result<CardReport, String> {
    let samples_dir = card_root.join("SAMPLES");
    if !samples_dir.is_dir() {
        return Err(format!(
            "Not a Deluge SD card: missing SAMPLES directory in {}",
            card_root.display()
        ));
    }

    let progress = |msg: &str| {
        if let Some(cb) = on_progress {
            cb(msg);
        }
    };

    progress("Scanning samples...");
    let all_samples = find_all_samples(card_root);

    progress("Scanning XML references...");
    let all_refs = scan_xml_references(card_root);
    let sample_refs: HashMap<String, Vec<String>> = all_refs
        .into_iter()
        .filter(|(r, _)| r.starts_with("SAMPLES/"))
        .collect();

    let sample_keys: HashSet<&String> = all_samples.keys().collect();
    let unused: HashSet<String> = sample_keys
        .iter()
        .filter(|k| !sample_refs.contains_key(**k))
        .map(|k| (*k).clone())
        .collect();
    let mut missing: Vec<MissingRef> = sample_refs
        .iter()
        .filter(|(r, _)| !sample_keys.contains(r))
        .map(|(r, sources)| {
            let mut sorted_sources = sources.clone();
            sorted_sources.sort();
            sorted_sources.dedup();
            MissingRef {
                sample: r.clone(),
                referenced_by: sorted_sources,
            }
        })
        .collect();
    missing.sort_by(|a, b| a.sample.cmp(&b.sample));

    let total_bytes: u64 = all_samples.values().sum();
    let reclaimable: u64 = unused.iter().filter_map(|r| all_samples.get(r)).sum();

    progress("Checking presets...");
    let mut preset_names: HashSet<String> = HashSet::new();
    let songs_dir = card_root.join("SONGS");
    if songs_dir.is_dir() {
        for xml_path in walk_xml_files(&songs_dir) {
            preset_names.extend(extract_preset_refs(&xml_path));
        }
    }

    let mut unused_presets: Vec<String> = Vec::new();
    for dirname in &["KITS", "SYNTHS"] {
        let dir = card_root.join(dirname);
        for xml_path in walk_xml_files(&dir) {
            if let Ok(rel) = xml_path.strip_prefix(card_root) {
                let stem = xml_path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy();
                let is_used = preset_names.iter().any(|n| n == stem.as_ref() || n.contains(stem.as_ref()));
                if !is_used {
                    unused_presets.push(rel.to_string_lossy().to_string());
                }
            }
        }
    }

    let mut unused_sorted: Vec<String> = unused.into_iter().collect();
    unused_sorted.sort();
    unused_presets.sort();

    Ok(CardReport {
        total_samples: all_samples.len(),
        total_samples_bytes: total_bytes,
        total_references: sample_refs.len(),
        unused_samples: unused_sorted,
        missing_references: missing,
        unused_presets,
        reclaimable_bytes: reclaimable,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn make_card(tmp: &TempDir) -> std::path::PathBuf {
        let root = tmp.path().to_path_buf();
        fs::create_dir_all(root.join("SONGS")).unwrap();
        fs::create_dir_all(root.join("KITS")).unwrap();
        fs::create_dir_all(root.join("SYNTHS")).unwrap();
        fs::create_dir_all(root.join("SAMPLES/RECORD")).unwrap();
        fs::create_dir_all(root.join("SAMPLES/Kicks")).unwrap();
        root
    }

    fn write_xml(path: &Path, content: &str) {
        fs::write(path, content.trim()).unwrap();
    }

    mod scan_xml_refs {
        use super::*;

        #[test]
        fn finds_filename_attributes() {
            let tmp = TempDir::new().unwrap();
            let root = make_card(&tmp);
            write_xml(
                &root.join("SONGS/SONG001.XML"),
                r#"<song firmwareVersion="4.1.4">
                  <sound>
                    <osc1 fileName="SAMPLES/RECORD/REC00001.WAV" />
                    <osc2 fileName="SAMPLES/Kicks/kick.wav" />
                  </sound>
                </song>"#,
            );
            let refs = scan_xml_references(&root);
            assert!(refs.contains_key("SAMPLES/RECORD/REC00001.WAV"));
            assert!(refs.contains_key("SAMPLES/Kicks/kick.wav"));
        }

        #[test]
        fn finds_filepath_attributes() {
            let tmp = TempDir::new().unwrap();
            let root = make_card(&tmp);
            write_xml(
                &root.join("KITS/KIT001.XML"),
                r#"<kit>
                  <soundSources>
                    <sound>
                      <osc1 filePath="SAMPLES/RECORD/REC00002.WAV" />
                    </sound>
                  </soundSources>
                </kit>"#,
            );
            let refs = scan_xml_references(&root);
            assert!(refs.contains_key("SAMPLES/RECORD/REC00002.WAV"));
        }

        #[test]
        fn scans_all_three_folders() {
            let tmp = TempDir::new().unwrap();
            let root = make_card(&tmp);
            write_xml(
                &root.join("SONGS/S.XML"),
                r#"<song><osc fileName="SAMPLES/a.wav" /></song>"#,
            );
            write_xml(
                &root.join("KITS/K.XML"),
                r#"<kit><osc fileName="SAMPLES/b.wav" /></kit>"#,
            );
            write_xml(
                &root.join("SYNTHS/Y.XML"),
                r#"<synth><osc fileName="SAMPLES/c.wav" /></synth>"#,
            );
            let refs = scan_xml_references(&root);
            let keys: HashSet<String> = refs.keys().cloned().collect();
            let expected: HashSet<String> = ["SAMPLES/a.wav", "SAMPLES/b.wav", "SAMPLES/c.wav"]
                .iter()
                .map(|s| s.to_string())
                .collect();
            assert_eq!(keys, expected);
        }

        #[test]
        fn skips_malformed_xml() {
            let tmp = TempDir::new().unwrap();
            let root = make_card(&tmp);
            fs::write(root.join("SONGS/BAD.XML"), "not xml at all <<<").unwrap();
            let refs = scan_xml_references(&root);
            assert!(refs.is_empty());
        }

        #[test]
        fn handles_empty_folders() {
            let tmp = TempDir::new().unwrap();
            let root = make_card(&tmp);
            let refs = scan_xml_references(&root);
            assert!(refs.is_empty());
        }

        #[test]
        fn deduplicates() {
            let tmp = TempDir::new().unwrap();
            let root = make_card(&tmp);
            write_xml(
                &root.join("SONGS/S1.XML"),
                r#"<song><osc fileName="SAMPLES/x.wav" /></song>"#,
            );
            write_xml(
                &root.join("SONGS/S2.XML"),
                r#"<song><osc fileName="SAMPLES/x.wav" /></song>"#,
            );
            let refs = scan_xml_references(&root);
            assert_eq!(refs.len(), 1);
            assert!(refs.contains_key("SAMPLES/x.wav"));
        }

        #[test]
        fn case_insensitive_xml_extension() {
            let tmp = TempDir::new().unwrap();
            let root = make_card(&tmp);
            write_xml(
                &root.join("SONGS/song.xml"),
                r#"<song><osc fileName="SAMPLES/low.wav" /></song>"#,
            );
            let refs = scan_xml_references(&root);
            assert!(refs.contains_key("SAMPLES/low.wav"));
        }
    }

    mod find_samples {
        use super::*;

        #[test]
        fn finds_files_recursively() {
            let tmp = TempDir::new().unwrap();
            let root = make_card(&tmp);
            fs::write(root.join("SAMPLES/RECORD/REC001.WAV"), b"").unwrap();
            fs::write(root.join("SAMPLES/Kicks/kick.wav"), b"").unwrap();
            let samples = find_all_samples(&root);
            assert!(samples.contains_key("SAMPLES/RECORD/REC001.WAV"));
            assert!(samples.contains_key("SAMPLES/Kicks/kick.wav"));
        }

        #[test]
        fn ignores_non_audio_files() {
            let tmp = TempDir::new().unwrap();
            let root = make_card(&tmp);
            fs::write(root.join("SAMPLES/readme.txt"), b"").unwrap();
            fs::write(root.join("SAMPLES/RECORD/REC001.WAV"), b"").unwrap();
            let samples = find_all_samples(&root);
            assert!(samples.contains_key("SAMPLES/RECORD/REC001.WAV"));
            assert!(!samples.keys().any(|k| k.contains("readme")));
        }

        #[test]
        fn empty_samples_dir() {
            let tmp = TempDir::new().unwrap();
            let root = make_card(&tmp);
            let samples = find_all_samples(&root);
            assert!(samples.is_empty());
        }
    }

    mod scan_card_tests {
        use super::*;

        #[test]
        fn identifies_unused_samples() {
            let tmp = TempDir::new().unwrap();
            let root = make_card(&tmp);
            fs::write(root.join("SAMPLES/RECORD/USED.WAV"), b"").unwrap();
            fs::write(root.join("SAMPLES/RECORD/UNUSED.WAV"), b"").unwrap();
            write_xml(
                &root.join("SONGS/S.XML"),
                r#"<song><osc fileName="SAMPLES/RECORD/USED.WAV" /></song>"#,
            );
            let report = scan_card(&root, None).unwrap();
            assert!(report.unused_samples.contains(&"SAMPLES/RECORD/UNUSED.WAV".to_string()));
            assert!(!report.unused_samples.contains(&"SAMPLES/RECORD/USED.WAV".to_string()));
        }

        #[test]
        fn identifies_missing_references() {
            let tmp = TempDir::new().unwrap();
            let root = make_card(&tmp);
            write_xml(
                &root.join("SONGS/S.XML"),
                r#"<song><osc fileName="SAMPLES/RECORD/GONE.WAV" /></song>"#,
            );
            let report = scan_card(&root, None).unwrap();
            assert!(report.missing_references.iter().any(|m| m.sample == "SAMPLES/RECORD/GONE.WAV"));
            let gone = report.missing_references.iter().find(|m| m.sample == "SAMPLES/RECORD/GONE.WAV").unwrap();
            assert!(gone.referenced_by.contains(&"SONGS/S.XML".to_string()));
        }

        #[test]
        fn identifies_unused_presets() {
            let tmp = TempDir::new().unwrap();
            let root = make_card(&tmp);
            write_xml(
                &root.join("KITS/USED.XML"),
                r#"<kit><osc fileName="SAMPLES/x.wav" /></kit>"#,
            );
            write_xml(
                &root.join("KITS/ORPHAN.XML"),
                r#"<kit><osc fileName="SAMPLES/y.wav" /></kit>"#,
            );
            write_xml(
                &root.join("SYNTHS/LONELY.XML"),
                r#"<synth><osc fileName="SAMPLES/z.wav" /></synth>"#,
            );
            write_xml(
                &root.join("SONGS/S.XML"),
                r#"<song>
                  <instruments>
                    <kit presetSlot="0" presetName="USED" />
                  </instruments>
                </song>"#,
            );
            let report = scan_card(&root, None).unwrap();
            assert!(report.unused_presets.contains(&"KITS/ORPHAN.XML".to_string()));
            assert!(report.unused_presets.contains(&"SYNTHS/LONELY.XML".to_string()));
            assert!(!report.unused_presets.contains(&"KITS/USED.XML".to_string()));
        }

        #[test]
        fn report_reclaimable_bytes() {
            let tmp = TempDir::new().unwrap();
            let root = make_card(&tmp);
            fs::write(root.join("SAMPLES/RECORD/BIG.WAV"), vec![0u8; 1024]).unwrap();
            let report = scan_card(&root, None).unwrap();
            assert!(report.reclaimable_bytes >= 1024);
        }

        #[test]
        fn all_used_report() {
            let tmp = TempDir::new().unwrap();
            let root = make_card(&tmp);
            fs::write(root.join("SAMPLES/RECORD/A.WAV"), b"").unwrap();
            write_xml(
                &root.join("SONGS/S.XML"),
                r#"<song><osc fileName="SAMPLES/RECORD/A.WAV" /></song>"#,
            );
            let report = scan_card(&root, None).unwrap();
            assert!(report.unused_samples.is_empty());
            assert!(report.missing_references.is_empty());
        }

        #[test]
        fn validates_card_structure() {
            let tmp = TempDir::new().unwrap();
            let result = scan_card(tmp.path(), None);
            assert!(result.is_err());
            assert!(result.unwrap_err().contains("SAMPLES"));
        }
    }
}
