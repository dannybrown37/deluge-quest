import re
from dataclasses import replace
from pathlib import Path

import pytest

from deluge_tools.midi_preset_devices import DEVICES, P90, PEAK
from deluge_tools.midi_presets import (
    NUM_REAL_CCS,
    definition_xml,
    explainer_html,
    preset_xml,
    validate,
    write_card,
)


def _mod_knobs(xml: str) -> list[str]:
    return re.findall(r'<modKnob\s+cc="([^"]+)"', xml)


def _labels(xml: str) -> dict[int, str]:
    block = re.search(r"<ccLabels(.*?)/>", xml, re.S)
    assert block
    return {int(k): v for k, v in re.findall(r'(\d+)="([^"]*)"', block.group(1))}


@pytest.mark.parametrize("device", DEVICES, ids=lambda d: d.name)
def test_every_device_validates(device):
    validate(device)


@pytest.mark.parametrize("device", DEVICES, ids=lambda d: d.name)
def test_preset_has_16_knobs_bottom_first(device):
    knobs = _mod_knobs(preset_xml(device))
    assert len(knobs) == 16
    for mode, (top, bottom) in enumerate(device.knobs):
        assert knobs[mode * 2] == ("none" if bottom is None else str(bottom))
        assert knobs[mode * 2 + 1] == ("none" if top is None else str(top))


@pytest.mark.parametrize("device", DEVICES, ids=lambda d: d.name)
def test_labels_cover_all_real_ccs_except_mod_wheel(device):
    labels = _labels(definition_xml(device))
    assert sorted(labels) == [cc for cc in range(NUM_REAL_CCS) if cc != 1]
    assert {cc: v for cc, v in labels.items() if v} == device.labels


def test_preset_links_definition_and_zero_indexes_channel():
    xml = preset_xml(PEAK)
    assert 'name="MIDI_DEVICES/DEFINITION/Novation/Peak.xml"' in xml
    assert 'channel="0"' in xml
    assert "<definitionFile" not in definition_xml(PEAK)


@pytest.mark.parametrize(
    "change, msg",
    [
        ({"knobs": PEAK.knobs[:7]}, "knob pairs"),
        ({"channel": 17}, "channel"),
        ({"labels": {**PEAK.labels, 1: "Mod"}}, "can't carry"),
        ({"labels": {**PEAK.labels, 120: "x"}}, "can't carry"),
        ({"knobs": ((2, None),) + PEAK.knobs[1:]}, "no label"),
        ({"labels": {**PEAK.labels, 7: 'Vol "x"'}}, "unsafe"),
        ({"labels": {**PEAK.labels, 7: "A&B"}}, "unsafe"),
        ({"name": "P<k"}, "unsafe"),
    ],
)
def test_validate_rejects(change, msg):
    with pytest.raises(ValueError, match=msg):
        validate(replace(PEAK, **change))


def test_explainer_lists_every_knob_and_escapes():
    html = explainer_html(DEVICES + [replace(P90, name="<P>")])
    for d in DEVICES:
        for pair in d.knobs:
            for cc in pair:
                if cc is not None:
                    assert f"CC {cc}</b><span>" in html
    assert "&lt;P&gt;" in html and "<P>" not in html
    assert "{{CARDS}}" not in html


def test_write_card(tmp_path: Path):
    paths = write_card(DEVICES, tmp_path)
    assert len(paths) == 2 * len(DEVICES)
    assert (tmp_path / "MIDI/Yamaha/P-90.xml").exists()
    assert (tmp_path / "MIDI_DEVICES/DEFINITION/Roland/System-8.xml").exists()
