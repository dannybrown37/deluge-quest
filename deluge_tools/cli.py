from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

from deluge_tools.converter import NoArrangementError, song_to_score
from deluge_tools.parser import parse_song

MUSESCORE_PATHS = [
    "/mnt/c/Program Files/MuseScore 4/bin/MuseScore4.exe",
    "/mnt/c/Program Files/MuseScore 3/bin/MuseScore3.exe",
]


def _find_musescore() -> str | None:
    for name in ("mscore", "musescore", "MuseScore4"):
        if shutil.which(name):
            return name
    for path in MUSESCORE_PATHS:
        if Path(path).exists():
            return path
    return None


def _open_in_musescore(file_path: Path) -> bool:
    ms = _find_musescore()
    if ms is None:
        return False

    abs_path = file_path.resolve()

    if ms.startswith("/mnt/c/"):
        win_temp = Path("/mnt/c/Users") / "danny" / "AppData" / "Local" / "Temp"
        if not win_temp.exists():
            win_temp = Path("/mnt/c/Temp")
        win_copy = win_temp / abs_path.name
        shutil.copy2(abs_path, win_copy)
        win_path = subprocess.run(
            ["wslpath", "-w", str(win_copy)],
            capture_output=True, text=True,
        ).stdout.strip()
        subprocess.Popen(
            ["powershell.exe", "-NoProfile", "-Command", f'Start-Process "{win_path}"'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    else:
        subprocess.Popen(
            [ms, str(abs_path)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )

    return True


def _fix_musicxml_voices(path: Path) -> None:
    """music21 writes 0-indexed voices; MusicXML spec requires 1-indexed."""
    xml = path.read_text()
    xml = re.sub(
        r"<voice>(\d+)</voice>",
        lambda m: f"<voice>{int(m.group(1)) + 1}</voice>",
        xml,
    )
    path.write_text(xml)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Convert Deluge XML songs to sheet music",
    )
    parser.add_argument("input", nargs="?", type=Path, help="Deluge .XML song file")
    parser.add_argument(
        "-o", "--output", type=Path, default=None,
        help="Output file path (.musicxml, .xml, .mid, .ly)",
    )
    parser.add_argument(
        "-f", "--format", default=None,
        choices=["musicxml", "midi", "lilypond", "text"],
        help="Output format (default: inferred from --output, or musicxml)",
    )
    parser.add_argument(
        "--no-open", action="store_true",
        help="Don't open the output in MuseScore",
    )

    args = parser.parse_args(argv)

    if args.input is None:
        parser.print_help()
        sys.exit(1)

    if not args.input.exists():
        print(f"Error: {args.input} not found", file=sys.stderr)
        sys.exit(1)

    song = parse_song(args.input)
    view = "arrangement" if song.in_arrangement_view else "session"
    print(f"Parsed: {song.bpm:.0f} BPM, {len(song.instruments)} instruments, "
          f"{len(song.clips)} clips, view={view}, "
          f"root={song.root_note}, mode={song.mode_notes}")

    try:
        score = song_to_score(song)
    except NoArrangementError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    for part in score.parts:
        note_count = len(part.flatten().notes)
        print(f"  Part: {part.partName} — {note_count} notes")

    fmt = args.format
    if fmt is None and args.output:
        suffix = args.output.suffix.lower()
        fmt_map = {
            ".musicxml": "musicxml",
            ".xml": "musicxml",
            ".mid": "midi",
            ".midi": "midi",
            ".ly": "lilypond",
            ".txt": "text",
        }
        fmt = fmt_map.get(suffix, "musicxml")
    elif fmt is None:
        fmt = "musicxml"

    output_path = args.output
    if output_path is None:
        output_path = args.input.with_suffix(".musicxml")

    if fmt == "text":
        output_path.write_text(score.show("text", returnRecordingFilePath=True) or "")
    else:
        score.write(fmt, fp=str(output_path))

    if fmt == "musicxml":
        _fix_musicxml_voices(output_path)

    print(f"Written: {output_path}")

    if not args.no_open and fmt in ("musicxml", "midi"):
        if _open_in_musescore(output_path):
            print(f"Opening in MuseScore...")
        else:
            print("MuseScore not found — use --no-open to suppress this message", file=sys.stderr)


if __name__ == "__main__":
    main()
