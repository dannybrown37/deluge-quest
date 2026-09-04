from __future__ import annotations

import argparse
import shutil
import sys
from importlib.metadata import version
from pathlib import Path

from deluge_tools.card_scanner import CardReport, scan_card
from deluge_tools.cli_stats import _browse_for_folder


def _format_bytes(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    if n < 1024 * 1024 * 1024:
        return f"{n / (1024 * 1024):.1f} MB"
    return f"{n / (1024 * 1024 * 1024):.2f} GB"


def _prompt_for_card() -> Path:
    if not sys.stdin.isatty():
        print(
            "error: no card path given and stdin is not a TTY\n"
            "usage: deluge-clean <path-to-sd-card>",
            file=sys.stderr,
        )
        sys.exit(1)

    print("No path given. Opening folder picker...")
    selected = _browse_for_folder()
    if selected and selected.exists():
        print(f"Selected: {selected}")
        return selected

    if selected is None:
        print("Folder picker cancelled or unavailable.")
    path_str = input("Enter path to Deluge SD card root: ").strip()
    p = Path(path_str)
    if not p.exists():
        print(f"error: {p} does not exist", file=sys.stderr)
        sys.exit(1)
    return p


def _print_summary(report: CardReport, card_root: Path) -> None:
    print(f"\nDeluge SD Card: {card_root}")
    print("─" * 44)

    total_size = _format_bytes(report.total_samples_bytes)
    print(f"  Samples       {report.total_samples:,} files   {total_size}")
    print(f"  Referenced    {report.total_references:,} files")

    if report.unused_samples:
        reclaim = _format_bytes(report.reclaimable_bytes)
        print(f"  Unused        {len(report.unused_samples):>5,} files   {reclaim} reclaimable")
    else:
        print("  Unused            0 files")

    if report.missing_references:
        print(
            f"  Broken refs   {len(report.missing_references):>5,} files   (referenced but missing)"
        )

    if report.unused_presets:
        print(f"  Orphan presets {len(report.unused_presets):>4,} files   (not used by any song)")

    if report.unused_samples:
        print("\nRun with --move to relocate unused samples to SAMPLES/_UNUSED/")
    print("Run with --list for full file listing")


def _print_list(report: CardReport, category: str | None) -> None:
    if category is None or category == "samples":
        if report.unused_samples:
            print(f"\nUnused samples ({len(report.unused_samples)}):")
            for s in sorted(report.unused_samples):
                print(f"  {s}")

    if category is None or category == "missing":
        if report.missing_references:
            print(f"\nBroken references ({len(report.missing_references)}):")
            for m in sorted(report.missing_references):
                print(f"  {m}")

    if category is None or category == "presets":
        if report.unused_presets:
            print(f"\nOrphan presets ({len(report.unused_presets)}):")
            for p in sorted(report.unused_presets):
                print(f"  {p}")

    total = len(report.unused_samples) + len(report.missing_references) + len(report.unused_presets)
    if total == 0:
        print("\nNothing to list — card is clean.")


def _move_unused(card_root: Path, report: CardReport) -> int:
    unused_dir = card_root / "SAMPLES" / "_UNUSED"
    moved = 0
    for rel in sorted(report.unused_samples):
        src = card_root / rel
        if not src.exists():
            continue
        dest_rel = rel.removeprefix("SAMPLES/")
        dest = unused_dir / dest_rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dest))
        moved += 1
    return moved


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Find unused samples and presets on a Deluge SD card",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {version('deluge-tools')}",
    )
    parser.add_argument(
        "card_root",
        nargs="?",
        type=Path,
        help="Path to Deluge SD card root directory",
    )
    parser.add_argument(
        "--move",
        action="store_true",
        help="Move unused samples to SAMPLES/_UNUSED/ (default: report only)",
    )
    parser.add_argument(
        "--list",
        nargs="?",
        const="all",
        default=None,
        choices=["all", "samples", "missing", "presets"],
        metavar="CATEGORY",
        help="List files (all, samples, missing, presets)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output as JSON",
    )

    args = parser.parse_args(argv)

    if args.card_root is None:
        args.card_root = _prompt_for_card()

    def _progress(msg: str) -> None:
        if not args.json:
            print(f"  {msg}", end="\r", file=sys.stderr, flush=True)

    try:
        report = scan_card(args.card_root, on_progress=_progress)
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)

    if args.json:
        import json

        print(
            json.dumps(
                {
                    "total_samples": report.total_samples,
                    "total_samples_bytes": report.total_samples_bytes,
                    "total_references": report.total_references,
                    "unused_samples": sorted(report.unused_samples),
                    "missing_references": sorted(report.missing_references),
                    "unused_presets": sorted(report.unused_presets),
                    "reclaimable_bytes": report.reclaimable_bytes,
                },
                indent=2,
            )
        )
    elif args.list is not None:
        category = None if args.list == "all" else args.list
        _print_list(report, category)
    else:
        _print_summary(report, args.card_root)

    if args.move and report.unused_samples:
        if sys.stdin.isatty() and not args.json:
            confirm = input(
                f"\nMove {len(report.unused_samples)} unused samples to SAMPLES/_UNUSED/? [y/N] "
            )
            if confirm.lower() != "y":
                print("Aborted.")
                return
        moved = _move_unused(args.card_root, report)
        reclaimed = _format_bytes(report.reclaimable_bytes)
        print(f"\nMoved {moved} files to SAMPLES/_UNUSED/ ({reclaimed} reclaimed)")


if __name__ == "__main__":
    main()
