# deluge.quest

Browser-first toolset for the Synthstrom Deluge. A static Astro + Svelte site (`web/`) is the
product; a Python package (`deluge_tools/`) supplies the file-format logic, shipped into the
browser as a Pyodide wheel and also exposed as CLIs for local use.

## ⚠️ Keep This File Current

**This document is part of the work, not a description of it.** It drifted badly once already —
it described a 4-page site with one Svelte component long after the site had grown to 10 pages
and 8 components, and the largest file in the repo went unmentioned. That cost real context.

Update this file **in the same change** that causes the drift, whenever you:

- add, remove, or rename a page in `web/src/pages/` or a component in `web/src/components/`
- add or remove a module in `web/src/lib/` or `deluge_tools/`
- add, remove, or rename a CLI entrypoint in `pyproject.toml`
- change the Python↔JS contract in `pyodide.ts` (new bridge function, changed payload shape)
- change how state crosses pages (`cardStore`, IndexedDB schema, cache keys)
- fix or discover something in **Known Issues**
- change a dependency, the build pipeline, or the deploy target

If you finish a task and this file no longer matches the repo, the task is not finished. When
in doubt, verify against the tree (`ls web/src/components web/src/pages`, `grep '\[project.scripts\]' -A6 pyproject.toml`)
rather than trusting what's written here.

## Quick Start

```bash
just setup          # uv venv + pip install -e ".[dev]" + npm install
just check          # ruff check + pytest
just web-dev        # Astro dev server at localhost:4321
just build          # rebuild wheel, then static build
just coverage       # pytest + vitest coverage (+ real-Pyodide integration test), merged into one local HTML report
```

`justfile` is the task runner of record — prefer it over remembering raw commands. Raw
equivalents:

```bash
uv venv && source .venv/bin/activate && uv pip install -e ".[dev]"
.venv/bin/pytest tests/ -v
cd web && npm run dev
```

## Architecture

Two halves joined by a wheel. The Python does format work; the Svelte does everything a user
actually touches.

```
deluge_tools/           — pure-stdlib format logic (except music21/mido, CLI-only)
  parser.py             — XML → Song dataclasses. TICKS_PER_QUARTER=48, binary noteData /
                          clipInstances decoding, SoundPatch/OscPatch/PatchCable synth params
  converter.py          — Song → MusicXML (custom writer) or music21 Score (MIDI/Lilypond)
  musicxml_writer.py    — Custom MusicXML serializer (bypasses music21, divisions=48)
  analyzer.py           — Song → SongStats (BPM, key, scale, duration, instrument/note counts)
  card_scanner.py       — SD card tree → CardReport (unused samples, missing refs, reclaimable)
  midi_to_deluge.py     — MIDI → Deluge XML (reverse direction; needs mido)
  cli.py                — `deluge-score`   (argparse, MuseScore WSL launcher)
  cli_import.py         — `deluge-import`
  cli_stats.py          — `deluge-stats`   (directory scanner, table output)
  cli_clean.py          — `deluge-clean`   (card scan/cleanup)
tests/                  — test_parser, test_converter, test_analyzer, test_card_scanner,
                          test_cli_clean, test_cli_stats, test_midi_to_deluge
web/                    — Astro + Svelte, static, deployed to Vercel
  src/pages/            — one .astro shell per tool, each mounting one Svelte island
  src/components/       — the actual product (see table below)
  src/lib/              — shared TS (see table below)
  src/layouts/          — BaseLayout.astro (nav, footer, theme), ProseLayout.astro (Markdown pages)
  src/styles/           — design tokens
  public/py/            — checked-in wheel loaded by Pyodide
  public/audio/         — .mp3 demo tracks served by the home page player
  build-wheel.sh        — packages deluge_tools as the wheel above
  vercel.json           — deploy config
docs/handoffs/          — session handoff notes
```

### Pages → components

Every tool page is a thin `.astro` shell wrapping `BaseLayout` plus a single Svelte island.
Prose-only pages are Markdown instead (see `/faq`).

