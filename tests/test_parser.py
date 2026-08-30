from pathlib import Path

import pytest

from deluge_tools.parser import (
    Note,
    parse_clip_instances,
    parse_note_data,
    parse_note_data_with_lift,
    parse_song,
)

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


class TestParseNoteDataWithLift:
    @pytest.mark.parametrize(
        "hex_data, expected",
        [
            (
                "0x000000000000000C634014",
                [Note(position=0, length=12, velocity=99, lift_velocity=64)],
            ),
            (
                "0x000000000000000C634014000000300000000C634014",
                [
                    Note(position=0, length=12, velocity=99, lift_velocity=64),
                    Note(position=48, length=12, velocity=99, lift_velocity=64),
                ],
            ),
        ],
        ids=["single-note", "two-notes"],
    )
    def test_decode(self, hex_data: str, expected: list[Note]):
        assert parse_note_data_with_lift(hex_data) == expected

    def test_empty(self):
        assert parse_note_data_with_lift("") == []
        assert parse_note_data_with_lift(None) == []


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


class TestAudioClips:
    @pytest.fixture
    def song_with_audio(self, tmp_path):
        xml = """<?xml version="1.0" encoding="UTF-8"?>
<song firmwareVersion="4.0.0" timePerTimerTick="917" timerTickFraction="3006477107"
      rootNote="0" inArrangementView="1">
  <modeNotes><modeNote>0</modeNote><modeNote>2</modeNote><modeNote>4</modeNote>
  <modeNote>5</modeNote><modeNote>7</modeNote><modeNote>9</modeNote><modeNote>11</modeNote></modeNotes>
  <instruments>
    <sound presetSlot="0" presetSubSlot="-1" clipInstances="0x000000000000030000000000" />
    <audioOutput clipInstances="0x000000000000060000000001000006000000060000000002" />
    <audioOutput clipInstances="0x00000C000000030000000003" />
  </instruments>
  <sessionClips>
    <instrumentClip instrumentPresetSlot="0" instrumentPresetSubSlot="-1" length="768">
      <noteRows>
        <noteRow y="60" noteData="0x00000000000000604014" />
      </noteRows>
    </instrumentClip>
    <audioClip length="1152" filePath="SAMPLES/recording.wav" />
    <audioClip length="1152" filePath="SAMPLES/vocals.wav" />
    <audioClip length="576" filePath="SAMPLES/fx.wav" />
  </sessionClips>
</song>"""
        p = tmp_path / "test.XML"
        p.write_text(xml)
        return parse_song(p)

    def test_audio_clips_parsed(self, song_with_audio):
        assert len(song_with_audio.audio_clips) == 3

    def test_audio_clip_file_path(self, song_with_audio):
        paths = [c.file_path for c in song_with_audio.audio_clips]
        assert "SAMPLES/recording.wav" in paths
        assert "SAMPLES/vocals.wav" in paths
        assert "SAMPLES/fx.wav" in paths

    def test_audio_clip_length(self, song_with_audio):
        clip = next(c for c in song_with_audio.audio_clips if c.file_path == "SAMPLES/fx.wav")
        assert clip.length == 576

    def test_audio_clip_index(self, song_with_audio):
        indices = [c.index for c in song_with_audio.audio_clips]
        assert indices == [1, 2, 3]

    def test_audio_outputs_parsed(self, song_with_audio):
        audio_outputs = [i for i in song_with_audio.instruments if i.instrument_type == "audio"]
        assert len(audio_outputs) == 2

    def test_audio_output_clip_instances(self, song_with_audio):
        audio_outputs = [i for i in song_with_audio.instruments if i.instrument_type == "audio"]
        assert len(audio_outputs[0].clip_instances) == 2
        assert len(audio_outputs[1].clip_instances) == 1

    def test_audio_output_name(self, song_with_audio):
        audio_outputs = [i for i in song_with_audio.instruments if i.instrument_type == "audio"]
        assert audio_outputs[0].name == "Audio 1"
        assert audio_outputs[1].name == "Audio 2"


