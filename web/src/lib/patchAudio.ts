type OscConfig = {
  type: string;
  transpose: number;
  cents: number;
  retrigPhase: number;
};

type EnvelopeConfig = {
  attack: string;
  decay: string;
  sustain: string;
  release: string;
};

type PatchCable = { source: string; destination: string; amount: string };

export interface AudioPatch {
  mode: 'subtractive' | 'fm';
  category: string;
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
  patchCables: PatchCable[];
}

export function hexToNorm(h: string): number {
  const n = parseInt(h, 16);
  const signed = n > 0x7FFFFFFF ? n - 0x100000000 : n;
  return (signed + 0x80000000) / 0xFFFFFFFF;
}

export function envAttackTime(h: string): number {
  return 0.001 * Math.pow(8000, hexToNorm(h));
}

export function envDecayReleaseTime(h: string): number {
  return 0.01 * Math.pow(2000, hexToNorm(h));
}

export function envSustainLevel(h: string): number {
  return Math.max(0, Math.min(1, hexToNorm(h)));
}

export function lpfFreqHz(h: string): number {
  return 20 * Math.pow(1000, hexToNorm(h));
}

export function lpfResQ(h: string): number {
  return 0.5 + hexToNorm(h) * 20;
}

function lfoRateHz(h: string): number {
  return 0.05 * Math.pow(400, hexToNorm(h));
}

function volumeLevel(h: string): number {
  const t = hexToNorm(h);
  return t * t;
}

const OSC_MAP: Record<string, OscillatorType> = {
  analogSaw: 'sawtooth',
  analogSquare: 'square',
  saw: 'sawtooth',
  square: 'square',
  sine: 'sine',
  triangle: 'triangle',
};

const LFO_MAP: Record<string, OscillatorType> = {
  sine: 'sine',
  triangle: 'triangle',
  square: 'square',
  saw: 'sawtooth',
};

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

const PREVIEW_NOTES: Record<string, number[]> = {
  pad:  [60, 63, 67],
  lead: [72],
  bass: [36],
  keys: [60, 64, 67],
  fx:   [60],
};

const ARP_PATTERNS: Record<string, (notes: number[], octaves: number) => number[]> = {
  up: (notes, oct) => {
    const seq: number[] = [];
    for (let o = 0; o < oct; o++) for (const n of notes) seq.push(n + o * 12);
    return seq;
  },
  down: (notes, oct) => {
    const seq: number[] = [];
    for (let o = oct - 1; o >= 0; o--) for (const n of [...notes].reverse()) seq.push(n + o * 12);
    return seq;
  },
  upDown: (notes, oct) => {
    const up = ARP_PATTERNS.up(notes, oct);
    return [...up, ...up.slice(1, -1).reverse()];
  },
  random: (notes, oct) => {
    const pool: number[] = [];
    for (let o = 0; o < oct; o++) for (const n of notes) pool.push(n + o * 12);
    const seq: number[] = [];
    for (let i = 0; i < 8; i++) seq.push(pool[Math.floor(Math.random() * pool.length)]);
    return seq;
  },
};

let activeCtx: AudioContext | null = null;
let stopTimer: number | null = null;

export function isPlaying(): boolean {
  return activeCtx !== null && activeCtx.state === 'running';
}

export function stopPreview() {
  if (stopTimer !== null) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
  if (activeCtx) {
    try { activeCtx.close(); } catch {}
    activeCtx = null;
  }
}

