from pathlib import Path

import pytest
from music21 import stream

from deluge_tools.converter import song_to_score
from deluge_tools.parser import (
    Clip,
    ClipInstance,
    Instrument,
    Note,
    NoteRow,
    Song,
    parse_song,
)

SAMPLE_SONG = Path(__file__).parent / "fixtures" / "square_spelunking.XML"


@pytest.fixture
def score():
    song = parse_song(SAMPLE_SONG)
    return song_to_score(song)


def test_produces_score(score):
    assert isinstance(score, stream.Score)


def test_has_parts(score):
    assert len(score.parts) > 0


def test_synth_parts_have_notes(score):
    for part in score.parts:
        if part.partName and "Kit" not in part.partName:
            notes = part.flatten().notes
            assert len(notes) > 0, f"{part.partName} has no notes"


def test_can_export_musicxml(score, tmp_path):
    out = tmp_path / "test.musicxml"
    score.write("musicxml", fp=str(out))
    assert out.exists()
    assert out.stat().st_size > 100


def _make_song(
    clips: list[Clip],
    instruments: list[Instrument],
    in_arrangement_view: bool = True,
) -> Song:
    return Song(
        bpm=120.0,
        root_note=0,
        mode_notes=[0, 2, 4, 5, 7, 9, 11],
        instruments=instruments,
        clips=clips,
        in_arrangement_view=in_arrangement_view,
    )


class TestNoArrangement:
    def test_falls_back_to_clip_catalog(self):
        clip = Clip(
            index=0,
            instrument_slot=0,
            instrument_sub_slot=-1,
            length=192,
            rows=[NoteRow(y=60, notes=[Note(0, 96, 80, 20)])],
        )
        inst = Instrument(name="Synth", slot=0, sub_slot=-1, clip_instances=[])
        song = _make_song([clip], [inst], in_arrangement_view=False)
        score = song_to_score(song)
        assert len(score.parts) == 1

    def test_empty_clips_produce_empty_score(self):
        clip = Clip(
            index=0,
            instrument_slot=0,
            instrument_sub_slot=-1,
            length=192,
            rows=[],
        )
        inst = Instrument(name="Synth", slot=0, sub_slot=-1, clip_instances=[])
        song = _make_song([clip], [inst], in_arrangement_view=True)
        score = song_to_score(song)
        assert len(score.parts) == 0


