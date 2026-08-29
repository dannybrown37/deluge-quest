from __future__ import annotations

from dataclasses import dataclass

from deluge_tools.parser import TICKS_PER_QUARTER, Song

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

PRESET_SCALES: dict[tuple[int, ...], str] = {
    (0, 2, 4, 5, 7, 9, 11): "Major",
    (0, 2, 3, 5, 7, 8, 10): "Minor",
    (0, 2, 3, 5, 7, 9, 10): "Dorian",
    (0, 1, 3, 5, 7, 8, 10): "Phrygian",
    (0, 2, 4, 6, 7, 9, 11): "Lydian",
    (0, 2, 4, 5, 7, 9, 10): "Mixolydian",
    (0, 1, 3, 5, 6, 8, 10): "Locrian",
    (0, 2, 3, 5, 7, 9, 11): "Melodic Minor",
    (0, 2, 3, 5, 7, 8, 11): "Harmonic Minor",
    (0, 3, 5, 6, 7, 10): "Blues",
    (0, 2, 4, 7, 9): "Pentatonic",
    (0, 3, 5, 7, 10): "Minor Pentatonic",
    (0, 1, 4, 5, 7, 8, 11): "Hungarian Minor",
    (0, 2, 3, 6, 7, 8, 11): "Marva",
}


def detect_scale_name(mode_notes: list[int]) -> str:
    if not mode_notes:
        return "Chromatic"
    return PRESET_SCALES.get(tuple(mode_notes), "User")


def ticks_to_duration_str(ticks: int, bpm: float) -> str:
    if ticks == 0 or bpm <= 0:
        return "0:00"
    quarters = ticks / TICKS_PER_QUARTER
    seconds = quarters * 60.0 / bpm
    minutes = int(seconds // 60)
    secs = int(seconds % 60)
    if minutes == 0:
        return f"{secs}s"
    return f"{minutes}:{secs:02d}"


@dataclass
class SongStats:
    filename: str = ""
    bpm: float = 0.0
    key: str = ""
    has_arrangement: bool = False
    instrument_count: int = 0
    synth_count: int = 0
    kit_count: int = 0
    clip_count: int = 0
    total_notes: int = 0
    arrangement_length_ticks: int = 0
    duration_str: str = ""
    firmware_version: str = ""


def analyze_song(song: Song) -> SongStats:
    scale_name = detect_scale_name(song.mode_notes)
    root_name = NOTE_NAMES[song.root_note % 12]
    key = f"{root_name} {scale_name}"

    synth_count = sum(1 for i in song.instruments if not i.is_kit)
    kit_count = sum(1 for i in song.instruments if i.is_kit)

    total_notes = sum(
        len(row.notes)
        for clip in song.clips
        for row in clip.rows
    )

    has_arrangement = any(
        len(i.clip_instances) > 0 for i in song.instruments
    )

    arr_end = 0
    for inst in song.instruments:
        for ci in inst.clip_instances:
            end = ci.position + ci.length
            if end > arr_end:
                arr_end = end

    return SongStats(
        bpm=song.bpm,
        key=key,
        has_arrangement=has_arrangement,
        instrument_count=len(song.instruments),
        synth_count=synth_count,
        kit_count=kit_count,
        clip_count=len(song.clips),
        total_notes=total_notes,
        arrangement_length_ticks=arr_end,
        duration_str=ticks_to_duration_str(arr_end, song.bpm),
        firmware_version=song.firmware_version,
    )
