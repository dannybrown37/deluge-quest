---
title: Card Backup
description: Git-based backup for your Deluge SD card — full history, real diffs, optional GitHub sync.
---

# deluge-backup

Git-based backup for your Synthstrom Deluge SD card — full history, real diffs, optional GitHub sync.

Your Deluge SD card holds songs, kits, patches, and samples that represent hours of work. `deluge-backup` wraps a simple git workflow into a single command: rsync your card to a local folder, commit with git, and optionally push XML files to GitHub. You get real diffs, full history, and a backup that survives a dead card.

## Requirements

- **macOS or Linux** (including WSL on Windows). The CLI uses `rsync` and `git` under the hood.
- Windows users: install [WSL](https://learn.microsoft.com/en-us/windows/wsl/install) and run from there.

## Install

```bash
pipx install deluge-tools
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

## Commands

### Setup (run once)

#### `deluge-backup init [source]`

Copies the SD card (or an existing backup folder) into `~/deluge-card` and initializes a git repo. If `source` is omitted, reads from the SD card mount point.

```bash
deluge-backup init                    # from mounted SD card
deluge-backup init /path/to/backup    # from an existing folder
```

#### `deluge-backup remote-init <url>`

Sets up a shadow repo that pushes only XML/JSON files to GitHub (no samples). Keeps the GitHub repo small (typically under 50 MB) while giving you full XML history and diffs on the web.

```bash
deluge-backup remote-init git@github.com:you/deluge-card.git
```

### Daily workflow

#### `deluge-backup save [msg]`

The command you'll use most. Syncs the SD card to the local repo and commits in one step.

```bash
deluge-backup save "Friday jam session"
deluge-backup save    # defaults to "Session snapshot"
```

#### `deluge-backup sync [--go]`

Rsyncs the SD card to the local repo. Dry run by default — pass `--go` to apply.

```bash
deluge-backup sync        # preview what would change
deluge-backup sync --go   # apply the sync
```

#### `deluge-backup commit [msg]`

Stages all changes, generates a changelog entry in the repo's README.md, and commits.

```bash
deluge-backup commit "Rewired SONG003 drums"
```

#### `deluge-backup push [msg]`

Syncs XML files to the shadow repo and pushes to GitHub. Requires `remote-init` first.

```bash
deluge-backup push
deluge-backup push "Weekly XML sync"
```

### Inspection

| Command | What it does |
|---|---|
| `deluge-backup status` | `git status` on the card repo |
| `deluge-backup diff` | `git diff` on the card repo |
| `deluge-backup log` | Last 20 commits, compact graph view |
| `deluge-backup size` | Working tree size, git object size, commit count |

## Configuration

Three environment variables control paths (all have sensible defaults):

| Variable | Default | Purpose |
|---|---|---|
| `DELUGE_CARD_DIR` | `~/deluge-card` | Where the git-tracked backup lives |
| `DELUGE_CARD_MOUNT` | `/mnt/d` | Where the SD card is mounted |
| `DELUGE_CARD_DRIVE` | `D:` | Drive letter for WSL auto-mount |

## What gets committed

Everything on the card — songs, kits, synths, samples, firmware files. The auto-generated README.md changelog in the card repo summarizes each commit with per-file status and a samples section.

## GitHub sync (optional)

`remote-init` creates a shadow repo at `~/deluge-card/.xml-remote` that includes only `.XML`, `.JSON`, and `README.md` — no samples. This keeps the GitHub repo small while still giving you full XML history and diffs on the web. Samples stay in the local repo only.

## Justfile equivalents

If you have the repo cloned, the `just card-*` recipes still work — they do the same thing. The CLI is a pip-installable wrapper around the same workflow.
