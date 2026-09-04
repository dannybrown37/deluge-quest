import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPyodide } from "pyodide";
import {
  analyzeStats,
  convertMidiToDelugeXml,
  inspectSong,
  convertToMusicXML,
  type Pyodide,
} from "./pyodide";

// Runs the real deluge_tools wheel inside a real Pyodide/WASM runtime — no
// DOM mocks, no fakes. Separate from the fast unit suite: `npm run
// test:integration` / `just web-test-pyodide`. First run downloads Pyodide's
// package set over the network (cached in node_modules after that).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WHEEL_PATH = path.resolve(
  __dirname,
  "../../public/py/deluge_tools-0.1.0-py3-none-any.whl"
);
const FIXTURE_XML_PATH = path.resolve(
  __dirname,
  "../../../tests/fixtures/square_spelunking.XML"
);

// Built with mido (matches tests/test_midi_to_deluge.py's own fixtures):
// one MThd + one MTrk, a single quarter note at note 60, velocity 64.
const TINY_MIDI_BYTES = new Uint8Array([
  0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01,
  0x00, 0x60, 0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x0c, 0x00, 0x90,
  0x3c, 0x40, 0x60, 0x80, 0x3c, 0x40, 0x00, 0xff, 0x2f, 0x00,
]);

let pyodide: Pyodide;
let fixtureXml: string;

beforeAll(async () => {
  fixtureXml = fs.readFileSync(FIXTURE_XML_PATH, "utf-8");

  pyodide = await loadPyodide();
  await pyodide.loadPackage("micropip");
  const micropip = pyodide.pyimport("micropip");

  const wheelName = path.basename(WHEEL_PATH);
  pyodide.FS.writeFile(`/tmp/${wheelName}`, fs.readFileSync(WHEEL_PATH));
  // Mirrors the deps: false install in pyodide.ts's loadPyodide() — the
  // wheel's METADATA lists music21/mido unconditionally, but the
  // browser-loaded modules never import them. callKwargs is required for a
  // JS object to become Python kwargs (see the comment in pyodide.ts).
  await micropip.install.callKwargs(`emfs:/tmp/${wheelName}`, {
    deps: false,
  });
}, 120_000);

describe("pyodide.ts bridge functions against a real Pyodide runtime", () => {
  it("does not pull in music21's dependency chain (deps: false)", async () => {
    const installedJson: string = await pyodide.runPythonAsync(`
import importlib.util, json
json.dumps([
    name
    for name in ("music21", "matplotlib", "numpy")
    if importlib.util.find_spec(name) is not None
])
    `);

    expect(JSON.parse(installedJson)).toEqual([]);
  });

  it("analyzeStats parses a real song into stats", async () => {
    const [stats] = await analyzeStats(
      [{ name: "square_spelunking.XML", content: fixtureXml }],
      pyodide
    );

    expect(stats.filename).toBe("square_spelunking.XML");
    expect(stats.bpm).toBeGreaterThan(20);
    expect(stats.bpm).toBeLessThan(300);
    expect(stats.hasArrangement).toBe(true);
    expect(stats.totalNotes).toBeGreaterThan(0);
    expect(stats.key).not.toMatch(/^Error/);
  });

  it("analyzeStats reports a per-file error instead of throwing", async () => {
    const [stats] = await analyzeStats(
      [{ name: "broken.XML", content: "this is not xml at all" }],
      pyodide
    );

    expect(stats.filename).toBe("broken.XML");
    expect(stats.key).toMatch(/^Error/);
  });

  it("inspectSong returns tracks whose clip/note breakdown is internally consistent", async () => {
    const data = await inspectSong(fixtureXml, pyodide);

    expect(data.hasArrangement).toBe(true);
    expect(data.trackCount).toBe(data.tracks.length);
    expect(data.trackCount).toBeGreaterThan(0);

    const notesFromTracks = data.tracks
      .flatMap((t) => t.clips)
      .flatMap((c) => c.noteRows)
      .flatMap((r) => r.notes).length;
    expect(notesFromTracks).toBeGreaterThan(0);
  });

  it("convertToMusicXML produces a well-formed MusicXML document", async () => {
    const xml = await convertToMusicXML(fixtureXml, pyodide);

    expect(xml).toContain("<score-partwise");
    expect(xml).toContain("</score-partwise>");
  });

  it("convertMidiToDelugeXml converts a real MIDI file into Deluge song XML", async () => {
    const xml = await convertMidiToDelugeXml(
      TINY_MIDI_BYTES.buffer,
      "tiny.mid",
      pyodide
    );

    expect(xml).toContain("<song");
    expect(xml).toContain('firmwareVersion="3.0.0"');
  });
});
