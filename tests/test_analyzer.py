from __future__ import annotations

import pytest

from deluge_tools.analyzer import (
    NOTE_NAMES,
    PRESET_SCALES,
    SongStats,
    analyze_song,
    detect_scale_name,
    ticks_to_duration_str,
)
from deluge_tools.parser import Clip, ClipInstance, Instrument, Note, NoteRow, Song


def _make_song(
    bpm: float = 120.0,
    root_note: int = 0,
    mode_notes: list[int] | None = None,
    in_arrangement: bool = True,
    instruments: list[Instrument] | None = None,
    clips: list[Clip] | None = None,
) -> Song:
    return Song(
        firmware_version="4.1.0",
        root_note=root_note,
        mode_notes=mode_notes or [],
        bpm=bpm,
        instruments=instruments or [],
        clips=clips or [],
        in_arrangement_view=in_arrangement,
    )


class TestDetectScaleName:
    @pytest.mark.parametrize(
        "mode_notes, expected",
        [
            ([0, 2, 4, 5, 7, 9, 11], "Major"),
            ([0, 2, 3, 5, 7, 8, 10], "Minor"),
            ([0, 2, 3, 5, 7, 9, 10], "Dorian"),
            ([0, 1, 3, 5, 7, 8, 10], "Phrygian"),
            ([0, 2, 4, 6, 7, 9, 11], "Lydian"),
            ([0, 2, 4, 5, 7, 9, 10], "Mixolydian"),
            ([0, 2, 3, 5, 7, 8, 10, 11], "User"),
            ([], "Chromatic"),
        ],
        ids=[
            "major",
            "minor",
            "dorian",
            "phrygian",
            "lydian",
            "mixolydian",
            "user-8-notes",
            "empty-chromatic",
        ],
    )
    def test_scale_detection(self, mode_notes: list[int], expected: str):
        assert detect_scale_name(mode_notes) == expected


class TestNoteNames:
    @pytest.mark.parametrize(
        "root, expected",
        [
            (0, "C"),
            (1, "C#"),
            (2, "D"),
            (7, "G"),
            (11, "B"),
        ],
    )
    def test_root_to_name(self, root: int, expected: str):
        assert NOTE_NAMES[root] == expected


class TestTicksToDuration:
    @pytest.mark.parametrize(
        "ticks, bpm, expected",
        [
            (0, 120.0, "0:00"),
            (48 * 4, 120.0, "2s"),
            (48 * 4 * 60, 120.0, "2:00"),
            (48 * 4 * 90, 120.0, "3:00"),
            (48 * 4 * 150, 120.0, "5:00"),
            (48 * 4 * 30 + 48 * 2, 120.0, "1:01"),
        ],
        ids=["zero", "2-seconds", "2-min", "3-min", "5-min", "1m-1s"],
    )
    def test_conversion(self, ticks: int, bpm: float, expected: str):
        assert ticks_to_duration_str(ticks, bpm) == expected


class TestAnalyzeSong:
    def test_basic_stats(self):
        instruments = [
            Instrument(name="Synth 0", slot=0, sub_slot=-1, clip_instances=[
                ClipInstance(position=0, length=192 * 4, clip_index=0),
                ClipInstance(position=192 * 4, length=192 * 4, clip_index=0),
            ]),
            Instrument(name="Kit", is_kit=True, slot=1, sub_slot=-1, clip_instances=[
                ClipInstance(position=0, length=192 * 8, clip_index=1),
            ]),
        ]
        clips = [
            Clip(index=0, instrument_slot=0, instrument_sub_slot=-1, length=192 * 4, rows=[
                NoteRow(y=60, notes=[
                    Note(position=0, length=48, velocity=100, lift_velocity=20),
                    Note(position=48, length=48, velocity=80, lift_velocity=20),
                ]),
            ]),
            Clip(index=1, instrument_slot=1, instrument_sub_slot=-1, is_kit=True, length=192 * 8, rows=[
                NoteRow(drum_index=0, drum_name="Kick", notes=[
                    Note(position=0, length=24, velocity=127, lift_velocity=20),
                ]),
            ]),
        ]
        song = _make_song(
            bpm=140.0,
            root_note=7,
            mode_notes=[0, 2, 3, 5, 7, 8, 10],
            instruments=instruments,
            clips=clips,
        )

        stats = analyze_song(song)

        assert stats.bpm == pytest.approx(140.0)
        assert stats.key == "G Minor"
        assert stats.has_arrangement is True
        assert stats.instrument_count == 2
        assert stats.synth_count == 1
        assert stats.kit_count == 1
        assert stats.clip_count == 2
        assert stats.total_notes == 3
        assert stats.arrangement_length_ticks == 192 * 8

    def test_no_arrangement(self):
        song = _make_song(in_arrangement=False, instruments=[
            Instrument(name="Synth 0", clip_instances=[]),
        ])
        stats = analyze_song(song)
        assert stats.has_arrangement is False
        assert stats.arrangement_length_ticks == 0

    def test_empty_song(self):
        song = _make_song()
        stats = analyze_song(song)
        assert stats.instrument_count == 0
        assert stats.clip_count == 0
        assert stats.total_notes == 0
        assert stats.key == "C Chromatic"
