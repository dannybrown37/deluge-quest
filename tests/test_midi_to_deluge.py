from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

mido = pytest.importorskip("mido")

from deluge_tools.midi_to_deluge import (  # noqa: E402
    bpm_to_timer_ticks,
    encode_clip_instances,
    encode_note_data,
    midi_to_deluge_xml,
)
from deluge_tools.parser import (  # noqa: E402
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


class TestMidiToDelugeXmlEdgeCases:
    def test_root_note_and_mode_notes(self, tmp_path: Path) -> None:
        midi_path = _make_midi(tmp_path)
        out = tmp_path / "output.XML"
        midi_to_deluge_xml(midi_path, out, root_note=5, mode_notes=[0, 2, 3, 5, 7, 8, 10])
        from deluge_tools.parser import parse_song

        song = parse_song(out)
        assert song.root_note == 5
        assert song.mode_notes == [0, 2, 3, 5, 7, 8, 10]

    def test_default_mode_notes_is_major(self, tmp_path: Path) -> None:
        midi_path = _make_midi(tmp_path)
        out = tmp_path / "output.XML"
        midi_to_deluge_xml(midi_path, out)
        from deluge_tools.parser import parse_song

        song = parse_song(out)
        assert song.mode_notes == [0, 2, 4, 5, 7, 9, 11]

    def test_note_on_velocity_zero_treated_as_note_off(self, tmp_path: Path) -> None:
        mid = mido.MidiFile(ticks_per_beat=480)
        track = mido.MidiTrack()
        mid.tracks.append(track)
        track.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(120)))
        track.append(mido.Message("note_on", note=60, velocity=100, time=0))
        track.append(mido.Message("note_on", note=60, velocity=0, time=480))
        track.append(mido.MetaMessage("end_of_track"))
        path = tmp_path / "velzero.mid"
        mid.save(str(path))

        out = tmp_path / "output.XML"
        midi_to_deluge_xml(path, out)
        from deluge_tools.parser import parse_song

        song = parse_song(out)
        row = next(r for r in song.clips[0].rows if r.y == 60)
        assert len(row.notes) == 1
        assert row.notes[0].length == 48

    def test_note_off_without_note_on_is_ignored(self, tmp_path: Path) -> None:
        mid = mido.MidiFile(ticks_per_beat=480)
        track = mido.MidiTrack()
        mid.tracks.append(track)
        track.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(120)))
        track.append(mido.Message("note_off", note=60, velocity=0, time=0))
        track.append(mido.Message("note_on", note=64, velocity=90, time=0))
        track.append(mido.Message("note_off", note=64, velocity=0, time=240))
        track.append(mido.MetaMessage("end_of_track"))
        path = tmp_path / "orphan_off.mid"
        mid.save(str(path))

        out = tmp_path / "output.XML"
        midi_to_deluge_xml(path, out)
        from deluge_tools.parser import parse_song

        song = parse_song(out)
        pitches = {r.y for r in song.clips[0].rows if r.notes}
        assert pitches == {64}

    def test_track_with_no_notes_is_excluded(self, tmp_path: Path) -> None:
        mid = mido.MidiFile(ticks_per_beat=480)
        empty_track = mido.MidiTrack()
        mid.tracks.append(empty_track)
        empty_track.append(mido.MetaMessage("track_name", name="empty"))
        empty_track.append(mido.MetaMessage("end_of_track"))

        note_track = mido.MidiTrack()
        mid.tracks.append(note_track)
        note_track.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(120)))
        note_track.append(mido.Message("note_on", note=60, velocity=100, time=0))
        note_track.append(mido.Message("note_off", note=60, velocity=0, time=480))
        note_track.append(mido.MetaMessage("end_of_track"))
        path = tmp_path / "with_empty.mid"
        mid.save(str(path))

        out = tmp_path / "output.XML"
        midi_to_deluge_xml(path, out)
        from deluge_tools.parser import parse_song

        song = parse_song(out)
        assert len(song.clips) == 1

    def test_multiple_notes_same_pitch(self, tmp_path: Path) -> None:
        mid = mido.MidiFile(ticks_per_beat=480)
        track = mido.MidiTrack()
        mid.tracks.append(track)
        track.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(120)))
        track.append(mido.Message("note_on", note=60, velocity=100, time=0))
        track.append(mido.Message("note_off", note=60, velocity=0, time=480))
        track.append(mido.Message("note_on", note=60, velocity=110, time=0))
        track.append(mido.Message("note_off", note=60, velocity=0, time=480))
        track.append(mido.MetaMessage("end_of_track"))
        path = tmp_path / "repeat.mid"
        mid.save(str(path))

        out = tmp_path / "output.XML"
        midi_to_deluge_xml(path, out)
        from deluge_tools.parser import parse_song

        song = parse_song(out)
        row = next(r for r in song.clips[0].rows if r.y == 60)
        assert len(row.notes) == 2

    def test_clip_length_rounds_up_to_bar(self, tmp_path: Path) -> None:
        midi_path = _make_midi(tmp_path)
        out = tmp_path / "output.XML"
        midi_to_deluge_xml(midi_path, out)
        from deluge_tools.parser import parse_song

        song = parse_song(out)
        assert song.clips[0].length % (TICKS_PER_QUARTER * 4) == 0

    def test_second_clip_instance_position_offset(self, tmp_path: Path) -> None:
        mid = mido.MidiFile(ticks_per_beat=480)
        for i, pitch in enumerate([60, 72]):
            track = mido.MidiTrack()
            mid.tracks.append(track)
            if i == 0:
                track.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(120)))
            track.append(mido.Message("note_on", note=pitch, velocity=100, time=0))
            track.append(mido.Message("note_off", note=pitch, velocity=0, time=480))
            track.append(mido.MetaMessage("end_of_track"))
        path = tmp_path / "multi_offset.mid"
        mid.save(str(path))

        out = tmp_path / "output.XML"
        midi_to_deluge_xml(path, out)
        from deluge_tools.parser import parse_song

        song = parse_song(out)
        second_inst = song.instruments[1]
        assert second_inst.clip_instances[0].position != 0

    def test_zero_length_note_clamped_to_one(self, tmp_path: Path) -> None:
        mid = mido.MidiFile(ticks_per_beat=480)
        track = mido.MidiTrack()
        mid.tracks.append(track)
        track.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(120)))
        track.append(mido.Message("note_on", note=60, velocity=100, time=0))
        track.append(mido.Message("note_off", note=60, velocity=0, time=0))
        track.append(mido.MetaMessage("end_of_track"))
        path = tmp_path / "zerolen.mid"
        mid.save(str(path))

        out = tmp_path / "output.XML"
        midi_to_deluge_xml(path, out)
        from deluge_tools.parser import parse_song

        song = parse_song(out)
        row = next(r for r in song.clips[0].rows if r.y == 60)
        assert row.notes[0].length == 1