class TestNoteDataWithLift:
    @pytest.fixture
    def song_with_lift_notes(self, tmp_path):
        xml = """<?xml version="1.0" encoding="UTF-8"?>
<song firmwareVersion="4.0.0" timePerTimerTick="917" timerTickFraction="3006477107"
      rootNote="0" inArrangementView="1">
  <modeNotes><modeNote>0</modeNote><modeNote>2</modeNote><modeNote>4</modeNote>
  <modeNote>5</modeNote><modeNote>7</modeNote><modeNote>9</modeNote><modeNote>11</modeNote></modeNotes>
  <instruments>
    <sound presetSlot="0" presetSubSlot="-1" clipInstances="0x000000000000030000000000" />
  </instruments>
  <sessionClips>
    <instrumentClip instrumentPresetSlot="0" instrumentPresetSubSlot="-1" length="768">
      <noteRows>
        <noteRow y="60" noteDataWithLift="0x000000000000000C634014000000300000000C634014" />
      </noteRows>
    </instrumentClip>
  </sessionClips>
</song>"""
        p = tmp_path / "test.XML"
        p.write_text(xml)
        return parse_song(p)

    def test_notes_decoded_from_lift_format(self, song_with_lift_notes):
        clip = song_with_lift_notes.clips[0]
        assert sum(len(r.notes) for r in clip.rows) == 2

    def test_note_fields(self, song_with_lift_notes):
        clip = song_with_lift_notes.clips[0]
        note = clip.rows[0].notes[0]
        assert note.position == 0
        assert note.length == 12
        assert note.velocity == 99


class TestNamedPresetInstruments:
    @pytest.fixture
    def song_with_named_presets(self, tmp_path):
        xml = """<?xml version="1.0" encoding="UTF-8"?>
<song firmwareVersion="4.0.0" timePerTimerTick="917" timerTickFraction="3006477107"
      rootNote="0" inArrangementView="1">
  <modeNotes><modeNote>0</modeNote><modeNote>2</modeNote><modeNote>4</modeNote>
  <modeNote>5</modeNote><modeNote>7</modeNote><modeNote>9</modeNote><modeNote>11</modeNote></modeNotes>
  <instruments>
    <sound presetName="Alpha" presetFolder="SYNTHS/A" clipInstances="0x0000000000000A0000000000" />
    <sound presetName="Beta" presetFolder="SYNTHS/B" clipInstances="0x0000180000000A0000000001" />
  </instruments>
  <sessionClips>
    <instrumentClip instrumentPresetName="Alpha" instrumentPresetFolder="SYNTHS/A" length="768">
      <noteRows>
        <noteRow y="60" noteData="0x00000000000000604014" />
      </noteRows>
    </instrumentClip>
    <instrumentClip instrumentPresetName="Beta" instrumentPresetFolder="SYNTHS/B" length="768">
      <noteRows>
        <noteRow y="72" noteData="0x00000000000000404020000000C0000000404020" />
      </noteRows>
    </instrumentClip>
  </sessionClips>
</song>"""
        p = tmp_path / "test.XML"
        p.write_text(xml)
        return parse_song(p)

    def test_both_instruments_kept(self, song_with_named_presets):
        assert len(song_with_named_presets.instruments) == 2

    def test_instrument_names(self, song_with_named_presets):
        names = {i.name for i in song_with_named_presets.instruments}
        assert names == {"Alpha", "Beta"}

    def test_clips_matched_to_correct_instrument(self, song_with_named_presets):
        assert len(song_with_named_presets.clips) == 2
        alpha_clip = song_with_named_presets.clips[0]
        beta_clip = song_with_named_presets.clips[1]
        assert sum(len(r.notes) for r in alpha_clip.rows) == 1
        assert sum(len(r.notes) for r in beta_clip.rows) == 2

    def test_instruments_not_merged(self, song_with_named_presets):
        for inst in song_with_named_presets.instruments:
            assert len(inst.clip_instances) == 1


