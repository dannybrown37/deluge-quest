from __future__ import annotations

import xml.etree.ElementTree as ET
from xml.dom import minidom

DIVISIONS = 48

DURATION_TABLE: list[tuple[int, str, bool, bool]] = [
    # (ticks, type, dotted, triplet)
    (4, "32nd", False, True),
    (6, "32nd", False, False),
    (8, "16th", False, True),
    (9, "32nd", True, False),
    (12, "16th", False, False),
    (16, "eighth", False, True),
    (18, "16th", True, False),
    (24, "eighth", False, False),
    (32, "quarter", False, True),
    (36, "eighth", True, False),
    (48, "quarter", False, False),
    (64, "half", False, True),
    (72, "quarter", True, False),
    (96, "half", False, False),
    (128, "whole", False, True),
    (144, "half", True, False),
    (192, "whole", False, False),
]

VALID_DURATIONS = sorted(d[0] for d in DURATION_TABLE)
TRIPLET_DURATIONS = sorted(d[0] for d in DURATION_TABLE if d[3])
STRAIGHT_DURATIONS = sorted(d[0] for d in DURATION_TABLE if not d[3])


def snap_duration(ticks: int) -> int:
    if ticks <= 0:
        return VALID_DURATIONS[0]
    best = min(VALID_DURATIONS, key=lambda v: abs(v - ticks))
    return best


def _dur_info(ticks: int) -> tuple[str, bool, bool]:
    for d_ticks, d_type, d_dot, d_trip in DURATION_TABLE:
        if d_ticks == ticks:
            return d_type, d_dot, d_trip
    snapped = snap_duration(ticks)
    return _dur_info(snapped)


