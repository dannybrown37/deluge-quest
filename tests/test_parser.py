from pathlib import Path

import pytest

from deluge_tools.parser import Note, parse_clip_instances, parse_note_data, parse_song

SAMPLE_SONG = Path(__file__).parent.parent / "Square Spelunking.XML"


class TestParseNoteData:
    @pytest.mark.parametrize(
        "hex_data, expected",
        [
            (
                "0x00000240000000C04014",
                [Note(position=576, length=192, velocity=64, lift_velocity=20)],
            ),
            (
                "0x00000000000000604014000000C0000000C0401400000180000000604014",
                [
                    Note(position=0, length=96, velocity=64, lift_velocity=20),
                    Note(position=192, length=192, velocity=64, lift_velocity=20),
                    Note(position=384, length=96, velocity=64, lift_velocity=20),
                ],
            ),
            (
                "0x00000040000000104088",
                [Note(position=64, length=16, velocity=64, lift_velocity=136)],
            ),
        ],
        ids=["single-note", "three-notes", "drum-hit"],
    )
    def test_decode(self, hex_data: str, expected: list[Note]):
        assert parse_note_data(hex_data) == expected

    def test_empty(self):
        assert parse_note_data("") == []
        assert parse_note_data(None) == []


class TestParseClipInstances:
    def test_decode(self):
        instances = parse_clip_instances("0x0000210000000A8000000000")
        assert len(instances) == 1
        assert instances[0].position == 0x2100
        assert instances[0].length == 0xA80
        assert instances[0].clip_index == 0

    def test_multiple(self):
        instances = parse_clip_instances(
            "0x00000C00000003000000000B00001800000003000000000600001B0000000300000000060000210000000300000000010000240000000300000000010000270000000300000000010000"
        )
        assert len(instances) == 6
        assert instances[0].clip_index == 11
        assert instances[3].clip_index == 1


class TestParseSong:
    @pytest.fixture
    def song(self):
        return parse_song(SAMPLE_SONG)

    def test_loads_metadata(self, song):
        assert song.root_note == -5
        assert song.mode_notes == [0, 2, 3, 5, 7, 8, 10, 11]
        assert song.firmware_version == "3.0.0"

    def test_finds_instruments(self, song):
        assert len(song.instruments) > 0

    def test_finds_clips(self, song):
        assert len(song.clips) > 0

    def test_arrangement_view(self, song):
        assert song.in_arrangement_view is True

    def test_kit_instrument(self, song):
        kits = [i for i in song.instruments if i.is_kit]
        assert len(kits) >= 1
        assert kits[0].drum_names

    def test_clip_instances_parsed(self, song):
        for inst in song.instruments:
            if inst.clip_instances:
                for ci in inst.clip_instances:
                    assert ci.position >= 0
                    assert ci.length > 0
                    assert ci.clip_index >= 0

    def test_clips_have_separate_rows(self, song):
        synth_clips = [c for c in song.clips if not c.is_kit and c.instrument_slot == 135]
        assert len(synth_clips) == 3

    def test_note_data_decoded(self, song):
        all_notes = [
            note
            for clip in song.clips
            for row in clip.rows
            for note in row.notes
        ]
        assert len(all_notes) > 0
        for note in all_notes:
            assert note.position >= 0
            assert note.length > 0
            assert 0 <= note.velocity <= 127

    def test_bpm_reasonable(self, song):
        assert 20 < song.bpm < 300

    def test_instrument_type_synth(self, song):
        synths = [i for i in song.instruments if i.instrument_type == "synth"]
        assert len(synths) >= 1

    def test_instrument_type_kit(self, song):
        kits = [i for i in song.instruments if i.instrument_type == "kit"]
        assert len(kits) >= 1


class TestInstrumentTypes:
    @pytest.fixture
    def song_with_all_types(self, tmp_path):
        xml = """<?xml version="1.0" encoding="UTF-8"?>
<song firmwareVersion="4.0.0" timePerTimerTick="917" timerTickFraction="3006477107"
      rootNote="0" inArrangementView="1">
  <modeNotes><modeNote>0</modeNote><modeNote>2</modeNote><modeNote>4</modeNote>
  <modeNote>5</modeNote><modeNote>7</modeNote><modeNote>9</modeNote><modeNote>11</modeNote></modeNotes>
  <instruments>
    <sound presetSlot="0" presetSubSlot="-1" />
    <kit presetSlot="1" presetSubSlot="-1">
      <soundSources><sound name="kick"/></soundSources>
    </kit>
    <midiChannel presetSlot="2" presetSubSlot="-1" channel="0" />
    <cv presetSlot="3" presetSubSlot="-1" channel="0" />
  </instruments>
  <sessionClips></sessionClips>
</song>"""
        p = tmp_path / "test.XML"
        p.write_text(xml)
        return parse_song(p)

    @pytest.mark.parametrize(
        "expected_type,expected_count",
        [("synth", 1), ("kit", 1), ("midi", 1), ("cv", 1)],
        ids=["synth", "kit", "midi", "cv"],
    )
    def test_all_types_detected(self, song_with_all_types, expected_type, expected_count):
        matched = [i for i in song_with_all_types.instruments if i.instrument_type == expected_type]
        assert len(matched) == expected_count

    def test_midi_channel_stored(self, song_with_all_types):
        midi = [i for i in song_with_all_types.instruments if i.instrument_type == "midi"][0]
        assert midi.midi_channel == 0

    def test_cv_channel_stored(self, song_with_all_types):
        cv = [i for i in song_with_all_types.instruments if i.instrument_type == "cv"][0]
        assert cv.cv_channel == 0
