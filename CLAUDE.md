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
  parser.py       — XML → Song dataclasses (clips, instruments, noteData binary, clipInstances binary)
  converter.py    — Song → music21 Score (arrangement timeline only)
  cli.py          — `deluge-score` entrypoint (argparse, MuseScore WSL launcher)
  midi_to_deluge.py — MIDI → Deluge XML (reverse direction)
  cli_import.py   — `deluge-import` entrypoint for midi_to_deluge
tests/
  test_parser.py, test_converter.py, test_midi_to_deluge.py — 24 tests
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

## Style

- Python 3.10+, type hints everywhere.
- `pytest` + `pytest.mark.parametrize` for tests.
- `uv` for venv/package management.
- No comments unless explaining a non-obvious "why".
