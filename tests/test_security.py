"""Security regression tests — adversarial review findings."""

from __future__ import annotations

import json

import pytest

from deluge_tools.bridges import (
    analyze_stats_json,
    convert_to_musicxml,
    inspect_song_json,
)
from deluge_tools.cli_backup import _remote_url_to_web


class TestBridgeRobustness:
    """Bridge functions called from Pyodide must not raise unhandled exceptions.

    An unhandled exception in the Pyodide runtime crashes the user's browser tab.
    Each bridge should return a structured error JSON, not propagate a raw exception.
    """

    def test_inspect_song_invalid_xml_returns_error(self) -> None:
        result = json.loads(inspect_song_json("not xml at all"))
        assert "error" in result, "inspect_song_json should return {error: ...} for invalid XML"

    def test_inspect_song_malformed_hex_returns_error(self) -> None:
        xml = """<song firmwareVersion="3.0.0" rootNote="0" timePerTimerTick="229">
        <modeNotes><modeNote>0</modeNote></modeNotes>
        <instruments>
            <sound presetSlot="0" presetSubSlot="-1" />
        </instruments>
        <sessionClips>
            <instrumentClip instrumentPresetSlot="0" instrumentPresetSubSlot="-1" length="192">
                <noteRows><noteRow y="60" noteData="0xGGGGGGGG"/></noteRows>
            </instrumentClip>
        </sessionClips></song>"""
        result = json.loads(inspect_song_json(xml))
        assert "error" in result, "inspect_song_json should return {error: ...} for malformed hex"

    def test_inspect_song_non_integer_attribute_returns_error(self) -> None:
        xml = """<song firmwareVersion="3.0.0" rootNote="not_a_number" timePerTimerTick="229">
        <modeNotes/><instruments/><sessionClips/></song>"""
        result = json.loads(inspect_song_json(xml))
        assert "error" in result, "inspect_song_json should return {error: ...} for bad attributes"

    def test_convert_to_musicxml_invalid_xml_returns_error(self) -> None:
        result = convert_to_musicxml("totally invalid xml")
        parsed = json.loads(result)
        assert "error" in parsed, "convert_to_musicxml should return {error: ...} for invalid XML"

    def test_analyze_stats_invalid_json_returns_empty(self) -> None:
        result = json.loads(analyze_stats_json("not json"))
        assert result == [], "analyze_stats_json should return [] for invalid JSON input"


class TestRemoteUrlSanitization:
    """_remote_url_to_web must strip characters dangerous to cmd.exe /c start.

    On WSL, _open_browser runs subprocess.run(["cmd.exe", "/c", "start", "", url]).
    A URL containing " breaks Python's argument quoting; & is then interpreted
    by cmd.exe as a command separator, enabling arbitrary command execution.
    """

    @pytest.mark.parametrize(
        "url",
        [
            'https://evil.com"&calc',
            'https://evil.com"&powershell -enc QWJj',
            "https://evil.com&calc",
            "https://evil.com|calc",
        ],
    )
    def test_dangerous_chars_stripped_or_rejected(self, url: str) -> None:
        result = _remote_url_to_web(url)
        dangerous = any(c in result for c in '"&|')
        assert not dangerous, (
            f"_remote_url_to_web passed through dangerous characters: {result!r}. "
            f"On WSL, this enables command injection via cmd.exe /c start."
        )
