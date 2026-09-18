import { createEmptyRow, type Kit } from "./kitXml";

type SynthFn = (ctx: OfflineAudioContext, dest: AudioNode) => void;

interface DrumDef {
  name: string;
  duration: number;
  synth: SynthFn;
}

function noiseBuffer(
  ctx: BaseAudioContext,
  dur: number,
): AudioBufferSourceNode {
  const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  return src;
}

function kick(ctx: OfflineAudioContext, dest: AudioNode) {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(300, 0);
  osc.frequency.exponentialRampToValueAtTime(40, 0.12);

  const click = ctx.createOscillator();
  click.type = "square";
  click.frequency.setValueAtTime(1200, 0);
  click.frequency.exponentialRampToValueAtTime(40, 0.015);
  const clickGain = ctx.createGain();
  clickGain.gain.setValueAtTime(0.4, 0);
  clickGain.gain.exponentialRampToValueAtTime(0.001, 0.015);

  const g = ctx.createGain();
  g.gain.setValueAtTime(1.0, 0);
  g.gain.setValueAtTime(1.0, 0.12);
  g.gain.exponentialRampToValueAtTime(0.001, 0.8);

  osc.connect(g).connect(dest);
  click.connect(clickGain).connect(dest);
  osc.start(0);
  osc.stop(0.8);
  click.start(0);
  click.stop(0.015);
}

function snare(ctx: OfflineAudioContext, dest: AudioNode) {
  const body = ctx.createOscillator();
  body.type = "triangle";
  body.frequency.setValueAtTime(200, 0);
  body.frequency.exponentialRampToValueAtTime(80, 0.08);
  const bg = ctx.createGain();
  bg.gain.setValueAtTime(0.7, 0);
  bg.gain.exponentialRampToValueAtTime(0.001, 0.12);
  body.connect(bg).connect(dest);
  body.start(0);
  body.stop(0.12);

  const ns = noiseBuffer(ctx, 0.25);
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 2000;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.5, 0);
  ng.gain.exponentialRampToValueAtTime(0.001, 0.25);
  ns.connect(hp).connect(ng).connect(dest);
  ns.start(0);
  ns.stop(0.25);
}

function closedHat(ctx: OfflineAudioContext, dest: AudioNode) {
  const ns = noiseBuffer(ctx, 0.06);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 10000;
  bp.Q.value = 1;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 7000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.35, 0);
  g.gain.exponentialRampToValueAtTime(0.001, 0.06);
  ns.connect(bp).connect(hp).connect(g).connect(dest);
  ns.start(0);
  ns.stop(0.06);
}

function openHat(ctx: OfflineAudioContext, dest: AudioNode) {
  const ns = noiseBuffer(ctx, 0.5);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 10000;
  bp.Q.value = 1;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 7000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.35, 0);
  g.gain.exponentialRampToValueAtTime(0.001, 0.5);
  ns.connect(bp).connect(hp).connect(g).connect(dest);
  ns.start(0);
  ns.stop(0.5);
}

function clap(ctx: OfflineAudioContext, dest: AudioNode) {
  for (let i = 0; i < 3; i++) {
    const ns = noiseBuffer(ctx, 0.03);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2500;
    bp.Q.value = 3;
    const g = ctx.createGain();
    const offset = i * 0.012;
    g.gain.setValueAtTime(0, offset);
    g.gain.linearRampToValueAtTime(0.4, offset + 0.003);
    g.gain.exponentialRampToValueAtTime(0.001, offset + 0.03);
    ns.connect(bp).connect(g).connect(dest);
    ns.start(offset);
    ns.stop(offset + 0.03);
  }
  const tail = noiseBuffer(ctx, 0.18);
  const bp2 = ctx.createBiquadFilter();
  bp2.type = "bandpass";
  bp2.frequency.value = 2500;
  bp2.Q.value = 2;
  const tg = ctx.createGain();
  tg.gain.setValueAtTime(0.35, 0.035);
  tg.gain.exponentialRampToValueAtTime(0.001, 0.2);
  tail.connect(bp2).connect(tg).connect(dest);
  tail.start(0.035);
  tail.stop(0.2);
}