| Page | Component | What it does |
|---|---|---|
| `/` | `DelugeUI.svelte` | Interactive 8×16 pad-grid with drum sounds (velocity gradient per 4×4 block), sidebar tools column, demo audio player |
| `/manage` | `CardScanner.svelte` | SD card management: sample browser with drag-drop reorganization (auto-updates XML refs), song sorting, broken ref repair, analysis, incremental backup |
| `/stats` | `SongAnalyzer.svelte` | Batch song stats table over a card or file selection |
| `/preview` | `SongPreview.svelte` | Web Audio playback of a song with per-track mute/volume |
| `/kits` | `KitBuilder.svelte` | Build/edit Deluge kit XML from card samples (vim-style keys) |
| `/patch` | `PatchGenerator.svelte` | Generate synth presets with live Web Audio preview |
| `/score` | `ScoreConverter.svelte` | Song XML → MusicXML download |
| `/import` | `MidiImporter.svelte` | MIDI → Deluge song XML |
| `/songs` | — | Song index: list of all tracks with links to individual pages |
| `/songs/[slug]` | `SongPlayer.svelte` | Shareable per-song page with mobile-friendly audio player, OG tags |
| `/faq` | — | Hand-written prose. It is `src/pages/faq.md` (Markdown), rendered through `ProseLayout.astro` — edit the Markdown, not HTML |

**Prose pages are Markdown.** Drop a `.md` file in `src/pages/` with
`layout: ../layouts/ProseLayout.astro` plus `title` and `description` frontmatter — the title
becomes the `<h1>`, the nav/footer/theme come from `BaseLayout`, and all the prose styling is in
`ProseLayout`. No HTML to hand-write. Markdown has no link-target syntax, so a small inline
rehype plugin in `astro.config.mjs` adds `target="_blank" rel="noopener"` to any `http(s)://`
link at build time; that plugin is why `@astrojs/markdown-remark` is a dependency (Astro 7's
default Sätteri processor does not run rehype plugins).

`src/pages/audio/songs.json.ts` is an Astro endpoint that enumerates `public/audio/*.mp3` at
build time for the home-page player. `src/pages/songs/[slug].astro` generates one static page
per audio file for shareable song links.

### `web/src/lib/`

| Module | Role |
|---|---|
| `pyodide.ts` | The Python↔JS seam. Lazy singleton loader + 4 bridges: `analyzeStats`, `convertMidiToDelugeXml`, `inspectSong`, `convertToMusicXML`. Bridges covered by a real-Pyodide integration test, see Known Issues |
| `cardStore.ts` | Singleton `cardStore` — the SD card handle, sample index, and song cache, shared across `/manage`, `/stats`, `/kits`, `/preview`. Persists the `FileSystemDirectoryHandle` and a song-XML cache in IndexedDB (`deluge-card-store`, v2). Also exports `walkHandle()` for walking arbitrary directory handles (used by backup) and `APP_MANAGED_DIRS` |
| `softDelete.ts` | `moveToTrash(root, path)`, `moveFile(root, from, to)`, `updateXmlReferences(root, xmlPaths, xmlTexts, moves)` — file moves with XML ref updating. Backups to `MOVE_BACKUP/` |
| `patchAudio.ts` | Web Audio synth engine (subtractive + FM voices, envelopes) for `/patch` |
| `songAudio.ts` | Song-level scheduler over `patchAudio` voices + card samples for `/preview` |
| `kitXml.ts` | `Kit`/`KitRow` model and Deluge kit XML serialization for `/kits` |
| `padSounds.ts` | 8 Web Audio synth percussion sounds (kick, snare, hat, clap, tom, zap, blip, sweep) for the DelugeUI pad grid on `/songs/[slug]` pages. Velocity-to-glow mapping |
| `audioVisualizer.ts` | Canvas-based audio visualizer using `AnalyserNode` — frequency bars (gold/teal) when music plays, ambient wave when idle. Used on home page below the Deluge grid |
| `homeAudio.ts` | Singleton `homeAudio` — the site-wide `<audio>` player + Web Audio FX chain (filter, reverb, delay, analyser), song list, MediaSession wiring. Shared by the home page, the mini-player in `BaseLayout`, and `/songs/[slug]`. Also emits the song analytics events |
| `screenGuard.ts` | `shouldSyncScreen(state)` — decides whether the DelugeUI screen may revert to song info, or is currently claimed by a held knob value or a hovered pad |
| `analytics.ts` | Vercel Web Analytics wrapper. `track()` (never throws), `trackToolVisit()`, `trackToolAction()`, plus pure `crossedMarks()`/`percentPlayed()` for listen milestones |

## Key Design Decisions

- **Browser-first.** The site is the product; the CLIs are a convenience over the same package.
  Anything user-facing goes in `web/`, and processing stays client-side — no uploads, no server.
- **Arrangement view only** for scores. Session/Clips view has no timeline — `NoArrangementError`
  if no `clipInstances`. `cardStore.songHasArrangement()` filters by regex on the raw XML so
  other pages can pre-filter without invoking Python.