export function playPreview(patch: AudioPatch, onStop?: () => void) {
  stopPreview();

  const ctx = new AudioContext({ sampleRate: 44100 });
  activeCtx = ctx;

  const masterGain = ctx.createGain();
  const vol = volumeLevel(patch.params.volume);
  masterGain.gain.value = vol * 0.4;

  const lpf = ctx.createBiquadFilter();
  lpf.type = 'lowpass';
  lpf.frequency.value = Math.min(20000, lpfFreqHz(patch.params.lpfFrequency));
  lpf.Q.value = lpfResQ(patch.params.lpfResonance);

  let outputChain: AudioNode = masterGain;

  const delayFb = hexToNorm(patch.params.delayFeedback);
  let delayNode: DelayNode | null = null;
  let delayGain: GainNode | null = null;
  if (delayFb > 0.05) {
    const delayTime = patch.delaySyncLevel === 6 ? 0.3 : 0.15;
    delayNode = ctx.createDelay(2);
    delayNode.delayTime.value = delayTime;
    delayGain = ctx.createGain();
    delayGain.gain.value = Math.min(0.85, delayFb);
    const delayDry = ctx.createGain();
    delayDry.gain.value = 1;

    lpf.connect(delayDry);
    delayDry.connect(masterGain);
    lpf.connect(delayNode);
    delayNode.connect(delayGain);
    delayGain.connect(delayNode);
    delayGain.connect(masterGain);
  } else {
    lpf.connect(masterGain);
  }

  const reverbAmt = hexToNorm(patch.params.reverbAmount);
  if (reverbAmt > 0.05) {
    const convolver = ctx.createConvolver();
    const reverbLen = 2;
    const impulse = ctx.createBuffer(2, ctx.sampleRate * reverbLen, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2);
      }
    }
    convolver.buffer = impulse;
    const reverbGain = ctx.createGain();
    reverbGain.gain.value = reverbAmt * 0.5;
    masterGain.connect(reverbGain);
    reverbGain.connect(convolver);
    convolver.connect(ctx.destination);
  }

  masterGain.connect(ctx.destination);

  const env2Cable = patch.patchCables.find(
    c => c.source === 'envelope2' && c.destination === 'lpfFrequency'
  );
  const lfoPitchCable = patch.patchCables.find(
    c => c.source === 'lfo1' && c.destination === 'pitch'
  );

  let lfo: OscillatorNode | null = null;
  if (lfoPitchCable) {
    lfo = ctx.createOscillator();
    lfo.type = LFO_MAP[patch.lfo1Type] || 'sine';
    lfo.frequency.value = lfoRateHz(patch.params.lfo1Rate);
    lfo.start();
  }

  const baseNotes = PREVIEW_NOTES[patch.category] || [60];
  const transposedNotes = baseNotes.map(n => n + patch.transpose);

  const isArp = patch.arpMode !== 'off' && ARP_PATTERNS[patch.arpMode];
  const arpSeq = isArp ? ARP_PATTERNS[patch.arpMode](transposedNotes, patch.arpOctaves) : null;

  const a1 = envAttackTime(patch.envelope1.attack);
  const d1 = envDecayReleaseTime(patch.envelope1.decay);
  const s1 = envSustainLevel(patch.envelope1.sustain);
  const r1 = envDecayReleaseTime(patch.envelope1.release);

  const totalDuration = arpSeq ? Math.min(4, arpSeq.length * 0.2 + r1 + 0.5) : Math.min(5, a1 + d1 + 1.5 + r1 + 0.5);
  const noteOff = totalDuration - r1 - 0.3;

  function playNote(midi: number, startTime: number, duration: number) {
    const freq = midiToFreq(midi);

    const noteGain = ctx.createGain();
    noteGain.gain.setValueAtTime(0, startTime);
    noteGain.gain.linearRampToValueAtTime(1, startTime + a1);
    noteGain.gain.linearRampToValueAtTime(s1, startTime + a1 + d1);
    noteGain.gain.setValueAtTime(s1, startTime + duration);
    noteGain.gain.linearRampToValueAtTime(0, startTime + duration + r1);
    noteGain.connect(lpf);

    if (env2Cable) {
      const env2Amt = hexToNorm(env2Cable.amount) * 8000;
      const a2 = envAttackTime(patch.envelope2.attack);
      const d2 = envDecayReleaseTime(patch.envelope2.decay);
      const s2 = envSustainLevel(patch.envelope2.sustain);
      const baseFreq = lpf.frequency.value;
      lpf.frequency.setValueAtTime(baseFreq, startTime);
      lpf.frequency.linearRampToValueAtTime(
        Math.min(20000, baseFreq + env2Amt), startTime + a2
      );
      lpf.frequency.linearRampToValueAtTime(
        Math.min(20000, baseFreq + env2Amt * s2), startTime + a2 + d2
      );
    }

    const unisonCount = patch.unisonNum;
    const detuneCents = patch.unisonDetune;

    for (let u = 0; u < unisonCount; u++) {
      const detuneOffset = unisonCount === 1 ? 0 :
        ((u / (unisonCount - 1)) - 0.5) * detuneCents;

      if (patch.mode === 'fm') {
        createFMVoice(ctx, freq, detuneOffset, patch, noteGain, startTime, duration + r1 + 0.1, lfo, lfoPitchCable);
      } else {
        createSubVoice(ctx, freq, detuneOffset, patch, noteGain, startTime, duration + r1 + 0.1, lfo, lfoPitchCable);
      }
    }
  }

  const now = ctx.currentTime + 0.05;

  if (arpSeq) {
    const stepLen = 0.15;
    for (let i = 0; i < arpSeq.length; i++) {
      playNote(arpSeq[i], now + i * stepLen, stepLen * 0.8);
    }
  } else {
    for (const note of transposedNotes) {
      playNote(note, now, noteOff);
    }
  }

  const cleanupTime = (totalDuration + 1) * 1000;
  stopTimer = window.setTimeout(() => {
    stopPreview();
    onStop?.();
  }, cleanupTime);
}

