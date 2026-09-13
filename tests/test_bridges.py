from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from deluge_tools.analyzer import SongStats
from deluge_tools.bridges import (
    analyze_stats_json,
    convert_midi_to_deluge_xml,
    convert_to_musicxml,
    inspect_song_json,
)
from deluge_tools.parser import (
    TICKS_PER_QUARTER,
    Clip,
    ClipInstance,
    ClipSoundParams,
    EnvelopePatch,
    Instrument,
    ModulatorPatch,
    Note,
    NoteRow,
    OscPatch,
    PatchCable,
    Song,
    SoundPatch,
)

SAMPLE_SONG = Path(__file__).parent / "fixtures" / "square_spelunking.XML"

SESSION_ONLY_XML = """<?xml version="1.0" encoding="UTF-8"?>
<song firmwareVersion="4.0.0" timePerTimerTick="917" timerTickFraction="3006477107"
      rootNote="0" inArrangementView="0">
  <modeNotes><modeNote>0</modeNote><modeNote>2</modeNote><modeNote>4</modeNote>
  <modeNote>5</modeNote><modeNote>7</modeNote><modeNote>9</modeNote><modeNote>11</modeNote></modeNotes>
  <instruments>
    <sound presetSlot="0" presetSubSlot="-1" />
  </instruments>
  <sessionClips>
    <instrumentClip instrumentPresetSlot="0" instrumentPresetSubSlot="-1" length="768">
      <noteRows>
        <noteRow y="60" noteData="0x00000000000000604014" />
      </noteRows>
    </instrumentClip>
  </sessionClips>
</song>"""

AUDIO_CLIP_XML = """<?xml version="1.0" encoding="UTF-8"?>
<song firmwareVersion="4.0.0" timePerTimerTick="917" timerTickFraction="3006477107"
      rootNote="0" inArrangementView="1">
  <modeNotes><modeNote>0</modeNote><modeNote>2</modeNote><modeNote>4</modeNote>
  <modeNote>5</modeNote><modeNote>7</modeNote><modeNote>9</modeNote><modeNote>11</modeNote></modeNotes>
  <instruments>
    <sound presetSlot="0" presetSubSlot="-1" />
    <audioOutput clipInstances="0x00000C000000030000000000" />
  </instruments>
  <sessionClips>
    <audioClip length="1152" filePath="SAMPLES/vocals.wav" />
  </sessionClips>
</song>"""


@pytest.fixture
def song_xml() -> str:
    return SAMPLE_SONG.read_text()


@pytest.fixture
def mock_song() -> Song:
    note = Note(position=0, length=12, velocity=80, lift_velocity=5)
    row = NoteRow(y=60, drum_index=None, drum_name=None, sample_path=None, notes=[note])
    clip = Clip(
        index=0,
        instrument_slot=0,
        instrument_sub_slot=-1,
        is_kit=False,
        length=768,
        rows=[row],
    )

    osc1 = OscPatch(type="square", transpose=0, cents=0)
    osc2 = OscPatch(type="square", transpose=0, cents=0)
    sound = SoundPatch(
        mode="subtractive",
        polyphonic="poly",
        lpf_mode="24dB",
        osc1=osc1,
        osc2=osc2,
        lfo1_type="sine",
        lfo2_type="sine",
        modulator1=None,
        modulator2=None,
    )

    instrument = Instrument(
        slot=0,
        sub_slot=-1,
        name="Synth",
        instrument_type="synth",
        is_kit=False,
        midi_channel=-1,
        cv_channel=-1,
        sound=sound,
        clip_instances=[],
    )

    return Song(
        bpm=120.0,
        root_note=0,
        mode_notes=[0, 2, 4, 5, 7, 9, 11],
        firmware_version="4.0.0",
        instruments=[instrument],
        clips=[clip],
        audio_clips=[],
    )


@pytest.fixture
def mock_song_stats() -> SongStats:
    return SongStats(
        bpm=120.0,
        key="C Major",
        has_arrangement=False,
        instrument_count=1,
        synth_count=1,
        kit_count=0,
        midi_count=0,
        cv_count=0,
        audio_count=0,
        clip_count=1,
        total_notes=1,
        arrangement_length_ticks=0,
        duration_str="0:12",
        firmware_version="4.0.0",
    )