class TestClipCatalog:
    """When no arrangement exists, render each clip as a standalone part."""

    def test_clip_mode_song_produces_parts(self):
        clip = Clip(
            index=0,
            instrument_slot=0,
            instrument_sub_slot=-1,
            length=192,
            rows=[NoteRow(y=60, notes=[Note(0, 96, 80, 20)])],
        )
        inst = Instrument(name="Synth 0", slot=0, sub_slot=-1, clip_instances=[])
        song = _make_song([clip], [inst], in_arrangement_view=False)
        score = song_to_score(song)
        assert len(score.parts) == 1

    def test_clip_mode_multiple_clips_same_instrument(self):
        clips = [
            Clip(
                index=0,
                instrument_slot=0,
                instrument_sub_slot=-1,
                length=192,
                rows=[NoteRow(y=60, notes=[Note(0, 48, 80, 20)])],
            ),
            Clip(
                index=1,
                instrument_slot=0,
                instrument_sub_slot=-1,
                length=96,
                rows=[NoteRow(y=64, notes=[Note(0, 48, 80, 20)])],
            ),
        ]
        inst = Instrument(name="Synth 0", slot=0, sub_slot=-1, clip_instances=[])
        song = _make_song(clips, [inst], in_arrangement_view=False)
        score = song_to_score(song)
        assert len(score.parts) == 2

    def test_clip_mode_note_offsets_start_at_zero(self):
        clip = Clip(
            index=0,
            instrument_slot=0,
            instrument_sub_slot=-1,
            length=192,
            rows=[NoteRow(y=60, notes=[Note(0, 48, 80, 20), Note(48, 48, 80, 20)])],
        )
        inst = Instrument(name="Synth 0", slot=0, sub_slot=-1, clip_instances=[])
        song = _make_song([clip], [inst], in_arrangement_view=False)
        score = song_to_score(song)
        notes = list(score.parts[0].flatten().notes)
        assert len(notes) == 2
        assert float(notes[0].offset) == 0.0
        assert float(notes[1].offset) == 1.0

    def test_clip_mode_musicxml(self):
        from deluge_tools.converter import song_to_musicxml

        clip = Clip(
            index=0,
            instrument_slot=0,
            instrument_sub_slot=-1,
            length=192,
            rows=[NoteRow(y=60, notes=[Note(0, 48, 80, 20)])],
        )
        inst = Instrument(name="Synth 0", slot=0, sub_slot=-1, clip_instances=[])
        song = _make_song([clip], [inst], in_arrangement_view=False)
        xml = song_to_musicxml(song)
        assert "<part" in xml
        assert "<note" in xml

    def test_clip_mode_kit(self):
        clip = Clip(
            index=0,
            instrument_slot=1,
            instrument_sub_slot=-1,
            is_kit=True,
            length=192,
            rows=[NoteRow(drum_index=0, drum_name="Kick", notes=[Note(0, 12, 100, 20)])],
        )
        inst = Instrument(name="Kit", slot=1, sub_slot=-1, is_kit=True, clip_instances=[])
        song = _make_song([clip], [inst], in_arrangement_view=False)
        score = song_to_score(song)
        assert len(score.parts) == 1

    def test_clip_mode_empty_clips_skipped(self):
        clip = Clip(
            index=0,
            instrument_slot=0,
            instrument_sub_slot=-1,
            length=192,
            rows=[],
        )
        inst = Instrument(name="Synth 0", slot=0, sub_slot=-1, clip_instances=[])
        song = _make_song([clip], [inst], in_arrangement_view=False)
        score = song_to_score(song)
        assert len(score.parts) == 0


class TestClipLooping:
    def test_clip_loops_when_instance_longer_than_clip(self):
        clip = Clip(
            index=0,
            instrument_slot=0,
            instrument_sub_slot=-1,
            length=96,
            rows=[NoteRow(y=60, notes=[Note(0, 48, 80, 20)])],
        )
        inst = Instrument(
            name="Synth",
            slot=0,
            sub_slot=-1,
            clip_instances=[ClipInstance(position=0, length=288, clip_index=0)],
        )
        song = _make_song([clip], [inst])
        score = song_to_score(song)
        notes = list(score.parts[0].flatten().notes)
        assert len(notes) == 3

    def test_looped_notes_at_correct_offsets(self):
        clip = Clip(
            index=0,
            instrument_slot=0,
            instrument_sub_slot=-1,
            length=96,
            rows=[NoteRow(y=60, notes=[Note(0, 48, 80, 20)])],
        )
        inst = Instrument(
            name="Synth",
            slot=0,
            sub_slot=-1,
            clip_instances=[ClipInstance(position=0, length=288, clip_index=0)],
        )
        song = _make_song([clip], [inst])
        score = song_to_score(song)
        notes = list(score.parts[0].flatten().notes)
        offsets = [n.offset for n in notes]
        assert offsets == [0.0, 2.0, 4.0]


