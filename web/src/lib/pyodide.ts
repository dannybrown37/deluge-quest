let pyodidePromise: Promise<any> | null = null;

export type ProgressCallback = (stage: string, pct: number) => void;

export async function loadPyodide(onProgress?: ProgressCallback): Promise<any> {
  if (pyodidePromise) return pyodidePromise;

  pyodidePromise = (async () => {
    onProgress?.("Loading Python runtime", 10);

    const { loadPyodide: load } = await import(
      "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/pyodide.mjs"
    );

    onProgress?.("Initializing Pyodide", 40);
    const pyodide = await load();

    onProgress?.("Loading deluge_tools", 70);
    await pyodide.loadPackage("micropip");
    const micropip = pyodide.pyimport("micropip");
    await micropip.install("/py/deluge_tools-0.1.0-py3-none-any.whl");

    onProgress?.("Ready", 100);
    return pyodide;
  })();

  return pyodidePromise;
}

export interface SongStats {
  filename: string;
  bpm: number;
  key: string;
  hasArrangement: boolean;
  instrumentCount: number;
  synthCount: number;
  kitCount: number;
  midiCount: number;
  cvCount: number;
  audioCount: number;
  clipCount: number;
  totalNotes: number;
  durationStr: string;
  lastModified?: number;
}

export async function analyzeStats(
  files: { name: string; content: string }[],
  pyodide: any
): Promise<SongStats[]> {
  pyodide.globals.set("_js_files", JSON.stringify(files));

  const resultJson = await pyodide.runPythonAsync(`
import json, tempfile, os
from deluge_tools.parser import parse_song
from deluge_tools.analyzer import analyze_song

_files = json.loads(_js_files)
_results = []

for _f in _files:
    _tmp = tempfile.NamedTemporaryFile(mode='w', suffix='.XML', delete=False)
    _tmp.write(_f["content"])
    _tmp.close()
    try:
        _song = parse_song(_tmp.name)
        _stats = analyze_song(_song)
        _results.append({
            "filename": _f["name"],
            "bpm": _stats.bpm,
            "key": _stats.key,
            "hasArrangement": _stats.has_arrangement,
            "instrumentCount": _stats.instrument_count,
            "synthCount": _stats.synth_count,
            "kitCount": _stats.kit_count,
            "midiCount": _stats.midi_count,
            "cvCount": _stats.cv_count,
            "audioCount": _stats.audio_count,
            "clipCount": _stats.clip_count,
            "totalNotes": _stats.total_notes,
            "durationStr": _stats.duration_str if _stats.has_arrangement else "-",
        })
    except Exception as _e:
        _results.append({
            "filename": _f["name"],
            "bpm": 0,
            "key": "Error: " + str(_e),
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
        })
    finally:
        os.unlink(_tmp.name)

json.dumps(_results)
  `);

  return JSON.parse(resultJson);
}

export async function convertMidiToDelugeXml(
  midiBytes: ArrayBuffer,
  fileName: string,
  pyodide: any
): Promise<string> {
  await pyodide.loadPackage("micropip");
  const micropip = pyodide.pyimport("micropip");
  await micropip.install("mido");

  const uint8 = new Uint8Array(midiBytes);
  pyodide.globals.set("_js_midi_bytes", pyodide.toPy(uint8));
  pyodide.globals.set("_js_midi_name", fileName);

  return pyodide.runPythonAsync(`
import tempfile, os
from deluge_tools.midi_to_deluge import midi_to_deluge_xml

_midi_tmp = tempfile.NamedTemporaryFile(suffix='.mid', delete=False)
_midi_tmp.write(bytes(_js_midi_bytes))
_midi_tmp.close()

_out_tmp = tempfile.NamedTemporaryFile(suffix='.XML', delete=False)
_out_tmp.close()

try:
    midi_to_deluge_xml(_midi_tmp.name, _out_tmp.name)
    with open(_out_tmp.name, 'r') as _f:
        _result = _f.read()
finally:
    os.unlink(_midi_tmp.name)
    os.unlink(_out_tmp.name)

_result
  `);
}

export interface PreviewNote {
  pos: number;
  len: number;
  vel: number;
}

export interface PreviewNoteRow {
  y: number | null;
  drumName: string | null;
  samplePath: string | null;
  notes: PreviewNote[];
}

export interface PreviewTrack {
  name: string;
  isKit: boolean;
  instrumentType: "synth" | "kit" | "midi" | "cv" | "audio";
  midiChannel: number | null;
  cvChannel: number | null;
  clips: {
    positionTicks: number;
    lengthTicks: number;
    clipIndex: number;
    noteCount: number;
    rowCount: number;
    noteRows: PreviewNoteRow[];
  }[];
}

export interface PreviewData {
  bpm: number;
  key: string;
  durationTicks: number;
  durationStr: string;
  ticksPerQuarter: number;
  trackCount: number;
  totalNotes: number;
  tracks: PreviewTrack[];
}