class TestAnalyzeStatsJson:
    def test_single_file(self, song_xml: str) -> None:
        files_json = json.dumps([{"name": "SONG001.XML", "content": song_xml}])
        results = json.loads(analyze_stats_json(files_json))
        assert len(results) == 1
        r = results[0]
        assert r["filename"] == "SONG001.XML"
        assert r["bpm"] > 0
        assert isinstance(r["key"], str)
        assert isinstance(r["instrumentCount"], int)
        assert r["instrumentCount"] > 0

    def test_invalid_xml_returns_error(self) -> None:
        files_json = json.dumps([{"name": "BAD.XML", "content": "not xml at all<<<"}])
        results = json.loads(analyze_stats_json(files_json))
        assert len(results) == 1
        assert results[0]["key"].startswith("Error:")
        assert results[0]["bpm"] == 0

    def test_multiple_files(self, song_xml: str) -> None:
        files_json = json.dumps(
            [
                {"name": "A.XML", "content": song_xml},
                {"name": "B.XML", "content": song_xml},
            ]
        )
        results = json.loads(analyze_stats_json(files_json))
        assert len(results) == 2
        assert results[0]["filename"] == "A.XML"
        assert results[1]["filename"] == "B.XML"

    def test_empty_list(self) -> None:
        results = json.loads(analyze_stats_json("[]"))
        assert results == []

    @patch("deluge_tools.bridges.parse_song_xml")
    @patch("deluge_tools.bridges.analyze_song")
    def test_mocked_single_file(
        self,
        mock_analyze: Mock,
        mock_parse: Mock,
        mock_song: Song,
        mock_song_stats: SongStats,
    ) -> None:
        mock_parse.return_value = mock_song
        mock_analyze.return_value = mock_song_stats

        files_json = json.dumps([{"name": "test.XML", "content": "<song></song>"}])
        results = json.loads(analyze_stats_json(files_json))

        assert len(results) == 1
        assert results[0]["filename"] == "test.XML"
        assert results[0]["bpm"] == 120.0
        assert results[0]["key"] == "C Major"
        assert results[0]["instrumentCount"] == 1
        assert results[0]["synthCount"] == 1

    @patch("deluge_tools.bridges.parse_song_xml")
    def test_parse_exception_captured(self, mock_parse: Mock) -> None:
        mock_parse.side_effect = ValueError("Bad XML")

        files_json = json.dumps([{"name": "broken.XML", "content": "<song></song>"}])
        results = json.loads(analyze_stats_json(files_json))

        assert len(results) == 1
        assert results[0]["key"].startswith("Error:")
        assert "Bad XML" in results[0]["key"]
        assert results[0]["bpm"] == 0
        assert results[0]["instrumentCount"] == 0

    @patch("deluge_tools.bridges.analyze_song")
    @patch("deluge_tools.bridges.parse_song_xml")
    def test_all_stat_fields_populated(
        self,
        mock_parse: Mock,
        mock_analyze: Mock,
        mock_song: Song,
    ) -> None:
        stats = SongStats(
            bpm=140.0,
            key="D Minor",
            has_arrangement=True,
            instrument_count=3,
            synth_count=2,
            kit_count=1,
            midi_count=0,
            cv_count=0,
            audio_count=0,
            clip_count=5,
            total_notes=42,
            arrangement_length_ticks=4800,
            duration_str="1:30",
            firmware_version="4.0.0",
        )
        mock_parse.return_value = mock_song
        mock_analyze.return_value = stats

        files_json = json.dumps([{"name": "complex.XML", "content": "<song></song>"}])
        results = json.loads(analyze_stats_json(files_json))
        r = results[0]

        assert r["bpm"] == 140.0
        assert r["key"] == "D Minor"
        assert r["hasArrangement"] is True
        assert r["instrumentCount"] == 3
        assert r["synthCount"] == 2
        assert r["kitCount"] == 1
        assert r["clipCount"] == 5
        assert r["totalNotes"] == 42
        assert r["durationStr"] == "1:30"
        assert r["firmwareVersion"] == "4.0.0"

    def test_invalid_xml_firmware_version_empty(self) -> None:
        files_json = json.dumps([{"name": "BAD.XML", "content": "not xml at all<<<"}])
        results = json.loads(analyze_stats_json(files_json))
        assert results[0]["firmwareVersion"] == ""

    @pytest.mark.parametrize(
        "bpm,expected_dur",
        [
            (120.0, "1:00"),
            (0, "-"),
            (240.0, "0:30"),
        ],
    )
    @patch("deluge_tools.bridges.analyze_song")
    @patch("deluge_tools.bridges.parse_song_xml")
    def test_duration_handling_no_arrangement(
        self,
        mock_parse: Mock,
        mock_analyze: Mock,
        bpm: float,
        expected_dur: str,
        mock_song: Song,
    ) -> None:
        stats = SongStats(
            bpm=bpm,
            key="C Major",
            has_arrangement=True,
            instrument_count=1,
            synth_count=1,
            kit_count=0,
            midi_count=0,
            cv_count=0,
            audio_count=0,
            clip_count=1,
            total_notes=0,
            arrangement_length_ticks=0,
            duration_str=expected_dur,
        )
        mock_parse.return_value = mock_song
        mock_analyze.return_value = stats

        files_json = json.dumps([{"name": "test.XML", "content": "<song></song>"}])
        results = json.loads(analyze_stats_json(files_json))

        assert results[0]["durationStr"] == expected_dur