function rim(ctx: OfflineAudioContext, dest: AudioNode) {
  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(800, 0);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.6, 0);
  g.gain.exponentialRampToValueAtTime(0.001, 0.04);
  osc.connect(g).connect(dest);
  osc.start(0);
  osc.stop(0.04);

  const osc2 = ctx.createOscillator();
  osc2.type = "square";
  osc2.frequency.setValueAtTime(1400, 0);
  const g2 = ctx.createGain();
  g2.gain.setValueAtTime(0.3, 0);
  g2.gain.exponentialRampToValueAtTime(0.001, 0.02);
  osc2.connect(g2).connect(dest);
  osc2.start(0);
  osc2.stop(0.02);
}

function loTom(ctx: OfflineAudioContext, dest: AudioNode) {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(150, 0);
  osc.frequency.exponentialRampToValueAtTime(60, 0.15);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.85, 0);
  g.gain.exponentialRampToValueAtTime(0.001, 0.35);
  osc.connect(g).connect(dest);
  osc.start(0);
  osc.stop(0.35);
}

function cowbell(ctx: OfflineAudioContext, dest: AudioNode) {
  const osc1 = ctx.createOscillator();
  osc1.type = "square";
  osc1.frequency.value = 587;
  const osc2 = ctx.createOscillator();
  osc2.type = "square";
  osc2.frequency.value = 845;

  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 800;
  bp.Q.value = 3;

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.35, 0);
  g.gain.exponentialRampToValueAtTime(0.001, 0.3);

  osc1.connect(bp);
  osc2.connect(bp);
  bp.connect(g).connect(dest);
  osc1.start(0);
  osc2.start(0);
  osc1.stop(0.3);
  osc2.stop(0.3);
}

const DRUM_808_DEFS: DrumDef[] = [
  { name: "KICK", duration: 0.85, synth: kick },
  { name: "SNARE", duration: 0.3, synth: snare },
  { name: "CL HAT", duration: 0.08, synth: closedHat },
  { name: "OP HAT", duration: 0.55, synth: openHat },
  { name: "CLAP", duration: 0.25, synth: clap },
  { name: "RIM", duration: 0.06, synth: rim },
  { name: "LO TOM", duration: 0.4, synth: loTom },
  { name: "COWBELL", duration: 0.35, synth: cowbell },
];

export const DRUM_808_NAMES = DRUM_808_DEFS.map((d) => d.name);

const SAMPLE_RATE = 44100;

export async function render808Buffers(): Promise<Map<string, AudioBuffer>> {
  const map = new Map<string, AudioBuffer>();
  for (const def of DRUM_808_DEFS) {
    const length = Math.ceil(SAMPLE_RATE * def.duration);
    const ctx = new OfflineAudioContext(1, length, SAMPLE_RATE);
    def.synth(ctx, ctx.destination);
    const buffer = await ctx.startRendering();
    map.set(def.name, buffer);
  }
  return map;
}

export function create808Kit(): Kit {
  return {
    name: "808",
    rows: DRUM_808_NAMES.map((name) => createEmptyRow(name, "")),
    selectedIndex: 0,
  };
}

const _ = false;
const X = true;

export const DEFAULT_808_PATTERN: boolean[][] = [
  [X, _, _, _, _, _, X, _, X, _, _, _, _, _, _, _], // KICK
  [_, _, _, _, X, _, _, _, _, _, _, _, X, _, _, _], // SNARE
  [X, _, X, _, X, _, X, _, X, _, X, _, X, _, X, _], // CL HAT
  [_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _], // OP HAT
  [_, _, _, _, X, _, _, _, _, _, _, _, X, _, _, _], // CLAP
  [_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _], // RIM
  [_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _], // LO TOM
  [_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _], // COWBELL
];
