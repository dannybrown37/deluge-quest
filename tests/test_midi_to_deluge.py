from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

import mido
import pytest

from deluge_tools.midi_to_deluge import (
    bpm_to_timer_ticks,
    encode_clip_instances,
    encode_note_data,
    midi_to_deluge_xml,
)
from deluge_tools.parser import (
    TICKS_PER_QUARTER,
    ClipInstance,
    Note,
    parse_clip_instances,
    parse_note_data,
)


class TestEncodeNoteData:
    def test_roundtrip_single_note(self) -> None:
        notes = [Note(position=0, length=48, velocity=100, lift_velocity=64)]
        encoded = encode_note_data(notes)
        decoded = parse_note_data(encoded)
        assert len(decoded) == 1
        assert decoded[0].position == 0
        assert decoded[0].length == 48
        assert decoded[0].velocity == 100
        assert decoded[0].lift_velocity == 64

    def test_roundtrip_multiple_notes(self) -> None:
        notes = [
            Note(position=0, length=24, velocity=80, lift_velocity=20),
            Note(position=48, length=96, velocity=127, lift_velocity=0),
            Note(position=192, length=12, velocity=64, lift_velocity=40),
        ]
        encoded = encode_note_data(notes)
        decoded = parse_note_data(encoded)
        assert len(decoded) == len(notes)
        for orig, dec in zip(notes, decoded, strict=True):
            assert dec.position == orig.position
            assert dec.length == orig.length
            assert dec.velocity == orig.velocity
            assert dec.lift_velocity == orig.lift_velocity

    def test_empty(self) -> None:
        assert encode_note_data([]) == ""

    def test_hex_prefix(self) -> None:
        notes = [Note(position=0, length=16, velocity=64, lift_velocity=20)]
        encoded = encode_note_data(notes)
        assert encoded.startswith("0x")


class TestEncodeClipInstances:
    def test_roundtrip(self) -> None:
        instances = [
            ClipInstance(position=0, length=384, clip_index=0),
            ClipInstance(position=384, length=768, clip_index=1),
        ]
        encoded = encode_clip_instances(instances)
        decoded = parse_clip_instances(encoded)
        assert len(decoded) == len(instances)
        for orig, dec in zip(instances, decoded, strict=True):
            assert dec.position == orig.position
            assert dec.length == orig.length
            assert dec.clip_index == orig.clip_index

    def test_empty(self) -> None:
        assert encode_clip_instances([]) == ""

    def test_hex_prefix(self) -> None:
        instances = [ClipInstance(position=0, length=192, clip_index=0)]
        encoded = encode_clip_instances(instances)
        assert encoded.startswith("0x")


class TestBpmToTimerTicks:
    @pytest.mark.parametrize("bpm", [60.0, 90.0, 120.0, 140.0, 180.0, 200.0])
    def test_roundtrip(self, bpm: float) -> None:
        tpt, frac = bpm_to_timer_ticks(bpm)
        sample_rate = 44100
        ticks_per_second = sample_rate / (tpt + frac / (2**32))
        ticks_per_minute = ticks_per_second * 60
        recovered_bpm = ticks_per_minute / TICKS_PER_QUARTER
        assert abs(recovered_bpm - bpm) < 0.01


def _make_midi(tmp_path: Path, bpm: float = 120.0, ticks_per_beat: int = 480) -> Path:
    mid = mido.MidiFile(ticks_per_beat=ticks_per_beat)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(bpm)))
    track.append(mido.MetaMessage("track_name", name="Lead"))
    track.append(mido.Message("note_on", note=60, velocity=100, time=0))
    track.append(mido.Message("note_off", note=60, velocity=0, time=480))
    track.append(mido.Message("note_on", note=64, velocity=80, time=0))
    track.append(mido.Message("note_off", note=64, velocity=0, time=480))
    track.append(mido.Message("note_on", note=67, velocity=90, time=0))
    track.append(mido.Message("note_off", note=67, velocity=0, time=240))
    track.append(mido.MetaMessage("end_of_track"))
    path = tmp_path / "test.mid"
    mid.save(str(path))
    return path


