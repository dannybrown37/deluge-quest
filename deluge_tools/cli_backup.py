from __future__ import annotations

import os
import subprocess
import sys
from datetime import datetime
from importlib.metadata import version
from pathlib import Path

CARD_ONLY_EXCLUDES = [".git", ".xml-remote", ".gitignore", "README.md"]

XML_INCLUDE_PATTERNS = [
    "--include=*/",
    "--include=*.XML",
    "--include=*.xml",
    "--include=*.JSON",
    "--include=*.json",
    "--include=README.md",
    "--exclude=*",
]


def _card_dir() -> Path:
    return Path(os.environ.get("DELUGE_CARD_DIR", Path.home() / "deluge-card"))


def _card_mount() -> Path:
    return Path(os.environ.get("DELUGE_CARD_MOUNT", "/mnt/d"))


def _card_drive() -> str:
    return os.environ.get("DELUGE_CARD_DRIVE", "D:")


def _require_repo(card_dir: Path) -> None:
    if not (card_dir / ".git").is_dir():
        print(
            f"error: no card repo at {card_dir} — run 'deluge-backup init' first",
            file=sys.stderr,
        )
        sys.exit(1)


def _is_wsl() -> bool:
    try:
        return "microsoft" in Path("/proc/version").read_text().lower()
    except OSError:
        return False


def _mount_needs_help(mount: Path) -> bool:
    """True if mount point exists as a name but is inaccessible or empty."""
    try:
        if mount.is_dir() and any(mount.iterdir()):
            return False  # mounted and has content
    except OSError:
        pass
    # Check if the name exists in the parent (WSL creates /mnt/d even when unmounted)
    try:
        return mount.parent.is_dir() and mount.name in {p.name for p in mount.parent.iterdir()}
    except OSError:
        return False


def _ensure_mount(mount: Path, drive: str) -> None:
    """On WSL, try to mount the Windows drive if the mount point is empty."""
    if not _is_wsl():
        return
    if not _mount_needs_help(mount):
        return
    print(f"WSL detected — mounting {drive} to {mount} (may need your password)...")
    result = subprocess.run(["sudo", "mount", "-t", "drvfs", drive, str(mount)])
    if result.returncode != 0:
        print(
            f"warning: mount failed — try running: sudo mount -t drvfs {drive} {mount}",
            file=sys.stderr,
        )


def _run(cmd: list[str], *, cwd: Path | None = None, **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, **kwargs)


def cmd_status(args) -> None:
    card_dir = _card_dir()
    _require_repo(card_dir)
    _run(["git", "status"], cwd=card_dir, check=False)


def cmd_diff(args) -> None:
    card_dir = _card_dir()
    _require_repo(card_dir)
    _run(["git", "diff"], cwd=card_dir, check=False)


def cmd_log(args) -> None:
    card_dir = _card_dir()
    _require_repo(card_dir)
    _run(["git", "log", "--oneline", "--graph", "-20"], cwd=card_dir, check=False)


def cmd_size(args) -> None:
    card_dir = _card_dir()
    _require_repo(card_dir)

    tree = _run(
        ["du", "-sh", "--exclude=.git", "--exclude=.xml-remote", "."],
        cwd=card_dir,
        capture_output=True,
        text=True,
        check=False,
    )
    tree_size = tree.stdout.strip().split("\t")[0] if tree.stdout.strip() else "?"
    print(f"Working tree: {tree_size}")

    git_obj = _run(
        ["du", "-sh", ".git"],
        cwd=card_dir,
        capture_output=True,
        text=True,
        check=False,
    )
    git_size = git_obj.stdout.strip().split("\t")[0] if git_obj.stdout.strip() else "?"
    print(f"Git objects:  {git_size}")

    commits = _run(
        ["git", "rev-list", "--count", "HEAD"],
        cwd=card_dir,
        capture_output=True,
        text=True,
        check=False,
    )
    print(f"Commits:      {commits.stdout.strip()}")

    xml_remote = card_dir / ".xml-remote" / ".git"
    if xml_remote.is_dir():
        remote_obj = _run(
            ["du", "-sh", ".xml-remote/.git"],
            cwd=card_dir,
            capture_output=True,
            text=True,
            check=False,
        )
        remote_size = remote_obj.stdout.strip().split("\t")[0] if remote_obj.stdout.strip() else "?"
        remote_commits = _run(
            ["git", "rev-list", "--count", "HEAD"],
            cwd=card_dir / ".xml-remote",
            capture_output=True,
            text=True,
            check=False,
        )
        print(f"XML remote:   {remote_size} ({remote_commits.stdout.strip()} commits)")


