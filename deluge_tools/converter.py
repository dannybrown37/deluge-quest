from __future__ import annotations

from collections import defaultdict
from pathlib import Path

from deluge_tools.musicxml_writer import MusicXMLWriter, PartData, snap_duration
from deluge_tools.parser import Clip, ClipInstance, Instrument, Song


class NoArrangementError(Exception):
    pass

TICKS_PER_QUARTER = 48

MODE_TO_KEY_MODE = {
    (0, 2, 4, 5, 7, 9, 11): ("major", 0),
    (0, 2, 3, 5, 7, 8, 10): ("minor", 0),
}

MIDI_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

KEY_FIFTHS = {
    "C": 0, "G": 1, "D": 2, "A": 3, "E": 4, "B": 5, "F#": 6,
    "F": -1, "Bb": -2, "Eb": -3, "Ab": -4, "Db": -5, "Gb": -6,
}


def _root_note_to_pitch_name(root_note: int) -> str:
    midi = 60 + root_note
    return MIDI_NOTE_NAMES[midi % 12]


def _iter_clip_notes(
    clip: Clip, ci: ClipInstance,
) -> list[tuple[int, int, int, int | None, str | None]]:
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
                raw_entries.append((
                    ci.position + pos_in_instance,
                    n.length,
                    n.velocity,
                    row.y,
                    row.drum_name or (f"Drum {row.drum_index}" if row.drum_index is not None else None),
                ))
    return raw_entries


def _build_synth_part(
    inst: Instrument, clips_by_index: dict[int, Clip], song: Song,
) -> PartData | None:
    pitch_name = _root_note_to_pitch_name(song.root_note)
    mode_tuple = tuple(song.mode_notes)
    mode_str, _ = MODE_TO_KEY_MODE.get(mode_tuple, ("minor", 0))
    fifths = KEY_FIFTHS.get(pitch_name, 0)
    if mode_str == "minor":
        fifths -= 3

    part = PartData(
        name=inst.name or f"Instrument {inst.slot}",
        tempo=song.bpm,
        key_fifths=fifths,
        key_mode=mode_str,
    )

    by_pos: dict[int, list[tuple[int, int, int]]] = defaultdict(list)
    for ci in inst.clip_instances:
        clip = clips_by_index.get(ci.clip_index)
        if clip is None:
            continue
        for abs_pos, length, velocity, y, _ in _iter_clip_notes(clip, ci):
            if y is None:
                continue
            by_pos[abs_pos].append((y, velocity, length))

    if not by_pos:
        return None

    events = []
    for pos in sorted(by_pos):
        notes = by_pos[pos]
        pitches = [n[0] for n in notes]
        vel = max(n[1] for n in notes)
        dur = max(n[2] for n in notes)
        events.append((pos, dur, pitches, vel))

    for i in range(len(events) - 1):
        pos, dur, pitches, vel = events[i]
        next_pos = events[i + 1][0]
        if pos + dur > next_pos:
            dur = max(next_pos - pos, 4)
            events[i] = (pos, dur, pitches, vel)

    for pos, dur, pitches, vel in events:
        part.add_event(pos, dur, pitches, velocity=vel)

    return part


def _build_drum_part(
    inst: Instrument, clips_by_index: dict[int, Clip], song: Song,
) -> PartData | None:
    part = PartData(
        name=inst.name or "Kit",
        tempo=song.bpm,
        clef_sign="percussion",
        clef_line=2,
    )

    by_pos: dict[int, tuple[str | None, int, int]] = {}
    for ci in inst.clip_instances:
        clip = clips_by_index.get(ci.clip_index)
        if clip is None:
            continue
        for abs_pos, length, velocity, _, name in _iter_clip_notes(clip, ci):
            if abs_pos not in by_pos:
                by_pos[abs_pos] = (name, velocity, length)

    if not by_pos:
        return None

    for pos in sorted(by_pos):
        name, vel, dur = by_pos[pos]
        part.add_event(
            pos, dur, [60],
            velocity=vel,
            notehead="x",
            lyric=name or "Drum",
            stem="none",
        )

    return part


