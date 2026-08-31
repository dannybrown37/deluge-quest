export interface KitRow {
  name: string;
  samplePath: string;
  volume: number;
  pan: number;
  loopMode: "once" | "loop" | "cut";
  polyphonic: "auto" | "choke" | "mono" | "poly";
  fileHandle?: FileSystemFileHandle;
}

export interface Kit {
  name: string;
  rows: KitRow[];
  selectedIndex: number;
}

export function createEmptyRow(name = "NEW", samplePath = ""): KitRow {
  return {
    name,
    samplePath,
    volume: 80,
    pan: 0,
    loopMode: "once",
    polyphonic: "auto",
  };
}

export function createEmptyKit(name = "Kit"): Kit {
  return { name, rows: [], selectedIndex: -1 };
}

// Deluge uses signed 32-bit hex for params.
// Volume: 0x80000000 (-2147483648) = silent, 0x7FFFFFFF (2147483647) = max
// We map 0–100 linearly across the full signed range.
export function volumeToHex(v: number): string {
  const clamped = Math.max(0, Math.min(100, v));
  const val = Math.round(-2147483648 + (clamped / 100) * 4294967295);
  return toHex32(val);
}

export function hexToVolume(hex: string): number {
  const val = parseHex32(hex);
  return Math.round(((val + 2147483648) / 4294967295) * 100);
}

// Pan: 0x00000000 = center, negative = left, positive = right
// We map -50..+50 linearly across the signed range.
export function panToHex(p: number): string {
  const clamped = Math.max(-50, Math.min(50, p));
  const val = Math.round((clamped / 50) * 2147483647);
  return toHex32(val);
}

export function hexToPan(hex: string): number {
  const val = parseHex32(hex);
  return Math.round((val / 2147483647) * 50);
}

function toHex32(val: number): string {
  const unsigned = val < 0 ? val + 4294967296 : val;
  return "0x" + unsigned.toString(16).toUpperCase().padStart(8, "0");
}

function parseHex32(hex: string): number {
  const cleaned = hex.replace(/^0x/i, "");
  const unsigned = parseInt(cleaned, 16);
  return unsigned > 0x7fffffff ? unsigned - 4294967296 : unsigned;
}

const LOOP_MODE_MAP: Record<string, KitRow["loopMode"]> = {
  "0": "cut",
  "1": "once",
  "2": "loop",
};

const LOOP_MODE_TO_NUM: Record<KitRow["loopMode"], string> = {
  cut: "0",
  once: "1",
  loop: "2",
};

const POLY_MAP: Record<string, KitRow["polyphonic"]> = {
  auto: "auto",
  choke: "choke",
  "0": "mono",
  "2": "poly",
};

const POLY_TO_ATTR: Record<KitRow["polyphonic"], string> = {
  auto: "auto",
  choke: "choke",
  mono: "0",
  poly: "2",
};

function getAttrOrChild(el: Element, name: string): string | null {
  const attr = el.getAttribute(name);
  if (attr !== null) return attr;
  const child = el.querySelector(`:scope > ${name}`);
  return child?.textContent?.trim() ?? null;
}

export function parseKitXml(xml: string): Kit {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "text/xml");
  const kitEl = doc.querySelector("kit");
  if (!kitEl) throw new Error("No <kit> root element found");

  const sounds = kitEl.querySelectorAll("soundSources > sound");
  const rows: KitRow[] = [];

  for (const sound of sounds) {
    const name = getAttrOrChild(sound, "name") ?? "UNNAMED";
    const polyRaw = getAttrOrChild(sound, "polyphonic") ?? "auto";

    const osc1 = sound.querySelector("osc1");
    const samplePath = osc1 ? (getAttrOrChild(osc1, "fileName") ?? "") : "";
    const loopRaw = osc1 ? (getAttrOrChild(osc1, "loopMode") ?? "1") : "1";

    const params = sound.querySelector("defaultParams");
    const volHex = params
      ? (getAttrOrChild(params, "volume") ?? "0x4CCCCCA8")
      : "0x4CCCCCA8";
    const panHex = params
      ? (getAttrOrChild(params, "pan") ?? "0x00000000")
      : "0x00000000";

    rows.push({
      name,
      samplePath,
      volume: hexToVolume(volHex),
      pan: hexToPan(panHex),
      loopMode: LOOP_MODE_MAP[loopRaw] ?? "once",
      polyphonic: POLY_MAP[polyRaw] ?? "auto",
    });
  }

  return { name: "Kit", rows, selectedIndex: rows.length > 0 ? 0 : -1 };
}

