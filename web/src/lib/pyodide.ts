// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Python<->JS is an untyped string seam, see CLAUDE.md
export type Pyodide = any;

let pyodidePromise: Promise<Pyodide> | null = null;

export type ProgressCallback = (stage: string, pct: number) => void;

export async function loadPyodide(
  onProgress?: ProgressCallback,
): Promise<Pyodide> {
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
    // Wheel filename embeds the package version (build-wheel.sh), which drifts
    // out of sync with a hardcoded literal every version bump — read it from
    // the manifest build-wheel.sh writes alongside the wheel instead.
    const manifest = await (await fetch("/py/manifest.json")).json();
    // deps=False: the wheel's METADATA lists music21/mido as unconditional
    // dependencies (pyproject.toml `dependencies`), but the browser-loaded
    // modules (parser/converter/musicxml_writer/analyzer/card_scanner) are
    // pure stdlib and never import music21. Without this, every page load
    // pulls music21's full chain (matplotlib, numpy, Pillow, ...). mido is
    // installed separately, on demand, by convertMidiToDelugeXml below.
    // callKwargs (not a plain trailing object) is required: a normal call
    // passes {deps: false} as the positional `keep_going` arg instead,
    // which silently leaves deps at its default of True.
    await micropip.install.callKwargs(`/py/${manifest.wheel}`, { deps: false });

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
  midiChannels: number[];
  firmwareVersion: string;
  lastModified?: number;
  path?: string;
}

export async function analyzeStats(
  files: { name: string; content: string }[],
  pyodide: Pyodide,
): Promise<SongStats[]> {
  pyodide.globals.set("_js_files", JSON.stringify(files));

  const resultJson = await pyodide.runPythonAsync(`
from deluge_tools.bridges import analyze_stats_json
analyze_stats_json(_js_files)
  `);

  return JSON.parse(resultJson);
}

export async function convertMidiToDelugeXml(
  midiBytes: ArrayBuffer,
  fileName: string,
  pyodide: Pyodide,
): Promise<string> {
  await pyodide.loadPackage("micropip");
  const micropip = pyodide.pyimport("micropip");
  await micropip.install("mido");

  const uint8 = new Uint8Array(midiBytes);
  pyodide.globals.set("_js_midi_bytes", pyodide.toPy(uint8));
  pyodide.globals.set("_js_midi_name", fileName);

  return pyodide.runPythonAsync(`
from deluge_tools.bridges import convert_midi_to_deluge_xml
convert_midi_to_deluge_xml(bytes(_js_midi_bytes))
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

export interface PreviewOscPatch {
  type: string;
  transpose: number;
  cents: number;
}

export interface PreviewEnvelope {
  attack: string;
  decay: string;
  sustain: string;
  release: string;
}

export interface PreviewPatchCable {
  source: string;
  destination: string;
  amount: string;
}

export interface PreviewModulatorPatch {
  transpose: number;
  cents: number;
  toModulator1: boolean;
}

export interface PreviewPatch {
  mode: string;
  polyphonic: string;
  lpfMode: string;
  osc1: PreviewOscPatch;
  osc2: PreviewOscPatch;
  modulator1: PreviewModulatorPatch | null;
  modulator2: PreviewModulatorPatch | null;
  lfo1Type: string;
  lfo2Type: string;
  unisonNum: number;
  unisonDetune: number;
  arpMode: string;
  arpOctaves: number;
  arpSyncLevel: number;
  params: Record<string, string>;
  envelope1: PreviewEnvelope;
  envelope2: PreviewEnvelope;
  patchCables: PreviewPatchCable[];
}

export interface PreviewTrack {
  name: string;
  isKit: boolean;
  instrumentType: "synth" | "kit" | "midi" | "cv" | "audio";
  midiChannel: number | null;
  cvChannel: number | null;
  patch: PreviewPatch | null;
  clips: {
    positionTicks: number;
    lengthTicks: number;
    clipLengthTicks: number;
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
  hasArrangement: boolean;
  tracks: PreviewTrack[];
}

export async function inspectSong(
  xmlContent: string,
  pyodide: Pyodide,
): Promise<PreviewData> {
  pyodide.globals.set("_js_xml_content", xmlContent);

  const json = await pyodide.runPythonAsync(`
from deluge_tools.bridges import inspect_song_json
inspect_song_json(_js_xml_content)
  `);

  const parsed = JSON.parse(json);
  if (parsed.error) throw new Error(parsed.error);
  return parsed;
}

export async function convertToMusicXML(
  xmlContent: string,
  pyodide: Pyodide,
): Promise<string> {
  pyodide.globals.set("_js_xml_content", xmlContent);

  const result = await pyodide.runPythonAsync(`
from deluge_tools.bridges import convert_to_musicxml
convert_to_musicxml(_js_xml_content)
  `);
  if (result.startsWith("{")) {
    const parsed = JSON.parse(result);
    if (parsed.error) throw new Error(parsed.error);
  }
  return result;
}