def _midi_to_step_alter_octave(midi: int) -> tuple[str, int, int]:
    STEPS = ["C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B"]
    ALTERS = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0]
    pc = midi % 12
    octave = (midi // 12) - 1
    return STEPS[pc], ALTERS[pc], octave


def _add_note_element(
    measure: ET.Element,
    duration_ticks: int,
    pitch_midi: int | None = None,
    is_rest: bool = False,
    is_chord: bool = False,
    velocity: int = 80,
    notehead: str | None = None,
    lyric_text: str | None = None,
    stem: str | None = None,
    tuplet_start: bool = False,
    tuplet_stop: bool = False,
    tie_start: bool = False,
    tie_stop: bool = False,
) -> None:
    note_el = ET.SubElement(measure, "note")

    if is_chord:
        ET.SubElement(note_el, "chord")

    if is_rest:
        ET.SubElement(note_el, "rest")
    elif pitch_midi is not None:
        pitch = ET.SubElement(note_el, "pitch")
        step, alter, octave = _midi_to_step_alter_octave(pitch_midi)
        ET.SubElement(pitch, "step").text = step
        if alter:
            ET.SubElement(pitch, "alter").text = str(alter)
        ET.SubElement(pitch, "octave").text = str(octave)

    ET.SubElement(note_el, "duration").text = str(duration_ticks)
    if tie_stop:
        ET.SubElement(note_el, "tie", type="stop")
    if tie_start:
        ET.SubElement(note_el, "tie", type="start")
    ET.SubElement(note_el, "voice").text = "1"

    note_type, dotted, triplet = _dur_info(duration_ticks)
    ET.SubElement(note_el, "type").text = note_type
    if dotted:
        ET.SubElement(note_el, "dot")
    if triplet:
        tm = ET.SubElement(note_el, "time-modification")
        ET.SubElement(tm, "actual-notes").text = "3"
        ET.SubElement(tm, "normal-notes").text = "2"

    if stem:
        ET.SubElement(note_el, "stem").text = stem
    if notehead:
        ET.SubElement(note_el, "notehead").text = notehead

    if tuplet_start or tuplet_stop or tie_start or tie_stop:
        notations = ET.SubElement(note_el, "notations")
        if tie_stop:
            ET.SubElement(notations, "tied", type="stop")
        if tie_start:
            ET.SubElement(notations, "tied", type="start")
        if tuplet_start:
            ET.SubElement(notations, "tuplet", type="start", number="1")
        if tuplet_stop:
            ET.SubElement(notations, "tuplet", type="stop", number="1")

    if lyric_text:
        lyric = ET.SubElement(note_el, "lyric", number="1")
        ET.SubElement(lyric, "text").text = lyric_text


MEASURE_TICKS = DIVISIONS * 4


def _split_rests(ticks: int, triplet: bool = False) -> list[int]:
    pool = TRIPLET_DURATIONS if triplet else VALID_DURATIONS
    result: list[int] = []
    while ticks > 0:
        best = max((v for v in pool if v <= ticks), default=None)
        if best is None:
            best = pool[0]
            ticks = 0
        else:
            ticks -= best
        result.append(best)
    return result


def _build_note_seq(m_events: list, measure_ticks: int = MEASURE_TICKS) -> list[dict]:
    """Build sequence of notes and forward-gaps for a measure.

    Uses <forward> for gaps by default, then pads isolated triplet notes
    with triplet rests to form complete tuplet groups.
    """
    seq: list[dict] = []
    cursor = 0
    for offset_in_measure, evt in m_events:
        abs_pos, dur_ticks, pitches, velocity, notehead, lyric, stem = evt
        if offset_in_measure > cursor:
            seq.append({"forward": offset_in_measure - cursor})
        elif offset_in_measure < cursor:
            continue
        event_dur = min(dur_ticks, measure_ticks - offset_in_measure)
        event_dur = snap_duration(event_dur)
        seq.append({
            "dur": event_dur, "pitches": pitches,
            "velocity": velocity, "notehead": notehead,
            "lyric": lyric, "stem": stem,
        })
        cursor = offset_in_measure + event_dur
    if cursor < measure_ticks:
        seq.append({"forward": measure_ticks - cursor})
    _pad_triplet_groups(seq)
    _merge_triplet_islands(seq)
    return seq


def _pad_triplet_groups(seq: list[dict]) -> None:
    """Ensure every triplet note is part of a group of 3+ by consuming
    adjacent forward-gap time as triplet rests."""
    i = 0
    while i < len(seq):
        if seq[i].get("forward") or not _dur_info(seq[i]["dur"])[2]:
            i += 1
            continue
        run_start = i
        run_dur = 0
        while i < len(seq) and not seq[i].get("forward") and _dur_info(seq[i]["dur"])[2]:
            run_dur += seq[i]["dur"]
            i += 1
        run_end = i
        count = run_end - run_start
        if count >= 3:
            continue
        needed = 3 - count
        smallest = min(seq[j]["dur"] for j in range(run_start, run_end))
        pad_each = smallest
        total_pad = needed * pad_each
        added = 0
        if run_end < len(seq) and seq[run_end].get("forward"):
            take = min(seq[run_end]["forward"], total_pad - added)
            n_rests = take // pad_each
            for _ in range(n_rests):
                seq.insert(run_end, {"dur": pad_each, "rest": True})
                added += pad_each
                run_end += 1
                i += 1
            seq[run_end]["forward"] -= n_rests * pad_each
            if seq[run_end]["forward"] <= 0:
                seq.pop(run_end)
                i -= 1
        if added < total_pad and run_start > 0 and seq[run_start - 1].get("forward"):
            take = min(seq[run_start - 1]["forward"], total_pad - added)
            n_rests = take // pad_each
            for k in range(n_rests):
                seq.insert(run_start, {"dur": pad_each, "rest": True})
                added += pad_each
                run_start += 1
                run_end += 1
                i += 1
            seq[run_start - n_rests - 1]["forward"] -= n_rests * pad_each
            if seq[run_start - n_rests - 1]["forward"] <= 0:
                seq.pop(run_start - n_rests - 1)
                i -= 1


def _merge_triplet_islands(seq: list[dict]) -> None:
    """Merge isolated triplet notes (< 3 consecutive) into adjacent groups
    by converting intervening forwards to triplet rests and splitting
    straight notes into tied triplet equivalents."""
    changed = True
    while changed:
        changed = False
        i = 0
        while i < len(seq):
            item = seq[i]
            if item.get("forward") or item.get("rest"):
                i += 1
                continue
            dur = item.get("dur", 0)
            if dur <= 0 or not _dur_info(dur)[2]:
                i += 1
                continue
            start = i
            while i < len(seq) and not seq[i].get("forward"):
                d = seq[i].get("dur", 0)
                if d > 0 and _dur_info(d)[2]:
                    i += 1
                else:
                    break
            count = i - start
            if count >= 3:
                continue
            merged = False
            if start > 0:
                prev = seq[start - 1]
                if prev.get("forward") and prev["forward"] % 4 == 0:
                    parts = _split_rests(prev["forward"], triplet=True)
                    if sum(parts) == prev["forward"]:
                        seq[start - 1 : start] = [
                            {"dur": d, "rest": True} for d in parts
                        ]
                        merged = True
                elif not prev.get("forward") and not prev.get("rest"):
                    _, _, pt = _dur_info(prev["dur"])
                    if not pt and prev["dur"] % 4 == 0:
                        parts = _split_rests(prev["dur"], triplet=True)
                        if sum(parts) == prev["dur"] and len(parts) >= 2:
                            new_items = []
                            for k, d in enumerate(parts):
                                ni = {**prev, "dur": d}
                                ni.pop("tuplet_start", None)
                                ni.pop("tuplet_stop", None)
                                if k > 0:
                                    ni["tie_stop"] = True
                                if k < len(parts) - 1:
                                    ni["tie_start"] = True
                                new_items.append(ni)
                            seq[start - 1 : start] = new_items
                            merged = True
            if merged:
                changed = True
                break
            if i < len(seq):
                nxt = seq[i]
                if nxt.get("forward") and nxt["forward"] % 4 == 0:
                    parts = _split_rests(nxt["forward"], triplet=True)
                    if sum(parts) == nxt["forward"]:
                        seq[i : i + 1] = [
                            {"dur": d, "rest": True} for d in parts
                        ]
                        merged = True
                elif not nxt.get("forward") and not nxt.get("rest"):
                    _, _, nt = _dur_info(nxt["dur"])
                    if not nt and nxt["dur"] % 4 == 0:
                        parts = _split_rests(nxt["dur"], triplet=True)
                        if sum(parts) == nxt["dur"] and len(parts) >= 2:
                            new_items = []
                            for k, d in enumerate(parts):
                                ni = {**nxt, "dur": d}
                                ni.pop("tuplet_start", None)
                                ni.pop("tuplet_stop", None)
                                if k > 0:
                                    ni["tie_stop"] = True
                                if k < len(parts) - 1:
                                    ni["tie_start"] = True
                                new_items.append(ni)
                            seq[i : i + 1] = new_items
                            merged = True
            if merged:
                changed = True
                break
            i += 1


def _add_tuplet_brackets(seq: list[dict]) -> None:
    """Add tuplet start/stop to consecutive runs of triplet events (notes and rests)."""
    i = 0
    while i < len(seq):
        if seq[i].get("forward"):
            i += 1
            continue
        _, _, is_trip = _dur_info(seq[i]["dur"])
        if not is_trip:
            i += 1
            continue
        start = i
        while i < len(seq) and not seq[i].get("forward") and _dur_info(seq[i]["dur"])[2]:
            i += 1
        seq[start]["tuplet_start"] = True
        seq[i - 1]["tuplet_stop"] = True


class MusicXMLWriter:
    def __init__(self) -> None:
        self.parts: list[PartData] = []

    def add_part(self, part: PartData) -> None:
        self.parts.append(part)

    def to_xml(self) -> str:
        root = ET.Element("score-partwise", version="4.0")

        part_list = ET.SubElement(root, "part-list")
        for i, part in enumerate(self.parts):
            sp = ET.SubElement(part_list, "score-part", id=f"P{i}")
            ET.SubElement(sp, "part-name").text = part.name

            instr = ET.SubElement(sp, "score-instrument", id=f"P{i}-I1")
            if part.clef_sign == "percussion":
                ET.SubElement(instr, "instrument-name").text = "Percussion"
                ET.SubElement(instr, "instrument-abbreviation").text = "Perc."
            else:
                ET.SubElement(instr, "instrument-name").text = part.name
                ET.SubElement(instr, "instrument-abbreviation").text = part.name[:4]

            midi = ET.SubElement(sp, "midi-instrument", id=f"P{i}-I1")
            if part.clef_sign == "percussion":
                ET.SubElement(midi, "midi-program").text = "0"
                ET.SubElement(midi, "midi-channel").text = "10"
                ET.SubElement(midi, "midi-unpitched").text = "36"
            else:
                ET.SubElement(midi, "midi-program").text = "0"
                ET.SubElement(midi, "midi-channel").text = "1"

        max_ticks = 0
        for part in self.parts:
            if part.events:
                last = max(e[0] + e[1] for e in part.events)
                max_ticks = max(max_ticks, last)
        n_measures = max((max_ticks + MEASURE_TICKS - 1) // MEASURE_TICKS, 1)

        for i, part in enumerate(self.parts):
            part_el = ET.SubElement(root, "part", id=f"P{i}")
            events_by_measure: dict[int, list] = {}
            for evt in part.events:
                m_idx = evt[0] // MEASURE_TICKS
                offset_in_measure = evt[0] % MEASURE_TICKS
                events_by_measure.setdefault(m_idx, []).append(
                    (offset_in_measure, evt)
                )

            for m_idx in range(n_measures):
                measure = ET.SubElement(part_el, "measure", number=str(m_idx + 1))

                if m_idx == 0:
                    attrs = ET.SubElement(measure, "attributes")
                    ET.SubElement(attrs, "divisions").text = str(DIVISIONS)
                    if part.key_fifths is not None:
                        k = ET.SubElement(attrs, "key")
                        ET.SubElement(k, "fifths").text = str(part.key_fifths)
                        ET.SubElement(k, "mode").text = part.key_mode or "major"
                    ts = ET.SubElement(attrs, "time")
                    ET.SubElement(ts, "beats").text = "4"
                    ET.SubElement(ts, "beat-type").text = "4"
                    if part.clef_sign:
                        c = ET.SubElement(attrs, "clef")
                        ET.SubElement(c, "sign").text = part.clef_sign
                        ET.SubElement(c, "line").text = str(part.clef_line)

                    if part.tempo:
                        direction = ET.SubElement(measure, "direction", placement="above")
                        dt = ET.SubElement(direction, "direction-type")
                        metro = ET.SubElement(dt, "metronome")
                        ET.SubElement(metro, "beat-unit").text = "quarter"
                        ET.SubElement(metro, "per-minute").text = str(int(part.tempo))
                        ET.SubElement(direction, "sound", tempo=str(int(part.tempo)))

                m_events = events_by_measure.get(m_idx, [])
                m_events.sort(key=lambda x: x[0])

                note_seq = _build_note_seq(m_events)
                _add_tuplet_brackets(note_seq)

                for item in note_seq:
                    if item.get("forward"):
                        fwd = ET.SubElement(measure, "forward")
                        ET.SubElement(fwd, "duration").text = str(item["forward"])
                        continue
                    ts = item.get("tuplet_start", False)
                    te = item.get("tuplet_stop", False)
                    t_start = item.get("tie_start", False)
                    t_stop = item.get("tie_stop", False)
                    if item.get("rest"):
                        _add_note_element(
                            measure, item["dur"], is_rest=True,
                            tuplet_start=ts, tuplet_stop=te,
                        )
                    else:
                        for j, p in enumerate(item["pitches"]):
                            _add_note_element(
                                measure, item["dur"],
                                pitch_midi=p,
                                is_chord=(j > 0),
                                velocity=item["velocity"],
                                notehead=item["notehead"],
                                lyric_text=item["lyric"] if j == 0 else None,
                                stem=item["stem"],
                                tuplet_start=ts and j == 0,
                                tuplet_stop=te and j == 0,
                                tie_start=t_start,
                                tie_stop=t_stop,
                            )

        rough = ET.tostring(root, encoding="unicode")
        dom = minidom.parseString(rough)
        return dom.toprettyxml(indent="  ", encoding=None)


class PartData:
    def __init__(
        self,
        name: str,
        tempo: float | None = None,
        clef_sign: str = "G",
        clef_line: int = 2,
        key_fifths: int | None = None,
        key_mode: str | None = None,
    ) -> None:
        self.name = name
        self.tempo = tempo
        self.clef_sign = clef_sign
        self.clef_line = clef_line
        self.key_fifths = key_fifths
        self.key_mode = key_mode
        self.events: list[tuple[int, int, list[int], int, str | None, str | None, str | None]] = []

    def add_event(
        self,
        position_ticks: int,
        duration_ticks: int,
        pitches: list[int],
        velocity: int = 80,
        notehead: str | None = None,
        lyric: str | None = None,
        stem: str | None = None,
    ) -> None:
        dur = snap_duration(duration_ticks)
        self.events.append((position_ticks, dur, pitches, velocity, notehead, lyric, stem))