- **Clips are first-class objects.** `Song.clips` indexed by position in `sessionClips`;
  `Instrument.clip_instances` references clips by index. Matches Deluge's own model.
- **Nothing is destroyed.** Card operations move files into `SOFT_DELETE/`, `REPAIR_BACKUP/`, or
  `MOVE_BACKUP/` (all in `APP_MANAGED_DIRS`, never re-scanned). Sample moves back up affected
  XMLs to `MOVE_BACKUP/` before rewriting references.
- **Python↔JS is an untyped string seam.** `pyodide.ts` embeds Python in template literals and
  marshals via `JSON.stringify` + `pyodide.globals.set`. TS interfaces (`SongStats`, `PreviewTrack`)
  are hand-maintained mirrors of the Python dataclasses — change one, change the other, no
  compiler will catch it.
- **music21 `insert()` not `append()`** for absolute note positioning.
- **Grace notes** for sub-16th clusters that would collapse into false chords.

## Binary Formats (Big-Endian)

- **noteData**: 10-byte records — `uint32 position`, `uint32 length`, `uint8 velocity`, `uint8 lift_velocity`
- **noteDataWithLift**: 11-byte records (firmware 4.0+) — same fields + 1 trailing probability/condition byte (ignored). Used instead of `noteData` on newer-firmware songs; `_parse_clip_note_rows` falls back to it when `noteData` is absent.
- **clipInstances**: 12-byte records — `uint32 position`, `uint32 length`, `uint32 clip_index`. Bit 31 (`ARRANGEMENT_ONLY_FLAG = 0x80000000`) set means `clip_index` points into `arrangementOnlyTracks` (masked-off low bits = index there), not `sessionClips`.

## Known Issues

- ~~**Quantization drift**~~ **FIXED** — was rounding all notes to 16th grid (12 ticks), destroying triplet positions. Now uses music21's `quantize(quarterLengthDivisors=(3, 4, 6, 12))` which preserves both straight and triplet rhythms with proper tuplet notation.
- ~~**noteDataWithLift not supported**~~ **FIXED** — firmware 4.0+ note rows silently decoded to 0 notes.
- ~~**Named-preset instrument collision**~~ **FIXED** — firmware 4.0+ synths address by `presetName`/`presetFolder` instead of numeric `presetSlot` (which is absent); all such instruments collided on key `(-1, -1)` and overwrote each other.
- ~~**MIDI/CV channel collision**~~ **FIXED** — `midiChannel`/`cv` instruments also lack `presetSlot`; multiple channels collided the same way. Now keyed by `(type, channel)`.
- ~~**`arrangementOnlyTracks` ignored**~~ **FIXED** — clips dropped straight into the arranger (no session-view slot) live in a separate top-level `<arrangementOnlyTracks>` block; `clip_index` values with bit 31 set reference it. Previously unparsed → those clips (and any instrument's notes routed through them) showed as 0.
- ~~**Filter cutoff default not maxed**~~ **FIXED (×3)** — `homeAudio.initAudio()` creates a `BiquadFilterNode` whose default frequency is 350Hz, not 20kHz. Without an explicit `filterNode.frequency.value = 22050`, songs sound muffled. Regresses whenever `initAudio()` is rewritten — the fix is one line (`filterNode.frequency.value = 22050`) right after creating the node. Pages without knob UI (like `/songs/[slug]`) never called `updateFilter`, so the default stuck.
- ~~**System play/pause buttons broken**~~ **FIXED (×2)** — `initMediaSession()` registers `MediaSession` handlers for hardware play/pause/next/prev, but was only called from `reassertMediaSession()` which nothing invoked. Fix: call `this.initMediaSession()` inside `togglePlay()` on play start. Regresses whenever `togglePlay()` is rewritten — look for the `initMediaSession()` call.
- **Thin `web/` test coverage** — vitest is wired up (`web/src/lib/*.test.ts`, `just web-test`,
  `just check`). Every file in `web/src/lib/` has 100% line coverage. `pyodide.ts`'s 4 bridge
  functions (`analyzeStats`, `convertMidiToDelugeXml`, `inspectSong`, `convertToMusicXML`) are
  covered by a real-runtime integration test (`web/src/lib/pyodide.integration.test.ts`, real
  Pyodide/WASM + the real wheel, no DOM mocks) — run directly with `just web-test-pyodide`,
  or as part of `just coverage` (not part of `just check`, since it's the one recipe with
  out-of-repo network I/O on a cold cache). `loadPyodide()` itself (the browser CDN
  loader/wiring) is still untested. ~9,000 lines of Svelte still have no automated coverage.
- ~~**`micropip.install()` pulled `music21`/`matplotlib`/`numpy`/`pillow` on every page
  load**~~ **FIXED** — found via the new `pyodide.integration.test.ts`. `pyproject.toml` lists
  `music21` and `mido` as unconditional top-level `dependencies`, so the wheel's METADATA
  declares them as `Requires-Dist` with no marker; `micropip.install()` with default dependency
  resolution installed music21's full transitive chain (matplotlib, numpy, Pillow, fonttools,
  …) on every page that called `loadPyodide()`, not just the CLI path that imports
  `song_to_score()`. Fixed with `deps=False` (verified safe: no browser-loaded module
  (parser/converter/musicxml_writer/analyzer/card_scanner) imports music21 at module level —
  it's a lazy `from music21 import ...` inside `song_to_score()`, CLI-only; `mido` is installed
  separately, on demand, by `convertMidiToDelugeXml`). **Gotcha**: `micropip.install(path,
  {deps: false})` called plainly from JS does **not** work and fails silently — a trailing JS
  object becomes the next *positional* Python arg (`keep_going`), not kwargs, so `deps` stays
  at its default of `True` with no error. Must use
  `micropip.install.callKwargs(path, {deps: false})`. Same trap applies to any other
  Pyodide/micropip call taking Python kwargs from JS.
