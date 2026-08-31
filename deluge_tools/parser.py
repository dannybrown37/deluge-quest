from __future__ import annotations

import struct
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

TICKS_PER_QUARTER = 48
NOTE_RECORD_SIZE = 10
NOTE_RECORD_SIZE_WITH_LIFT = 11
CLIP_INSTANCE_SIZE = 12
ARRANGEMENT_ONLY_FLAG = 0x80000000


@dataclass
class Note:
    position: int
    length: int
    velocity: int
    lift_velocity: int


@dataclass
class NoteRow:
    y: int | None = None
    drum_index: int | None = None
    drum_name: str | None = None
    sample_path: str | None = None
    notes: list[Note] = field(default_factory=list)


@dataclass
class ClipInstance:
    position: int
    length: int
    clip_index: int


@dataclass
class Clip:
    index: int
    instrument_slot: int
    instrument_sub_slot: int
    is_kit: bool = False
    length: int = 0
    rows: list[NoteRow] = field(default_factory=list)
    sound_params: ClipSoundParams | None = None


@dataclass
class OscPatch:
    type: str = "square"
    transpose: int = 0
    cents: int = 0


@dataclass
class ModulatorPatch:
    transpose: int = 0
    cents: int = 0
    to_modulator1: bool = False


@dataclass
class SoundPatch:
    mode: str = "subtractive"
    polyphonic: str = "poly"
    lpf_mode: str = "24dB"
    osc1: OscPatch = field(default_factory=OscPatch)
    osc2: OscPatch = field(default_factory=OscPatch)
    lfo1_type: str = "sine"
    lfo2_type: str = "sine"
    unison_num: int = 1
    unison_detune: int = 0
    arp_mode: str = "off"
    arp_octaves: int = 2
    arp_sync_level: int = 0
    modulator1: ModulatorPatch | None = None
    modulator2: ModulatorPatch | None = None


@dataclass
class EnvelopePatch:
    attack: str = "0x80000000"
    decay: str = "0x80000000"
    sustain: str = "0x7FFFFFFF"
    release: str = "0x80000000"


@dataclass
class PatchCable:
    source: str
    destination: str
    amount: str


@dataclass
class ClipSoundParams:
    params: dict[str, str] = field(default_factory=dict)
    envelope1: EnvelopePatch = field(default_factory=EnvelopePatch)
    envelope2: EnvelopePatch = field(default_factory=EnvelopePatch)
    patch_cables: list[PatchCable] = field(default_factory=list)


@dataclass
class Instrument:
    name: str | None = None
    is_kit: bool = False
    instrument_type: str = "synth"
    slot: int = -1
    sub_slot: int = -1
    midi_channel: int | None = None
    cv_channel: int | None = None
    clip_instances: list[ClipInstance] = field(default_factory=list)
    drum_names: list[str] = field(default_factory=list)
    drum_sample_paths: list[str | None] = field(default_factory=list)
    sound: SoundPatch | None = None


@dataclass
class AudioClip:
    index: int
    file_path: str = ""
    length: int = 0


@dataclass
class Song:
    firmware_version: str = ""
    root_note: int = 0
    mode_notes: list[int] = field(default_factory=list)
    bpm: float = 120.0
    instruments: list[Instrument] = field(default_factory=list)
    clips: list[Clip] = field(default_factory=list)
    audio_clips: list[AudioClip] = field(default_factory=list)
    in_arrangement_view: bool = False


def _parse_note_records(hex_str: str | None, record_size: int) -> list[Note]:
    if not hex_str:
        return []
    raw = hex_str.removeprefix("0x")
    data = bytes.fromhex(raw)
    notes = []
    for i in range(0, len(data), record_size):
        chunk = data[i : i + record_size]
        if len(chunk) < record_size:
            break
        pos, length = struct.unpack(">II", chunk[:8])
        velocity = chunk[8]
        lift = chunk[9]
        notes.append(Note(position=pos, length=length, velocity=velocity, lift_velocity=lift))
    return notes


def parse_note_data(hex_str: str | None) -> list[Note]:
    return _parse_note_records(hex_str, NOTE_RECORD_SIZE)


def parse_note_data_with_lift(hex_str: str | None) -> list[Note]:
    return _parse_note_records(hex_str, NOTE_RECORD_SIZE_WITH_LIFT)


def parse_clip_instances(hex_str: str | None) -> list[ClipInstance]:
    if not hex_str:
        return []
    raw = hex_str.removeprefix("0x")
    data = bytes.fromhex(raw)
    instances = []
    for i in range(0, len(data), CLIP_INSTANCE_SIZE):
        chunk = data[i : i + CLIP_INSTANCE_SIZE]
        if len(chunk) < CLIP_INSTANCE_SIZE:
            break
        pos, length, clip_idx = struct.unpack(">III", chunk)
        instances.append(ClipInstance(position=pos, length=length, clip_index=clip_idx))
    return instances


