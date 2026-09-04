from __future__ import annotations

import os
import xml.etree.ElementTree as ET
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

AUDIO_EXTENSIONS = {".wav", ".aif", ".aiff"}
XML_DIRS = ("SONGS", "KITS", "SYNTHS")
FILE_ATTRS = ("fileName", "filePath")


@dataclass
class CardReport:
    total_samples: int = 0
    total_samples_bytes: int = 0
    total_references: int = 0
    unused_samples: set[str] = field(default_factory=set)
    missing_references: set[str] = field(default_factory=set)
    unused_presets: set[str] = field(default_factory=set)
    reclaimable_bytes: int = 0


def _walk_files(root_dir: str, ext_filter: set[str] | None = None) -> list[tuple[str, int]]:
    results: list[tuple[str, int]] = []
    for dirpath, _, filenames in os.walk(root_dir):
        for fname in filenames:
            if ext_filter and os.path.splitext(fname)[1].lower() not in ext_filter:
                continue
            full = os.path.join(dirpath, fname)
            try:
                size = os.path.getsize(full)
            except OSError:
                size = 0
            results.append((full, size))
    return results


def _extract_file_refs_streaming(xml_path: str) -> set[str]:
    refs: set[str] = set()
    try:
        for _event, elem in ET.iterparse(xml_path, events=("start",)):
            for attr in FILE_ATTRS:
                val = elem.get(attr)
                if val:
                    refs.add(val.strip())
            elem.clear()
    except ET.ParseError:
        pass
    return refs


def _extract_preset_refs_streaming(xml_path: str) -> set[str]:
    names: set[str] = set()
    try:
        for _event, elem in ET.iterparse(xml_path, events=("start",)):
            pname = elem.get("presetName")
            if pname:
                names.add(pname.strip())
            pslot = elem.get("presetSlot")
            if pslot is not None:
                tag = elem.tag
                if tag in ("kit", "sound"):
                    sub = elem.get("presetSubSlot", "")
                    folder = "KITS" if tag == "kit" else "SYNTHS"
                    names.add(f"{folder}/{pslot}/{sub}")
            elem.clear()
    except ET.ParseError:
        pass
    return names


def scan_xml_references(card_root: Path) -> set[str]:
    refs: set[str] = set()
    root_str = str(card_root)
    for dirname in XML_DIRS:
        dirpath = os.path.join(root_str, dirname)
        if not os.path.isdir(dirpath):
            continue
        for fpath, _ in _walk_files(dirpath, {".xml"}):
            refs |= _extract_file_refs_streaming(fpath)
    return refs


def find_all_samples(card_root: Path) -> dict[str, int]:
    samples_dir = os.path.join(str(card_root), "SAMPLES")
    if not os.path.isdir(samples_dir):
        return {}
    result: dict[str, int] = {}
    card_str = str(card_root)
    for fpath, size in _walk_files(samples_dir, AUDIO_EXTENSIONS):
        rel = os.path.relpath(fpath, card_str)
        result[rel] = size
    return result


def scan_card(
    card_root: Path,
    on_progress: Callable[[str], None] | None = None,
) -> CardReport:
    samples_dir = os.path.join(str(card_root), "SAMPLES")
    if not os.path.isdir(samples_dir):
        raise ValueError(f"Not a Deluge SD card: missing SAMPLES directory in {card_root}")

    def progress(msg: str) -> None:
        if on_progress:
            on_progress(msg)

    progress("Scanning samples...")
    all_samples = find_all_samples(card_root)

    progress("Scanning XML references...")
    all_refs = scan_xml_references(card_root)
    sample_refs = {r for r in all_refs if r.startswith("SAMPLES/")}

    sample_keys = set(all_samples.keys())
    unused = sample_keys - sample_refs
    missing = sample_refs - sample_keys

    total_bytes = sum(all_samples.values())
    reclaimable = sum(all_samples[r] for r in unused)

    progress("Checking presets...")
    preset_names: set[str] = set()
    songs_dir = os.path.join(str(card_root), "SONGS")
    if os.path.isdir(songs_dir):
        for fpath, _ in _walk_files(songs_dir, {".xml"}):
            preset_names |= _extract_preset_refs_streaming(fpath)

    unused_presets: set[str] = set()
    card_str = str(card_root)
    for dirname in ("KITS", "SYNTHS"):
        dirpath = os.path.join(card_str, dirname)
        if not os.path.isdir(dirpath):
            continue
        for fpath, _ in _walk_files(dirpath, {".xml"}):
            rel = os.path.relpath(fpath, card_str)
            stem = os.path.splitext(os.path.basename(fpath))[0]
            if stem not in preset_names and not any(stem in n for n in preset_names):
                unused_presets.add(rel)

    return CardReport(
        total_samples=len(all_samples),
        total_samples_bytes=total_bytes,
        total_references=len(sample_refs),
        unused_samples=unused,
        missing_references=missing,
        unused_presets=unused_presets,
        reclaimable_bytes=reclaimable,
    )