class TestQuantization:
    def test_triplet_positions_preserved(self):
        """Notes at triplet positions (multiples of 16 ticks) stay on triplet grid."""
        clip = Clip(
            index=0,
            instrument_slot=0,
            instrument_sub_slot=-1,
            length=192,
            rows=[
                NoteRow(
                    y=60,
                    notes=[
                        Note(0, 16, 80, 20),
                        Note(16, 16, 80, 20),
                        Note(32, 16, 80, 20),
                    ],
                )
            ],
        )
        inst = Instrument(
            name="Synth",
            slot=0,
            sub_slot=-1,
            clip_instances=[ClipInstance(position=0, length=192, clip_index=0)],
        )
        song = _make_song([clip], [inst])
        score = song_to_score(song)
        notes = list(score.parts[0].flatten().notes)
        assert len(notes) == 3
        offsets = [float(n.offset) for n in notes]
        assert offsets == pytest.approx([0.0, 1 / 3, 2 / 3], abs=0.01)

    def test_sixteenth_positions_preserved(self):
        """Notes at 16th positions (multiples of 12 ticks) stay on 16th grid."""
        clip = Clip(
            index=0,
            instrument_slot=0,
            instrument_sub_slot=-1,
            length=192,
            rows=[
                NoteRow(
                    y=60,
                    notes=[
                        Note(0, 12, 80, 20),
                        Note(12, 12, 80, 20),
                        Note(24, 12, 80, 20),
                        Note(36, 12, 80, 20),
                    ],
                )
            ],
        )
        inst = Instrument(
            name="Synth",
            slot=0,
            sub_slot=-1,
            clip_instances=[ClipInstance(position=0, length=192, clip_index=0)],
        )
        song = _make_song([clip], [inst])
        score = song_to_score(song)
        notes = list(score.parts[0].flatten().notes)
        assert len(notes) == 4
        offsets = [n.offset for n in notes]
        assert offsets == [0.0, 0.25, 0.5, 0.75]

    def test_measures_total_four_quarters(self):
        """Every measure should total 4.0 quarter lengths in 4/4."""
        clip = Clip(
            index=0,
            instrument_slot=0,
            instrument_sub_slot=-1,
            length=192,
            rows=[
                NoteRow(
                    y=60,
                    notes=[
                        Note(0, 16, 80, 20),
                        Note(16, 16, 80, 20),
                        Note(32, 16, 80, 20),
                        Note(48, 48, 80, 20),
                        Note(96, 48, 80, 20),
                        Note(144, 48, 80, 20),
                    ],
                )
            ],
        )
        inst = Instrument(
            name="Synth",
            slot=0,
            sub_slot=-1,
            clip_instances=[ClipInstance(position=0, length=192, clip_index=0)],
        )
        song = _make_song([clip], [inst])
        score = song_to_score(song)
        for m in score.parts[0].getElementsByClass("Measure"):
            total = sum(n.quarterLength for n in m.flatten().notesAndRests)
            assert total == pytest.approx(4.0), f"Measure {m.number} has {total} QL"

    def test_on_grid_notes_unchanged(self):
        clip = Clip(
            index=0,
            instrument_slot=0,
            instrument_sub_slot=-1,
            length=192,
            rows=[NoteRow(y=60, notes=[Note(0, 48, 80, 20), Note(48, 96, 80, 20)])],
        )
        inst = Instrument(
            name="Synth",
            slot=0,
            sub_slot=-1,
            clip_instances=[ClipInstance(position=0, length=192, clip_index=0)],
        )
        song = _make_song([clip], [inst])
        score = song_to_score(song)
        notes = list(score.parts[0].flatten().notes)
        assert len(notes) == 2
        assert float(notes[0].quarterLength) == pytest.approx(1.0)
        assert float(notes[1].quarterLength) == pytest.approx(2.0)


class TestClipTruncation:
    def test_notes_beyond_instance_length_excluded(self):
        clip = Clip(
            index=0,
            instrument_slot=0,
            instrument_sub_slot=-1,
            length=384,
            rows=[
                NoteRow(
                    y=60,
                    notes=[
                        Note(0, 48, 80, 20),
                        Note(96, 48, 80, 20),
                        Note(192, 48, 80, 20),
                    ],
                )
            ],
        )
        inst = Instrument(
            name="Synth",
            slot=0,
            sub_slot=-1,
            clip_instances=[ClipInstance(position=0, length=144, clip_index=0)],
        )
        song = _make_song([clip], [inst])
        score = song_to_score(song)
        notes = list(score.parts[0].flatten().notes)
        assert len(notes) == 2
