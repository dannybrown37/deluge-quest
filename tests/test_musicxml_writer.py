"""Tests for the custom MusicXML writer (song_to_musicxml), the path the
browser actually calls for the /score tool. song_to_score (music21) is a
separate CLI-only path covered by test_converter.py.
"""

import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from deluge_tools.converter import song_to_musicxml
from deluge_tools.musicxml_writer import (
    MusicXMLWriter,
    PartData,
    _add_tuplet_brackets,
    _build_note_seq,
    _dur_info,
    _split_rests,
    snap_duration,
)
from deluge_tools.parser import Clip, ClipInstance, Instrument, Note, NoteRow, Song, parse_song

SAMPLE_SONG = Path(__file__).parent / "fixtures" / "square_spelunking.XML"


def _findtext(elem: ET.Element, path: str) -> str:
    found = elem.find(path)
    assert found is not None, f"no element matched {path!r}"
    assert found.text is not None
    return found.text


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


# ---- snap_duration / _dur_info ----


@pytest.mark.parametrize(
    "ticks,expected",
    [
        (0, 4),
        (-5, 4),
        (48, 48),
        (47, 48),
        (50, 48),
        (200, 192),
    ],
)
def test_snap_duration(ticks, expected):
    assert snap_duration(ticks) == expected


@pytest.mark.parametrize(
    "ticks,expected_type,expected_dotted,expected_triplet",
    [
        (48, "quarter", False, False),
        (16, "eighth", False, True),
        (8, "16th", False, True),
        (36, "eighth", True, False),
        (192, "whole", False, False),
    ],
)
def test_dur_info(ticks, expected_type, expected_dotted, expected_triplet):
    assert _dur_info(ticks) == (expected_type, expected_dotted, expected_triplet)


def test_dur_info_snaps_unknown_ticks():
    assert _dur_info(50) == _dur_info(48)


# ---- _split_rests ----


@pytest.mark.parametrize(
    "ticks,triplet",
    [
        (48, False),
        (96, False),
        (192, False),
        (48, True),
        (96, True),
    ],
)
def test_split_rests_sums_to_input_on_clean_values(ticks, triplet):
    assert sum(_split_rests(ticks, triplet=triplet)) == ticks


# ---- _build_note_seq / _add_tuplet_brackets (triplet padding + merging) ----


def _evt(abs_pos, dur, pitches=(60,)):
    return (abs_pos, dur, list(pitches), 80, None, None, None)


def test_build_note_seq_pads_isolated_triplet_into_group_of_three():
    m_events = [(0, _evt(0, 16))]
    seq = _build_note_seq(m_events, measure_ticks=192)
    _add_tuplet_brackets(seq)

    non_forward = [s for s in seq if not s.get("forward")]
    assert len(non_forward) == 3
    assert non_forward[0]["dur"] == non_forward[1]["dur"] == non_forward[2]["dur"] == 16
    assert non_forward[1].get("rest") is True
    assert non_forward[2].get("rest") is True
    assert non_forward[0]["tuplet_start"] is True
    assert non_forward[2]["tuplet_stop"] is True


def test_build_note_seq_leaves_leading_and_trailing_forward_gaps():
    m_events = [(48, _evt(48, 48))]
    seq = _build_note_seq(m_events, measure_ticks=192)

    assert seq[0] == {"forward": 48}
    assert seq[1]["dur"] == 48
    assert seq[-1] == {"forward": 96}


def test_build_note_seq_full_triplet_run_untouched():
    m_events = [
        (0, _evt(0, 16)),
        (16, _evt(16, 16)),
        (32, _evt(32, 16)),
    ]
    seq = _build_note_seq(m_events, measure_ticks=192)
    _add_tuplet_brackets(seq)

    non_forward = [s for s in seq if not s.get("forward")]
    assert len(non_forward) == 3
    assert all(not s.get("rest") for s in non_forward)
    assert non_forward[0]["tuplet_start"] is True
    assert non_forward[2]["tuplet_stop"] is True


def test_build_note_seq_merges_triplet_island_at_measure_start():
    """An isolated triplet note with nothing before it (start of measure) can't
    be padded from a preceding note, so the merge logic must split the
    following straight note into tied triplet parts instead."""
    m_events = [(0, _evt(0, 16)), (16, _evt(16, 48))]
    seq = _build_note_seq(m_events, measure_ticks=192)

    assert any(item.get("tie_start") or item.get("tie_stop") for item in seq)
    assert len(seq) > 2