class TestMidoMissing:
    def test_import_error_when_mido_missing(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import deluge_tools.midi_to_deluge as mod

        monkeypatch.setattr(mod, "mido", None)
        with pytest.raises(ImportError, match="mido is required"):
            mod.midi_to_deluge_xml(tmp_path / "nope.mid", tmp_path / "out.XML")


class TestBuildSoundParamsElement:
    def test_contains_default_params(self) -> None:
        from deluge_tools.midi_to_deluge import _build_sound_params_element

        el = _build_sound_params_element()
        assert el.tag == "soundParams"
        assert el.get("volume") == "0x7FFFFFFF"
        assert el.find("envelope1") is not None
        assert el.find("patchCables/patchCable") is not None
        assert el.find("equalizer") is not None

    def test_custom_tag_name(self) -> None:
        from deluge_tools.midi_to_deluge import _build_sound_params_element

        el = _build_sound_params_element(tag="defaultParams")
        assert el.tag == "defaultParams"


class TestBuildInstrumentElement:
    def test_without_clip_instances(self) -> None:
        from deluge_tools.midi_to_deluge import _build_instrument_element

        el = _build_instrument_element(0, "")
        assert el.get("clipInstances") is None
        assert el.get("presetSlot") == "0"

    def test_with_clip_instances(self) -> None:
        from deluge_tools.midi_to_deluge import _build_instrument_element

        el = _build_instrument_element(2, "0xDEADBEEF")
        assert el.get("clipInstances") == "0xDEADBEEF"
        assert el.get("presetSlot") == "2"


class TestScaleTickAndCeilToBar:
    @pytest.mark.parametrize(
        ("midi_tick", "midi_tpb", "expected"),
        [
            (0, 480, 0),
            (480, 480, 48),
            (240, 480, 24),
            (960, 480, 96),
        ],
    )
    def test_scale_tick(self, midi_tick: int, midi_tpb: int, expected: int) -> None:
        from deluge_tools.midi_to_deluge import _scale_tick

        assert _scale_tick(midi_tick, midi_tpb) == expected

    @pytest.mark.parametrize(
        ("ticks", "expected"),
        [
            (0, 192),
            (-5, 192),
            (1, 192),
            (192, 192),
            (193, 384),
            (384, 384),
        ],
    )
    def test_ceil_to_bar(self, ticks: int, expected: int) -> None:
        from deluge_tools.midi_to_deluge import _ceil_to_bar

        assert _ceil_to_bar(ticks) == expected


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
