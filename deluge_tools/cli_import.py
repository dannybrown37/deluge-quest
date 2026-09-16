from __future__ import annotations

import argparse
import sys
from importlib.metadata import version
from pathlib import Path

from deluge_tools.midi_to_deluge import midi_to_deluge_xml


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Convert a MIDI file to Deluge XML song format",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {version('deluge-quest')}",
    )
    parser.add_argument("input", nargs="?", type=Path, help="MIDI file (.mid)")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=None,
        help="Output Deluge XML path (default: <input>.XML)",
    )
    parser.add_argument(
        "--root-note", type=int, default=0, help="Root note offset (default: 0 = C)"
    )
    parser.add_argument(
        "--scale",
        default="major",
        choices=["major", "minor"],
        help="Scale mode (default: major)",
    )

    args = parser.parse_args(argv)

    if args.input is None:
        parser.print_help()
        sys.exit(1)

    if not args.input.exists():
        print(f"Error: {args.input} not found", file=sys.stderr)
        sys.exit(1)

    output = args.output or args.input.with_suffix(".XML")

    scale_map = {
        "major": [0, 2, 4, 5, 7, 9, 11],
        "minor": [0, 2, 3, 5, 7, 8, 10],
    }

    midi_to_deluge_xml(
        args.input,
        output,
        root_note=args.root_note,
        mode_notes=scale_map[args.scale],
    )

    print(f"Written: {output}")


if __name__ == "__main__":
    main()
