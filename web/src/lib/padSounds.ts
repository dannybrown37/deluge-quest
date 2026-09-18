export interface PadSound {
  name: string;
  color: string;
  play: (ctx: AudioContext, dest: AudioNode, velocity: number) => void;
}

function noiseBuffer(ctx: AudioContext, dur: number): AudioBufferSourceNode {
  const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  return src;
}

function kick(ctx: AudioContext, dest: AudioNode, vel: number) {
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(150, t);
  osc.frequency.exponentialRampToValueAtTime(30, t + 0.15);
  const g = ctx.createGain();
  g.gain.setValueAtTime(vel, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
  osc.connect(g).connect(dest);
  osc.start(t);
  osc.stop(t + 0.4);
}

function snare(ctx: AudioContext, dest: AudioNode, vel: number) {
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(200, t);
  osc.frequency.exponentialRampToValueAtTime(80, t + 0.1);
  const og = ctx.createGain();
  og.gain.setValueAtTime(vel * 0.6, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
  osc.connect(og).connect(dest);
  osc.start(t);
  osc.stop(t + 0.15);

  const ns = noiseBuffer(ctx, 0.2);
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 3000;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(vel * 0.5, t);
  ng.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  ns.connect(hp).connect(ng).connect(dest);
  ns.start(t);
  ns.stop(t + 0.2);
}

function hihat(ctx: AudioContext, dest: AudioNode, vel: number) {
  const t = ctx.currentTime;
  const ns = noiseBuffer(ctx, 0.08);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 10000;
  bp.Q.value = 1;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vel * 0.4, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
  ns.connect(bp).connect(g).connect(dest);
  ns.start(t);
  ns.stop(t + 0.08);
}

function clap(ctx: AudioContext, dest: AudioNode, vel: number) {
  const t = ctx.currentTime;
  for (let i = 0; i < 3; i++) {
    const ns = noiseBuffer(ctx, 0.04);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2500;
    bp.Q.value = 3;
    const g = ctx.createGain();
    const offset = i * 0.015;
    g.gain.setValueAtTime(0, t + offset);
    g.gain.linearRampToValueAtTime(vel * 0.35, t + offset + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + offset + 0.04);
    ns.connect(bp).connect(g).connect(dest);
    ns.start(t + offset);
    ns.stop(t + offset + 0.04);
  }
  const tail = noiseBuffer(ctx, 0.15);
  const bp2 = ctx.createBiquadFilter();
  bp2.type = "bandpass";
  bp2.frequency.value = 2500;
  bp2.Q.value = 2;
  const tg = ctx.createGain();
  tg.gain.setValueAtTime(vel * 0.3, t + 0.04);
  tg.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
  tail.connect(bp2).connect(tg).connect(dest);
  tail.start(t + 0.04);
  tail.stop(t + 0.18);
}

function tom(ctx: AudioContext, dest: AudioNode, vel: number) {
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(120, t);
  osc.frequency.exponentialRampToValueAtTime(60, t + 0.2);
  const g = ctx.createGain();
  g.gain.setValueAtTime(vel * 0.8, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  osc.connect(g).connect(dest);
  osc.start(t);
  osc.stop(t + 0.3);
}

function zap(ctx: AudioContext, dest: AudioNode, vel: number) {
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(800, t);
  osc.frequency.exponentialRampToValueAtTime(50, t + 0.12);
  const g = ctx.createGain();
  g.gain.setValueAtTime(vel * 0.3, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
  osc.connect(g).connect(dest);
  osc.start(t);
  osc.stop(t + 0.12);
}

function blip(ctx: AudioContext, dest: AudioNode, vel: number) {
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(1200, t);
  osc.frequency.exponentialRampToValueAtTime(600, t + 0.06);
  const g = ctx.createGain();
  g.gain.setValueAtTime(vel * 0.35, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
  osc.connect(g).connect(dest);
  osc.start(t);
  osc.stop(t + 0.1);
}

function sweep(ctx: AudioContext, dest: AudioNode, vel: number) {
  const t = ctx.currentTime;
  const ns = noiseBuffer(ctx, 0.5);
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(200, t);
  lp.frequency.exponentialRampToValueAtTime(8000, t + 0.25);
  lp.frequency.exponentialRampToValueAtTime(200, t + 0.5);
  lp.Q.value = 8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vel * 0.3, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
  ns.connect(lp).connect(g).connect(dest);
  ns.start(t);
  ns.stop(t + 0.5);
}

export const PAD_SOUNDS: PadSound[] = [
  { name: "Kick", color: "#4488DD", play: kick },
  { name: "Snare", color: "#DD55AA", play: snare },
  { name: "Hat", color: "#DDBB33", play: hihat },
  { name: "Clap", color: "#5AABAC", play: clap },
  { name: "Tom", color: "#CC3030", play: tom },
  { name: "Zap", color: "#AACC30", play: zap },
  { name: "Blip", color: "#3355CC", play: blip },
  { name: "Sweep", color: "#FF6622", play: sweep },
];

export function velocityForPosition(
  localRow: number,
  localCol: number,
): number {
  const index = localRow * 4 + localCol;
  const maxVel = 1.0;
  const minVel = 0.15;
  return maxVel - (index / 15) * (maxVel - minVel);
}

export function glowForVelocity(velocity: number): number {
  return 0.2 + velocity * 0.7;
}

export class PadEffectsChain {
  ctx: AudioContext;
  input: AudioNode;
  private filter: BiquadFilterNode;
  private dryGain: GainNode;
  private wetGain: GainNode;
  private reverb: ConvolverNode;
  private delay: DelayNode;
  private delayFeedback: GainNode;
  private delayWet: GainNode;
  private master: GainNode;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;

    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 22000;

    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = 0;
    this.master = ctx.createGain();

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.createImpulse(ctx);

    this.delay = ctx.createDelay(2.0);
    this.delay.delayTime.value = 0.375;
    this.delayFeedback = ctx.createGain();
    this.delayFeedback.gain.value = 0;
    this.delayWet = ctx.createGain();
    this.delayWet.gain.value = 0;

    this.filter.connect(this.dryGain);
    this.filter.connect(this.reverb);
    this.filter.connect(this.delay);
    this.delay.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delay);
    this.delay.connect(this.delayWet);
    this.reverb.connect(this.wetGain);
    this.dryGain.connect(this.master);
    this.wetGain.connect(this.master);
    this.delayWet.connect(this.master);
    this.master.connect(ctx.destination);

    this.input = this.filter;
  }

  private createImpulse(ctx: AudioContext): AudioBuffer {
    const rate = ctx.sampleRate;
    const duration = 2;
    const decay = 3;
    const len = rate * duration;
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  updateVolume(value: number) {
    this.master.gain.value = value / 127;
  }

  updateFilter(cutoff: number, resonance: number) {
    const norm = cutoff / 127;
    this.filter.frequency.value = 80 * Math.pow(280, norm);
    this.filter.Q.value = 0.5 + (resonance / 127) * 24.5;
  }

  updateReverb(value: number) {
    const mix = value / 127;
    this.dryGain.gain.value = 1 - mix * 0.5;
    this.wetGain.gain.value = mix;
  }

  updateDelay(time: number, feedback: number) {
    this.delay.delayTime.value = 0.05 + (time / 127) * 0.75;
    this.delayFeedback.gain.value = (feedback / 127) * 0.85;
    this.delayWet.gain.value = feedback > 0 || time > 0 ? 0.4 : 0;
  }
}
