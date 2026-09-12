---
layout: ../layouts/ProseLayout.astro
title: Card Backup
description: Back up your Deluge SD card with full history, real diffs, and optional GitHub sync.
---

## Back up your card with history

Your Deluge SD card holds songs, kits, synths, samples. It's got hours of creative work on a tiny chip that could fail, get lost, or just get overwritten by accident. **deluge-backup** gives you a safety net: a full copy of your card with version history, so you can always get back to where you were.

This is the most technical tool on deluge.quest. It runs in a terminal, not a browser. But if you can copy and paste a few commands, you can do this! And once it's set up, keeping backups current is a single command.

## What you'll need

- A computer running macOS, Linux, or Windows with WSL. If you're on Windows and haven't set up WSL yet, [Microsoft's guide](https://learn.microsoft.com/en-us/windows/wsl/install) walks you through it. It's a one-time setup.
- A terminal (macOS Terminal, Linux Terminal, or Windows Terminal running WSL).
- An SD card reader (or your Deluge connected via USB).
- About 15 minutes for the first-time setup.

You do *not* need to know Git, Python, or the command line beyond what's on this page.

## Step 1: Install

Open a terminal and run one of these — either one works, pick whichever you have:

```bash
pipx install deluge-quest
```

```bash
uv tool install deluge-quest
```

Don't have `pipx` or `uv`? Install pipx with `pip install --user pipx` (comes with Python), or install uv from [astral.sh/uv](https://docs.astral.sh/uv/getting-started/installation/).

Confirm it worked:

```bash
deluge-quest --version
```

You should see `deluge-quest 0.1.0` (or newer). If you do, you're ready.

## Step 2: First backup

Plug in your SD card. Then:

```bash
deluge-backup init
```

This copies your entire SD card into `~/deluge-card` and creates a version history. It might take a few minutes depending on how many samples you have.

That's it — your first backup is done.

## Step 3: After every session

Whenever you've been working on the Deluge and want to save your progress:

```bash
deluge-backup save "what I worked on"
```

For example:

```bash
deluge-backup save "new bass patch, reworked drums on SONG042"
```

The message is optional — skip it and you'll get a timestamped "Session snapshot" instead. But a quick note about what you did makes it much easier to find things later.

**That's the whole workflow.** `save` copies any changes from the card, records what changed, and stores it. One command, done.

## Seeing what changed

Curious what's different since your last backup?

```bash
deluge-backup status    # which files changed
deluge-backup diff      # what changed inside them
deluge-backup log       # history of all your backups
deluge-backup size      # how big your backup is
```

## Pushing to GitHub (optional)

Everything above works completely offline. But if you want an offsite backup — or just want to browse your XML changes on the web — you can sync to a GitHub repository.

This only pushes your XML files (songs, kits, synths), not your samples. That keeps the GitHub repo small (usually under 50 MB) while you still get full history and diffs online.

```bash
# One-time setup — create an empty repo on GitHub first, then:
deluge-backup remote-init git@github.com:yourname/deluge-card.git

# After that, push whenever you want:
deluge-backup push
```

If you don't use GitHub, skip this entirely — your local backup is still fully functional.

## Configuration

By default, `deluge-backup` looks for your SD card at `/mnt/d` (standard WSL mount) and stores backups in `~/deluge-card`. If your setup is different, set these environment variables:

| Variable | Default | What it controls |
|---|---|---|
| `DELUGE_CARD_DIR` | `~/deluge-card` | Where your backup lives |
| `DELUGE_CARD_MOUNT` | `/mnt/d` | Where your SD card is mounted |
| `DELUGE_CARD_DRIVE` | `D:` | Drive letter (WSL auto-mount) |

## All commands

| Command | What it does |
|---|---|
| `deluge-backup init` | First-time setup — copy card, create backup repo |
| `deluge-backup save` | The everyday command — sync + snapshot in one step |
| `deluge-backup sync` | Preview what would sync (add `--go` to apply) |
| `deluge-backup commit` | Snapshot current state without syncing |
| `deluge-backup status` | See what's changed |
| `deluge-backup diff` | See exactly what changed inside files |
| `deluge-backup log` | Browse your backup history |
| `deluge-backup size` | Check how big your backup is |
| `deluge-backup remote-init` | Connect to a GitHub repo (one-time) |
| `deluge-backup push` | Push XML files to GitHub |

## Troubleshooting

**"command not found: deluge-backup"** — The install didn't add it to your PATH. Try running `pipx ensurepath` and opening a new terminal.

**"SD card not found"** — Make sure your card is plugged in and mounted. On WSL, it's usually `/mnt/d` or `/mnt/e` — check with `ls /mnt/`. Set `DELUGE_CARD_MOUNT` if it's somewhere else.

**"not a git repository"** — Run `deluge-backup init` first. This only needs to happen once.

Still stuck? [Open an issue](https://github.com/dannybrown37/deluge-quest/issues) — we'll help you get it working.
