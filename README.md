# deluge.quest

Browser-based tools for the [Synthstrom Deluge](https://synthstrom.com/product/deluge/) — a
standalone music workstation that stores songs and kits as XML on an SD card. This repo reads,
writes, and analyzes that XML, and does it entirely in the browser: no upload, no server, no
account.

Live at [deluge.quest](https://deluge.quest).

**Source is public for transparency, not for reuse.** No LICENSE is granted. You're welcome to
read the code and verify it does what it says (everything runs client-side; nothing you load
ever leaves your browser), but copying, redistributing, or building on it isn't authorized. If
that changes, this notice will too.

## What's here

- **SD card manager**: browse samples, fix broken references, sort songs, reclaim space, back up
  a card, all via drag-and-drop in the browser (Chromium only — needs the File System Access API).
- **Song analyzer**: tempo, key, scale, duration, instrument counts across a whole card or a
  folder of files.
- **Song preview**: play a Deluge song in the browser with per-track mute/volume, no hardware
  needed. It doesn't sound *right*, but it often sounds fun. And ultimately, it will remind you
  what song is what when you're reviwing your card.
- **Kit builder**: assemble a Deluge kit from card samples with vim-style keyboard navigation.
- **Patch generator**: build synth presets with a live Web Audio preview.
- **Score converter**: turn a Deluge arrangement into sheet music (MusicXML).
- **MIDI importer**: turn a MIDI file into a Deluge song.

## Repo layout

Two halves joined by a Python wheel:

```
deluge_tools/   Pure-stdlib Python: parses Deluge XML, converts formats, analyzes songs.
                Compiled to a wheel and loaded into the browser via Pyodide (Python-in-WASM).
                Also usable as CLIs — see below.
web/            Astro + Svelte site. This is the product. All file processing happens
                client-side; the Python wheel above is what does the work in-browser.
```

See [`CLAUDE.md`](CLAUDE.md) for the full architecture — page-by-page component map, the binary
XML formats, firmware source references, and design decisions.

## Local development

Requires [`uv`](https://docs.astral.sh/uv/) (Python) and Node 22+, plus
[`just`](https://github.com/casey/just) as the task runner:

```bash
just setup      # uv venv + pip install -e ".[dev]" + npm install
just check      # lint + typecheck + test, both Python and web
just web-dev    # Astro dev server at localhost:4321
just build      # rebuild the Python wheel, then the static site
```

Raw equivalents (no `just`) are in the [Quick Start](CLAUDE.md#quick-start) section of `CLAUDE.md`.

### CLIs

The Python package also ships as standalone CLIs, useful outside the browser:

```bash
deluge-score   path/to/song.XML          # → MusicXML / MIDI / Lilypond
deluge-import  path/to/song.mid          # MIDI → Deluge XML
deluge-stats   path/to/card/or/folder    # tempo, key, duration table
deluge-clean   path/to/sd/card           # find/move unused samples, broken refs
```

Each takes `--version` and `--help`.

## SD card backup

Git-tracked snapshots of your Deluge SD card. Every song, kit, synth, and sample is versioned —
you get real diffs, history, and the ability to roll back to any previous state.

### Setup

```bash
# One-time: initialize from an existing backup or directly from the SD card
just card-init /mnt/c/Users/you/path/to/backup
# — or, with the card plugged in (defaults to /mnt/d) —
just card-init
```

### Workflow

Plug in the SD card, then:

```bash
just card-save "Added drum kit patches"   # sync from card + commit
```

That's the one command you need. For more control:

| Recipe | What it does |
|---|---|
| `just card-init` | Copy SD card (or backup path) → `~/deluge-card`, initialize git |
| `just card-sync` | Dry-run rsync from SD card → local repo (pass `--go` to apply) |
| `just card-commit "msg"` | Stage everything and commit |
| `just card-save "msg"` | Sync + commit in one step |
| `just card-status` | `git status` on the card repo |
| `just card-diff` | Diff of changed files |
| `just card-log` | Recent commit history |
| `just card-size` | Working tree vs `.git` size |

### Pushing XML to GitHub

The local repo tracks everything (samples included), but samples are too large for GitHub.
A shadow repo pushes only XML and JSON files — songs, kits, synths, settings — which is where
the meaningful diffs are anyway.

```bash
# One-time: create a GitHub repo and connect it
just card-remote-init git@github.com:you/deluge-card.git

# After any session:
just card-push "Added new drum patterns"
```

| Recipe | What it does |
|---|---|
| `just card-remote-init <url>` | Set up the GitHub remote (initial XML commit + push) |
| `just card-push "msg"` | Sync XML/JSON → shadow repo, commit, push |

### Configuration

Set these environment variables to override defaults:

- `DELUGE_CARD_DIR` — where the git repo lives (default: `~/deluge-card`)
- `DELUGE_CARD_MOUNT` — where the SD card mounts in WSL (default: `/mnt/d`)
- `DELUGE_CARD_DRIVE` — Windows drive letter for mount (default: `D:`)

## Code quality

Pre-commit hooks (ruff, eslint, gitleaks, end-of-file-fixer) run on every commit —
`just pre-commit-install` to wire them up locally. `just check` runs the full lint/type/test
gate by hand.
