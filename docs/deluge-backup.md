---
title: Card Backup
description: Git-based backup for your Deluge SD card, with full history, real diffs, optional GitHub sync.
---

## deluge-backup

Your Deluge SD card holds songs, kits, patches, and samples that represent hours of work. `deluge-backup` wraps a simple git workflow into a single command: rsync your card to a local folder, commit with git, and optionally push XML files to GitHub. You get real diffs, full history, and a backup that survives a dead card.

## Requirements

macOS or Linux (including WSL on Windows). The CLI uses `rsync` and `git` under the hood. Windows users should install [WSL](https://learn.microsoft.com/en-us/windows/wsl/install) and run from there.

## Install

Install globally with `pipx`:

```bash
pipx install deluge-tools
```

Or with `uv`:

```bash
uv tool install deluge-tools
```

No repo clone needed, no `just` dependency. If you already have the [deluge-quest](https://github.com/dannybrown37/deluge-quest) repo cloned, the `just card-*` recipes still work.

## Quick start

```bash
# First time — copy your card into a git repo
deluge-backup init

# After a session — sync and commit in one step
deluge-backup save "Added bass patch, reworked drums on SONG042"

# See what changed
deluge-backup status
deluge-backup diff
deluge-backup log
```

## The one command you need

`deluge-backup save "your message"` syncs the SD card and commits in one step. Run it after every session and you're covered. It defaults to "Session snapshot" if you skip the message.

## All commands

| Command | What it does |
|---|---|
| `init [source]` | Copy the SD card (or a folder) into `~/deluge-card` and create a git repo |
| `save [msg]` | Sync SD card + commit in one step — the everyday command |
| `sync [--go]` | Rsync the card to the repo (dry run by default, `--go` to apply) |
| `commit [msg]` | Stage everything, generate a changelog, and commit |
| `remote-init <url>` | Set up a GitHub remote for XML-only pushes (no samples) |
| `push [msg]` | Sync XML files to the shadow repo and push to GitHub |
| `status` | `git status` on the card repo |
| `diff` | `git diff` on the card repo |
| `log` | Last 20 commits, compact graph view |
| `size` | Working tree size, git object size, commit count |

## Configuration

Three environment variables control paths (all have sensible defaults):

| Variable | Default | Purpose |
|---|---|---|
| `DELUGE_CARD_DIR` | `~/deluge-card` | Where the git-tracked backup lives |
| `DELUGE_CARD_MOUNT` | `/mnt/d` | Where the SD card is mounted |
| `DELUGE_CARD_DRIVE` | `D:` | Drive letter for WSL auto-mount |

## What gets committed

Everything on the card — songs, kits, synths, samples, firmware files. Each commit auto-generates a changelog entry in the card repo's README.md with per-file status and a samples section.

## GitHub sync

This is optional. `remote-init` creates a shadow repo at `~/deluge-card/.xml-remote` that includes only `.XML`, `.JSON`, and `README.md` — no samples. This keeps the GitHub repo small (typically under 50 MB) while giving you full XML history and diffs on the web. Samples stay local.

```bash
deluge-backup remote-init git@github.com:you/deluge-card.git
deluge-backup push
```
