---
layout: ../layouts/ProseLayout.astro
title: Card Backup
description: Back up your Deluge SD card with full history, real diffs, and optional GitHub sync.
---

## Back up your card, with history

Your Deluge SD card holds songs, kits, synths, and samples. It's got hours of creative work on a tiny chip; disaster could strike at any time. `deluge-backup` gives you a safety net: a full copy of your card with version history, so you can always get back to where you were.

This is the most technical tool on [deluge.quest](https://deluge.quest). It runs in a terminal, not a browser. If you've figured out how to use the Deluge effectively, you can handle running a few commands from the terminal. You might even find it fun!

## What you'll need

- A computer running macOS, Linux, or Windows with [WSL](#wsl-support).
- A terminal (macOS Terminal, Linux Terminal, or Windows Terminal running WSL) to type the below commands into.
- An internet connection for the install and optional GitHub sync (not required for local backups).
- An SD card reader (or your Deluge connected via USB).
- About 15 minutes for the first-time setup.

You do *not* need to know Git, Python, or the command line beyond what's on this page.

## Step 1: Install

Open a terminal and run one of these. Either one works, pick whichever you have:

```bash
pipx install deluge-quest
```

```bash
uv tool install deluge-quest
```

Don't have `pipx` or `uv`? Install pipx with `pip install --user pipx` (comes with Python), or install uv from [astral.sh/uv](https://docs.astral.sh/uv/getting-started/installation/).

Confirm it worked:

```bash
deluge-backup --version
```

You should see `deluge-backup 0.1.0` (or newer). If you do, you're ready.

## Step 2: First backup

Plug in your SD card. Then:

```bash
deluge-backup init
```

This copies your entire SD card into `~/deluge-card` and creates a version history. It might take a few minutes depending on how many samples you have.

That's it! Your first backup is done.

## Step 3: After every session

Whenever you've been working on the Deluge and want to save your progress:

```bash
deluge-backup save "what I worked on"
```

For example:

```bash
deluge-backup save "new bass patch, reworked drums on SONG042"
```

The message is optional. Skip it and you'll get a timestamped "Session snapshot" instead. But a quick note about what you did makes it much easier to find things later.

That's the whole workflow. `save` copies any changes from the card, records what changed, and stores it. One command, done.

## Advanced Usage

For those who want to go a little deeper with these tools...

### Pushing to GitHub (optional)

Everything above works completely offline. But if you want an offsite backup (or just want to browse your XML changes on the web) you can sync to a GitHub repository.

This only pushes your XML files (songs, kits, synths), not your samples. That keeps the GitHub repo small (usually under 50 MB) while you still get full history and diffs online.

```bash
# One-time setup. Create an empty repo on GitHub first, then:
deluge-backup remote-init git@github.com:yourname/deluge-card.git

# After that, push whenever you want:
deluge-backup push

# Jump to the repo on GitHub in your browser:
deluge-backup open
```

If you don't use GitHub, you can skip this. Your local backup is still fully functional. You may want to copy it to a second place for additional safety, like an external hard drive or cloud storage.

### Seeing what changed

Curious what's different since your last backup?

```bash
deluge-backup status    # which files changed
deluge-backup diff      # what changed inside them
deluge-backup log       # history of all your backups
deluge-backup size      # how big your backup is
```

### Configuration

Backups are stored in `~/deluge-card` by default. The SD card mount point defaults to `/mnt/d` (standard WSL), but macOS and Linux users will need to set `DELUGE_CARD_MOUNT` to wherever their card appears (e.g. `/Volumes/DELUGE` on macOS, `/media/username/DELUGE` on Linux).

| Variable | Default | What it controls |
| --- | --- | --- |
| `DELUGE_CARD_DIR` | `~/deluge-card` | Where your backup lives |
| `DELUGE_CARD_MOUNT` | `/mnt/d` | Where your SD card is mounted |
| `DELUGE_CARD_DRIVE` | `D:` | Drive letter (WSL only) |

## All commands

| Command | What it does |
| --- | --- |
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
| `deluge-backup open` | Open the GitHub repo in your browser |

## Other tools included with deluge-quest

When you installed `deluge-quest`, you also got these CLIs. Each one has a browser version on [deluge.quest](https://deluge.quest). Power users may prefer the CLIs.

| Command | What it does | Web version |
| --- | --- | --- |
| `deluge-stats` | Batch stats for songs on your card (BPM, key, scale, duration, instrument counts) | [Song Stats](/stats) |
| `deluge-score` | Convert a song XML to MusicXML sheet music | [Score Converter](/score) |
| `deluge-import` | Convert a MIDI file into a Deluge song XML | [MIDI Importer](/import) |
| `deluge-clean` | Scan your SD card for unused samples, broken references, and reclaimable space | [Card Manager](/manage) |

Run any of them with `--help` to see usage, e.g. `deluge-stats --help`.

### Troubleshooting

#### "command not found: deluge-backup"

The install didn't add it to your PATH. Try running `pipx ensurepath` and opening a new terminal.

#### "SD card not found"

Make sure your card is plugged in and mounted. On WSL, it's usually `/mnt/d` or `/mnt/e` — check with `ls /mnt/`. Set `DELUGE_CARD_MOUNT` if it's somewhere else.

#### "not a git repository"

Run `deluge-backup init` first. This only needs to happen once.

#### WSL Support

If you're on Windows and haven't set up WSL yet, [Microsoft's guide](https://learn.microsoft.com/en-us/windows/wsl/install) walks you through it. It's a one-time setup.

I'm not totally opposed to supporting Windows tbh, but it's a fair amount of work for something that I don't know will be used. [Open an issue](https://github.com/dannybrown37/deluge-quest/issues) or [email me](mailto:danny@deluge.quest) if you're interested in Windows support.

#### Still stuck?

You can try [opening an issue](https://github.com/dannybrown37/deluge-quest/issues), maybe I can help.