class TestInspectSongJson:
    def test_returns_valid_preview_data(self, song_xml: str) -> None:
        result = json.loads(inspect_song_json(song_xml))
        assert result["bpm"] > 0
        assert result["ticksPerQuarter"] == 48
        assert isinstance(result["tracks"], list)
        assert result["trackCount"] == len(result["tracks"])
        assert isinstance(result["hasArrangement"], bool)

    def test_tracks_have_required_fields(self, song_xml: str) -> None:
        result = json.loads(inspect_song_json(song_xml))
        for track in result["tracks"]:
            assert "name" in track
            assert "isKit" in track
            assert "instrumentType" in track
            assert "clips" in track
            assert len(track["clips"]) > 0
            for clip in track["clips"]:
                assert "positionTicks" in clip
                assert "lengthTicks" in clip
                assert "noteRows" in clip

    @patch("deluge_tools.bridges.analyze_song")
    @patch("deluge_tools.bridges.parse_song_xml")
    def test_mocked_inspect_basic(
        self,
        mock_parse: Mock,
        mock_analyze: Mock,
        mock_song: Song,
        mock_song_stats: SongStats,
    ) -> None:
        mock_parse.return_value = mock_song
        mock_analyze.return_value = mock_song_stats

        result = json.loads(inspect_song_json("<song></song>"))

        assert result["bpm"] == 120.0
        assert result["key"] == "C Major"
        assert result["ticksPerQuarter"] == TICKS_PER_QUARTER
        assert result["hasArrangement"] is False
        assert result["trackCount"] == 1

    @patch("deluge_tools.bridges.analyze_song")
    @patch("deluge_tools.bridges.parse_song_xml")
    def test_clip_note_counts(
        self,
        mock_parse: Mock,
        mock_analyze: Mock,
        mock_song: Song,
        mock_song_stats: SongStats,
    ) -> None:
        note1 = Note(position=0, length=12, velocity=80, lift_velocity=5)
        note2 = Note(position=12, length=12, velocity=100, lift_velocity=5)
        row = NoteRow(y=60, notes=[note1, note2])
        mock_song.clips[0].rows = [row]
        mock_song_stats.total_notes = 2

        mock_parse.return_value = mock_song
        mock_analyze.return_value = mock_song_stats

        result = json.loads(inspect_song_json("<song></song>"))

        assert result["totalNotes"] == 2
        assert len(result["tracks"][0]["clips"]) > 0
        assert result["tracks"][0]["clips"][0]["noteCount"] == 2

    @patch("deluge_tools.bridges.analyze_song")
    @patch("deluge_tools.bridges.parse_song_xml")
    def test_arrangement_view_track_filtering(
        self,
        mock_parse: Mock,
        mock_analyze: Mock,
        mock_song: Song,
        mock_song_stats: SongStats,
    ) -> None:
        mock_song_stats.has_arrangement = True

        inst_with_clips = Instrument(
            slot=0,
            sub_slot=-1,
            name="Active",
            instrument_type="synth",
            is_kit=False,
            midi_channel=-1,
            cv_channel=-1,
            sound=None,
            clip_instances=[ClipInstance(position=0, length=768, clip_index=0)],
        )
        inst_without_clips = Instrument(
            slot=1,
            sub_slot=-1,
            name="Inactive",
            instrument_type="synth",
            is_kit=False,
            midi_channel=-1,
            cv_channel=-1,
            sound=None,
            clip_instances=[],
        )
        mock_song.instruments = [inst_with_clips, inst_without_clips]

        mock_parse.return_value = mock_song
        mock_analyze.return_value = mock_song_stats

        result = json.loads(inspect_song_json("<song></song>"))

        assert result["trackCount"] == 1
        assert result["tracks"][0]["name"] == "Active"

    @patch("deluge_tools.bridges.analyze_song")
    @patch("deluge_tools.bridges.parse_song_xml")
    def test_session_view_no_clip_instances(
        self,
        mock_parse: Mock,
        mock_analyze: Mock,
        mock_song: Song,
        mock_song_stats: SongStats,
    ) -> None:
        mock_song_stats.has_arrangement = False

        inst = Instrument(
            slot=0,
            sub_slot=-1,
            name="Session",
            instrument_type="synth",
            is_kit=False,
            midi_channel=-1,
            cv_channel=-1,
            sound=None,
            clip_instances=[],
        )
        mock_song.instruments = [inst]

        mock_parse.return_value = mock_song
        mock_analyze.return_value = mock_song_stats

        result = json.loads(inspect_song_json("<song></song>"))

        assert result["hasArrangement"] is False
        assert result["trackCount"] >= 0

    @patch("deluge_tools.bridges.analyze_song")
    @patch("deluge_tools.bridges.parse_song_xml")
    def test_audio_clip_file_path_in_name(
        self,
        mock_parse: Mock,
        mock_analyze: Mock,
        mock_song: Song,
        mock_song_stats: SongStats,
    ) -> None:
        from deluge_tools.parser import AudioClip

        audio_clip = AudioClip(index=0, file_path="SAMPLES/drums.wav")
        mock_song.audio_clips = [audio_clip]

        inst = Instrument(
            slot=0,
            sub_slot=-1,
            name="Audio",
            instrument_type="audio",
            is_kit=False,
            midi_channel=-1,
            cv_channel=-1,
            sound=None,
            clip_instances=[ClipInstance(position=0, length=768, clip_index=0)],
        )
        mock_song.instruments = [inst]
        mock_song_stats.has_arrangement = True

        mock_parse.return_value = mock_song
        mock_analyze.return_value = mock_song_stats

        result = json.loads(inspect_song_json("<song></song>"))

        assert result["trackCount"] == 1
        assert "drums.wav" in result["tracks"][0]["name"]

    @patch("deluge_tools.bridges.analyze_song")
    @patch("deluge_tools.bridges.parse_song_xml")
    def test_note_row_details_captured(
        self,
        mock_parse: Mock,
        mock_analyze: Mock,
        mock_song: Song,
        mock_song_stats: SongStats,
    ) -> None:
        note = Note(position=100, length=48, velocity=127, lift_velocity=10)
        row = NoteRow(y=60, drum_name="Kick", sample_path="kicks/deep.wav", notes=[note])
        mock_song.clips[0].rows = [row]

        mock_parse.return_value = mock_song
        mock_analyze.return_value = mock_song_stats

        result = json.loads(inspect_song_json("<song></song>"))

        note_rows = result["tracks"][0]["clips"][0]["noteRows"]
        assert len(note_rows) == 1
        assert note_rows[0]["y"] == 60
        assert note_rows[0]["drumName"] == "Kick"
        assert note_rows[0]["samplePath"] == "kicks/deep.wav"
        assert len(note_rows[0]["notes"]) == 1
        assert note_rows[0]["notes"][0]["pos"] == 100
        assert note_rows[0]["notes"][0]["len"] == 48
        assert note_rows[0]["notes"][0]["vel"] == 127

    @patch("deluge_tools.bridges.analyze_song")
    @patch("deluge_tools.bridges.parse_song_xml")
    def test_session_view_duration_calculation(
        self,
        mock_parse: Mock,
        mock_analyze: Mock,
        mock_song: Song,
        mock_song_stats: SongStats,
    ) -> None:
        clip2 = Clip(
            index=1,
            instrument_slot=0,
            instrument_sub_slot=-1,
            is_kit=False,
            length=2000,
        )
        mock_song.clips.append(clip2)
        mock_song_stats.has_arrangement = False
        mock_song_stats.bpm = 120.0

        mock_parse.return_value = mock_song
        mock_analyze.return_value = mock_song_stats

        result = json.loads(inspect_song_json("<song></song>"))

        assert result["hasArrangement"] is False
        assert result["durationTicks"] == 2000

    @patch("deluge_tools.bridges.analyze_song")
    @patch("deluge_tools.bridges.parse_song_xml")
    def test_arrangement_view_uses_stats_duration(
        self,
        mock_parse: Mock,
        mock_analyze: Mock,
        mock_song: Song,
        mock_song_stats: SongStats,
    ) -> None:
        mock_song_stats.has_arrangement = True
        mock_song_stats.arrangement_length_ticks = 5000
        mock_song_stats.duration_str = "2:05"

        inst = Instrument(
            slot=0,
            sub_slot=-1,
            name="Test",
            instrument_type="synth",
            is_kit=False,
            midi_channel=-1,
            cv_channel=-1,
            sound=None,
            clip_instances=[ClipInstance(position=0, length=5000, clip_index=0)],
        )
        mock_song.instruments = [inst]

        mock_parse.return_value = mock_song
        mock_analyze.return_value = mock_song_stats

        result = json.loads(inspect_song_json("<song></song>"))

        assert result["hasArrangement"] is True
        assert result["durationTicks"] == 5000
        assert result["durationStr"] == "2:05"


