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


SIXTEENTH = 12
MIN_DURATION_TICKS = SIXTEENTH


def _quantize(ticks: int) -> int:
    if ticks <= 0:
        return 0
    snapped = round(ticks / SIXTEENTH) * SIXTEENTH
    return max(snapped, SIXTEENTH)


def _ticks_to_quarter_lengths(ticks: int) -> float:
    return ticks / TICKS_PER_QUARTER


def _iter_clip_notes(
    clip: Clip, ci: ClipInstance,
) -> list[tuple[int, int, int, int | None, str | None, bool]]:
    """Yield (abs_position, length, velocity, y, drum_name, is_grace) for each
    note, handling looping and truncation of clip within clip instance.
    Notes that would collapse into false chords under 16th quantization are
    marked as grace notes instead."""
    from collections import defaultdict

    raw_entries: list[tuple[int, int, int, int | None, str | None]] = []
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
                raw_entries.append((pos_in_instance, n.length, n.velocity, row.y, row.drum_name or (f"Drum {row.drum_index}" if row.drum_index is not None else None)))

    by_qpos: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for i, (pos, _len, _vel, y, _name) in enumerate(raw_entries):
        by_qpos[_quantize(pos)].append((pos, i))

    grace_indices: set[int] = set()
    for qpos, group in by_qpos.items():
        raw_positions = {pos for pos, _ in group}
        if len(raw_positions) > 1:
            sorted_by_pos = sorted(group, key=lambda x: x[0])
            for pos, idx in sorted_by_pos[:-1]:
                grace_indices.add(idx)

    results = []
    for i, (pos, length, velocity, y, drum_name) in enumerate(raw_entries):
        is_grace = i in grace_indices
        abs_pos = ci.position + _quantize(pos)
        q_len = _quantize(length)
        results.append((abs_pos, q_len, velocity, y, drum_name, is_grace))
    return results


def _insert_synth_clip_notes(
    part: stream.Part, clip: Clip, ci: ClipInstance,
) -> None:
    for abs_pos, length, velocity, y, _, is_grace in _iter_clip_notes(clip, ci):
        if y is None:
            continue
        offset_ql = _ticks_to_quarter_lengths(abs_pos)
        if is_grace:
            gn = note.Note(y)
            gn.duration = gn.duration.getGraceDuration()
            gn.volume.velocity = velocity
            part.insert(offset_ql, gn)
        else:
            duration_ql = _ticks_to_quarter_lengths(length)
            mn = note.Note(y)
            mn.quarterLength = duration_ql
            mn.volume.velocity = velocity
            part.insert(offset_ql, mn)


def _insert_drum_clip_notes(
    part: stream.Part, clip: Clip, ci: ClipInstance,
) -> None:
    for abs_pos, length, velocity, _, name, is_grace in _iter_clip_notes(clip, ci):
        offset_ql = _ticks_to_quarter_lengths(abs_pos)
        if is_grace:
            gn = note.Note("C4")
            gn.notehead = "x"
            gn.duration = gn.duration.getGraceDuration()
            gn.volume.velocity = velocity
            gn.lyric = name or "Drum"
            part.insert(offset_ql, gn)
        else:
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

    parts = []
    for inst in song.instruments:
        if not inst.clip_instances:
            continue
        part = _build_arrangement_part(inst, clips_by_index, song)
        if part is not None:
            parts.append(part)

    if parts:
        max_measures = max(
            len(p.getElementsByClass("Measure")) for p in parts
        )
        for part in parts:
            n_measures = len(part.getElementsByClass("Measure"))
            if n_measures < max_measures:
                last = part.getElementsByClass("Measure")[-1]
                last_offset = last.offset
                bar_ql = 4.0
                for i in range(max_measures - n_measures):
                    m = stream.Measure(number=n_measures + i + 1)
                    r = note.Rest(quarterLength=bar_ql)
                    m.append(r)
                    part.insert(last_offset + bar_ql * (i + 1), m)
            score.insert(0, part)

    return score
