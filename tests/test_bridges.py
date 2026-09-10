from __future__ import annotations

import json
from pathlib import Path

import mido
import pytest

from deluge_tools.bridges import (
    analyze_stats_json,
    convert_midi_to_deluge_xml,
    convert_to_musicxml,
    inspect_song_json,
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


class TestConvertToMusicxml:
    def test_returns_musicxml_string(self, song_xml: str) -> None:
        result = convert_to_musicxml(song_xml)
        assert "<?xml" in result
        assert "score-partwise" in result


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