class TestBuildPatch:
    @patch("deluge_tools.bridges.analyze_song")
    @patch("deluge_tools.bridges.parse_song_xml")
    def test_patch_with_sound_params(
        self,
        mock_parse: Mock,
        mock_analyze: Mock,
        mock_song: Song,
        mock_song_stats: SongStats,
    ) -> None:
        cable = PatchCable(source="osc1", destination="filter", amount="0x7FFFFFFF")
        sound_params = ClipSoundParams(
            params={"filterCutoff": "0x80000000"},
            envelope1=EnvelopePatch(
                attack="0x10000000",
                decay="0x20000000",
                sustain="0x30000000",
                release="0x40000000",
            ),
            envelope2=EnvelopePatch(),
            patch_cables=[cable],
        )
        mock_song.clips[0].sound_params = sound_params

        mock_parse.return_value = mock_song
        mock_analyze.return_value = mock_song_stats

        result = json.loads(inspect_song_json("<song></song>"))

        patch = result["tracks"][0]["patch"]
        assert patch is not None
        assert patch["mode"] == "subtractive"
        assert patch["polyphonic"] == "poly"
        assert patch["lpfMode"] == "24dB"
        assert patch["params"]["filterCutoff"] == "0x80000000"
        assert len(patch["patchCables"]) == 1
        assert patch["patchCables"][0]["source"] == "osc1"

    @patch("deluge_tools.bridges.analyze_song")
    @patch("deluge_tools.bridges.parse_song_xml")
    def test_patch_with_modulators(
        self,
        mock_parse: Mock,
        mock_analyze: Mock,
        mock_song: Song,
        mock_song_stats: SongStats,
    ) -> None:
        sound_params = ClipSoundParams()
        mock_song.clips[0].sound_params = sound_params

        mod1 = ModulatorPatch(transpose=2, cents=50, to_modulator1=False)
        mod2 = ModulatorPatch(transpose=-1, cents=100, to_modulator1=True)
        mock_song.instruments[0].sound.modulator1 = mod1
        mock_song.instruments[0].sound.modulator2 = mod2

        mock_parse.return_value = mock_song
        mock_analyze.return_value = mock_song_stats

        result = json.loads(inspect_song_json("<song></song>"))

        patch = result["tracks"][0]["patch"]
        assert patch["modulator1"]["transpose"] == 2
        assert patch["modulator1"]["cents"] == 50
        assert patch["modulator2"]["toModulator1"] is True

    @patch("deluge_tools.bridges.analyze_song")
    @patch("deluge_tools.bridges.parse_song_xml")
    def test_no_patch_when_sound_is_none(
        self,
        mock_parse: Mock,
        mock_analyze: Mock,
        mock_song: Song,
        mock_song_stats: SongStats,
    ) -> None:
        mock_song.instruments[0].sound = None

        mock_parse.return_value = mock_song
        mock_analyze.return_value = mock_song_stats

        result = json.loads(inspect_song_json("<song></song>"))

        patch = result["tracks"][0]["patch"]
        assert patch is None

    @patch("deluge_tools.bridges.analyze_song")
    @patch("deluge_tools.bridges.parse_song_xml")
    def test_no_patch_when_no_sound_params(
        self,
        mock_parse: Mock,
        mock_analyze: Mock,
        mock_song: Song,
        mock_song_stats: SongStats,
    ) -> None:
        mock_song.clips[0].sound_params = None

        mock_parse.return_value = mock_song
        mock_analyze.return_value = mock_song_stats

        result = json.loads(inspect_song_json("<song></song>"))

        patch = result["tracks"][0]["patch"]
        assert patch is None


