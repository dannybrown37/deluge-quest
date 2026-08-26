from __future__ import annotations

from music21 import (
    clef,
    instrument,
    key,
    metadata,
    meter,
    note,
    stream,
    tempo,
)

from deluge_tools.parser import Clip, ClipInstance, Instrument, Song


class NoArrangementError(Exception):
    pass

TICKS_PER_QUARTER = 48

MODE_TO_KEY_MODE = {
    (0, 2, 4, 5, 7, 9, 11): "major",
    (0, 2, 3, 5, 7, 8, 10): "minor",
}

MIDI_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _root_note_to_pitch_name(root_note: int) -> str:
    midi = 60 + root_note
    return MIDI_NOTE_NAMES[midi % 12]


GRID_DIVISORS = [48, 32, 24, 16, 12, 8, 6, 4]
MIN_DURATION_TICKS = 4


def _quantize(ticks: int) -> int:
    if ticks <= 0:
        return 0
    best = ticks
    best_err = ticks
    for div in GRID_DIVISORS:
        snapped = round(ticks / div) * div
        if snapped > 0 and abs(ticks - snapped) < best_err:
            best = snapped
            best_err = abs(ticks - snapped)
    return best


def _ticks_to_quarter_lengths(ticks: int) -> float:
    return ticks / TICKS_PER_QUARTER


def _iter_clip_notes(
    clip: Clip, ci: ClipInstance,
) -> list[tuple[int, int, int, int | None, str | None]]:
    """Yield (abs_position, length, velocity, y, drum_name) for each note,
    handling looping and truncation of clip within clip instance."""
    results = []
    loops = (ci.length + clip.length - 1) // clip.length if clip.length > 0 else 1
    for row in clip.rows:
        if not row.notes:
            continue
        for loop_i in range(loops):
            loop_offset = loop_i * clip.length
            for n in row.notes:
                pos_in_instance = loop_offset + n.position
                if pos_in_instance >= ci.length:
                    continue
                q_len = _quantize(n.length)
                if q_len < MIN_DURATION_TICKS:
                    continue
                abs_pos = ci.position + _quantize(pos_in_instance)
                results.append((abs_pos, q_len, n.velocity, row.y, row.drum_name or (f"Drum {row.drum_index}" if row.drum_index is not None else None)))
    return results


def _insert_synth_clip_notes(
    part: stream.Part, clip: Clip, ci: ClipInstance,
) -> None:
    for abs_pos, length, velocity, y, _ in _iter_clip_notes(clip, ci):
        if y is None:
            continue
        offset_ql = _ticks_to_quarter_lengths(abs_pos)
        duration_ql = _ticks_to_quarter_lengths(length)
        mn = note.Note(y)
        mn.quarterLength = duration_ql
        mn.volume.velocity = velocity
        part.insert(offset_ql, mn)


def _insert_drum_clip_notes(
    part: stream.Part, clip: Clip, ci: ClipInstance,
) -> None:
    for abs_pos, length, velocity, _, name in _iter_clip_notes(clip, ci):
        offset_ql = _ticks_to_quarter_lengths(abs_pos)
        duration_ql = _ticks_to_quarter_lengths(length)
        mn = note.Note("C4")
        mn.stemDirection = "noStem"
        mn.notehead = "x"
        mn.lyric = name or "Drum"
        mn.quarterLength = duration_ql
        mn.volume.velocity = velocity
        part.insert(offset_ql, mn)


def _build_arrangement_part(
    inst: Instrument, clips_by_index: dict[int, Clip], song: Song,
) -> stream.Part | None:
    part = stream.Part()
    part.partName = inst.name or f"Instrument {inst.slot}"

    if inst.is_kit:
        part.insert(0, instrument.Percussion())
        part.insert(0, clef.PercussionClef())
    else:
        part.insert(0, instrument.Piano())
        pitch_name = _root_note_to_pitch_name(song.root_note)
        mode_tuple = tuple(song.mode_notes)
        mode_str = MODE_TO_KEY_MODE.get(mode_tuple, "minor")
        part.insert(0, key.Key(pitch_name, mode_str))

    part.insert(0, tempo.MetronomeMark(number=song.bpm))
    part.insert(0, meter.TimeSignature("4/4"))

    has_notes = False
    for ci in inst.clip_instances:
        clip = clips_by_index.get(ci.clip_index)
        if clip is None:
            continue
        if inst.is_kit:
            _insert_drum_clip_notes(part, clip, ci)
        else:
            _insert_synth_clip_notes(part, clip, ci)
        has_notes = True

    if not has_notes:
        return None

    part.makeNotation(inPlace=True)
    for m in part.getElementsByClass("Measure"):
        m.makeVoices(inPlace=True)
    return part


def song_to_score(song: Song) -> stream.Score:
    score = stream.Score()
    score.metadata = metadata.Metadata()
    score.metadata.title = "Deluge Song"

    has_any_arrangement = any(inst.clip_instances for inst in song.instruments)
    if not has_any_arrangement:
        raise NoArrangementError(
            "This file has no Song arrangement (no clipInstances on any instrument). "
            "Only Clips view data was found — there is no timeline to convert."
        )

    clips_by_index = {c.index: c for c in song.clips}

    for inst in song.instruments:
        if not inst.clip_instances:
            continue
        part = _build_arrangement_part(inst, clips_by_index, song)
        if part is not None:
            score.insert(0, part)

    return score