def test_build_note_seq_no_triplets_no_tuplet_markers():
    m_events = [(0, _evt(0, 48))]
    seq = _build_note_seq(m_events, measure_ticks=192)
    _add_tuplet_brackets(seq)

    non_forward = [s for s in seq if not s.get("forward")]
    assert all("tuplet_start" not in s and "tuplet_stop" not in s for s in non_forward)


# ---- PartData ----


def test_part_data_add_event_snaps_duration():
    part = PartData(name="Synth")
    part.add_event(0, 50, [60])
    assert part.events[0][1] == 48


# ---- MusicXMLWriter ----


def test_to_xml_well_formed_and_has_divisions():
    part = PartData(name="Synth")
    part.add_event(0, 48, [60])
    writer = MusicXMLWriter()
    writer.add_part(part)
    xml = writer.to_xml()

    root = ET.fromstring(xml)
    assert root.tag == "score-partwise"
    divisions = root.find(".//divisions")
    assert divisions is not None
    assert divisions.text == "48"


def test_to_xml_multiple_measures_for_long_events():
    part = PartData(name="Synth")
    part.add_event(0, 48, [60])
    part.add_event(200, 48, [64])
    writer = MusicXMLWriter()
    writer.add_part(part)
    xml = writer.to_xml()

    root = ET.fromstring(xml)
    measures = root.findall(".//part/measure")
    assert len(measures) == 2


def test_to_xml_empty_part_still_produces_one_measure():
    part = PartData(name="Synth")
    writer = MusicXMLWriter()
    writer.add_part(part)
    xml = writer.to_xml()

    root = ET.fromstring(xml)
    measures = root.findall(".//part/measure")
    assert len(measures) == 1


def test_to_xml_percussion_part_has_unpitched_channel():
    part = PartData(name="Kit", clef_sign="percussion", clef_line=2)
    part.add_event(0, 48, [60], notehead="x", lyric="Kick", stem="none")
    writer = MusicXMLWriter()
    writer.add_part(part)
    xml = writer.to_xml()

    root = ET.fromstring(xml)
    assert _findtext(root, ".//midi-unpitched") == "36"
    assert _findtext(root, ".//midi-channel") == "10"
    assert _findtext(root, ".//clef/sign") == "percussion"


def test_to_xml_key_signature_written_for_melodic_part():
    part = PartData(name="Synth", key_fifths=2, key_mode="major")
    part.add_event(0, 48, [60])
    writer = MusicXMLWriter()
    writer.add_part(part)
    xml = writer.to_xml()

    root = ET.fromstring(xml)
    assert _findtext(root, ".//key/fifths") == "2"
    assert _findtext(root, ".//key/mode") == "major"


# ---- song_to_musicxml integration ----


def test_song_to_musicxml_well_formed_from_real_fixture():
    song = parse_song(SAMPLE_SONG)
    xml = song_to_musicxml(song)
    root = ET.fromstring(xml)
    assert root.tag == "score-partwise"
    assert len(root.findall(".//part")) > 0


def test_song_to_musicxml_clip_catalog_fallback():
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
    root = ET.fromstring(xml)
    assert len(root.findall(".//part")) == 1
    assert len(root.findall(".//note")) == 1


def test_song_to_musicxml_kit_part_uses_percussion_clef():
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
    xml = song_to_musicxml(song)
    root = ET.fromstring(xml)
    assert _findtext(root, ".//clef/sign") == "percussion"
    assert _findtext(root, ".//note/notehead") == "x"
    assert _findtext(root, ".//note/lyric/text") == "Kick"


def test_song_to_musicxml_triplet_notes_get_time_modification():
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
    xml = song_to_musicxml(song)
    root = ET.fromstring(xml)

    time_mods = root.findall(".//note/time-modification")
    assert len(time_mods) == 3
    for tm in time_mods:
        assert _findtext(tm, "actual-notes") == "3"
        assert _findtext(tm, "normal-notes") == "2"

    tuplets = root.findall(".//notations/tuplet")
    tuplet_types = [t.get("type") for t in tuplets]
    types = sorted(t for t in tuplet_types if t is not None)
    assert types == ["start", "stop"]


def test_song_to_musicxml_empty_song_produces_no_parts():
    inst = Instrument(name="Synth", slot=0, sub_slot=-1, clip_instances=[])
    song = _make_song([], [inst], in_arrangement_view=True)
    xml = song_to_musicxml(song)
    root = ET.fromstring(xml)
    assert len(root.findall(".//part")) == 0
