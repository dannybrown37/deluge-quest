from __future__ import annotations

import struct
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

import mido

from deluge_tools.parser import (
    CLIP_INSTANCE_SIZE,
    NOTE_RECORD_SIZE,
    TICKS_PER_QUARTER,
    ClipInstance,
    Note,
)

DELUGE_TICKS_PER_BAR = TICKS_PER_QUARTER * 4  # 192
SAMPLE_RATE = 44100


def encode_note_data(notes: list[Note]) -> str:
    if not notes:
        return ""
    chunks = []
    for n in notes:
        chunks.append(
            struct.pack(">II", n.position, n.length)
            + bytes([n.velocity, n.lift_velocity])
        )
    return "0x" + b"".join(chunks).hex().upper()


def encode_clip_instances(instances: list[ClipInstance]) -> str:
    if not instances:
        return ""
    chunks = []
    for ci in instances:
        chunks.append(struct.pack(">III", ci.position, ci.length, ci.clip_index))
    return "0x" + b"".join(chunks).hex().upper()


def bpm_to_timer_ticks(bpm: float) -> tuple[int, int]:
    ticks_per_minute = bpm * TICKS_PER_QUARTER
    ticks_per_second = ticks_per_minute / 60
    samples_per_tick = SAMPLE_RATE / ticks_per_second
    time_per_tick = int(samples_per_tick)
    fraction = int((samples_per_tick - time_per_tick) * (2**32))
    return time_per_tick, fraction


def _scale_tick(midi_tick: int, midi_tpb: int) -> int:
    return round(midi_tick * TICKS_PER_QUARTER / midi_tpb)