class TestConvertToMusicxml:
    def test_returns_musicxml_string(self, song_xml: str) -> None:
        result = convert_to_musicxml(song_xml)
        assert "<?xml" in result
        assert "score-partwise" in result

    @patch("deluge_tools.converter.song_to_musicxml")
    @patch("deluge_tools.bridges.parse_song_xml")
    def test_mocked_musicxml_conversion(
        self,
        mock_parse: Mock,
        mock_musicxml: Mock,
        mock_song: Song,
    ) -> None:
        expected_musicxml = '<?xml version="1.0"?><score-partwise></score-partwise>'
        mock_parse.return_value = mock_song
        mock_musicxml.return_value = expected_musicxml

        result = convert_to_musicxml("<song></song>")

        assert result == expected_musicxml
        mock_parse.assert_called_once()
        mock_musicxml.assert_called_once_with(mock_song)

    @patch("deluge_tools.bridges.parse_song_xml")
    def test_parse_exception_propagates(
        self,
        mock_parse: Mock,
    ) -> None:
        mock_parse.side_effect = ValueError("Invalid XML")

        with pytest.raises(ValueError, match="Invalid XML"):
            convert_to_musicxml("<invalid>")

    @patch("deluge_tools.converter.song_to_musicxml")
    @patch("deluge_tools.bridges.parse_song_xml")
    def test_musicxml_conversion_exception_propagates(
        self,
        mock_parse: Mock,
        mock_musicxml: Mock,
        mock_song: Song,
    ) -> None:
        mock_parse.return_value = mock_song
        mock_musicxml.side_effect = RuntimeError("Conversion failed")

        with pytest.raises(RuntimeError, match="Conversion failed"):
            convert_to_musicxml("<song></song>")


