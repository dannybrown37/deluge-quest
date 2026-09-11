---
layout: ../layouts/ProseLayout.astro
title: Card Backup
description: Git-based backup for your Deluge SD card — full history, real diffs, optional GitHub sync.
---

Your Deluge SD card holds songs, kits, patches, and samples that represent hours of work. The browser-based tools on this site process files without uploading anything, but they don't back them up.

**The recommended approach is git-based**: rsync your card to a local folder, commit with git, and optionally push XML files to GitHub. This gives you real diffs, full history, and a backup that survives a dead card.

## Quick start

The project's [justfile](https://github.com/dannybrown37/deluge-quest) includes ready-made commands. Install [just](https://github.com/casey/just), clone the repo, then:

```bash
# First time — copy your card into a git repo
just card-init

# After a session — sync and commit in one step
just card-save "Added bass patch, reworked drums on SONG042"

# See what changed
just card-status
just card-diff
just card-log
```

## All commands

| Command | What it does |
|---|---|
| `card-init` | Copies the SD card (or an existing backup folder) into `~/deluge-card` and initializes a git repo |
| `card-sync` | Rsyncs the SD card to the repo (dry run by default, pass `--go` to apply) |
| `card-commit` | Stages everything, generates a changelog entry in README.md, and commits |
| `card-save` | `card-sync --go` + `card-commit` in one step |
| `card-status` | `git status` on the card repo |
| `card-diff` | `git diff` on the card repo |
| `card-log` | Last 20 commits, compact graph view |
| `card-size` | Working tree size, git object size, commit count |
| `card-remote-init` | Sets up a shadow repo that pushes only XML/JSON files to GitHub (no samples) |
| `card-push` | Syncs XML files to the shadow repo and pushes to GitHub |

## Configuration

Three environment variables control paths (all have sensible defaults):

| Variable | Default | Purpose |
|---|---|---|
| `DELUGE_CARD_DIR` | `~/deluge-card` | Where the git-tracked backup lives |
| `DELUGE_CARD_MOUNT` | `/mnt/d` | Where the SD card is mounted |
| `DELUGE_CARD_DRIVE` | `D:` | Drive letter for WSL auto-mount |

## What gets committed

Everything on the card — songs, kits, synths, samples, firmware files. The auto-generated README.md changelog summarizes each commit with per-file status and a samples section.

## GitHub sync (optional)

`card-remote-init <url>` creates a shadow repo that includes only `.XML`, `.JSON`, and `README.md` — no samples. This keeps the GitHub repo small (typically under 50 MB) while still giving you full XML history and diffs on the web. Samples stay in the local repo only.

## What's next

We're planning a standalone CLI tool (publishable to PyPI) that wraps this workflow without requiring the justfile or the full repo clone. If that interests you, [watch the repo](https://github.com/dannybrown37/deluge-quest) or open an issue.
