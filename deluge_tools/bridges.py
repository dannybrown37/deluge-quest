from __future__ import annotations

import json
import os
import tempfile
from typing import Any

from deluge_tools.analyzer import analyze_song
from deluge_tools.parser import (
    TICKS_PER_QUARTER,
    Instrument,
    parse_song_xml,
)


def analyze_stats_json(files_json: str) -> str:
    files: list[dict[str, str]] = json.loads(files_json)
    results: list[dict[str, Any]] = []

    for f in files:
        try:
            song = parse_song_xml(f["content"])
            stats = analyze_song(song)
            results.append(
                {
                    "filename": f["name"],
                    "bpm": stats.bpm,
                    "key": stats.key,
                    "hasArrangement": stats.has_arrangement,
                    "instrumentCount": stats.instrument_count,
                    "synthCount": stats.synth_count,
                    "kitCount": stats.kit_count,
                    "midiCount": stats.midi_count,
                    "cvCount": stats.cv_count,
                    "audioCount": stats.audio_count,
                    "clipCount": stats.clip_count,
                    "totalNotes": stats.total_notes,
                    "durationStr": stats.duration_str if stats.has_arrangement else "-",
                    "midiChannels": stats.midi_channels,
                    "firmwareVersion": stats.firmware_version,
                }
            )
        except Exception as e:
            results.append(
                {
                    "filename": f["name"],
                    "bpm": 0,
                    "key": f"Error: {e}",
                    "hasArrangement": False,
                    "instrumentCount": 0,
                    "synthCount": 0,
                    "kitCount": 0,
                    "midiCount": 0,
                    "cvCount": 0,
                    "audioCount": 0,
                    "clipCount": 0,
                    "totalNotes": 0,
                    "durationStr": "-",
                    "midiChannels": [],
                    "firmwareVersion": "",
                }
            )

    return json.dumps(results)


def inspect_song_json(xml_content: str) -> str:
    song = parse_song_xml(xml_content)
    stats = analyze_song(song)

    clip_note_counts: dict[int, int] = {}
    clip_row_counts: dict[int, int] = {}
    clip_note_rows: dict[int, list[dict[str, Any]]] = {}
    clip_lengths: dict[int, int] = {}

    for c in song.clips:
        clip_note_counts[c.index] = sum(len(r.notes) for r in c.rows)
        clip_row_counts[c.index] = len(c.rows)
        clip_lengths[c.index] = c.length
        rows: list[dict[str, Any]] = []
        for r in c.rows:
            if r.notes:
                rows.append(
                    {
                        "y": r.y,
                        "drumName": r.drum_name,
                        "samplePath": r.sample_path,
                        "notes": [
                            {"pos": n.position, "len": n.length, "vel": n.velocity} for n in r.notes
                        ],
                    }
                )
        clip_note_rows[c.index] = rows

    audio_clip_map = {ac.index: ac for ac in song.audio_clips}
    has_arrangement = any(inst.clip_instances for inst in song.instruments)

    tracks: list[dict[str, Any]] = []
    for inst in song.instruments:
        if has_arrangement and not inst.clip_instances:
            continue

        clips: list[dict[str, Any]] = []
        if inst.clip_instances:
            for ci in inst.clip_instances:
                clips.append(
                    {
                        "positionTicks": ci.position,
                        "lengthTicks": ci.length,
                        "clipLengthTicks": clip_lengths.get(ci.clip_index, ci.length),
                        "clipIndex": ci.clip_index,
                        "noteCount": clip_note_counts.get(ci.clip_index, 0),
                        "rowCount": clip_row_counts.get(ci.clip_index, 0),
                        "noteRows": clip_note_rows.get(ci.clip_index, []),
                    }
                )
        else:
            for c in song.clips:
                if c.instrument_slot == inst.slot and c.instrument_sub_slot == inst.sub_slot:
                    clips.append(
                        {
                            "positionTicks": 0,
                            "lengthTicks": c.length,
                            "clipLengthTicks": c.length,
                            "clipIndex": c.index,
                            "noteCount": clip_note_counts.get(c.index, 0),
                            "rowCount": clip_row_counts.get(c.index, 0),
                            "noteRows": clip_note_rows.get(c.index, []),
                        }
                    )
        if not clips:
            continue

        name = inst.name or f"Instrument {inst.slot}"
        if inst.instrument_type == "audio" and inst.clip_instances:
            ac = audio_clip_map.get(inst.clip_instances[0].clip_index)
            if ac and ac.file_path:
                name = ac.file_path.rsplit("/", 1)[-1]

        tracks.append(
            {
                "name": name,
                "isKit": inst.is_kit,
                "instrumentType": inst.instrument_type,
                "midiChannel": inst.midi_channel,
                "cvChannel": inst.cv_channel,
                "patch": _build_patch(inst, [cl["clipIndex"] for cl in clips], song),
                "clips": clips,
            }
        )

    if has_arrangement:
        dur_ticks = stats.arrangement_length_ticks
        dur_str = stats.duration_str
    else:
        dur_ticks = max(
            (c["lengthTicks"] for t in tracks for c in t["clips"]),
            default=0,
        )
        for t in tracks:
            for c in t["clips"]:
                c["lengthTicks"] = dur_ticks
        total_secs = dur_ticks / TICKS_PER_QUARTER * 60.0 / stats.bpm if stats.bpm > 0 else 0
        dur_str = f"{int(total_secs // 60)}:{int(total_secs % 60):02d}" if dur_ticks > 0 else "-"

    result = {
        "bpm": stats.bpm,
        "key": stats.key,
        "durationTicks": dur_ticks,
        "durationStr": dur_str,
        "ticksPerQuarter": TICKS_PER_QUARTER,
        "trackCount": len(tracks),
        "totalNotes": stats.total_notes,
        "hasArrangement": has_arrangement,
        "tracks": tracks,
    }

    return json.dumps(result)