class TestInspectSongJsonSessionOnly:
    """Covers the no-arrangement (session-view) branches of inspect_song_json."""

    def test_has_arrangement_false(self) -> None:
        result = json.loads(inspect_song_json(SESSION_ONLY_XML))
        assert result["hasArrangement"] is False

    def test_clips_built_from_session_clips_not_instances(self) -> None:
        result = json.loads(inspect_song_json(SESSION_ONLY_XML))
        assert result["trackCount"] == 1
        clip = result["tracks"][0]["clips"][0]
        assert clip["positionTicks"] == 0
        assert clip["lengthTicks"] == 768

    def test_duration_derived_from_max_clip_length(self) -> None:
        result = json.loads(inspect_song_json(SESSION_ONLY_XML))
        assert result["durationTicks"] == 768
        assert result["durationStr"] != "-"

    def test_duration_dash_when_no_clips(self) -> None:
        xml = SESSION_ONLY_XML.replace(
            '<instrumentClip instrumentPresetSlot="0" instrumentPresetSubSlot="-1" length="768">'
            '\n      <noteRows>\n        <noteRow y="60" noteData="0x00000000000000604014" />'
            "\n      </noteRows>\n    </instrumentClip>",
            "",
        )
        result = json.loads(inspect_song_json(xml))
        assert result["trackCount"] == 0
        assert result["durationTicks"] == 0
        assert result["durationStr"] == "-"


