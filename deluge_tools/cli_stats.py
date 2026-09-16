from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from collections.abc import Callable
from importlib.metadata import version
from pathlib import Path
from typing import Any

from deluge_tools.analyzer import SongStats, analyze_song
from deluge_tools.parser import parse_song


def _browse_for_folder() -> Path | None:
    if shutil.which("powershell.exe"):
        ps_cmd = (
            "Add-Type -AssemblyName System.Windows.Forms; "
            "$d = New-Object System.Windows.Forms.FolderBrowserDialog; "
            "$d.Description = 'Select folder containing Deluge .XML songs'; "
            "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { exit 1 }"
        )
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-Command", ps_cmd],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            return None
        win_path = result.stdout.strip()
        if not win_path:
            return None
        wsl_result = subprocess.run(
            ["wslpath", "-u", win_path],
            capture_output=True,
            text=True,
        )
        if wsl_result.returncode != 0:
            return None
        return Path(wsl_result.stdout.strip())
    return None


def _prompt_for_path() -> Path:
    if not sys.stdin.isatty():
        print(
            "error: no paths given and stdin is not a TTY\nusage: deluge-stats <path> [<path> ...]",
            file=sys.stderr,
        )
        sys.exit(1)

    print("No paths given. Opening folder picker...")
    selected = _browse_for_folder()
    if selected and selected.exists():
        print(f"Selected: {selected}")
        return selected

    if selected is None:
        print("Folder picker cancelled or unavailable.")
    path_str = input("Enter path to Deluge songs directory: ").strip()
    p = Path(path_str)
    if not p.exists():
        print(f"error: {p} does not exist", file=sys.stderr)
        sys.exit(1)
    return p


_APP_MANAGED_DIRS = {"SOFT_DELETE", "REPAIR_BACKUP"}


def _is_app_managed(path: Path) -> bool:
    """SOFT_DELETE/ and REPAIR_BACKUP/ are app-managed, not card content — never scan them."""
    return bool(_APP_MANAGED_DIRS & {part.upper() for part in path.parts})


def _collect_songs(paths: list[Path]) -> list[Path]:
    songs: list[Path] = []
    for p in paths:
        if p.is_dir():
            songs.extend(sorted(p.rglob("*.XML")))
            songs.extend(sorted(p.rglob("*.xml")))
        elif p.is_file():
            songs.append(p)
    return [s for s in songs if not _is_app_managed(s)]


def _is_deluge_xml(path: Path) -> bool:
    try:
        for _, elem in ET.iterparse(path, events=["start"]):
            return elem.tag == "song"
    except ET.ParseError:
        return False
    return False


def _analyze_file(path: Path) -> SongStats | None:
    if not _is_deluge_xml(path):
        return None
    try:
        song = parse_song(path)
    except Exception as e:
        print(f"  SKIP {path.name}: {e}", file=sys.stderr)
        return None
    stats = analyze_song(song)
    stats.filename = path.name
    return stats


def _print_table(all_stats: list[SongStats], sort_by: str) -> None:
    sort_keys: dict[str, Callable[[SongStats], Any]] = {
        "name": lambda s: s.filename.lower(),
        "bpm": lambda s: s.bpm,
        "key": lambda s: s.key,
        "duration": lambda s: s.arrangement_length_ticks,
        "notes": lambda s: s.total_notes,
        "instruments": lambda s: s.instrument_count,
    }
    key_fn = sort_keys.get(sort_by, sort_keys["name"])
    all_stats.sort(key=key_fn)

    headers = ["Song", "BPM", "Key", "Arr?", "Duration", "Inst", "Clips", "Notes"]
    rows: list[list[str]] = []
    for s in all_stats:
        name = s.filename.removesuffix(".XML").removesuffix(".xml")
        rows.append(
            [
                name,
                f"{s.bpm:.0f}",
                s.key,
                "Y" if s.has_arrangement else "",
                s.duration_str if s.has_arrangement else "-",
                str(s.instrument_count),
                str(s.clip_count),
                str(s.total_notes),
            ]
        )

    widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(cell))

    header_line = "  ".join(h.ljust(widths[i]) for i, h in enumerate(headers))
    sep_line = "  ".join("-" * widths[i] for i in range(len(headers)))
    print(header_line)
    print(sep_line)
    for row in rows:
        print("  ".join(cell.ljust(widths[i]) for i, cell in enumerate(row)))


def _print_summary(all_stats: list[SongStats]) -> None:
    total = len(all_stats)
    arr_count = sum(1 for s in all_stats if s.has_arrangement)
    bpms = [s.bpm for s in all_stats]
    total_notes = sum(s.total_notes for s in all_stats)

    key_counts = Counter(s.key for s in all_stats)
    top_keys = key_counts.most_common(5)

    print(f"\n--- Summary ({total} songs) ---")
    print(f"With arrangement: {arr_count}/{total}")
    if bpms:
        print(f"BPM range: {min(bpms):.0f}–{max(bpms):.0f} (avg {sum(bpms) / len(bpms):.0f})")
    print(f"Total notes: {total_notes:,}")
    if top_keys:
        keys_str = ", ".join(f"{k} ({n})" for k, n in top_keys)
        print(f"Top keys: {keys_str}")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Analyze Deluge song files — tempo, key, duration, and more",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {version('deluge-quest')}",
    )
    parser.add_argument(
        "paths",
        nargs="*",
        type=Path,
        help="Deluge .XML files or directories to scan",
    )
    parser.add_argument(
        "--sort",
        default="name",
        choices=["name", "bpm", "key", "duration", "notes", "instruments"],
        help="Sort by field (default: name)",
    )
    parser.add_argument(
        "--no-summary",
        action="store_true",
        help="Skip the summary section",
    )

    args = parser.parse_args(argv)

    if not args.paths:
        if not sys.stdin.isatty():
            parser.print_help()
            sys.exit(1)
        selected = _prompt_for_path()
        args.paths = [selected]

    song_files = _collect_songs(args.paths)
    if not song_files:
        print("No .XML files found.", file=sys.stderr)
        sys.exit(1)

    all_stats: list[SongStats] = []
    for path in song_files:
        stats = _analyze_file(path)
        if stats:
            all_stats.append(stats)

    if not all_stats:
        print("No valid songs found.", file=sys.stderr)
        sys.exit(1)

    _print_table(all_stats, args.sort)

    if not args.no_summary:
        _print_summary(all_stats)


if __name__ == "__main__":
    main()