export function createSubVoice(
  ctx: AudioContext, freq: number, detuneCents: number,
  patch: AudioPatch, dest: AudioNode,
  start: number, dur: number,
  lfo: OscillatorNode | null, lfoCable: PatchCable | undefined
) {
  const oscAType = OSC_MAP[patch.osc1.type] || 'sawtooth';
  const oscBType = OSC_MAP[patch.osc2.type] || 'square';
  const oscBVol = patch.params.oscBVolume ? volumeLevel(patch.params.oscBVolume) : 0;

  const oscA = ctx.createOscillator();
  oscA.type = oscAType;
  oscA.frequency.value = freq * Math.pow(2, patch.osc1.transpose / 12) * Math.pow(2, patch.osc1.cents / 1200);
  oscA.detune.value = detuneCents;

  const gainA = ctx.createGain();
  gainA.gain.value = 1;
  oscA.connect(gainA);
  gainA.connect(dest);

  if (lfo && lfoCable) {
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = hexToNorm(lfoCable.amount) * 50;
    lfo.connect(lfoGain);
    lfoGain.connect(oscA.detune);
  }

  oscA.start(start);
  oscA.stop(start + dur);

  if (oscBVol > 0.01) {
    const oscB = ctx.createOscillator();
    oscB.type = oscBType;
    oscB.frequency.value = freq * Math.pow(2, patch.osc2.transpose / 12) * Math.pow(2, patch.osc2.cents / 1200);
    oscB.detune.value = detuneCents;

    const gainB = ctx.createGain();
    gainB.gain.value = oscBVol;
    oscB.connect(gainB);
    gainB.connect(dest);

    if (lfo && lfoCable) {
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = hexToNorm(lfoCable.amount) * 50;
      lfo.connect(lfoGain);
      lfoGain.connect(oscB.detune);
    }

    oscB.start(start);
    oscB.stop(start + dur);
  }

  const noiseVol = patch.params.noiseVolume ? volumeLevel(patch.params.noiseVolume) : 0;
  if (noiseVol > 0.01) {
    const bufferSize = ctx.sampleRate * 2;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = noiseVol * 0.3;
    noise.connect(noiseGain);
    noiseGain.connect(dest);
    noise.start(start);
    noise.stop(start + dur);
  }
}

export function createFMVoice(
  ctx: AudioContext, freq: number, detuneCents: number,
  patch: AudioPatch, dest: AudioNode,
  start: number, dur: number,
  lfo: OscillatorNode | null, lfoCable: PatchCable | undefined
) {
  const carrierFreq = freq * Math.pow(2, detuneCents / 1200);

  const mod1Amt = (patch.params.modulator1Amount ? hexToNorm(patch.params.modulator1Amount) : 0) * carrierFreq * 5;
  const mod2Amt = (patch.params.modulator2Amount ? hexToNorm(patch.params.modulator2Amount) : 0) * carrierFreq * 5;

  const mod1Ratio = patch.modulator1 ? Math.pow(2, patch.modulator1.transpose / 12) : 1;
  const mod2Ratio = patch.modulator2 ? Math.pow(2, patch.modulator2.transpose / 12) : 1;

  const mod2 = ctx.createOscillator();
  mod2.type = 'sine';
  mod2.frequency.value = carrierFreq * mod2Ratio;
  const mod2Gain = ctx.createGain();
  mod2Gain.gain.value = mod2Amt;
  mod2.connect(mod2Gain);

  const mod1 = ctx.createOscillator();
  mod1.type = 'sine';
  mod1.frequency.value = carrierFreq * mod1Ratio;
  const mod1Gain = ctx.createGain();
  mod1Gain.gain.value = mod1Amt;

  if (patch.modulator2?.toModulator1) {
    mod2Gain.connect(mod1.frequency);
  }

  mod1.connect(mod1Gain);

  const carrier1 = ctx.createOscillator();
  carrier1.type = 'sine';
  carrier1.frequency.value = carrierFreq;
  mod1Gain.connect(carrier1.frequency);

  const carrier2 = ctx.createOscillator();
  carrier2.type = 'sine';
  carrier2.frequency.value = carrierFreq;
  mod2Gain.connect(carrier2.frequency);

  const c1Gain = ctx.createGain();
  c1Gain.gain.value = 1;
  carrier1.connect(c1Gain);
  c1Gain.connect(dest);

  const oscBVol = patch.params.oscBVolume ? volumeLevel(patch.params.oscBVolume) : 0;
  const c2Gain = ctx.createGain();
  c2Gain.gain.value = oscBVol;
  carrier2.connect(c2Gain);
  c2Gain.connect(dest);

  if (lfo && lfoCable) {
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = hexToNorm(lfoCable.amount) * 50;
    lfo.connect(lfoGain);
    lfoGain.connect(carrier1.detune);
    const lfoGain2 = ctx.createGain();
    lfoGain2.gain.value = hexToNorm(lfoCable.amount) * 50;
    lfo.connect(lfoGain2);
    lfoGain2.connect(carrier2.detune);
  }

  mod1.start(start);
  mod2.start(start);
  carrier1.start(start);
  carrier2.start(start);
  mod1.stop(start + dur);
  mod2.stop(start + dur);
  carrier1.stop(start + dur);
  carrier2.stop(start + dur);
}