class TestMidiToDelugeXml:
    def test_produces_valid_xml(self, tmp_path: Path) -> None:
        midi_path = _make_midi(tmp_path)
        out = tmp_path / "output.XML"
        midi_to_deluge_xml(midi_path, out)
        tree = ET.parse(out)
        root = tree.getroot()
        assert root.tag == "song"

    def test_bpm_preserved(self, tmp_path: Path) -> None:
        midi_path = _make_midi(tmp_path, bpm=140.0)
        out = tmp_path / "output.XML"
        midi_to_deluge_xml(midi_path, out)
        from deluge_tools.parser import parse_song

        song = parse_song(out)
        assert abs(song.bpm - 140.0) < 0.1

    def test_notes_roundtrip(self, tmp_path: Path) -> None:
        midi_path = _make_midi(tmp_path)
        out = tmp_path / "output.XML"
        midi_to_deluge_xml(midi_path, out)
        from deluge_tools.parser import parse_song

        song = parse_song(out)
        assert len(song.clips) >= 1
        clip = song.clips[0]
        rows_with_notes = [r for r in clip.rows if r.notes]
        assert len(rows_with_notes) == 3
        pitches = {r.y for r in rows_with_notes}
        assert pitches == {60, 64, 67}

    def test_has_arrangement_data(self, tmp_path: Path) -> None:
        midi_path = _make_midi(tmp_path)
        out = tmp_path / "output.XML"
        midi_to_deluge_xml(midi_path, out)
        from deluge_tools.parser import parse_song

        song = parse_song(out)
        assert song.in_arrangement_view
        assert any(inst.clip_instances for inst in song.instruments)

    def test_multiple_tracks(self, tmp_path: Path) -> None:
        mid = mido.MidiFile(ticks_per_beat=480)
        for i, pitch in enumerate([60, 72]):
            track = mido.MidiTrack()
            mid.tracks.append(track)
            if i == 0:
                track.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(120)))
            track.append(mido.Message("note_on", note=pitch, velocity=100, time=0))
            track.append(mido.Message("note_off", note=pitch, velocity=0, time=480))
            track.append(mido.MetaMessage("end_of_track"))
        path = tmp_path / "multi.mid"
        mid.save(str(path))

        out = tmp_path / "output.XML"
        midi_to_deluge_xml(path, out)
        from deluge_tools.parser import parse_song

        song = parse_song(out)
        assert len(song.clips) == 2
        assert len(song.instruments) == 2

    def test_note_durations_scaled(self, tmp_path: Path) -> None:
        """A quarter note at 480 tpb MIDI → 48 ticks in Deluge."""
        midi_path = _make_midi(tmp_path, ticks_per_beat=480)
        out = tmp_path / "output.XML"
        midi_to_deluge_xml(midi_path, out)
        from deluge_tools.parser import parse_song

        song = parse_song(out)
        clip = song.clips[0]
        row_c = next(r for r in clip.rows if r.y == 60)
        assert row_c.notes[0].length == 48  # quarter note
        assert row_c.notes[0].position == 0


class TestCliImport:
    def test_cli_produces_output(self, tmp_path: Path) -> None:
        midi_path = _make_midi(tmp_path)
        out = tmp_path / "out.XML"
        from deluge_tools.cli_import import main

        main([str(midi_path), "-o", str(out)])
        assert out.exists()
        tree = ET.parse(out)
        assert tree.getroot().tag == "song"

    def test_cli_default_output_name(self, tmp_path: Path) -> None:
        midi_path = _make_midi(tmp_path)
        from deluge_tools.cli_import import main

        main([str(midi_path)])
        expected = midi_path.with_suffix(".XML")
        assert expected.exists()