class TestMultipleMidiChannels:
    @pytest.fixture
    def song_with_multiple_midi(self, tmp_path):
        xml = """<?xml version="1.0" encoding="UTF-8"?>
<song firmwareVersion="4.0.0" timePerTimerTick="917" timerTickFraction="3006477107"
      rootNote="0" inArrangementView="1">
  <modeNotes><modeNote>0</modeNote><modeNote>2</modeNote><modeNote>4</modeNote>
  <modeNote>5</modeNote><modeNote>7</modeNote><modeNote>9</modeNote><modeNote>11</modeNote></modeNotes>
  <instruments>
    <midiChannel channel="5" clipInstances="0x000000000000030000000000" />
    <midiChannel channel="8" clipInstances="0x000000000000030000000001" />
  </instruments>
  <sessionClips>
    <instrumentClip length="768">
      <noteRows><noteRow y="1" noteData="0x00000000000000604014" /></noteRows>
    </instrumentClip>
    <instrumentClip length="768">
      <noteRows><noteRow y="2" noteData="0x00000000000000604014" /></noteRows>
    </instrumentClip>
  </sessionClips>
</song>"""
        p = tmp_path / "test.XML"
        p.write_text(xml)
        return parse_song(p)

    def test_both_channels_kept(self, song_with_multiple_midi):
        midis = [i for i in song_with_multiple_midi.instruments if i.instrument_type == "midi"]
        assert len(midis) == 2

    def test_channel_numbers_distinct(self, song_with_multiple_midi):
        channels = {i.midi_channel for i in song_with_multiple_midi.instruments}
        assert channels == {5, 8}

    def test_each_channel_keeps_own_clip_instances(self, song_with_multiple_midi):
        for inst in song_with_multiple_midi.instruments:
            assert len(inst.clip_instances) == 1

    def test_clips_not_dropped(self, song_with_multiple_midi):
        assert len(song_with_multiple_midi.clips) == 2
        assert sum(len(r.notes) for c in song_with_multiple_midi.clips for r in c.rows) == 2


class TestArrangementOnlyTracks:
    @pytest.fixture
    def song_with_arrangement_only(self, tmp_path):
        xml = """<?xml version="1.0" encoding="UTF-8"?>
<song firmwareVersion="4.0.0" timePerTimerTick="917" timerTickFraction="3006477107"
      rootNote="0" inArrangementView="1">
  <modeNotes><modeNote>0</modeNote><modeNote>2</modeNote><modeNote>4</modeNote>
  <modeNote>5</modeNote><modeNote>7</modeNote><modeNote>9</modeNote><modeNote>11</modeNote></modeNotes>
  <instruments>
    <kit presetName="808" presetFolder="KITS"
         clipInstances="0x000000000000030080000000000003000000030000000001" />
  </instruments>
  <sessionClips>
    <instrumentClip length="768">
      <noteRows><noteRow y="1" noteData="0x00000000000000604014" /></noteRows>
    </instrumentClip>
    <instrumentClip length="768">
      <noteRows><noteRow y="2" noteData="0x00000000000000604014" /></noteRows>
    </instrumentClip>
  </sessionClips>
  <arrangementOnlyTracks>
    <instrumentClip instrumentPresetName="808" instrumentPresetFolder="KITS" length="768">
      <noteRows>
        <noteRow y="3" noteData="0x00000000000000604014000000C0000000604014" />
      </noteRows>
    </instrumentClip>
  </arrangementOnlyTracks>
</song>"""
        p = tmp_path / "test.XML"
        p.write_text(xml)
        return parse_song(p)

    def test_arrangement_only_clip_added(self, song_with_arrangement_only):
        assert len(song_with_arrangement_only.clips) == 3

    def test_arrangement_only_clip_has_notes(self, song_with_arrangement_only):
        clip = song_with_arrangement_only.clips[2]
        assert sum(len(r.notes) for r in clip.rows) == 2

    def test_flagged_clip_index_resolves_to_arrangement_only_clip(self, song_with_arrangement_only):
        kit = song_with_arrangement_only.instruments[0]
        assert kit.clip_instances[0].clip_index == 2
        assert kit.clip_instances[1].clip_index == 1
