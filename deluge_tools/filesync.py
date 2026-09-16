from __future__ import annotations

import fnmatch
import os
import shutil
from pathlib import Path


def sync_tree(
    src: Path,
    dst: Path,
    *,
    delete: bool = False,
    excludes: list[str] | None = None,
    includes: list[str] | None = None,
    dry_run: bool = False,
    verbose: bool = False,
) -> list[str]:
    """Pure-Python directory sync (rsync equivalent). Returns list of change descriptions."""
    excludes = excludes or []
    dst.mkdir(parents=True, exist_ok=True)
    changes: list[str] = []

    def is_excluded(name: str) -> bool:
        return any(fnmatch.fnmatch(name, pat) for pat in excludes)

    def is_included(name: str) -> bool:
        if not includes:
            return True
        return any(fnmatch.fnmatch(name, pat) for pat in includes)

    for dirpath, dirnames, filenames in os.walk(src):
        dirnames[:] = [d for d in dirnames if not is_excluded(d)]

        rel = Path(dirpath).relative_to(src)
        dst_dir = dst / rel

        for fname in filenames:
            if is_excluded(fname) or not is_included(fname):
                continue

            src_file = Path(dirpath) / fname
            dst_file = dst_dir / fname
            rel_file = rel / fname

            if dst_file.exists():
                src_stat = src_file.stat()
                dst_stat = dst_file.stat()
                if (
                    abs(src_stat.st_mtime - dst_stat.st_mtime) < 1
                    and src_stat.st_size == dst_stat.st_size
                ):
                    continue

            desc = f"copy {rel_file}"
            changes.append(desc)
            if not dry_run:
                dst_dir.mkdir(parents=True, exist_ok=True)
                shutil.copy2(str(src_file), str(dst_file))

    if delete:
        for dirpath, dirnames, filenames in os.walk(dst):
            rel = Path(dirpath).relative_to(dst)
            if rel != Path(".") and is_excluded(rel.name):
                dirnames.clear()
                continue
            dirnames[:] = [d for d in dirnames if not is_excluded(d)]

            for fname in filenames:
                if is_excluded(fname):
                    continue
                src_file = src / rel / fname
                if not src_file.exists():
                    desc = f"delete {rel / fname}"
                    changes.append(desc)
                    if not dry_run:
                        (Path(dirpath) / fname).unlink()

        for dirpath, _, _ in os.walk(dst, topdown=False):
            rel = Path(dirpath).relative_to(dst)
            if rel == Path(".") or any(is_excluded(p) for p in rel.parts):
                continue
            if not (src / rel).exists():
                if not dry_run:
                    try:
                        Path(dirpath).rmdir()
                    except OSError:
                        pass

    return changes


def dir_size(path: Path, *, excludes: list[str] | None = None) -> int:
    """Total file size in bytes under path, excluding named directories."""
    excludes = excludes or []
    total = 0
    for dirpath, dirnames, filenames in os.walk(path):
        dirnames[:] = [d for d in dirnames if d not in excludes]
        for fname in filenames:
            try:
                total += (Path(dirpath) / fname).stat().st_size
            except OSError:
                pass
    return total


def format_size(size_bytes: int) -> str:
    """Human-readable size string (matches du -sh style)."""
    if size_bytes < 1024:
        return f"{size_bytes}B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.0f}K"
    elif size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.1f}M"
    else:
        return f"{size_bytes / (1024 * 1024 * 1024):.1f}G"
