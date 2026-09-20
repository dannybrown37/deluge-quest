# deluge.quest

Browser-based tools for the [Synthstrom Deluge](https://synthstrom.com/product/deluge/) — a
standalone music workstation that stores songs and kits as XML on an SD card. This repo reads,
writes, and analyzes that XML, and does it entirely in the browser: no upload, no server, no
account.

Live at [deluge.quest](https://deluge.quest).

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

```filesystem
deluge_tools/   Pure-stdlib Python: parses Deluge XML, converts formats, analyzes songs.
                Compiled to a wheel and loaded into the browser via Pyodide (Python-in-WASM).
                Also usable as CLIs (see below).
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
deluge-backup  init /path/to/card        # git-tracked SD card snapshots (see below)
deluge-quest                             # meta CLI — links to docs and tools
```

Each takes `--version` and `--help`.

## SD card backup

Git-tracked snapshots of your Deluge SD card. Every song, kit, synth, and sample is versioned —
you get real diffs, history, and the ability to roll back to any previous state.

Two interfaces: the `deluge-backup` CLI (pip-installable, no repo clone needed) and equivalent
`just card-*` recipes for contributors who already have the repo.

### Setup

```bash
pip install deluge-quest
deluge-backup init /mnt/c/Users/you/path/to/backup
# — or, with the card plugged in (defaults to /mnt/d) —
deluge-backup init
```

Or with just: `just card-init /path/to/backup`

### Workflow

Plug in the SD card, then:

```bash
deluge-backup save "Added drum kit patches"   # sync from card + commit
```

That's the one command you need. For more control:

| CLI command | Just recipe | What it does |
| --- | --- | --- |
| `deluge-backup init` | `just card-init` | Copy SD card → `~/deluge-card`, initialize git |
| `deluge-backup sync` | `just card-sync` | Dry-run rsync from card (pass `--go` to apply) |
| `deluge-backup commit "msg"` | `just card-commit "msg"` | Stage everything and commit |
| `deluge-backup save "msg"` | `just card-save "msg"` | Sync + commit in one step |
| `deluge-backup status` | `just card-status` | `git status` on the card repo |
| `deluge-backup diff` | `just card-diff` | Diff of changed files |
| `deluge-backup log` | `just card-log` | Recent commit history |
| `deluge-backup size` | `just card-size` | Working tree vs `.git` size |

### Pushing XML to GitHub

The local repo tracks everything (samples included), but samples are too large for GitHub.
A shadow repo pushes only XML and JSON files — songs, kits, synths, settings — which is where
the meaningful diffs are anyway.

```bash
# One-time: create a GitHub repo and connect it
deluge-backup remote-init git@github.com:you/deluge-card.git

# After any session:
deluge-backup push "Added new drum patterns"
```

| CLI command | Just recipe | What it does |
| --- | --- | --- |
| `deluge-backup remote-init <url>` | `just card-remote-init <url>` | Set up GitHub remote (initial XML commit + push) |
| `deluge-backup push "msg"` | `just card-push "msg"` | Sync XML/JSON → shadow repo, commit, push |

### Configuration

Set these environment variables to override defaults:

- `DELUGE_CARD_DIR` — where the git repo lives (default: `~/deluge-card`)
- `DELUGE_CARD_MOUNT` — where the SD card is (default: `/mnt/d` on Linux/WSL, `D:\` on Windows)
- `DELUGE_CARD_DRIVE` — Windows drive letter for WSL mount (default: `D:`)

## Web architecture

The site is a static Astro + Svelte app deployed to Vercel. All file processing runs
client-side — Python logic executes in the browser via Pyodide (CPython compiled to WASM),
and SD card access uses the File System Access API (Chromium only; Firefox/Safari fall back to
read-only drag-and-drop).

```filesystem
Browser
  ├── Astro shell (.astro pages)
  │     └── Svelte island (one component per tool)
  ├── cardStore.ts ──── IndexedDB (persisted card handle + song cache)
  ├── pyodide.ts ────── Pyodide WASM ──── deluge_tools .whl
  └── Web Audio API
        ├── homeAudio.ts   (site-wide player + FX chain)
        ├── songAudio.ts   (song-level synth playback)
        ├── patchAudio.ts  (subtractive + FM synth engine)
        └── padSounds.ts   (percussion voices for pad grid)
```

Full details in [`docs/web_architecture.md`](docs/web_architecture.md).

## Code quality

Pre-commit hooks (ruff, eslint, gitleaks, end-of-file-fixer) run on every commit —
`just pre-commit-install` to wire them up locally. `just check` runs the full lint/type/test
gate by hand.

## License

Two licenses, split cleanly:

- **Code** — GPL-3.0. All Python, TypeScript, Svelte, Astro, CSS, config, docs, and build
  scripts. See [`LICENSE`](LICENSE).

- **Creative media** — All Rights Reserved. The `.mp3` demo tracks in
  [`web/public/audio/`](web/public/audio/), the `.XML` demo tracks in [`web/public/demo`](web/public/demo),
  and the site's logo/OG image/favicons are original
  works by Danny Brown and are **not** covered by the GPL. They ride along so the site can play/demo
  them, but may not be redistributed, remixed, sampled, used commercially, or used as ML
  training data without permission. See [`web/public/audio/LICENSE`](web/public/audio/LICENSE)
  and [`NOTICE`](NOTICE) for the full breakdown.
