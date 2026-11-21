"""MIDI device definition files + MIDI instrument presets for Deluge community firmware c1.3.

Format mirrors MIDIInstrument::writeDataToFile / writeDeviceDefinitionFile in the firmware
(src/deluge/model/instrument/midi_instrument.cpp).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

FIRMWARE_VERSION = "c1.3.0"
EARLIEST_COMPATIBLE = "4.1.0-alpha"
NUM_REAL_CCS = 120
MOD_WHEEL_CC = 1
NUM_MOD_BUTTONS = 8

MOD_BUTTON_NAMES = (
    "Level / Pan",
    "Cutoff / Resonance",
    "Attack / Release",
    "Delay amount / time",
    "Reverb / Sidechain",
    "Mod rate / depth",
    "Custom 1 / Stutter",
    "Custom 2 / Custom 3",
)

Knob = int | None


@dataclass(frozen=True)
class Device:
    vendor: str
    name: str
    channel: int
    labels: dict[int, str]
    knobs: tuple[tuple[Knob, Knob], ...]
    notes: tuple[str, ...] = field(default=())

    @property
    def definition_path(self) -> str:
        return f"MIDI_DEVICES/DEFINITION/{self.vendor}/{self.name}.xml"

    @property
    def preset_path(self) -> str:
        return f"MIDI/{self.vendor}/{self.name}.xml"


def validate(device: Device) -> None:
    if len(device.knobs) != NUM_MOD_BUTTONS:
        raise ValueError(f"{device.name}: need {NUM_MOD_BUTTONS} (top, bottom) knob pairs")
    if not 1 <= device.channel <= 16:
        raise ValueError(f"{device.name}: channel {device.channel} out of range")
    for cc in device.labels:
        if not 0 <= cc < NUM_REAL_CCS or cc == MOD_WHEEL_CC:
            raise ValueError(f"{device.name}: CC {cc} can't carry a label")
    # The firmware's XML reader doesn't decode entities, so unsafe characters can't be escaped.
    for text in [*device.labels.values(), device.vendor, device.name]:
        if any(ch in text for ch in '"<>&'):
            raise ValueError(f"{device.name}: unsafe character in {text!r}")
    for pair in device.knobs:
        for cc in pair:
            if cc is not None and cc not in device.labels:
                raise ValueError(f"{device.name}: knob CC {cc} has no label")


def _cc_labels_xml(labels: dict[int, str], indent: str) -> str:
    attrs = "".join(
        f'\n{indent}\t{cc}="{labels.get(cc, "")}"'
        for cc in range(NUM_REAL_CCS)
        if cc != MOD_WHEEL_CC
    )
    return f"{indent}<ccLabels{attrs} />"


def _midi_device_xml(device: Device, indent: str, with_file_name: bool) -> str:
    lines = [f"{indent}<midiDevice>"]
    if with_file_name:
        lines.append(f'{indent}\t<definitionFile\n{indent}\t\tname="{device.definition_path}" />')
    lines.append(_cc_labels_xml(device.labels, indent + "\t"))
    lines.append(f'{indent}\t<hideUnlabeledCC\n{indent}\t\tvalue="1" />')
    lines.append(f"{indent}</midiDevice>")
    return "\n".join(lines)


def definition_xml(device: Device) -> str:
    validate(device)
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + _midi_device_xml(device, "", False) + "\n"


def preset_xml(device: Device) -> str:
    validate(device)
    knob_lines = []
    for top, bottom in device.knobs:
        for cc in (bottom, top):  # firmware stores [mode*2 + 0] = bottom knob, +1 = top knob
            value = "none" if cc is None else str(cc)
            knob_lines.append(f'\t\t<modKnob\n\t\t\tcc="{value}" />')
    return "\n".join(
        [
            '<?xml version="1.0" encoding="UTF-8"?>',
            "<midi",
            f'\tfirmwareVersion="{FIRMWARE_VERSION}"',
            f'\tearliestCompatibleFirmware="{EARLIEST_COMPATIBLE}"',
            f'\tchannel="{device.channel - 1}"',
            '\tsuffix="-1">',
            "\t<modKnobs>",
            *knob_lines,
            "\t</modKnobs>",
            "\t<polyToMonoConversion",
            '\t\taftertouch="0"',
            '\t\tmpe="1"',
            '\t\tyCC="74" />',
            _midi_device_xml(device, "\t", True),
            "</midi>",
            "",
        ]
    )


def write_card(devices: list[Device], root: Path) -> list[Path]:
    written = []
    for device in devices:
        for rel, text in (
            (device.definition_path, definition_xml(device)),
            (device.preset_path, preset_xml(device)),
        ):
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
            written.append(path)
    return written


def explainer_html(devices: list[Device]) -> str:
    from html import escape

    def knob(cc: Knob, labels: dict[int, str]) -> str:
        if cc is None:
            return '<div class="knob off"><b>—</b><span>unassigned</span></div>'
        return f'<div class="knob"><b>CC {cc}</b><span>{escape(labels[cc])}</span></div>'

    cards = []
    for d in devices:
        rows = "".join(
            f'<div class="row"><div class="btn"><i></i>{escape(MOD_BUTTON_NAMES[i])}</div>'
            f"{knob(top, d.labels)}{knob(bottom, d.labels)}</div>"
            for i, (top, bottom) in enumerate(d.knobs)
        )
        notes = "".join(f"<li>{escape(n)}</li>" for n in d.notes)
        cards.append(
            f'<section class="card"><h2>{escape(d.vendor)} {escape(d.name)}'
            f"<small>MIDI ch {d.channel}</small></h2>"
            f'<div class="head"><span>Mod button</span><span>Top knob ▲</span>'
            f"<span>Bottom knob ▼</span></div>{rows}"
            f'<p class="files">Preset: <code>{escape(d.preset_path)}</code><br>'
            f"Definition: <code>{escape(d.definition_path)}</code></p>"
            f"<ul>{notes}</ul></section>"
        )
    template = (Path(__file__).parent / "midi_presets_explainer.html").read_text(encoding="utf-8")
    return template.replace("{{CARDS}}", "\n".join(cards))