def cmd_init(args) -> None:
    card_dir = _card_dir()
    if (card_dir / ".git").is_dir():
        print(f"error: card repo already exists at {card_dir}", file=sys.stderr)
        sys.exit(1)

    source = Path(args.source) if args.source else _card_mount()
    if not source.is_dir():
        print(f"error: source not found: {source}", file=sys.stderr)
        print("Plug in your SD card or pass the path to an existing backup:", file=sys.stderr)
        print("  deluge-backup init /path/to/backup", file=sys.stderr)
        sys.exit(1)

    print(f"Copying {source} → {card_dir} ...")
    card_dir.mkdir(parents=True, exist_ok=True)

    _run(["rsync", "-a", f"{source}/", f"{card_dir}/"], check=True)
    _run(["git", "init"], cwd=card_dir, check=True)
    _run(["git", "config", "core.fileMode", "false"], cwd=card_dir, check=True)
    _run(["git", "add", "-A"], cwd=card_dir, check=True)
    _run(["git", "commit", "-m", "Initial snapshot"], cwd=card_dir, check=True)

    commits = _run(
        ["git", "rev-list", "--count", "HEAD"],
        cwd=card_dir,
        capture_output=True,
        text=True,
        check=False,
    )
    tree = _run(
        ["du", "-sh", ".", "--exclude=.git"],
        cwd=card_dir,
        capture_output=True,
        text=True,
        check=False,
    )
    tree_size = tree.stdout.strip().split("\t")[0] if tree.stdout.strip() else "?"
    print(f"Card repo initialized at {card_dir} ({commits.stdout.strip()} commit, {tree_size})")


def cmd_sync(args) -> None:
    card_dir = _card_dir()
    _require_repo(card_dir)

    mount = _card_mount()
    _ensure_mount(mount, _card_drive())
    try:
        found = mount.is_dir() and any(mount.iterdir())
    except OSError:
        found = False
    if not found:
        print(f"error: SD card not found at {mount}", file=sys.stderr)
        print("Set DELUGE_CARD_MOUNT or plug in the card", file=sys.stderr)
        sys.exit(1)

    excludes = [f"--exclude={p}" for p in CARD_ONLY_EXCLUDES]

    if args.go:
        _run(
            ["rsync", "-av", "--delete", *excludes, f"{mount}/", f"{card_dir}/"],
            check=True,
        )
        result = _run(
            ["git", "status", "--short"],
            cwd=card_dir,
            capture_output=True,
            text=True,
            check=False,
        )
        lines = [line for line in result.stdout.strip().splitlines() if line.strip()]
        if not lines:
            print("No changes")
        elif len(lines) <= 12:
            print(result.stdout.strip())
        else:
            print(f"{len(lines)} files changed")
    else:
        print("=== DRY RUN (pass --go to apply) ===")
        _run(
            ["rsync", "-avn", "--delete", *excludes, f"{mount}/", f"{card_dir}/"],
            check=False,
        )
        print("\nRun 'deluge-backup sync --go' to apply")


def _format_change(status: str, f1: str, f2: str, prefix: str = "") -> str:
    verb_map = {"A": "Added", "D": "Deleted", "M": "Modified", "R": "Renamed", "C": "Copied"}
    verb = verb_map.get(status[0], status)
    if prefix:
        f1 = f1.removeprefix(prefix)
        f2 = f2.removeprefix(prefix)
        verb = verb.lower()
        lead = "  - "
    else:
        lead = "- "
    if status[0] in ("R", "C"):
        return f"{lead}{verb} `{f1}` → `{f2}`"
    return f"{lead}{verb} `{f1}`"


def _build_changelog_entry(changes_output: str, msg: str) -> str:
    lines = [line for line in changes_output.strip().splitlines() if line.strip()]
    count = len(lines)
    date_str = datetime.now().strftime("%Y-%m-%d")

    parts = [f"### {date_str} — {msg}"]

    if count <= 12:
        for line in lines:
            cols = line.split("\t")
            status = cols[0]
            f1 = cols[1] if len(cols) > 1 else ""
            f2 = cols[2] if len(cols) > 2 else ""
            parts.append(_format_change(status, f1, f2))
    else:
        parts.append(f"- {count} files changed (too many to list individually)")

    sample_lines = [
        line for line in lines if any(c.startswith("SAMPLES/") for c in line.split("\t")[1:])
    ]
    if sample_lines:
        parts.append("- **Samples:**")
        for line in sample_lines:
            cols = line.split("\t")
            status = cols[0]
            f1 = cols[1] if len(cols) > 1 else ""
            f2 = cols[2] if len(cols) > 2 else ""
            parts.append(_format_change(status, f1, f2, "SAMPLES/"))
    else:
        parts.append("- No sample changes.")

    return "\n".join(parts)