export async function inspectSong(
  xmlContent: string,
  pyodide: any
): Promise<PreviewData> {
  pyodide.globals.set("_js_xml_content", xmlContent);

  const json = await pyodide.runPythonAsync(`
import json, tempfile, os
from deluge_tools.parser import parse_song, TICKS_PER_QUARTER
from deluge_tools.analyzer import analyze_song

_tmpfile = tempfile.NamedTemporaryFile(mode='w', suffix='.XML', delete=False)
_tmpfile.write(_js_xml_content)
_tmpfile.close()

try:
    _song = parse_song(_tmpfile.name)
    _stats = analyze_song(_song)
    _clip_note_counts = {}
    _clip_row_counts = {}
    _clip_note_rows = {}
    for _c in _song.clips:
        _clip_note_counts[_c.index] = sum(len(r.notes) for r in _c.rows)
        _clip_row_counts[_c.index] = len(_c.rows)
        _rows = []
        for _r in _c.rows:
            if _r.notes:
                _rows.append({
                    "y": _r.y,
                    "drumName": _r.drum_name,
                    "samplePath": _r.sample_path,
                    "notes": [{"pos": _n.position, "len": _n.length, "vel": _n.velocity} for _n in _r.notes],
                })
        _clip_note_rows[_c.index] = _rows

    _audio_clip_map = {_ac.index: _ac for _ac in _song.audio_clips}

    _has_arrangement = any(_inst.clip_instances for _inst in _song.instruments)

    _tracks = []
    for _inst in _song.instruments:
        if _has_arrangement and not _inst.clip_instances:
            continue

        _clips = []
        if _inst.clip_instances:
            for _ci in _inst.clip_instances:
                _clips.append({
                    "positionTicks": _ci.position,
                    "lengthTicks": _ci.length,
                    "clipIndex": _ci.clip_index,
                    "noteCount": _clip_note_counts.get(_ci.clip_index, 0),
                    "rowCount": _clip_row_counts.get(_ci.clip_index, 0),
                    "noteRows": _clip_note_rows.get(_ci.clip_index, []),
                })
        else:
            _pos = 0
            for _c in _song.clips:
                if _c.instrument_slot == _inst.slot and _c.instrument_sub_slot == _inst.sub_slot:
                    _clips.append({
                        "positionTicks": _pos,
                        "lengthTicks": _c.length,
                        "clipIndex": _c.index,
                        "noteCount": _clip_note_counts.get(_c.index, 0),
                        "rowCount": _clip_row_counts.get(_c.index, 0),
                        "noteRows": _clip_note_rows.get(_c.index, []),
                    })
                    _pos += _c.length
        if not _clips:
            continue

        _name = _inst.name or f"Instrument {_inst.slot}"
        if _inst.instrument_type == "audio" and _inst.clip_instances:
            _ac = _audio_clip_map.get(_inst.clip_instances[0].clip_index)
            if _ac and _ac.file_path:
                _name = _ac.file_path.rsplit("/", 1)[-1]
        _tracks.append({
            "name": _name,
            "isKit": _inst.is_kit,
            "instrumentType": _inst.instrument_type,
            "midiChannel": _inst.midi_channel,
            "cvChannel": _inst.cv_channel,
            "clips": _clips,
        })

    if _has_arrangement:
        _dur_ticks = _stats.arrangement_length_ticks
        _dur_str = _stats.duration_str
    else:
        _dur_ticks = max((c["positionTicks"] + c["lengthTicks"] for t in _tracks for c in t["clips"]), default=0)
        _total_secs = _dur_ticks / TICKS_PER_QUARTER * 60.0 / _stats.bpm if _stats.bpm > 0 else 0
        _dur_str = f"{int(_total_secs // 60)}:{int(_total_secs % 60):02d}" if _dur_ticks > 0 else "-"

    _result = {
        "bpm": _stats.bpm,
        "key": _stats.key,
        "durationTicks": _dur_ticks,
        "durationStr": _dur_str,
        "ticksPerQuarter": TICKS_PER_QUARTER,
        "trackCount": len(_tracks),
        "totalNotes": _stats.total_notes,
        "tracks": _tracks,
    }
finally:
    os.unlink(_tmpfile.name)

json.dumps(_result)
  `);

  return JSON.parse(json);
}

export async function convertToMusicXML(
  xmlContent: string,
  pyodide: any
): Promise<string> {
  pyodide.globals.set("_js_xml_content", xmlContent);

  return pyodide.runPythonAsync(`
from deluge_tools.parser import parse_song
from deluge_tools.converter import song_to_musicxml
import tempfile, os

_tmpfile = tempfile.NamedTemporaryFile(mode='w', suffix='.XML', delete=False)
_tmpfile.write(_js_xml_content)
_tmpfile.close()

try:
    _song = parse_song(_tmpfile.name)
    _result = song_to_musicxml(_song)
finally:
    os.unlink(_tmpfile.name)

_result
  `);
}