export function generateKitXml(kit: Kit): string {
  const rows = kit.rows.map((row) => generateSoundXml(row)).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<kit
\tfirmwareVersion="4.0.0"
\tearliestCompatibleFirmware="4.0.0-beta"
\tlpfMode="24dB"
\tmodFXType="flanger"
\tmodFXCurrentParam="feedback"
\tcurrentFilterType="lpf">
\t<delay
\t\tpingPong="1"
\t\tanalog="0"
\t\tsyncLevel="7" />
\t<compressor
\t\tsyncLevel="6"
\t\tattack="327244"
\t\trelease="936" />
\t<defaultParams
\t\treverbAmount="0x80000000"
\t\tvolume="0x7FFFFFFF"
\t\tpan="0x00000000"
\t\tsidechainCompressorShape="0xDC28F5B2"
\t\tmodFXDepth="0x00000000"
\t\tmodFXRate="0xE0000000"
\t\tstutterRate="0x00000000"
\t\tsampleRateReduction="0x80000000"
\t\tbitCrush="0x80000000"
\t\tmodFXOffset="0x00000000"
\t\tmodFXFeedback="0x80000000">
\t\t<delay
\t\t\trate="0x00000000"
\t\t\tfeedback="0x80000000" />
\t\t<lpf
\t\t\tfrequency="0x7FFFFFFF"
\t\t\tresonance="0x80000000" />
\t\t<hpf
\t\t\tfrequency="0x80000000"
\t\t\tresonance="0x80000000" />
\t\t<equalizer
\t\t\tbass="0x00000000"
\t\t\ttreble="0x00000000"
\t\t\tbassFrequency="0x00000000"
\t\t\ttrebleFrequency="0x00000000" />
\t</defaultParams>
\t<soundSources>
${rows}
\t</soundSources>
\t<selectedDrumIndex>${Math.max(0, kit.selectedIndex)}</selectedDrumIndex>
</kit>
`;
}

function generateSoundXml(row: KitRow): string {
  const vol = volumeToHex(row.volume);
  const pan = panToHex(row.pan);
  const loop = LOOP_MODE_TO_NUM[row.loopMode];
  const poly = POLY_TO_ATTR[row.polyphonic];

  return `\t\t<sound
\t\t\tname="${escapeXml(row.name)}"
\t\t\tpolyphonic="${poly}"
\t\t\tvoicePriority="1"
\t\t\tmode="subtractive"
\t\t\tlpfMode="24dB"
\t\t\tmodFXType="none">
\t\t\t<osc1
\t\t\t\ttype="sample"
\t\t\t\tloopMode="${loop}"
\t\t\t\treversed="0"
\t\t\t\ttimeStretchEnable="0"
\t\t\t\ttimeStretchAmount="0"
\t\t\t\tfileName="${escapeXml(row.samplePath)}">
\t\t\t\t<zone startSamplePos="0" endSamplePos="0" />
\t\t\t</osc1>
\t\t\t<osc2
\t\t\t\ttype="sample"
\t\t\t\tloopMode="0"
\t\t\t\treversed="0"
\t\t\t\ttimeStretchEnable="0"
\t\t\t\ttimeStretchAmount="0" />
\t\t\t<lfo1 type="triangle" syncLevel="0" />
\t\t\t<lfo2 type="triangle" />
\t\t\t<unison num="1" detune="8" />
\t\t\t<delay pingPong="1" analog="0" syncLevel="7" />
\t\t\t<compressor syncLevel="6" attack="327244" release="936" />
\t\t\t<defaultParams
\t\t\t\tarpeggiatorGate="0x00000000"
\t\t\t\tportamento="0x80000000"
\t\t\t\tcompressorShape="0xDC28F5B2"
\t\t\t\toscAVolume="0x7FFFFFFF"
\t\t\t\toscAPulseWidth="0x00000000"
\t\t\t\toscAWavetablePosition="0x00000000"
\t\t\t\toscBVolume="0x80000000"
\t\t\t\toscBPulseWidth="0x00000000"
\t\t\t\toscBWavetablePosition="0x00000000"
\t\t\t\tnoiseVolume="0x80000000"
\t\t\t\tvolume="${vol}"
\t\t\t\tpan="${pan}"
\t\t\t\tlpfFrequency="0x7FFFFFFF"
\t\t\t\tlpfResonance="0x80000000"
\t\t\t\thpfFrequency="0x80000000"
\t\t\t\thpfResonance="0x80000000"
\t\t\t\tlfo1Rate="0x1999997E"
\t\t\t\tlfo2Rate="0x00000000"
\t\t\t\tmodulator1Amount="0x80000000"
\t\t\t\tmodulator1Feedback="0x80000000"
\t\t\t\tmodulator2Amount="0x80000000"
\t\t\t\tmodulator2Feedback="0x80000000"
\t\t\t\tcarrier1Feedback="0x80000000"
\t\t\t\tcarrier2Feedback="0x80000000"
\t\t\t\tmodFXRate="0x00000000"
\t\t\t\tmodFXDepth="0x00000000"
\t\t\t\tdelayRate="0x00000000"
\t\t\t\tdelayFeedback="0x80000000"
\t\t\t\treverbAmount="0x80000000"
\t\t\t\tarpeggiatorRate="0x00000000"
\t\t\t\tstutterRate="0x00000000"
\t\t\t\tsampleRateReduction="0x80000000"
\t\t\t\tbitCrush="0x80000000"
\t\t\t\tmodFXOffset="0x00000000"
\t\t\t\tmodFXFeedback="0x00000000">
\t\t\t\t<envelope1
\t\t\t\t\tattack="0x80000000"
\t\t\t\t\tdecay="0xE6666654"
\t\t\t\t\tsustain="0x7FFFFFD2"
\t\t\t\t\trelease="0x80000000" />
\t\t\t\t<envelope2
\t\t\t\t\tattack="0xE6666654"
\t\t\t\t\tdecay="0xE6666654"
\t\t\t\t\tsustain="0xFFFFFFE9"
\t\t\t\t\trelease="0xE6666654" />
\t\t\t\t<patchCables>
\t\t\t\t\t<patchCable source="velocity" destination="volume" amount="0x3FFFFFE8" />
\t\t\t\t</patchCables>
\t\t\t\t<equalizer
\t\t\t\t\tbass="0x00000000"
\t\t\t\t\ttreble="0x00000000"
\t\t\t\t\tbassFrequency="0x00000000"
\t\t\t\t\ttrebleFrequency="0x00000000" />
\t\t\t</defaultParams>
\t\t\t<arpeggiator mode="off" numOctaves="2" syncLevel="7" />
\t\t\t<modKnobs>
\t\t\t\t<modKnob controlsParam="pan" />
\t\t\t\t<modKnob controlsParam="volumePostFX" />
\t\t\t\t<modKnob controlsParam="lpfResonance" />
\t\t\t\t<modKnob controlsParam="lpfFrequency" />
\t\t\t\t<modKnob controlsParam="env1Release" />
\t\t\t\t<modKnob controlsParam="env1Attack" />
\t\t\t\t<modKnob controlsParam="delayFeedback" />
\t\t\t\t<modKnob controlsParam="delayRate" />
\t\t\t\t<modKnob controlsParam="reverbAmount" />
\t\t\t\t<modKnob controlsParam="volumePostReverbSend" patchAmountFromSource="compressor" />
\t\t\t\t<modKnob controlsParam="pitch" patchAmountFromSource="lfo1" />
\t\t\t\t<modKnob controlsParam="lfo1Rate" />
\t\t\t\t<modKnob controlsParam="pitch" />
\t\t\t\t<modKnob controlsParam="stutterRate" />
\t\t\t\t<modKnob controlsParam="bitcrushAmount" />
\t\t\t\t<modKnob controlsParam="sampleRateReduction" />
\t\t\t</modKnobs>
\t\t</sound>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