def _parse_bpm(root: ET.Element) -> float:
    time_per_tick = int(root.get("timePerTimerTick", "0"))
    fraction = int(root.get("timerTickFraction", "0"))
    if time_per_tick == 0:
        return 120.0
    sample_rate = 44100
    ticks_per_second = sample_rate / (time_per_tick + fraction / (2**32))
    ticks_per_minute = ticks_per_second * 60
    return ticks_per_minute / TICKS_PER_QUARTER


def _parse_clip_note_rows(
    clip: ET.Element,
    drum_names: list[str] | None = None,
    drum_sample_paths: list[str | None] | None = None,
) -> list[NoteRow]:
    rows = []
    for nr in clip.findall("noteRows/noteRow"):
        row = NoteRow()
        if nr.get("y") is not None:
            row.y = int(nr.get("y"))
        if nr.get("drumIndex") is not None:
            row.drum_index = int(nr.get("drumIndex"))
            if drum_names and 0 <= row.drum_index < len(drum_names):
                row.drum_name = drum_names[row.drum_index]
            if drum_sample_paths and 0 <= row.drum_index < len(drum_sample_paths):
                row.sample_path = drum_sample_paths[row.drum_index]
        note_data = nr.get("noteData")
        if note_data is not None:
            row.notes = parse_note_data(note_data)
        else:
            row.notes = parse_note_data_with_lift(nr.get("noteDataWithLift"))
        rows.append(row)
    return rows


def _parse_sound_patch(sound_el: ET.Element) -> SoundPatch:
    def osc(tag: str) -> OscPatch:
        el = sound_el.find(tag)
        if el is None:
            return OscPatch()
        return OscPatch(
            type=el.get("type", "square"),
            transpose=int(el.get("transpose", "0")),
            cents=int(el.get("cents", "0")),
        )

    lfo1 = sound_el.find("lfo1")
    lfo2 = sound_el.find("lfo2")
    unison = sound_el.find("unison")
    arp = sound_el.find("arpeggiator")
    mod1_el = sound_el.find("modulator1")
    mod2_el = sound_el.find("modulator2")
    modulator1 = (
        ModulatorPatch(transpose=int(mod1_el.get("transpose", "0")), cents=int(mod1_el.get("cents", "0")))
        if mod1_el is not None
        else None
    )
    modulator2 = (
        ModulatorPatch(
            transpose=int(mod2_el.get("transpose", "0")),
            cents=int(mod2_el.get("cents", "0")),
            to_modulator1=mod2_el.get("toModulator1", "0") == "1",
        )
        if mod2_el is not None
        else None
    )

    return SoundPatch(
        mode=sound_el.get("mode", "subtractive"),
        polyphonic=sound_el.get("polyphonic", "poly"),
        lpf_mode=sound_el.get("lpfMode", "24dB"),
        osc1=osc("osc1"),
        osc2=osc("osc2"),
        lfo1_type=lfo1.get("type", "sine") if lfo1 is not None else "sine",
        lfo2_type=lfo2.get("type", "sine") if lfo2 is not None else "sine",
        unison_num=int(unison.get("num", "1")) if unison is not None else 1,
        unison_detune=int(unison.get("detune", "0")) if unison is not None else 0,
        arp_mode=arp.get("mode", "off") if arp is not None else "off",
        arp_octaves=int(arp.get("numOctaves", "2")) if arp is not None else 2,
        arp_sync_level=int(arp.get("syncLevel", "0")) if arp is not None else 0,
        modulator1=modulator1,
        modulator2=modulator2,
    )


def _parse_clip_sound_params(clip_el: ET.Element) -> ClipSoundParams | None:
    sp_el = clip_el.find("soundParams")
    if sp_el is None:
        return None

    def envelope(tag: str) -> EnvelopePatch:
        el = sp_el.find(tag)
        if el is None:
            return EnvelopePatch()
        return EnvelopePatch(
            attack=el.get("attack", "0x80000000"),
            decay=el.get("decay", "0x80000000"),
            sustain=el.get("sustain", "0x7FFFFFFF"),
            release=el.get("release", "0x80000000"),
        )

    patch_cables = [
        PatchCable(
            source=pc.get("source", ""),
            destination=pc.get("destination", ""),
            amount=pc.get("amount", "0x80000000"),
        )
        for pc in sp_el.findall("patchCables/patchCable")
    ]

    return ClipSoundParams(
        params=dict(sp_el.attrib),
        envelope1=envelope("envelope1"),
        envelope2=envelope("envelope2"),
        patch_cables=patch_cables,
    )


def _instrument_key(
    slot: int, sub: int, preset_name: str | None, preset_folder: str | None
) -> tuple:
    if slot == -1 and preset_name is not None:
        return ("name", preset_name, preset_folder)
    return ("slot", slot, sub)