- **Only 2 scales** — major and minor. Should support all 14 firmware presets + USER_SCALE label.
- **`midiChannel`/`cv` instruments** parse correctly now but still render nothing in MusicXML/score output (`converter.py` skips them) — preview/inspector paths (`pyodide.ts`) are fine.
- **Kit drums at C4** — no General MIDI mapping; all drums render as x-noteheads with lyric labels.
- **Hardcoded 4/4** — Deluge has no native time signature.
- **No swing** — `swingAmount` is ignored in XML→score direction.
- **No automation** — `parameterAutomation`, `knobPositions` not parsed in the score path.
- **`audioClip` elements** ignored in the score path.

## Web Frontend

Static Astro + Svelte on Vercel (free tier). All file processing is client-side via Pyodide
(Python compiled to WASM) and the File System Access API.

### Pyodide Compatibility

- `parser.py` → `converter.py` → `musicxml_writer.py` → `analyzer.py` → `card_scanner.py` are
  **pure stdlib** (struct, xml.etree, dataclasses) and work as-is in the browser.
- `midi_to_deluge.py` needs `mido` (pure Python, installed via micropip on demand).
- `song_to_score()` uses `music21` (~50MB) — **CLI only**, never loaded in the browser.

Keep new `deluge_tools` code stdlib-only unless it is deliberately CLI-only.

### Browser API Constraints

- **File System Access API** (`showDirectoryPicker`, `FileSystemDirectoryHandle`) is
  Chromium-only. Firefox/Safari fall back to drag-and-drop / file input, which is read-only —
  card mutation features simply aren't available there.
- Directory handles persisted in IndexedDB need permission re-granted per session; see
  `cardStore.reconnect()` / `requestReconnect()`, which must be triggered by a user gesture.

### Dev Commands

```bash
cd web
npm run dev              # Astro dev server at localhost:4321
npm run build            # Static build → web/dist/  (acceptance bar: zero errors, zero warnings)
npm run test:integration # Real-Pyodide integration test (slow, network on first run; not in `just check`)
bash build-wheel.sh      # Rebuild Python wheel into web/public/py/
npx vercel               # Deploy to Vercel
```

**⚠️ The site loads `deluge_tools` from the checked-in wheel, not live source.** Any change to
`deluge_tools/*.py` (parser, converter, analyzer, card_scanner, musicxml_writer) is invisible in
the browser — including `npm run dev` — until you run `bash build-wheel.sh` to regenerate
`web/public/py/deluge_tools-0.1.0-py3-none-any.whl`. `git status` will show the `.whl` as
modified; commit it alongside the source change. Symptom of forgetting: preview/converter
behaves as if the old bug is still there even though `pytest` passes and the fix is correct —
always rebuild the wheel before trusting a browser repro of a `deluge_tools` change.

### Analytics

Vercel Web Analytics (`@vercel/analytics`), mounted once as `<Analytics />` in `BaseLayout.astro`.
Cookieless, so no consent banner. Custom events (free tier caps at ~50k/month):

