<script lang="ts">
  import { playPreview, stopPreview, isPlaying, type AudioPatch } from '../lib/patchAudio';
  import { trackToolAction } from '../lib/analytics';

  type Category = 'pad' | 'lead' | 'bass' | 'keys' | 'fx';
  type SynthMode = 'subtractive' | 'fm';

  interface OscConfig {
    type: string;
    transpose: number;
    cents: number;
    retrigPhase: number;
  }

  interface EnvelopeConfig {
    attack: string;
    decay: string;
    sustain: string;
    release: string;
  }

  interface Patch {
    name: string;
    category: Category;
    mode: SynthMode;
    polyphonic: string;
    transpose: number;
    osc1: OscConfig;
    osc2: OscConfig;
    modulator1?: { transpose: number; cents: number; retrigPhase: number };
    modulator2?: { transpose: number; cents: number; retrigPhase: number; toModulator1: number };
    lfo1Type: string;
    lfo2Type: string;
    unisonNum: number;
    unisonDetune: number;
    lpfMode: string;
    modFXType: string;
    delayPingPong: number;
    delayAnalog: number;
    delaySyncLevel: number;
    arpMode: string;
    arpOctaves: number;
    arpSyncLevel: number;
    params: Record<string, string>;
    envelope1: EnvelopeConfig;
    envelope2: EnvelopeConfig;
    patchCables: { source: string; destination: string; amount: string }[];
  }

  const CATEGORIES: { id: Category; label: string; desc: string }[] = [
    { id: 'pad', label: 'Pad', desc: 'Slow attacks, lush sustains' },
    { id: 'lead', label: 'Lead', desc: 'Bright, cutting, mono-friendly' },
    { id: 'bass', label: 'Bass', desc: 'Deep, punchy, low octaves' },
    { id: 'keys', label: 'Keys', desc: 'Plucky, percussive, FM tones' },
    { id: 'fx', label: 'FX', desc: 'Textures, drones, noise' },
  ];

  const SUB_OSC_TYPES = ['analogSaw', 'analogSquare', 'saw', 'square', 'sine', 'triangle'];
  const LFO_TYPES = ['sine', 'triangle', 'square', 'saw'];
  const LPF_MODES = ['24dB', '24dBDrive', '12dB', 'SVF'];
  const MOD_FX_TYPES = ['none', 'flanger', 'chorus', 'phaser'];
  const ARP_MODES = ['off', 'up', 'down', 'upDown', 'random'];
  const POLY_MODES = ['poly', 'mono', 'legato', 'choke'];

  let selectedCategory: Category = $state('lead');
  let patch: Patch | null = $state(null);
  let history: Patch[] = $state([]);
  let locked: Set<string> = $state(new Set());
  let bulkCount: number = $state(10);

  function hex(value: number): string {
    const clamped = Math.max(-2147483648, Math.min(2147483647, Math.round(value)));
    return '0x' + ((clamped >>> 0).toString(16).toUpperCase().padStart(8, '0'));
  }

  function randInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function pick<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function weightedPick<T>(items: T[], weights: number[]): T {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  function randHex(min: number, max: number): string {
    return hex(randInt(min, max));
  }

  function randHexFloat(min: number, max: number): string {
    return hex(Math.round(min + Math.random() * (max - min)));
  }

  const NAMES_ADJ = ['Cosmic', 'Velvet', 'Crystal', 'Neon', 'Shadow', 'Solar', 'Lunar', 'Arctic', 'Ember', 'Silk', 'Iron', 'Vapor', 'Mystic', 'Prism', 'Hollow', 'Deep', 'Bright', 'Warm', 'Cold', 'Wild', 'Soft', 'Sharp', 'Raw', 'Pure', 'Dark', 'Hazy', 'Lush', 'Dense', 'Thin', 'Wide'];
  const NAMES_NOUN: Record<Category, string[]> = {
    pad: ['Cloud', 'Drift', 'Wash', 'Bloom', 'Haze', 'Mist', 'Field', 'Shore', 'Dream', 'Veil'],
    lead: ['Blade', 'Spark', 'Edge', 'Beam', 'Pulse', 'Wire', 'Bolt', 'Arc', 'Ray', 'Flare'],
    bass: ['Rumble', 'Thump', 'Growl', 'Depth', 'Weight', 'Core', 'Mass', 'Quake', 'Drone', 'Stomp'],
    keys: ['Bell', 'Chime', 'Pluck', 'Tap', 'Ring', 'Tone', 'Click', 'Key', 'Mallet', 'Tine'],
    fx: ['Glitch', 'Scatter', 'Morph', 'Warp', 'Flux', 'Swirl', 'Burst', 'Fracture', 'Echo', 'Noise'],
  };

  function generateName(cat: Category): string {
    return `${pick(NAMES_ADJ)} ${pick(NAMES_NOUN[cat])}`;
  }

  function generatePatch(cat: Category): Patch {
    const mode: SynthMode = cat === 'keys' ? weightedPick(['subtractive', 'fm'], [0.4, 0.6]) :
                             cat === 'bass' ? weightedPick(['subtractive', 'fm'], [0.7, 0.3]) :
                             weightedPick(['subtractive', 'fm'], [0.8, 0.2]);

    const isFM = mode === 'fm';

    const transpose = cat === 'bass' ? pick([-24, -12]) :
                      cat === 'lead' ? pick([0, 12]) :
                      cat === 'pad'  ? pick([-12, 0]) :
                      cat === 'fx'   ? pick([-24, -12, 0, 12]) : 0;

    const polyphonic = cat === 'lead' ? weightedPick(POLY_MODES, [0.2, 0.5, 0.3, 0]) :
                       cat === 'bass' ? weightedPick(POLY_MODES, [0.3, 0.5, 0.2, 0]) :
                       cat === 'pad'  ? 'poly' :
                       cat === 'fx'   ? pick(['poly', 'mono']) : 'poly';

    let osc1: OscConfig, osc2: OscConfig;
    if (isFM) {
      osc1 = { type: 'sine', transpose: 0, cents: 0, retrigPhase: -1 };
      osc2 = { type: 'sine', transpose: 0, cents: 0, retrigPhase: -1 };
    } else {
      osc1 = {
        type: pick(SUB_OSC_TYPES),
        transpose: pick([0, 0, 0, 12, -12]),
        cents: randInt(-10, 10),
        retrigPhase: pick([-1, 0]),
      };
      osc2 = {
        type: pick(SUB_OSC_TYPES),
        transpose: pick([0, 0, 12, -12, 7]),
        cents: randInt(-15, 15),
        retrigPhase: pick([-1, 0]),
      };
    }

    let modulator1, modulator2;
    if (isFM) {
      modulator1 = { transpose: pick([0, 12, 24]), cents: randInt(-5, 5), retrigPhase: -1 };
      modulator2 = {
        transpose: pick([0, 12, 19, 24]),
        cents: randInt(-5, 5),
        retrigPhase: -1,
        toModulator1: Math.random() > 0.5 ? 1 : 0,
      };
    }

    const unisonNum = cat === 'pad' ? pick([2, 4, 6, 8]) :
                      cat === 'lead' ? pick([1, 2, 4]) :
                      cat === 'bass' ? pick([1, 1, 2]) :
                      cat === 'fx'  ? pick([1, 4, 8]) : pick([1, 2]);
    const unisonDetune = unisonNum === 1 ? 8 : randInt(5, 50);

    const lpfMode = pick(LPF_MODES);
    const modFXType = cat === 'pad' ? weightedPick(MOD_FX_TYPES, [0.2, 0.3, 0.3, 0.2]) :
                      cat === 'fx'  ? weightedPick(MOD_FX_TYPES, [0.1, 0.3, 0.2, 0.4]) :
                      weightedPick(MOD_FX_TYPES, [0.5, 0.2, 0.2, 0.1]);

    const arpMode = cat === 'lead' ? weightedPick(ARP_MODES, [0.5, 0.15, 0.1, 0.15, 0.1]) :
                    cat === 'keys' ? weightedPick(ARP_MODES, [0.4, 0.2, 0.1, 0.2, 0.1]) :
                    'off';

    let env1: EnvelopeConfig;
    if (cat === 'pad') {
      env1 = {
        attack: randHexFloat(0x20000000, 0x60000000),
        decay: randHexFloat(0x40000000, 0x7FFFFFFF),
        sustain: randHexFloat(0x40000000, 0x7FFFFFFF),
        release: randHexFloat(0x20000000, 0x60000000),
      };
    } else if (cat === 'lead') {
      env1 = {
        attack: randHexFloat(-0x80000000, -0x40000000),
        decay: randHexFloat(0x00000000, 0x60000000),
        sustain: randHexFloat(0x20000000, 0x7FFFFFFF),
        release: randHexFloat(-0x20000000, 0x20000000),
      };
    } else if (cat === 'bass') {
      env1 = {
        attack: randHexFloat(-0x80000000, -0x60000000),
        decay: randHexFloat(-0x20000000, 0x40000000),
        sustain: randHexFloat(0x00000000, 0x60000000),
        release: randHexFloat(-0x40000000, 0x00000000),
      };
    } else if (cat === 'keys') {
      env1 = {
        attack: randHexFloat(-0x80000000, -0x60000000),
        decay: randHexFloat(0x00000000, 0x60000000),
        sustain: randHexFloat(-0x20000000, 0x40000000),
        release: randHexFloat(0x00000000, 0x40000000),
      };
    } else {
      env1 = {
        attack: randHexFloat(-0x40000000, 0x60000000),
        decay: randHexFloat(-0x40000000, 0x60000000),
        sustain: randHexFloat(-0x40000000, 0x7FFFFFFF),
        release: randHexFloat(-0x20000000, 0x60000000),
      };
    }

    const env2: EnvelopeConfig = {
      attack: randHexFloat(-0x20000000, 0x40000000),
      decay: randHexFloat(0x00000000, 0x60000000),
      sustain: randHexFloat(-0x40000000, 0x7FFFFFFF),
      release: randHexFloat(0x00000000, 0x60000000),
    };

    let lpfFreq: string, lpfRes: string;
    if (cat === 'pad') {
      lpfFreq = randHexFloat(0x20000000, 0x7FFFFFFF);
      lpfRes = randHexFloat(-0x60000000, 0x00000000);
    } else if (cat === 'bass') {
      lpfFreq = randHexFloat(-0x20000000, 0x40000000);
      lpfRes = randHexFloat(-0x40000000, 0x20000000);
    } else if (cat === 'lead') {
      lpfFreq = randHexFloat(0x00000000, 0x7FFFFFFF);
      lpfRes = randHexFloat(-0x60000000, 0x00000000);
    } else {
      lpfFreq = randHexFloat(-0x20000000, 0x7FFFFFFF);
      lpfRes = randHexFloat(-0x60000000, 0x00000000);
    }

    const oscBVol = isFM ? hex(0) : randHexFloat(-0x80000000, 0x40000000);

    const params: Record<string, string> = {
      arpeggiatorGate: hex(0),
      portamento: polyphonic === 'legato' ? randHexFloat(0x00000000, 0x40000000) : hex(-0x80000000),
      compressorShape: hex(-0x23D70A4E),
      oscAVolume: hex(0x7FFFFFFF),
      oscAPulseWidth: hex(0),
      oscBVolume: oscBVol,
      oscBPulseWidth: hex(0),
      noiseVolume: cat === 'fx' ? randHexFloat(-0x60000000, 0x00000000) : hex(-0x80000000),
      volume: randHexFloat(0x30000000, 0x60000000),
      pan: hex(0),
      lpfFrequency: lpfFreq,
      lpfResonance: lpfRes,
      hpfFrequency: hex(-0x80000000),
      hpfResonance: hex(-0x80000000),
      lfo1Rate: randHexFloat(-0x40000000, 0x40000000),
      lfo2Rate: randHexFloat(-0x40000000, 0x20000000),
      modulator1Amount: isFM ? randHexFloat(-0x20000000, 0x60000000) : hex(-0x80000000),
      modulator1Feedback: isFM ? randHexFloat(-0x80000000, 0x00000000) : hex(-0x80000000),
      modulator2Amount: isFM ? randHexFloat(-0x20000000, 0x60000000) : hex(-0x80000000),
      modulator2Feedback: isFM ? randHexFloat(-0x80000000, 0x00000000) : hex(-0x80000000),
      carrier1Feedback: isFM ? randHexFloat(-0x80000000, 0x00000000) : hex(-0x80000000),
      carrier2Feedback: isFM ? randHexFloat(-0x80000000, 0x00000000) : hex(-0x80000000),
      modFXRate: modFXType !== 'none' ? randHexFloat(-0x20000000, 0x20000000) : hex(0),
      modFXDepth: modFXType !== 'none' ? randHexFloat(0x00000000, 0x40000000) : hex(0),
      delayRate: hex(0),
      delayFeedback: Math.random() > 0.6 ? randHexFloat(-0x40000000, 0x20000000) : hex(-0x80000000),
      reverbAmount: Math.random() > 0.5 ? randHexFloat(-0x40000000, 0x20000000) : hex(-0x80000000),
      arpeggiatorRate: hex(0),
      stutterRate: hex(0),
      sampleRateReduction: hex(-0x80000000),
      bitCrush: cat === 'fx' && Math.random() > 0.7 ? randHexFloat(-0x40000000, 0x00000000) : hex(-0x80000000),
      modFXOffset: hex(0),
      modFXFeedback: modFXType !== 'none' ? randHexFloat(-0x40000000, 0x20000000) : hex(0),
    };

    const patchCables = [
      { source: 'velocity', destination: 'volume', amount: hex(0x3FFFFFE8) },
    ];
    if (cat === 'pad' || cat === 'fx') {
      if (Math.random() > 0.4) {
        patchCables.push({ source: 'lfo1', destination: 'pitch', amount: randHexFloat(0x02000000, 0x10000000) });
      }
    }
    if (!isFM && Math.random() > 0.5) {
      patchCables.push({ source: 'envelope2', destination: 'lpfFrequency', amount: randHexFloat(0x10000000, 0x50000000) });
    }

    const modKnobParams = isFM
      ? ['pan', 'volumePostFX', 'modulator2Volume', 'modulator1Volume', 'env1Release', 'env1Attack',
         'delayFeedback', 'delayRate', 'reverbAmount', 'volumePostReverbSend', 'pitch', 'lfo1Rate',
         'portamento', 'stutterRate', 'modulator1Feedback', 'carrier1Feedback']
      : ['pan', 'volumePostFX', 'lpfResonance', 'lpfFrequency', 'env1Release', 'env1Attack',
         'delayFeedback', 'delayRate', 'reverbAmount', 'volumePostReverbSend', 'pitch', 'lfo1Rate',
         'portamento', 'stutterRate', 'oscAPhaseWidth', 'sampleRateReduction'];

    return {
      name: generateName(cat),
      category: cat,
      mode,
      polyphonic,
      transpose,
      osc1, osc2,
      modulator1, modulator2,
      lfo1Type: pick(LFO_TYPES),
      lfo2Type: pick(LFO_TYPES),
      unisonNum, unisonDetune,
      lpfMode, modFXType,
      delayPingPong: 1,
      delayAnalog: Math.random() > 0.5 ? 1 : 0,
      delaySyncLevel: pick([6, 7]),
      arpMode,
      arpOctaves: arpMode !== 'off' ? pick([1, 2, 3]) : 2,
      arpSyncLevel: 7,
      params,
      envelope1: env1,
      envelope2: env2,
      patchCables,
      _modKnobParams: modKnobParams,
    } as Patch & { _modKnobParams: string[] };
  }

  function generate() {
    stopPreview();
    playing = false;
    const p = generatePatch(selectedCategory);
    if (patch && locked.size > 0) {
      for (const key of locked) {
        if (key in patch.params && key in p.params) {
          p.params[key] = patch.params[key];
        }
        if (key === 'envelope1') Object.assign(p.envelope1, patch.envelope1);
        if (key === 'envelope2') Object.assign(p.envelope2, patch.envelope2);
        if (key === 'osc1') Object.assign(p.osc1, patch.osc1);
        if (key === 'osc2') Object.assign(p.osc2, patch.osc2);
        if (key === 'mode') { p.mode = patch.mode; }
        if (key === 'unison') { p.unisonNum = patch.unisonNum; p.unisonDetune = patch.unisonDetune; }
      }
    }
    patch = p;
    history = [p, ...history.slice(0, 19)];
    trackToolAction('patch', 'generate');
  }

  function toXML(p: Patch): string {
    const mp = (p as Patch & { _modKnobParams?: string[] })._modKnobParams;
    const modKnobs = (mp || []).map((param, i) => {
      let extra = '';
      if (param === 'volumePostReverbSend') extra = ' patchAmountFromSource="compressor"';
      if (param === 'pitch' && i === 10) extra = ' patchAmountFromSource="lfo1"';
      return `\t\t<modKnob controlsParam="${param}"${extra} />`;
    }).join('\n');

    const cables = p.patchCables.map(c =>
      `\t\t\t<patchCable\n\t\t\t\tsource="${c.source}"\n\t\t\t\tdestination="${c.destination}"\n\t\t\t\tamount="${c.amount}" />`
    ).join('\n');

    const paramAttrs = Object.entries(p.params).map(([k, v]) => `\t\t${k}="${v}"`).join('\n');

    const modulators = p.mode === 'fm' ? `
\t<modulator1
\t\ttranspose="${p.modulator1!.transpose}"
\t\tcents="${p.modulator1!.cents}"
\t\tretrigPhase="${p.modulator1!.retrigPhase}" />
\t<modulator2
\t\ttranspose="${p.modulator2!.transpose}"
\t\tcents="${p.modulator2!.cents}"
\t\tretrigPhase="${p.modulator2!.retrigPhase}"
\t\ttoModulator1="${p.modulator2!.toModulator1}" />` : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<sound
\tfirmwareVersion="4.1.0"
\tearliestCompatibleFirmware="4.1.0"
\tpolyphonic="${p.polyphonic}"
\tvoicePriority="1"
\tmode="${p.mode}"${p.transpose !== 0 ? `\n\ttranspose="${p.transpose}"` : ''}
\tlpfMode="${p.lpfMode}"
\tmodFXType="${p.modFXType}">
\t<osc1
\t\ttype="${p.osc1.type}"
\t\ttranspose="${p.osc1.transpose}"
\t\tcents="${p.osc1.cents}"
\t\tretrigPhase="${p.osc1.retrigPhase}" />
\t<osc2
\t\ttype="${p.osc2.type}"
\t\ttranspose="${p.osc2.transpose}"
\t\tcents="${p.osc2.cents}"
\t\tretrigPhase="${p.osc2.retrigPhase}" />${modulators}
\t<lfo1 type="${p.lfo1Type}" syncLevel="0" />
\t<lfo2 type="${p.lfo2Type}" />
\t<unison num="${p.unisonNum}" detune="${p.unisonDetune}" />
\t<compressor
\t\tsyncLevel="6"
\t\tattack="327244"
\t\trelease="936" />
\t<delay
\t\tpingPong="${p.delayPingPong}"
\t\tanalog="${p.delayAnalog}"
\t\tsyncLevel="${p.delaySyncLevel}" />
\t<arpeggiator
\t\tmode="${p.arpMode}"
\t\tnumOctaves="${p.arpOctaves}"
\t\tsyncLevel="${p.arpSyncLevel}" />
\t<modKnobs>
${modKnobs}
\t</modKnobs>
\t<defaultParams
${paramAttrs}>
\t\t<envelope1
\t\t\tattack="${p.envelope1.attack}"
\t\t\tdecay="${p.envelope1.decay}"
\t\t\tsustain="${p.envelope1.sustain}"
\t\t\trelease="${p.envelope1.release}" />
\t\t<envelope2
\t\t\tattack="${p.envelope2.attack}"
\t\t\tdecay="${p.envelope2.decay}"
\t\t\tsustain="${p.envelope2.sustain}"
\t\t\trelease="${p.envelope2.release}" />
\t\t<patchCables>
${cables}
\t\t</patchCables>
\t\t<equalizer
\t\t\tbass="0x00000000"
\t\t\ttreble="0x00000000"
\t\t\tbassFrequency="0x00000000"
\t\t\ttrebleFrequency="0x00000000" />
\t</defaultParams>
</sound>
`;
  }

  function download() {
    if (!patch) return;
    const xml = toXML(patch);
    const blob = new Blob([xml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${patch.name.replace(/\s+/g, '_')}.XML`;
    a.click();
    trackToolAction('patch', 'download');
    URL.revokeObjectURL(url);
  }

  function buildZip(files: { name: string; data: Uint8Array }[]): Uint8Array {
    const centralDir: Uint8Array[] = [];
    const parts: Uint8Array[] = [];
    let offset = 0;

    for (const file of files) {
      const nameBytes = new TextEncoder().encode(file.name);
      const localHeader = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(localHeader.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint32(18, file.data.length, true);
      lv.setUint32(22, file.data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      localHeader.set(nameBytes, 30);

      const cdEntry = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cdEntry.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint32(20, file.data.length, true);
      cv.setUint32(24, file.data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      cdEntry.set(nameBytes, 46);

      parts.push(localHeader, file.data);
      centralDir.push(cdEntry);
      offset += localHeader.length + file.data.length;
    }

    const cdSize = centralDir.reduce((a, b) => a + b.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    const total = offset + cdSize + 22;
    const result = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) { result.set(p, pos); pos += p.length; }
    for (const c of centralDir) { result.set(c, pos); pos += c.length; }
    result.set(eocd, pos);
    return result;
  }

  function bulkDownload() {
    const count = Math.max(1, Math.min(100, bulkCount));
    const files: { name: string; data: Uint8Array }[] = [];
    const usedNames = new Set<string>();

    for (let i = 0; i < count; i++) {
      const p = generatePatch(selectedCategory);
      let fileName = `${p.name.replace(/\s+/g, '_')}.XML`;
      while (usedNames.has(fileName)) {
        fileName = `${p.name.replace(/\s+/g, '_')}_${i}.XML`;
      }
      usedNames.add(fileName);
      files.push({ name: fileName, data: new TextEncoder().encode(toXML(p)) });
      history = [p, ...history.slice(0, 19)];
    }
    if (files.length > 0) patch = files[0] ? history[0] : patch;

    const zip = buildZip(files);
    const blob = new Blob([zip], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `deluge_${selectedCategory}_patches.zip`;
    a.click();
    trackToolAction('patch', 'bulk_download');
    URL.revokeObjectURL(url);
  }

  function toggleLock(key: string) {
    const next = new Set(locked);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    locked = next;
  }

  function hexToPercent(h: string): number {
    const n = parseInt(h, 16);
    const signed = n > 0x7FFFFFFF ? n - 0x100000000 : n;
    return Math.round(((signed + 0x80000000) / 0xFFFFFFFF) * 100);
  }

  function describeOsc(osc: OscConfig): string {
    const names: Record<string, string> = {
      analogSaw: 'Analog Saw', analogSquare: 'Analog Square', saw: 'Saw',
      square: 'Square', sine: 'Sine', triangle: 'Triangle', sample: 'Sample',
    };
    let s = names[osc.type] || osc.type;
    if (osc.transpose !== 0) s += ` ${osc.transpose > 0 ? '+' : ''}${osc.transpose}st`;
    if (osc.cents !== 0) s += ` ${osc.cents > 0 ? '+' : ''}${osc.cents}c`;
    return s;
  }

  interface ParamDisplay { label: string; key: string; value: number }

  function getDisplayParams(p: Patch): ParamDisplay[] {
    const items: ParamDisplay[] = [
      { label: 'Volume', key: 'volume', value: hexToPercent(p.params.volume) },
      { label: 'LPF Freq', key: 'lpfFrequency', value: hexToPercent(p.params.lpfFrequency) },
      { label: 'LPF Res', key: 'lpfResonance', value: hexToPercent(p.params.lpfResonance) },
      { label: 'Osc B Vol', key: 'oscBVolume', value: hexToPercent(p.params.oscBVolume) },
      { label: 'LFO1 Rate', key: 'lfo1Rate', value: hexToPercent(p.params.lfo1Rate) },
      { label: 'Reverb', key: 'reverbAmount', value: hexToPercent(p.params.reverbAmount) },
      { label: 'Delay FB', key: 'delayFeedback', value: hexToPercent(p.params.delayFeedback) },
    ];
    if (p.mode === 'fm') {
      items.push(
        { label: 'Mod1 Amt', key: 'modulator1Amount', value: hexToPercent(p.params.modulator1Amount) },
        { label: 'Mod2 Amt', key: 'modulator2Amount', value: hexToPercent(p.params.modulator2Amount) },
      );
    }
    if (p.params.noiseVolume !== '0x80000000') {
      items.push({ label: 'Noise', key: 'noiseVolume', value: hexToPercent(p.params.noiseVolume) });
    }
    return items;
  }

  function envDisplay(env: EnvelopeConfig): { a: number; d: number; s: number; r: number } {
    return {
      a: hexToPercent(env.attack),
      d: hexToPercent(env.decay),
      s: hexToPercent(env.sustain),
      r: hexToPercent(env.release),
    };
  }

  let playing = $state(false);

  function togglePreview() {
    if (playing) {
      stopPreview();
      playing = false;
    } else if (patch) {
      playing = true;
      trackToolAction('patch', 'preview');
      playPreview(patch as unknown as AudioPatch, () => { playing = false; });
    }
  }

  let e1 = $derived(patch ? envDisplay(patch.envelope1) : { a: 0, d: 0, s: 0, r: 0 });
  let e2 = $derived(patch ? envDisplay(patch.envelope2) : { a: 0, d: 0, s: 0, r: 0 });
  let displayParams = $derived(patch ? getDisplayParams(patch) : []);
</script>

<div class="generator">
  <div class="categories">
    {#each CATEGORIES as cat}
      <button
        class="cat-btn"
        class:active={selectedCategory === cat.id}
        onclick={() => selectedCategory = cat.id}
      >
        <span class="cat-label">{cat.label}</span>
        <span class="cat-desc">{cat.desc}</span>
      </button>
    {/each}
  </div>

  <div class="actions">
    <button class="generate-btn" onclick={generate}>
      Generate Patch
    </button>
    {#if patch}
      <button class="preview-btn" class:playing onclick={togglePreview}>
        {playing ? '■ Stop' : '▶ Preview'}
      </button>
      <button class="download-btn" onclick={download}>
        Download .XML
      </button>
    {/if}
    <div class="bulk-group">
      <input
        type="number"
        class="bulk-input"
        bind:value={bulkCount}
        min="1"
        max="100"
      />
      <button class="download-btn" onclick={bulkDownload}>
        Bulk Download .ZIP
      </button>
    </div>
  </div>

  {#if patch}
    <div class="patch-display">
      <div class="patch-header">
        <h2 class="patch-name">{patch.name}</h2>
        <div class="patch-meta">
          <span class="meta-tag">{patch.mode === 'fm' ? 'FM' : 'Subtractive'}</span>
          <span class="meta-tag">{patch.polyphonic}</span>
          {#if patch.transpose !== 0}
            <span class="meta-tag">{patch.transpose > 0 ? '+' : ''}{patch.transpose}st</span>
          {/if}
          {#if patch.arpMode !== 'off'}
            <span class="meta-tag meta-tag--teal">Arp: {patch.arpMode}</span>
          {/if}
        </div>
      </div>

      <div class="patch-grid">
        <div class="patch-section">
          <h3 class="section-title">
            Oscillators
            <button class="lock-btn" class:locked={locked.has('osc1')} onclick={() => toggleLock('osc1')} title="Lock Osc 1">&#x1F512;</button>
          </h3>
          <div class="osc-row">
            <span class="osc-label">OSC 1</span>
            <span class="osc-value">{describeOsc(patch.osc1)}</span>
          </div>
          <div class="osc-row">
            <span class="osc-label">OSC 2</span>
            <span class="osc-value">{describeOsc(patch.osc2)}</span>
          </div>
          {#if patch.mode === 'fm' && patch.modulator1}
            <div class="osc-row">
              <span class="osc-label">MOD 1</span>
              <span class="osc-value">+{patch.modulator1.transpose}st</span>
            </div>
            <div class="osc-row">
              <span class="osc-label">MOD 2</span>
              <span class="osc-value">+{patch.modulator2!.transpose}st{patch.modulator2!.toModulator1 ? ' → Mod1' : ''}</span>
            </div>
          {/if}
          <div class="osc-row">
            <span class="osc-label">Unison</span>
            <span class="osc-value">{patch.unisonNum} voice{patch.unisonNum > 1 ? 's' : ''}, {patch.unisonDetune} detune</span>
          </div>
        </div>

        <div class="patch-section">
          <h3 class="section-title">
            Envelope 1 (Amp)
            <button class="lock-btn" class:locked={locked.has('envelope1')} onclick={() => toggleLock('envelope1')} title="Lock Envelope 1">&#x1F512;</button>
          </h3>
          <div class="env-display">
            <div class="env-bar-group">
              <div class="env-bar" style="height: {e1.a}%"></div>
              <span class="env-label">A</span>
            </div>
            <div class="env-bar-group">
              <div class="env-bar" style="height: {e1.d}%"></div>
              <span class="env-label">D</span>
            </div>
            <div class="env-bar-group">
              <div class="env-bar env-bar--sustain" style="height: {e1.s}%"></div>
              <span class="env-label">S</span>
            </div>
            <div class="env-bar-group">
              <div class="env-bar" style="height: {e1.r}%"></div>
              <span class="env-label">R</span>
            </div>
          </div>
        </div>

        <div class="patch-section">
          <h3 class="section-title">
            Envelope 2 (Mod)
            <button class="lock-btn" class:locked={locked.has('envelope2')} onclick={() => toggleLock('envelope2')} title="Lock Envelope 2">&#x1F512;</button>
          </h3>
          <div class="env-display">
            <div class="env-bar-group">
              <div class="env-bar" style="height: {e2.a}%"></div>
              <span class="env-label">A</span>
            </div>
            <div class="env-bar-group">
              <div class="env-bar" style="height: {e2.d}%"></div>
              <span class="env-label">D</span>
            </div>
            <div class="env-bar-group">
              <div class="env-bar env-bar--sustain" style="height: {e2.s}%"></div>
              <span class="env-label">S</span>
            </div>
            <div class="env-bar-group">
              <div class="env-bar" style="height: {e2.r}%"></div>
              <span class="env-label">R</span>
            </div>
          </div>
        </div>

        <div class="patch-section">
          <h3 class="section-title">Parameters</h3>
          {#each displayParams as dp}
            <div class="param-row">
              <span class="param-label">{dp.label}</span>
              <div class="param-bar-track">
                <div class="param-bar-fill" style="width: {dp.value}%"></div>
              </div>
              <span class="param-value">{dp.value}%</span>
            </div>
          {/each}
        </div>

        <div class="patch-section">
          <h3 class="section-title">Effects & Routing</h3>
          <div class="osc-row">
            <span class="osc-label">Filter</span>
            <span class="osc-value">{patch.lpfMode}</span>
          </div>
          <div class="osc-row">
            <span class="osc-label">LFO 1</span>
            <span class="osc-value">{patch.lfo1Type}</span>
          </div>
          <div class="osc-row">
            <span class="osc-label">LFO 2</span>
            <span class="osc-value">{patch.lfo2Type}</span>
          </div>
          <div class="osc-row">
            <span class="osc-label">Mod FX</span>
            <span class="osc-value">{patch.modFXType}</span>
          </div>
          <div class="osc-row">
            <span class="osc-label">Delay</span>
            <span class="osc-value">{patch.delayAnalog ? 'Analog' : 'Digital'}{patch.delayPingPong ? ' Ping-Pong' : ''}</span>
          </div>
          {#if patch.patchCables.length > 1}
            <div class="osc-row">
              <span class="osc-label">Routing</span>
              <span class="osc-value">{patch.patchCables.length} patch cable{patch.patchCables.length > 1 ? 's' : ''}</span>
            </div>
          {/if}
        </div>
      </div>
    </div>

    {#if history.length > 1}
      <div class="history">
        <h3 class="section-title">History</h3>
        <div class="history-list">
          {#each history as h, i}
            <button
              class="history-item"
              class:active={h === patch}
              onclick={() => patch = h}
            >
              <span class="history-name">{h.name}</span>
              <span class="history-meta">{h.mode === 'fm' ? 'FM' : 'Sub'} · {h.category}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .generator {
    max-width: 100%;
  }

  .categories {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-bottom: 1.5rem;
  }

  .cat-btn {
    flex: 1;
    min-width: 100px;
    padding: 0.75rem 1rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    cursor: pointer;
    text-align: left;
    transition: border-color 0.08s;
    color: var(--text);
  }
  .cat-btn:hover { border-color: var(--accent); }
  .cat-btn.active {
    border-color: var(--accent);
    background: var(--accent-dim);
  }
  .cat-label {
    display: block;
    font-family: 'DM Mono', monospace;
    font-size: 0.85rem;
    font-weight: 500;
  }
  .cat-desc {
    display: block;
    font-size: 0.75rem;
    color: var(--text-secondary);
    margin-top: 0.15rem;
  }

  .actions {
    display: flex;
    gap: 0.75rem;
    margin-bottom: 2rem;
  }

  .generate-btn {
    padding: 0.7rem 2rem;
    background: var(--accent);
    color: var(--text-on-color);
    border: none;
    border-radius: 6px;
    font-family: 'DM Mono', monospace;
    font-size: 0.9rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.08s;
  }
  .generate-btn:hover { background: var(--accent-hover); }

  .preview-btn {
    padding: 0.7rem 1.5rem;
    background: transparent;
    color: var(--teal);
    border: 1px solid var(--teal);
    border-radius: 6px;
    font-family: 'DM Mono', monospace;
    font-size: 0.9rem;
    cursor: pointer;
    transition: background 0.08s;
  }
  .preview-btn:hover {
    background: color-mix(in srgb, var(--teal) 12%, transparent);
  }
  .preview-btn.playing {
    background: var(--teal);
    color: var(--text-on-color);
  }

  .download-btn {
    padding: 0.7rem 1.5rem;
    background: transparent;
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 6px;
    font-family: 'DM Mono', monospace;
    font-size: 0.9rem;
    cursor: pointer;
    transition: background 0.08s;
  }
  .download-btn:hover {
    background: var(--accent-dim);
  }

  .bulk-group {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-left: auto;
  }
  .bulk-input {
    width: 60px;
    padding: 0.55rem 0.5rem;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-family: 'DM Mono', monospace;
    font-size: 0.85rem;
    text-align: center;
  }

  .patch-display {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.5rem;
  }

  .patch-header {
    margin-bottom: 1.25rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border);
  }

  .patch-name {
    font-family: 'DM Mono', monospace;
    font-size: 1.3rem;
    font-weight: 500;
    margin-bottom: 0.5rem;
  }

  .patch-meta {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .meta-tag {
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem;
    padding: 0.2rem 0.5rem;
    background: var(--ground);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-secondary);
  }
  .meta-tag--teal { color: var(--teal); border-color: var(--teal); }

  .patch-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 1.25rem;
  }

  .patch-section {
    padding: 1rem;
    background: var(--ground);
    border-radius: 8px;
    border: 1px solid var(--border);
  }

  .section-title {
    font-family: 'DM Mono', monospace;
    font-size: 0.78rem;
    font-weight: 500;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 0.75rem;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .lock-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.7rem;
    opacity: 0.3;
    padding: 0;
    transition: opacity 0.08s;
  }
  .lock-btn:hover { opacity: 0.7; }
  .lock-btn.locked { opacity: 1; }

  .osc-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.25rem 0;
    font-size: 0.82rem;
  }
  .osc-label {
    font-family: 'DM Mono', monospace;
    font-size: 0.75rem;
    color: var(--text-secondary);
    flex-shrink: 0;
  }
  .osc-value {
    font-family: 'DM Mono', monospace;
    font-size: 0.78rem;
    text-align: right;
  }

  .env-display {
    display: flex;
    gap: 0.5rem;
    align-items: flex-end;
    height: 80px;
    padding-bottom: 1.2rem;
    position: relative;
  }

  .env-bar-group {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    height: 100%;
    justify-content: flex-end;
  }

  .env-bar {
    width: 100%;
    max-width: 30px;
    background: var(--accent);
    border-radius: 3px 3px 0 0;
    min-height: 2px;
    transition: height 0.15s;
  }
  .env-bar--sustain { background: var(--teal); }

  .env-label {
    font-family: 'DM Mono', monospace;
    font-size: 0.65rem;
    color: var(--text-secondary);
    margin-top: 0.3rem;
    position: absolute;
    bottom: 0;
  }

  .param-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.2rem 0;
    font-size: 0.8rem;
  }
  .param-label {
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem;
    color: var(--text-secondary);
    width: 70px;
    flex-shrink: 0;
  }
  .param-bar-track {
    flex: 1;
    height: 6px;
    background: var(--border);
    border-radius: 3px;
    overflow: hidden;
  }
  .param-bar-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 3px;
    transition: width 0.15s;
  }
  .param-value {
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem;
    color: var(--text-secondary);
    width: 32px;
    text-align: right;
  }

  .history {
    margin-top: 1.5rem;
  }

  .history-list {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .history-item {
    padding: 0.4rem 0.75rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    cursor: pointer;
    text-align: left;
    color: var(--text);
    transition: border-color 0.08s;
  }
  .history-item:hover { border-color: var(--accent); }
  .history-item.active { border-color: var(--accent); background: var(--accent-dim); }

  .history-name {
    display: block;
    font-family: 'DM Mono', monospace;
    font-size: 0.75rem;
    font-weight: 500;
  }
  .history-meta {
    display: block;
    font-size: 0.65rem;
    color: var(--text-secondary);
  }

  @media (max-width: 600px) {
    .categories { flex-direction: column; }
    .cat-btn { min-width: unset; }
    .patch-grid { grid-template-columns: 1fr; }
    .actions { flex-direction: column; }
    .generate-btn, .download-btn { width: 100%; }
    .bulk-group { margin-left: 0; width: 100%; }
    .bulk-input { flex-shrink: 0; }
  }
</style>