def _ceil_to_bar(ticks: int) -> int:
    if ticks <= 0:
        return DELUGE_TICKS_PER_BAR
    return ((ticks + DELUGE_TICKS_PER_BAR - 1) // DELUGE_TICKS_PER_BAR) * DELUGE_TICKS_PER_BAR


def _extract_tracks(
    mid: mido.MidiFile,
) -> tuple[float, list[dict[int, list[Note]]]]:
    bpm = 120.0
    tracks: list[dict[int, list[Note]]] = []

    for track in mid.tracks:
        abs_time = 0
        pending: dict[int, tuple[int, int]] = {}
        notes_by_pitch: dict[int, list[Note]] = defaultdict(list)
        has_notes = False

        for msg in track:
            abs_time += msg.time
            if msg.type == "set_tempo":
                bpm = mido.tempo2bpm(msg.tempo)
            elif msg.type == "note_on" and msg.velocity > 0:
                pending[msg.note] = (_scale_tick(abs_time, mid.ticks_per_beat), msg.velocity)
            elif msg.type in ("note_off", "note_on"):
                start_info = pending.pop(msg.note, None)
                if start_info is None:
                    continue
                start_tick, vel = start_info
                end_tick = _scale_tick(abs_time, mid.ticks_per_beat)
                length = max(end_tick - start_tick, 1)
                notes_by_pitch[msg.note].append(
                    Note(position=start_tick, length=length, velocity=vel, lift_velocity=64)
                )
                has_notes = True

        if has_notes:
            tracks.append(dict(notes_by_pitch))

    return bpm, tracks


DEFAULT_SOUND_PARAMS = {
    "arpeggiatorGate": "0x00000000",
    "portamento": "0x80000000",
    "compressorShape": "0xDC28F5B2",
    "oscAVolume": "0x7FFFFFFF",
    "oscAPulseWidth": "0x00000000",
    "oscBVolume": "0x80000000",
    "oscBPulseWidth": "0x00000000",
    "noiseVolume": "0x80000000",
    "volume": "0x7FFFFFFF",
    "pan": "0x00000000",
    "lpfFrequency": "0x7FFFFFFF",
    "lpfResonance": "0x80000000",
    "hpfFrequency": "0x80000000",
    "hpfResonance": "0x80000000",
    "lfo1Rate": "0x1999999A",
    "lfo2Rate": "0x00000000",
    "modulator1Amount": "0x80000000",
    "modulator1Feedback": "0x80000000",
    "modulator2Amount": "0x80000000",
    "modulator2Feedback": "0x80000000",
    "carrier1Feedback": "0x80000000",
    "carrier2Feedback": "0x80000000",
    "modFXRate": "0x00000000",
    "modFXDepth": "0x00000000",
    "delayRate": "0x00000000",
    "delayFeedback": "0x80000000",
    "reverbAmount": "0x80000000",
    "arpeggiatorRate": "0x00000000",
    "stutterRate": "0x00000000",
    "sampleRateReduction": "0x80000000",
    "bitCrush": "0x80000000",
    "modFXOffset": "0x00000000",
    "modFXFeedback": "0x80000000",
}


def _build_sound_params_element(tag: str = "soundParams") -> ET.Element:
    el = ET.SubElement(ET.Element("_dummy"), tag)
    for k, v in DEFAULT_SOUND_PARAMS.items():
        el.set(k, v)
    env1 = ET.SubElement(el, "envelope1")
    env1.set("attack", "0x80000000")
    env1.set("decay", "0xE6666654")
    env1.set("sustain", "0x7FFFFFFF")
    env1.set("release", "0x80000000")
    env2 = ET.SubElement(el, "envelope2")
    env2.set("attack", "0xE6666654")
    env2.set("decay", "0xE6666654")
    env2.set("sustain", "0xFFFFFFE9")
    env2.set("release", "0xE6666654")
    cables = ET.SubElement(el, "patchCables")
    cable = ET.SubElement(cables, "patchCable")
    cable.set("source", "velocity")
    cable.set("destination", "volume")
    cable.set("amount", "0x3FFFFFE8")
    eq = ET.SubElement(el, "equalizer")
    eq.set("bass", "0x00000000")
    eq.set("treble", "0x00000000")
    eq.set("bassFrequency", "0x00000000")
    eq.set("trebleFrequency", "0x00000000")
    return el


def _build_instrument_element(
    slot: int, clip_instances_hex: str,
) -> ET.Element:
    sound = ET.Element("sound")
    sound.set("presetSlot", str(slot))
    sound.set("presetSubSlot", "-1")
    sound.set("isArmedForRecording", "0")
    if clip_instances_hex:
        sound.set("clipInstances", clip_instances_hex)
    sound.set("lpfMode", "24dB")
    sound.set("modFXType", "none")
    sound.set("currentFilterType", "lpf")
    sound.set("polyphonic", "auto")
    sound.set("voicePriority", "1")
    sound.set("mode", "subtractive")

    ET.SubElement(sound, "delay", pingPong="1", analog="0", syncLevel="7")
    ET.SubElement(sound, "compressor", syncLevel="6", attack="327244", release="936")

    osc1 = ET.SubElement(sound, "osc1", type="square")
    osc2 = ET.SubElement(sound, "osc2", type="square", transpose="0")
    ET.SubElement(sound, "lfo1", type="triangle", syncLevel="0")
    ET.SubElement(sound, "lfo2", type="triangle")
    ET.SubElement(sound, "unison", num="1", detune="8")
    ET.SubElement(sound, "arpeggiator", mode="off", numOctaves="2", syncLevel="7")

    return sound


def _build_clip_element(
    slot: int, clip_length: int, notes_by_pitch: dict[int, list[Note]],
) -> ET.Element:
    clip = ET.Element("instrumentClip")
    clip.set("instrumentPresetSlot", str(slot))
    clip.set("instrumentPresetSubSlot", "-1")
    clip.set("isPlaying", "0")
    clip.set("isSoloing", "0")
    clip.set("isArmedForRecording", "0")
    clip.set("length", str(clip_length))
    clip.set("colourOffset", "0")

    sp = _build_sound_params_element()
    clip.append(sp)

    note_rows = ET.SubElement(clip, "noteRows")
    for pitch in sorted(notes_by_pitch.keys()):
        row = ET.SubElement(note_rows, "noteRow")
        row.set("y", str(pitch))
        encoded = encode_note_data(notes_by_pitch[pitch])
        if encoded:
            row.set("noteData", encoded)

    return clip


def midi_to_deluge_xml(
    midi_path: Path | str,
    output_path: Path | str,
    *,
    root_note: int = 0,
    mode_notes: list[int] | None = None,
) -> None:
    mid = mido.MidiFile(str(midi_path))
    bpm, tracks = _extract_tracks(mid)

    if mode_notes is None:
        mode_notes = [0, 2, 4, 5, 7, 9, 11]  # major

    tpt, frac = bpm_to_timer_ticks(bpm)

    root = ET.Element("song")
    root.set("firmwareVersion", "3.0.0")
    root.set("earliestCompatibleFirmware", "3.0.0")
    root.set("inArrangementView", "1")
    root.set("timePerTimerTick", str(tpt))
    root.set("timerTickFraction", str(frac))
    root.set("rootNote", str(root_note))
    root.set("swingAmount", "0")

    mn_el = ET.SubElement(root, "modeNotes")
    for mn in mode_notes:
        ET.SubElement(mn_el, "modeNote").text = str(mn)

    instruments_el = ET.SubElement(root, "instruments")
    clips_el = ET.SubElement(root, "sessionClips")

    for clip_idx, notes_by_pitch in enumerate(tracks):
        max_end = 0
        for pitch_notes in notes_by_pitch.values():
            for n in pitch_notes:
                max_end = max(max_end, n.position + n.length)
        clip_length = _ceil_to_bar(max_end)

        ci = ClipInstance(position=0 if clip_idx == 0 else clip_idx * clip_length,
                          length=clip_length, clip_index=clip_idx)
        ci_hex = encode_clip_instances([ci])

        slot = clip_idx
        inst_el = _build_instrument_element(slot, ci_hex)
        instruments_el.append(inst_el)

        clip_el = _build_clip_element(slot, clip_length, notes_by_pitch)
        clips_el.append(clip_el)

    tree = ET.ElementTree(root)
    ET.indent(tree, space="\t")
    tree.write(str(output_path), encoding="UTF-8", xml_declaration=True)