def convert_to_musicxml(xml_content: str) -> str:
    from deluge_tools.converter import song_to_musicxml

    song = parse_song_xml(xml_content)
    return song_to_musicxml(song)


def convert_midi_to_deluge_xml(midi_bytes: bytes) -> str:
    from deluge_tools.midi_to_deluge import midi_to_deluge_xml

    midi_tmp = tempfile.NamedTemporaryFile(suffix=".mid", delete=False)
    out_tmp = tempfile.NamedTemporaryFile(suffix=".XML", delete=False)
    try:
        midi_tmp.write(midi_bytes)
        midi_tmp.close()
        out_tmp.close()
        midi_to_deluge_xml(midi_tmp.name, out_tmp.name)
        with open(out_tmp.name) as f:
            return f.read()
    finally:
        os.unlink(midi_tmp.name)
        os.unlink(out_tmp.name)


def _build_patch(
    inst: Instrument,
    clip_indices: list[int],
    song: Any,
) -> dict[str, Any] | None:
    if inst.sound is None:
        return None
    sp = None
    for ci in clip_indices:
        c = next((cc for cc in song.clips if cc.index == ci), None)
        if c and c.sound_params:
            sp = c.sound_params
            break
    if sp is None:
        return None

    def mod_dict(mod: Any) -> dict[str, Any] | None:
        if mod is None:
            return None
        return {
            "transpose": mod.transpose,
            "cents": mod.cents,
            "toModulator1": mod.to_modulator1,
        }

    return {
        "mode": inst.sound.mode,
        "polyphonic": inst.sound.polyphonic,
        "lpfMode": inst.sound.lpf_mode,
        "osc1": {
            "type": inst.sound.osc1.type,
            "transpose": inst.sound.osc1.transpose,
            "cents": inst.sound.osc1.cents,
        },
        "osc2": {
            "type": inst.sound.osc2.type,
            "transpose": inst.sound.osc2.transpose,
            "cents": inst.sound.osc2.cents,
        },
        "modulator1": mod_dict(inst.sound.modulator1),
        "modulator2": mod_dict(inst.sound.modulator2),
        "lfo1Type": inst.sound.lfo1_type,
        "lfo2Type": inst.sound.lfo2_type,
        "unisonNum": inst.sound.unison_num,
        "unisonDetune": inst.sound.unison_detune,
        "arpMode": inst.sound.arp_mode,
        "arpOctaves": inst.sound.arp_octaves,
        "arpSyncLevel": inst.sound.arp_sync_level,
        "params": sp.params,
        "envelope1": {
            "attack": sp.envelope1.attack,
            "decay": sp.envelope1.decay,
            "sustain": sp.envelope1.sustain,
            "release": sp.envelope1.release,
        },
        "envelope2": {
            "attack": sp.envelope2.attack,
            "decay": sp.envelope2.decay,
            "sustain": sp.envelope2.sustain,
            "release": sp.envelope2.release,
        },
        "patchCables": [
            {
                "source": pc.source,
                "destination": pc.destination,
                "amount": pc.amount,
            }
            for pc in sp.patch_cables
        ],
    }