def song_to_musicxml(song: Song) -> str:
    has_any_arrangement = any(inst.clip_instances for inst in song.instruments)
    if not has_any_arrangement:
        raise NoArrangementError(
            "This file has no Song arrangement (no clipInstances on any instrument). "
            "Only Clips view data was found — there is no timeline to convert."
        )

    clips_by_index = {c.index: c for c in song.clips}
    writer = MusicXMLWriter()

    for inst in song.instruments:
        if not inst.clip_instances:
            continue
        if inst.is_kit:
            part = _build_drum_part(inst, clips_by_index, song)
        else:
            part = _build_synth_part(inst, clips_by_index, song)
        if part is not None:
            writer.add_part(part)

    return writer.to_xml()


def song_to_score(song: Song):
    """Build a music21 Score (for MIDI/Lilypond export)."""
    from fractions import Fraction

    from music21 import (
        chord,
        clef,
        instrument,
        key,
        metadata,
        meter,
        note,
        stream,
        tempo,
    )

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

        part = stream.Part()
        part.partName = inst.name or f"Instrument {inst.slot}"

        if inst.is_kit:
            part.insert(0, instrument.Percussion())
            part.insert(0, clef.PercussionClef())
        else:
            part.insert(0, instrument.Piano())
            pitch_name = _root_note_to_pitch_name(song.root_note)
            mode_tuple = tuple(song.mode_notes)
            mode_str, _ = MODE_TO_KEY_MODE.get(mode_tuple, ("minor", 0))
            part.insert(0, key.Key(pitch_name, mode_str))

        part.insert(0, tempo.MetronomeMark(number=song.bpm))
        part.insert(0, meter.TimeSignature("4/4"))

        by_pos: dict[int, list[tuple[int, int, int]]] = defaultdict(list)
        has_notes = False
        for ci in inst.clip_instances:
            clip = clips_by_index.get(ci.clip_index)
            if clip is None:
                continue
            for abs_pos, length, velocity, y, name in _iter_clip_notes(clip, ci):
                if inst.is_kit:
                    offset_ql = Fraction(abs_pos, TICKS_PER_QUARTER)
                    dur_ql = Fraction(snap_duration(length), TICKS_PER_QUARTER)
                    mn = note.Note("C4")
                    mn.stemDirection = "noStem"
                    mn.notehead = "x"
                    mn.lyric = name or "Drum"
                    mn.quarterLength = dur_ql
                    mn.volume.velocity = velocity
                    part.insert(offset_ql, mn)
                    has_notes = True
                elif y is not None:
                    by_pos[abs_pos].append((y, velocity, length))
                    has_notes = True

        if not inst.is_kit and by_pos:
            events = []
            for pos in sorted(by_pos):
                notes_at = by_pos[pos]
                pitches = [n[0] for n in notes_at]
                vel = max(n[1] for n in notes_at)
                dur = max(n[2] for n in notes_at)
                events.append((pos, dur, pitches, vel))

            for i in range(len(events) - 1):
                pos, dur, pitches, vel = events[i]
                next_pos = events[i + 1][0]
                if pos + dur > next_pos:
                    dur = max(next_pos - pos, 4)
                    events[i] = (pos, dur, pitches, vel)

            for pos, dur, pitches, vel in events:
                offset_ql = Fraction(pos, TICKS_PER_QUARTER)
                dur_ql = Fraction(snap_duration(dur), TICKS_PER_QUARTER)
                if len(pitches) == 1:
                    mn = note.Note(pitches[0])
                    mn.quarterLength = dur_ql
                    mn.volume.velocity = vel
                    part.insert(offset_ql, mn)
                else:
                    ch = chord.Chord(pitches)
                    ch.quarterLength = dur_ql
                    ch.volume.velocity = vel
                    part.insert(offset_ql, ch)

        if not has_notes:
            continue
        part.makeNotation(inPlace=True)
        parts.append(part)

    score = stream.Score()
    score.metadata = metadata.Metadata()
    score.metadata.title = "Deluge Song"
    for part in parts:
        score.insert(0, part)
    return score