def cmd_commit(args) -> None:
    card_dir = _card_dir()
    _require_repo(card_dir)
    msg = args.msg

    diff_staged = _run(
        ["git", "diff", "--quiet", "--cached"],
        cwd=card_dir,
        check=False,
    )
    diff_unstaged = _run(
        ["git", "diff", "--quiet"],
        cwd=card_dir,
        check=False,
    )
    untracked = _run(
        ["git", "ls-files", "--others", "--exclude-standard"],
        cwd=card_dir,
        capture_output=True,
        text=True,
        check=False,
    )

    is_clean = (
        diff_staged.returncode == 0
        and diff_unstaged.returncode == 0
        and not untracked.stdout.strip()
    )
    if is_clean:
        print("Nothing to commit — card repo is clean")
        return

    _run(["git", "add", "-A"], cwd=card_dir, check=True)
    _run(["git", "reset", "-q", "--", "README.md"], cwd=card_dir, check=False)

    readme = card_dir / "README.md"
    if not readme.exists():
        head_readme = _run(
            ["git", "cat-file", "-e", "HEAD:README.md"],
            cwd=card_dir,
            check=False,
        )
        if head_readme.returncode == 0:
            content = _run(
                ["git", "show", "HEAD:README.md"],
                cwd=card_dir,
                capture_output=True,
                text=True,
                check=False,
            )
            readme.write_text(content.stdout)

    changes = _run(
        ["git", "diff", "--cached", "--name-status"],
        cwd=card_dir,
        capture_output=True,
        text=True,
        check=False,
    )

    entry = _build_changelog_entry(changes.stdout, msg)

    if readme.exists() and "## Changelog" in readme.read_text():
        text = readme.read_text()
        text = text.replace("## Changelog\n", f"## Changelog\n\n{entry}\n", 1)
        readme.write_text(text)
    else:
        readme.write_text(f"# Deluge Card Backup\n\n## Changelog\n\n{entry}\n")

    _run(["git", "add", "README.md"], cwd=card_dir, check=True)
    _run(["git", "status", "--short"], cwd=card_dir, check=False)
    _run(["git", "commit", "-m", msg], cwd=card_dir, check=True)


def cmd_save(args) -> None:
    class SyncArgs:
        go = True

    cmd_sync(SyncArgs())
    cmd_commit(args)


def cmd_remote_init(args) -> None:
    card_dir = _card_dir()
    _require_repo(card_dir)

    remote_dir = card_dir / ".xml-remote"
    if (remote_dir / ".git").is_dir():
        current = _run(
            ["git", "remote", "get-url", "origin"],
            cwd=remote_dir,
            capture_output=True,
            text=True,
            check=False,
        )
        print(
            f"error: XML remote repo already exists at {remote_dir}",
            file=sys.stderr,
        )
        if current.returncode == 0:
            print(f"Current remote: {current.stdout.strip()}", file=sys.stderr)
        sys.exit(1)

    remote_dir.mkdir(parents=True, exist_ok=True)
    _run(["git", "init"], cwd=remote_dir, check=True)
    _run(["git", "config", "core.fileMode", "false"], cwd=remote_dir, check=True)
    _run(["git", "remote", "add", "origin", args.url], cwd=remote_dir, check=True)

    _run(
        [
            "rsync",
            "-a",
            "--exclude=.git",
            "--exclude=.xml-remote",
            *XML_INCLUDE_PATTERNS,
            f"{card_dir}/",
            f"{remote_dir}/",
        ],
        check=True,
    )

    _run(["git", "add", "-A"], cwd=remote_dir, check=True)
    _run(["git", "commit", "-m", "Initial XML snapshot"], cwd=remote_dir, check=True)
    _run(["git", "push", "-u", "origin", "main"], cwd=remote_dir, check=True)

    gitignore = card_dir / ".gitignore"
    if not gitignore.exists() or ".xml-remote" not in gitignore.read_text():
        with open(gitignore, "a") as f:
            f.write(".xml-remote\n")

    print("XML remote initialized — use 'deluge-backup push' to sync and push")


def _remote_url_to_web(url: str) -> str:
    url = url.strip()
    if url.startswith("git@"):
        host, _, path = url.partition(":")
        host = host.removeprefix("git@")
        url = f"https://{host}/{path}"
    return url.removesuffix(".git")


def _open_browser(url: str) -> None:
    if _is_wsl():
        subprocess.run(["cmd.exe", "/c", "start", "", url], check=False)
    else:
        import webbrowser

        webbrowser.open(url)


