from __future__ import annotations

import json
from pathlib import Path

import pytest

from deluge_tools.bridges import (
    analyze_stats_json,
    convert_to_musicxml,
    inspect_song_json,
)

SAMPLE_SONG = Path(__file__).parent / "fixtures" / "square_spelunking.XML"


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