class TestInspectSongJsonAudioClips:
    def test_audio_track_name_from_file_path(self) -> None:
        result = json.loads(inspect_song_json(AUDIO_CLIP_XML))
        names = [t["name"] for t in result["tracks"]]
        assert "vocals.wav" in names

    def test_instrument_without_clip_instances_dropped_in_arrangement(self) -> None:
        result = json.loads(inspect_song_json(AUDIO_CLIP_XML))
        assert result["trackCount"] == 1


class TestConvertMidiToDelugeXml:
    def test_produces_valid_deluge_xml(self, tmp_path: Path) -> None:
        mido = pytest.importorskip("mido")
        mid = mido.MidiFile(ticks_per_beat=480)
        track = mido.MidiTrack()
        mid.tracks.append(track)
        track.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(120.0)))
        track.append(mido.Message("note_on", note=60, velocity=100, time=0))
        track.append(mido.Message("note_off", note=60, velocity=0, time=480))
        track.append(mido.MetaMessage("end_of_track"))
        midi_path = tmp_path / "test.mid"
        mid.save(midi_path)

        result = convert_midi_to_deluge_xml(midi_path.read_bytes())

        assert "<?xml" in result
        assert "<song" in result

    @patch("deluge_tools.midi_to_deluge.midi_to_deluge_xml")
    def test_mocked_midi_conversion(self, mock_midi: Mock) -> None:
        expected_xml = '<?xml version="1.0"?><song></song>'
        mock_midi.return_value = None

        midi_bytes = b"fake midi"

        def write_xml(midi_path: str, out_path: str) -> None:
            with open(out_path, "w") as f:
                f.write(expected_xml)

        mock_midi.side_effect = write_xml

        result = convert_midi_to_deluge_xml(midi_bytes)

        assert expected_xml in result

    @patch("deluge_tools.midi_to_deluge.midi_to_deluge_xml")
    def test_midi_conversion_error_propagates(self, mock_midi: Mock) -> None:
        mock_midi.side_effect = Exception("MIDI parsing failed")

        with pytest.raises(Exception, match="MIDI parsing failed"):
            convert_midi_to_deluge_xml(b"bad midi")

    def test_midi_conversion_with_multiple_notes(self, tmp_path: Path) -> None:
        mido = pytest.importorskip("mido")
        mid = mido.MidiFile(ticks_per_beat=480)
        track = mido.MidiTrack()
        mid.tracks.append(track)
        track.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(100.0)))
        for note_val in [60, 62, 64]:
            track.append(mido.Message("note_on", note=note_val, velocity=90, time=0))
            track.append(mido.Message("note_off", note=note_val, velocity=0, time=240))
        track.append(mido.MetaMessage("end_of_track"))
        midi_path = tmp_path / "multi.mid"
        mid.save(midi_path)

        result = convert_midi_to_deluge_xml(midi_path.read_bytes())

        assert "<?xml" in result
        assert "<song" in result