def cmd_open(args) -> None:
    card_dir = _card_dir()
    _require_repo(card_dir)

    remote_dir = card_dir / ".xml-remote"
    if not (remote_dir / ".git").is_dir():
        print(
            "error: no XML remote set up — run 'deluge-backup remote-init <url>' first",
            file=sys.stderr,
        )
        sys.exit(1)

    result = _run(
        ["git", "remote", "get-url", "origin"],
        cwd=remote_dir,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0 or not result.stdout.strip():
        print("error: no remote URL configured", file=sys.stderr)
        sys.exit(1)

    web_url = _remote_url_to_web(result.stdout.strip())
    print(f"Opening {web_url} ...")
    _open_browser(web_url)


def cmd_push(args) -> None:
    card_dir = _card_dir()
    _require_repo(card_dir)

    remote_dir = card_dir / ".xml-remote"
    if not (remote_dir / ".git").is_dir():
        print(
            "error: no XML remote set up — run 'deluge-backup remote-init <url>' first",
            file=sys.stderr,
        )
        sys.exit(1)

    _run(
        [
            "rsync",
            "-a",
            "--delete",
            "--exclude=.git",
            "--exclude=.xml-remote",
            *XML_INCLUDE_PATTERNS,
            f"{card_dir}/",
            f"{remote_dir}/",
        ],
        check=True,
    )

    _run(["git", "add", "-A"], cwd=remote_dir, check=True)

    diff_check = _run(
        ["git", "diff", "--cached", "--quiet"],
        cwd=remote_dir,
        check=False,
    )
    if diff_check.returncode == 0:
        print("No XML changes to push")
        return

    commit_msg = args.msg if args.msg else f"XML sync {datetime.now().strftime('%Y-%m-%d %H:%M')}"
    _run(["git", "status", "--short"], cwd=remote_dir, check=False)
    _run(["git", "commit", "-m", commit_msg], cwd=remote_dir, check=True)
    _run(["git", "push"], cwd=remote_dir, check=True)


def main(argv: list[str] | None = None) -> None:
    import argparse

    parser = argparse.ArgumentParser(
        prog="deluge-backup",
        description="Git-based backup for Synthstrom Deluge SD cards",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {version('deluge-tools')}",
    )
    subparsers = parser.add_subparsers(dest="command")

    # -- Setup (run once) --
    p_init = subparsers.add_parser("init", help="[setup] Create card repo from SD card or backup")
    p_init.add_argument(
        "source",
        nargs="?",
        default=None,
        help="Source directory (default: SD card mount)",
    )

    p_remote = subparsers.add_parser(
        "remote-init",
        help="[setup] Set up GitHub remote for XML-only pushes",
    )
    p_remote.add_argument("url", help="Git remote URL")

    # -- Core workflow --
    p_save = subparsers.add_parser(
        "save",
        help="[backup] Sync SD card and commit in one step (most common)",
    )
    p_save.add_argument("msg", nargs="?", default="Session snapshot", help="Commit message")

    p_sync = subparsers.add_parser(
        "sync",
        help="[backup] Sync SD card → local repo (dry run by default)",
    )
    p_sync.add_argument("--go", action="store_true", help="Apply changes (default: dry run)")

    p_commit = subparsers.add_parser(
        "commit",
        help="[backup] Stage all changes and commit with changelog",
    )
    p_commit.add_argument("msg", nargs="?", default="Session snapshot", help="Commit message")

    p_push = subparsers.add_parser("push", help="[backup] Push XML files to GitHub")
    p_push.add_argument(
        "msg",
        nargs="?",
        default=None,
        help="Commit message (default: auto-generated)",
    )

    subparsers.add_parser("open", help="[backup] Open the GitHub remote in a browser")

    # -- Inspection --
    subparsers.add_parser("status", help="[info] Show card repo status")
    subparsers.add_parser("diff", help="[info] Show diff of changed files")
    subparsers.add_parser("log", help="[info] Show last 20 commits")
    subparsers.add_parser("size", help="[info] Show working tree and git object sizes")

    args = parser.parse_args(argv)

    if args.command is None:
        parser.print_help()
        sys.exit(1)

    commands = {
        "status": cmd_status,
        "diff": cmd_diff,
        "log": cmd_log,
        "size": cmd_size,
        "init": cmd_init,
        "sync": cmd_sync,
        "commit": cmd_commit,
        "save": cmd_save,
        "remote-init": cmd_remote_init,
        "push": cmd_push,
        "open": cmd_open,
    }
    commands[args.command](args)


if __name__ == "__main__":
    main()
