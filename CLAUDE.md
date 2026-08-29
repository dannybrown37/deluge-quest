# Deluge Tools

CLI toolset for Synthstrom Deluge. Primary tool: `deluge-score` — converts Deluge XML Song arrangement view into sheet music (MusicXML, MIDI, Lilypond).

## Quick Start

```bash
uv venv && source .venv/bin/activate
uv pip install -e .
.venv/bin/pytest tests/ -v
.venv/bin/deluge-score "Square Spelunking.XML" -o output.musicxml --no-open
```

## Architecture

```
deluge_tools/
  parser.py          — XML → Song dataclasses (clips, instruments, noteData binary, clipInstances binary)
  converter.py       — Song → MusicXML (custom writer) or music21 Score (MIDI/Lilypond)
  musicxml_writer.py — Custom MusicXML serializer (bypasses music21, divisions=48)
  cli.py             — `deluge-score` entrypoint (argparse, MuseScore WSL launcher)
  midi_to_deluge.py  — MIDI → Deluge XML (reverse direction)
  cli_import.py      — `deluge-import` entrypoint for midi_to_deluge
tests/
  test_parser.py, test_converter.py, test_midi_to_deluge.py
web/                 — Astro + Svelte website (Vercel static hosting)
  src/pages/         — index, /score, /inspector, /about
  src/components/    — Svelte interactive islands (ScoreConverter.svelte)
  src/lib/pyodide.ts — Pyodide loader + Python-in-browser bridge
  src/layouts/       — BaseLayout.astro (nav, footer, theme)
  src/styles/        — Design tokens (DM Mono + DM Sans, gold/charcoal palette)
  public/py/         — Built Python wheel for Pyodide (deluge_tools-0.1.0-py3-none-any.whl)
  build-wheel.sh     — Packages deluge_tools as wheel for Pyodide
  vercel.json        — Vercel deployment config
```

## Key Design Decisions

- **Arrangement view only.** Session/Clips view has no timeline — `NoArrangementError` if no `clipInstances` found.
- **Clips are first-class objects.** `Song.clips` indexed by position in `sessionClips`. `Instrument.clip_instances` references clips by index. Matches Deluge's own model.
- **music21 `insert()` not `append()`** for absolute note positioning.
- **Grace notes** for sub-16th clusters that would collapse into false chords.

## Binary Formats (Big-Endian)

- **noteData**: 10-byte records — `uint32 position`, `uint32 length`, `uint8 velocity`, `uint8 lift_velocity`
- **noteDataWithLift**: 11-byte records (newer firmware) — adds condition byte. Not yet supported.
- **clipInstances**: 12-byte records — `uint32 position`, `uint32 length`, `uint32 clip_index` (bit 31 may flag section=255)

## Known Issues

- ~~**Quantization drift**~~ **FIXED** — was rounding all notes to 16th grid (12 ticks), destroying triplet positions. Now uses music21's `quantize(quarterLengthDivisors=(3, 4, 6, 12))` which preserves both straight and triplet rhythms with proper tuplet notation.
- **Only 2 scales** — major and minor. Should support all 14 firmware presets + USER_SCALE label.
- **Missing instrument types** — `midiChannel` (external MIDI) and `cv` instruments skipped entirely.
- **No `presetName`** — newer firmware stores patch names; we hardcode "Synth {slot}".
- **Kit drums at C4** — no General MIDI mapping; all drums render as x-noteheads with lyric labels.
- **Hardcoded 4/4** — Deluge has no native time signature, but the quantization issue makes this worse.
- **No swing** — `swingAmount` is ignored in XML→score direction.
- **No automation** — `parameterAutomation`, `knobPositions`, `patchCables` not parsed.
- **`audioClip` elements** ignored entirely.

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
- Our file's `[0,2,3,5,7,8,10,11]` has **8 notes** (no preset has 8) — it's a user-defined scale (natural minor + major 7th). Falling back to minor is correct.

### Community Ecosystem

No existing tool does Deluge → sheet music. Nearest peers:

| Tool | What | Notes |
|------|------|-------|
| `del2rpp` | Arrangement → REAPER | Same parsing problem, Python |
| `pydel` | Song parser library | Dormant |
| `deluge-cmd` / `deluge-card` | SD card management | On PyPI, active |
| `deluge-synthstrom-utils` | Multisample preset generator | Active |

## Web Frontend

The `web/` directory is an Astro + Svelte site deployed to Vercel (static, free tier). All file processing runs client-side via Pyodide (Python compiled to WASM).

### Pyodide Compatibility

The core pipeline is **pure stdlib Python** — no external deps needed:
- `parser.py` → `converter.py` → `musicxml_writer.py` (all stdlib: struct, xml.etree, dataclasses)
- `midi_to_deluge.py` needs `mido` (pure Python, installable via micropip)
- `song_to_score()` uses `music21` (~50MB) — **not used in web**, only CLI

### Dev Commands

```bash
cd web
npm run dev          # Astro dev server at localhost:4321
npm run build        # Static build → web/dist/
bash build-wheel.sh  # Rebuild Python wheel into web/public/py/
npx vercel           # Deploy to Vercel
```

### Design System
- **Typography:** DM Mono (headers, code, labels) + DM Sans (body, UI)
- **Palette:** Gold accent (#D4A847 dark / #C4942A light), charcoal ground (#131316 dark / #F2F0EB light), teal secondary (#5AABAC / #3A7B7C)
- **Theme:** Full light/dark support via CSS custom properties

## Style

- Python 3.10+, type hints everywhere.
- `pytest` + `pytest.mark.parametrize` for tests.
- `uv` for venv/package management.
- No comments unless explaining a non-obvious "why".