def parse_song(path: Path | str) -> Song:
    tree = ET.parse(path)
    root = tree.getroot()

    song = Song()
    song.firmware_version = root.get("firmwareVersion", "")
    song.root_note = int(root.get("rootNote", "0"))
    song.mode_notes = [
        int(mn.text) for mn in root.findall("modeNotes/modeNote") if mn.text
    ]
    song.bpm = _parse_bpm(root)
    song.in_arrangement_view = root.get("inArrangementView", "0") == "1"

    _TAG_TO_TYPE = {"sound": "synth", "kit": "kit", "midiChannel": "midi", "cv": "cv", "audioOutput": "audio"}

    instrument_map: dict[tuple, Instrument] = {}
    audio_output_count = 0
    for inst_el in root.findall("instruments/*"):
        tag = inst_el.tag
        inst_type = _TAG_TO_TYPE.get(tag)
        if inst_type is None:
            continue

        slot = int(inst_el.get("presetSlot", "-1"))
        sub = int(inst_el.get("presetSubSlot", "-1"))
        preset_name = inst_el.get("presetName")
        preset_folder = inst_el.get("presetFolder")

        instrument = Instrument(
            is_kit=(inst_type == "kit"),
            instrument_type=inst_type,
            slot=slot,
            sub_slot=sub,
            clip_instances=parse_clip_instances(inst_el.get("clipInstances")),
        )

        if inst_type == "audio":
            audio_output_count += 1
            instrument.name = f"Audio {audio_output_count}"
            audio_key = ("audio", audio_output_count)
            instrument_map[audio_key] = instrument
            continue
        elif inst_type == "kit":
            instrument.name = "Kit"
            for sound in inst_el.findall("soundSources/sound"):
                instrument.drum_names.append(sound.get("name", ""))
                osc1 = sound.find("osc1")
                file_name = osc1.get("fileName") if osc1 is not None else None
                instrument.drum_sample_paths.append(file_name)
        elif inst_type == "midi":
            instrument.midi_channel = int(inst_el.get("channel", "0"))
            instrument.name = f"MIDI Ch {instrument.midi_channel + 1}"
            instrument_map[("midi", instrument.midi_channel)] = instrument
            continue
        elif inst_type == "cv":
            instrument.cv_channel = int(inst_el.get("channel", "0"))
            instrument.name = f"CV {instrument.cv_channel + 1}"
            instrument_map[("cv", instrument.cv_channel)] = instrument
            continue
        else:
            instrument.name = preset_name or f"Synth {slot}"
            instrument.sound = _parse_sound_patch(inst_el)

        instrument_map[_instrument_key(slot, sub, preset_name, preset_folder)] = instrument

    song.instruments = list(instrument_map.values())

    session_clips_el = root.find("sessionClips")
    all_session_clips = list(session_clips_el) if session_clips_el is not None else []
    for global_idx, el in enumerate(all_session_clips):
        if el.tag == "audioClip":
            song.audio_clips.append(AudioClip(
                index=global_idx,
                file_path=el.get("filePath", ""),
                length=int(el.get("length", "0")),
            ))

    session_instrument_clips = root.findall("sessionClips/instrumentClip")
    for clip_idx, clip_el in enumerate(session_instrument_clips):
        slot = int(clip_el.get("instrumentPresetSlot", "-1"))
        sub = int(clip_el.get("instrumentPresetSubSlot", "-1"))
        preset_name = clip_el.get("instrumentPresetName")
        preset_folder = clip_el.get("instrumentPresetFolder")
        key = _instrument_key(slot, sub, preset_name, preset_folder)
        inst = instrument_map.get(key)

        clip = Clip(
            index=clip_idx,
            instrument_slot=slot,
            instrument_sub_slot=sub,
            is_kit=inst.is_kit if inst else False,
            length=int(clip_el.get("length", "0")),
            rows=_parse_clip_note_rows(
                clip_el,
                inst.drum_names if inst and inst.is_kit else None,
                inst.drum_sample_paths if inst and inst.is_kit else None,
            ),
            sound_params=_parse_clip_sound_params(clip_el),
        )
        song.clips.append(clip)

    num_session_clips = len(session_instrument_clips)
    for local_idx, clip_el in enumerate(root.findall("arrangementOnlyTracks/instrumentClip")):
        slot = int(clip_el.get("instrumentPresetSlot", "-1"))
        sub = int(clip_el.get("instrumentPresetSubSlot", "-1"))
        preset_name = clip_el.get("instrumentPresetName")
        preset_folder = clip_el.get("instrumentPresetFolder")
        key = _instrument_key(slot, sub, preset_name, preset_folder)
        inst = instrument_map.get(key)

        clip = Clip(
            index=num_session_clips + local_idx,
            instrument_slot=slot,
            instrument_sub_slot=sub,
            is_kit=inst.is_kit if inst else False,
            length=int(clip_el.get("length", "0")),
            rows=_parse_clip_note_rows(
                clip_el,
                inst.drum_names if inst and inst.is_kit else None,
                inst.drum_sample_paths if inst and inst.is_kit else None,
            ),
            sound_params=_parse_clip_sound_params(clip_el),
        )
        song.clips.append(clip)

    for inst in song.instruments:
        for ci in inst.clip_instances:
            if ci.clip_index & ARRANGEMENT_ONLY_FLAG:
                ci.clip_index = num_session_clips + (ci.clip_index & ~ARRANGEMENT_ONLY_FLAG)

    return song