| Event | Props | Fired from |
|---|---|---|
| `tool_visit` | `tool` | `BaseLayout` on `astro:page-load`, for the 7 tool routes only |
| `tool_action` | `tool`, `action`, + optional counts | `trackToolAction()`, called by every tool component at the points where real work completes |
| `song_play` | `song` | `homeAudio.togglePlay()`, once per loaded song (resume does not re-fire) |
| `song_progress` | `song`, `percent` | `homeAudio` raf tick at the 25/50/75/100 marks |
| `song_listen` | `song`, `seconds` | flushed on pause, track change, `pagehide`, and tab hide |

`song_listen` reports *unreported* seconds each flush, so summing gives real listen time.
Backward seeks never re-fire a milestone; `trackedPercent` is monotonic.

`tool_action` actions per tool:

| Tool | Actions |
|---|---|
| `manage` | `scan` (+samples/unused), `delete_sample`, `batch_move` (+moved/errors), `batch_delete` (+deleted/errors), `sort_songs` (+songs), `fix_all_refs` (+fixed/skipped/errors), `fix_all_xml`, `backup` (+files), `export_json` |
| `stats` | `analyze_card`, `analyze_drop`, `analyze_error`, `export_csv`, `delete_song`, `convert_score`, `open_in_preview` |
| `preview` | `inspect`, `inspect_error`, `play` |
| `kits` | `open_samples`, `load_kit`, `export` (+rows) |
| `patch` | `generate`, `preview`, `download`, `bulk_download` |
| `score` | `convert`, `convert_error`, `download` |
| `import` | `convert`, `convert_error`, `download` |

Deliberately **not** tracked: per-row edits (adding one kit row, dragging one sample). They fire
dozens of times per session and would burn the free-tier event quota without telling you more
than the completion event already does.

### Design System
- **Typography:** DM Mono (headers, code, labels) + DM Sans (body, UI)
- **Palette:** Gold accent (#D4A847 dark / #C4942A light), charcoal ground (#131316 dark / #F2F0EB light), teal secondary (#5AABAC / #3A7B7C)
- **Theme:** Full light/dark support via CSS custom properties

## Deluge Firmware Reference

Source: https://github.com/SynthstromAudible/DelugeFirmware (community firmware, fully open source)

### XML Format Authority

The firmware C++ source is the ground truth for the XML song format:

- **`src/deluge/model/song/song.cpp`** — `Song::writeToFile()` (line ~1143) is the canonical serializer. Writes `<song>` root with: `rootNote`, `xScroll`, `xZoom`, `timePerTimerTick`, `timerTickFraction`, `swingAmount`, `inArrangementView`, etc.
- **`src/deluge/model/output.cpp`** — `Output::writeDataToFile()` (line ~249) serializes `clipInstances` as packed hex.
- **`src/deluge/model/clip/instrument_clip.cpp`** — clip-level serialization (noteRows, noteData).

### Timing

- **48 PPQN** (pulses per quarter note) — confirmed in firmware. A sixteenth note = 12 ticks.
- **BPM**: `sample_rate (44100) / (timePerTimerTick + timerTickFraction / 2^32)` → ticks/sec → divide by 48 → BPM.

### Scale System

Located in `src/deluge/model/scale/`:

- **`preset_scales.h`** — `DEF_SCALES()` macro defines all 14 preset scales with exact semitone sets.
- **`musical_key.h`** — `MusicalKey` class holds `modeNotes` (NoteSet) + `rootNote`.
- **`note_set.h`** — `NoteSet` is a 12-bit bitfield, one bit per semitone.
- If `getScale(notes)` finds no match in `presetScaleNotes[]`, returns `USER_SCALE`.
- A song with `[0,2,3,5,7,8,10,11]` has **8 notes** (no preset has 8) — user-defined scale (natural minor + major 7th). Falling back to minor is correct.

### Community Ecosystem

No existing tool does Deluge → sheet music. Nearest peers:

| Tool | What | Notes |
|------|------|-------|
| `del2rpp` | Arrangement → REAPER | Same parsing problem, Python |
| `pydel` | Song parser library | Dormant |
| `deluge-cmd` / `deluge-card` | SD card management | On PyPI, active |
| `deluge-synthstrom-utils` | Multisample preset generator | Active |

## Style

- Python 3.10+, type hints everywhere.
- `pytest` + `pytest.mark.parametrize` for tests.
- `uv` for venv/package management; `just` for tasks.
- No comments unless explaining a non-obvious "why".
- TypeScript in `web/src/lib/` carries explicit types at module boundaries; Svelte components
  are where untyped local state is tolerated.
