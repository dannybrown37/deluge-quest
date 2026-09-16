---
layout: ../layouts/ProseLayout.astro
title: Card Backup
description: Back up your Deluge SD card with full history, real diffs, and optional GitHub sync.
---

## Back up your card, with history

Your Deluge SD card holds songs, kits, synths, and samples. It's got hours of creative work on a tiny chip; disaster could strike at any time. `deluge-backup` gives you a safety net: a full copy of your card with version history, so you can always get back to where you were.

This is the most technical tool on [deluge.quest](https://deluge.quest). It runs in a terminal, not a browser. If you've figured out how to use the Deluge effectively, you can handle running a few commands from the terminal. You might even find it fun!

The biggest win here is the speed of backup. Before I started using this system, I just backed up my whole card en masse to a new folder on my computer, sorted by backup date. This took a ton of time and a ton of storage space. By using this [Git](https://git-scm.com/docs)-backed approach, you can back up your card in seconds, and only the changes are stored. You can also see exactly what changed between backups, and roll back to any previous version.

## What you'll need

- A computer running macOS, Linux, or Windows.
- A terminal (macOS Terminal, Linux Terminal, PowerShell, or Windows Terminal) to type the below commands into.
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

You should see `deluge-backup 0.2.0` (or newer). If you do, you're ready.

**Windows note:** If `deluge-backup` isn't recognized after install, run `uv tool update-shell` (or `pipx ensurepath`), then restart your terminal. This adds the tool's install directory to your PATH.

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

That's it! A little work will be required to roll back to a previous version, but it's well worth digging deeper if you ever need it.

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

Backups are stored in `~/deluge-card` by default. The SD card mount point defaults to `/mnt/d` on Linux/WSL and `D:\` on Windows. macOS users will need to set `DELUGE_CARD_MOUNT` to wherever their card appears (e.g. `/Volumes/DELUGE`).

| Variable | Default | What it controls |
| --- | --- | --- |
| `DELUGE_CARD_DIR` | `~/deluge-card` | Where your backup lives |
| `DELUGE_CARD_MOUNT` | `/mnt/d` (Linux/WSL), `D:\` (Windows) | Where your SD card is mounted |
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

#### "command not found" / "is not recognized"

The install didn't add the tool directory to your PATH.

- **pipx:** run `pipx ensurepath` and restart your terminal.
- **uv:** run `uv tool update-shell` and restart your terminal.

#### "SD card not found"

Make sure your card is plugged in and mounted.

- **Windows:** it's usually `D:\` — set `DELUGE_CARD_MOUNT` if it's a different drive letter.
- **WSL:** usually `/mnt/d` or `/mnt/e` — check with `ls /mnt/`.
- **macOS:** usually `/Volumes/DELUGE` — set `DELUGE_CARD_MOUNT` accordingly.
- **Linux:** usually `/media/username/DELUGE` — set `DELUGE_CARD_MOUNT` accordingly.

#### "not a git repository"

Run `deluge-backup init` first. This only needs to happen once.

#### Windows notes

`deluge-backup` runs natively on Windows — no WSL required. You'll need [Git for Windows](https://gitforwindows.org/) installed, since the backup tool uses git for version history.

#### Still stuck?

You can try [opening an issue](https://github.com/dannybrown37/deluge-quest/issues), maybe I can help.
