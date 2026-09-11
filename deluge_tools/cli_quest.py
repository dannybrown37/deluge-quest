"""deluge-quest — discovery entrypoint for the deluge-quest CLI suite."""

from __future__ import annotations

import sys

VERSION = "0.1.0"

TOOLS = [
    ("deluge-backup", "Git-based SD card backup and sync"),
    ("deluge-clean", "SD card scan, cleanup, and repair"),
    ("deluge-stats", "Batch song statistics and analysis"),
    ("deluge-score", "Song XML → MusicXML sheet music"),
    ("deluge-import", "MIDI → Deluge song XML"),
]


def main(argv: list[str] | None = None) -> None:
    argv = argv if argv is not None else sys.argv[1:]

    if "--version" in argv or "-V" in argv:
        print(f"deluge-quest {VERSION}")
        sys.exit(0)

    max_name = max(len(name) for name, _ in TOOLS)
    tool_lines = "\n".join(f"  {name:<{max_name}}  {desc}" for name, desc in TOOLS)

    print(f"""\
deluge-quest {VERSION} — CLI tools for the Synthstrom Deluge

Tools:
{tool_lines}

Install:
  pip install deluge-quest

Each tool has its own --help. For example:
  deluge-backup --help
  deluge-stats --help

Website: https://deluge.quest""")


if __name__ == "__main__":
    main()
