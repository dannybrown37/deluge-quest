import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  hexToNorm,
  envAttackTime,
  envDecayReleaseTime,
  envSustainLevel,
  lpfFreqHz,
  lpfResQ,
  midiToFreq,
  isPlaying,
  stopPreview,
  playPreview,
  createSubVoice,
  createFMVoice,
  type AudioPatch,
} from './patchAudio';

function createParam(initial = 0) {
  return {
    value: initial,
    setValueAtTime: vi.fn(function (this: { value: number }, v: number) {
      this.value = v;
    }),
    exponentialRampToValueAtTime: vi.fn(function (this: { value: number }, v: number) {
      this.value = v;
    }),
    linearRampToValueAtTime: vi.fn(function (this: { value: number }, v: number) {
      this.value = v;
    }),
  };
}

function makeGainNode() {
  return { gain: createParam(1), connect: vi.fn((dest: unknown) => dest) };
}
function makeOscillatorNode() {
  return {
    type: '',
    frequency: createParam(440),
    detune: createParam(0),
    connect: vi.fn((dest: unknown) => dest),
    start: vi.fn(),
    stop: vi.fn(),
  };
}
function makeBiquadFilterNode() {
  return {
    type: '',
    frequency: createParam(350),
    Q: createParam(1),
    connect: vi.fn((dest: unknown) => dest),
  };
}
function makeBufferSourceNode() {
  return { buffer: null, connect: vi.fn((dest: unknown) => dest), start: vi.fn(), stop: vi.fn() };
}
function makeDelayNode() {
  return { delayTime: createParam(0), connect: vi.fn((dest: unknown) => dest) };
}
function makeConvolverNode() {
  return { buffer: null, connect: vi.fn((dest: unknown) => dest) };
}
function makeAudioBuffer(channels: number, length: number) {
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  return { getChannelData: (ch: number) => data[ch] };
}

class FakeAudioContext {
  currentTime = 0;
  sampleRate = 100;
  destination = {};
  state: 'running' | 'closed' = 'running';
  createOscillator() { return makeOscillatorNode(); }
  createGain() { return makeGainNode(); }
  createBiquadFilter() { return makeBiquadFilterNode(); }
  createBufferSource() { return makeBufferSourceNode(); }
  createBuffer(channels: number, length: number) { return makeAudioBuffer(channels, length); }
  createDelay() { return makeDelayNode(); }
  createConvolver() { return makeConvolverNode(); }
  close() { this.state = 'closed'; }
}

function makePatch(overrides: Partial<AudioPatch> = {}): AudioPatch {
  return {
    mode: 'subtractive',
    category: 'lead',
    polyphonic: 'poly',
    transpose: 0,
    osc1: { type: 'saw', transpose: 0, cents: 0, retrigPhase: 0 },
    osc2: { type: 'square', transpose: 0, cents: 0, retrigPhase: 0 },
    lfo1Type: 'sine',
    lfo2Type: 'sine',
    unisonNum: 1,
    unisonDetune: 0,
    lpfMode: '24dB',
    modFXType: 'none',
    delayPingPong: 0,
    delayAnalog: 0,
    delaySyncLevel: 0,
    arpMode: 'off',
    arpOctaves: 1,
    arpSyncLevel: 0,
    params: {
      volume: '7FFFFFFF',
      lpfFrequency: '7FFFFFFF',
      lpfResonance: '00000000',
      delayFeedback: '00000000',
      reverbAmount: '00000000',
      lfo1Rate: '00000000',
    },
    envelope1: { attack: '00000000', decay: '00000000', sustain: '7FFFFFFF', release: '00000000' },
    envelope2: { attack: '00000000', decay: '00000000', sustain: '7FFFFFFF', release: '00000000' },
    patchCables: [],
    ...overrides,
  };
}

describe('hexToNorm', () => {
  it.each([
    ['00000000', 0.5],
    ['7FFFFFFF', 1],
    ['80000000', 0],
  ])('hexToNorm(%s) ~= %d', (h, expected) => {
    expect(hexToNorm(h)).toBeCloseTo(expected, 4);
  });
});

describe('envelope/filter mapping curves', () => {
  it('envAttackTime spans 1ms to 8s', () => {
    expect(envAttackTime('80000000')).toBeCloseTo(0.001, 5);
    expect(envAttackTime('7FFFFFFF')).toBeCloseTo(8, 5);
  });

  it('envDecayReleaseTime spans 10ms to 20s', () => {
    expect(envDecayReleaseTime('80000000')).toBeCloseTo(0.01, 5);
    expect(envDecayReleaseTime('7FFFFFFF')).toBeCloseTo(20, 5);
  });

  it('envSustainLevel is clamped to [0, 1]', () => {
    expect(envSustainLevel('80000000')).toBe(0);
    expect(envSustainLevel('7FFFFFFF')).toBe(1);
  });

  it('lpfFreqHz spans 20Hz to 20kHz', () => {
    expect(lpfFreqHz('80000000')).toBeCloseTo(20, 5);
    expect(lpfFreqHz('7FFFFFFF')).toBeCloseTo(20000, 5);
  });

  it('lpfResQ spans 0.5 to 20.5', () => {
    expect(lpfResQ('80000000')).toBeCloseTo(0.5, 5);
    expect(lpfResQ('7FFFFFFF')).toBeCloseTo(20.5, 5);
  });
});

describe('midiToFreq', () => {
  it.each([
    [69, 440],
    [81, 880],
    [57, 220],
  ])('midiToFreq(%d) ~= %d', (midi, hz) => {
    expect(midiToFreq(midi)).toBeCloseTo(hz, 4);
  });
});

describe('createSubVoice', () => {
  let ctx: AudioContext;
  beforeEach(() => { ctx = new FakeAudioContext() as unknown as AudioContext; });

  it('plays osc A only when osc B / noise volumes are absent', () => {
    const dest = {} as AudioNode;
    expect(() =>
      createSubVoice(ctx, 440, 0, makePatch(), dest, 0, 1, null, undefined)
    ).not.toThrow();
  });

  it('adds osc B and noise when their volumes are set, plus LFO pitch mod and unison detune', () => {
    const dest = {} as AudioNode;
    const patch = makePatch({
      unisonNum: 2,
      unisonDetune: 20,
      params: {
        ...makePatch().params,
        oscBVolume: '7FFFFFFF',
        noiseVolume: '7FFFFFFF',
      },
    });
    const lfo = makeOscillatorNode() as unknown as OscillatorNode;
    const cable = { source: 'lfo1', destination: 'pitch', amount: '7FFFFFFF' };
    expect(() =>
      createSubVoice(ctx, 440, 10, patch, dest, 0, 1, lfo, cable)
    ).not.toThrow();
  });
});

describe('createFMVoice', () => {
  let ctx: AudioContext;
  beforeEach(() => { ctx = new FakeAudioContext() as unknown as AudioContext; });

  it('plays carriers/modulators with no modulator config', () => {
    const dest = {} as AudioNode;
    expect(() =>
      createFMVoice(ctx, 440, 0, makePatch({ mode: 'fm' }), dest, 0, 1, null, undefined)
    ).not.toThrow();
  });

  it('routes modulator2 into modulator1 when toModulator1 is set, plus LFO detune on both carriers', () => {
    const dest = {} as AudioNode;
    const patch = makePatch({
      mode: 'fm',
      modulator1: { transpose: 0, cents: 0, retrigPhase: 0 },
      modulator2: { transpose: 12, cents: 0, retrigPhase: 0, toModulator1: 1 },
      params: {
        ...makePatch().params,
        modulator1Amount: '7FFFFFFF',
        modulator2Amount: '7FFFFFFF',
        oscBVolume: '7FFFFFFF',
      },
    });
    const lfo = makeOscillatorNode() as unknown as OscillatorNode;
    const cable = { source: 'lfo1', destination: 'pitch', amount: '7FFFFFFF' };
    expect(() =>
      createFMVoice(ctx, 440, 5, patch, dest, 0, 1, lfo, cable)
    ).not.toThrow();
  });
});

describe('playPreview / stopPreview / isPlaying', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('AudioContext', FakeAudioContext);
  });

  afterEach(() => {
    stopPreview();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('is not playing before any preview starts', () => {
    expect(isPlaying()).toBe(false);
  });

  it('marks playing during a preview and stops on manual stopPreview', () => {
    playPreview(makePatch());
    expect(isPlaying()).toBe(true);
    stopPreview();
    expect(isPlaying()).toBe(false);
  });

  it('calling stopPreview twice does not throw', () => {
    playPreview(makePatch());
    stopPreview();
    expect(() => stopPreview()).not.toThrow();
  });

  it('replacing an active preview stops the previous one', () => {
    playPreview(makePatch());
    expect(isPlaying()).toBe(true);
    playPreview(makePatch({ category: 'bass' }));
    expect(isPlaying()).toBe(true);
  });

  it('auto-stops and invokes onStop after the note lifetime elapses', () => {
    const onStop = vi.fn();
    playPreview(makePatch(), onStop);
    expect(isPlaying()).toBe(true);
    vi.advanceTimersByTime(10000);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(isPlaying()).toBe(false);
  });

  it('skips the delay send when delayFeedback is near zero', () => {
    const patch = makePatch({
      params: { ...makePatch().params, delayFeedback: '80000000' },
    });
    expect(() => playPreview(patch)).not.toThrow();
  });

  it('wires a delay send when delayFeedback exceeds the noise floor', () => {
    const patch = makePatch({
      delaySyncLevel: 6,
      params: { ...makePatch().params, delayFeedback: '7FFFFFFF' },
    });
    expect(() => playPreview(patch)).not.toThrow();
  });

  it('wires a reverb send when reverbAmount exceeds the noise floor', () => {
    const patch = makePatch({
      params: { ...makePatch().params, reverbAmount: '7FFFFFFF' },
    });
    expect(() => playPreview(patch)).not.toThrow();
  });

  it('applies an envelope2-to-filter-cutoff patch cable', () => {
    const patch = makePatch({
      patchCables: [{ source: 'envelope2', destination: 'lpfFrequency', amount: '7FFFFFFF' }],
    });
    expect(() => playPreview(patch)).not.toThrow();
  });

  it('applies an lfo1-to-pitch patch cable', () => {
    const patch = makePatch({
      patchCables: [{ source: 'lfo1', destination: 'pitch', amount: '7FFFFFFF' }],
    });
    expect(() => playPreview(patch)).not.toThrow();
  });

  it.each(['up', 'down', 'upDown', 'random'] as const)(
    'plays an arpeggiated sequence in %s mode',
    (arpMode) => {
      const patch = makePatch({ arpMode, arpOctaves: 2 });
      expect(() => playPreview(patch)).not.toThrow();
      expect(isPlaying()).toBe(true);
    }
  );

  it('plays chord categories (pad/keys) with multiple simultaneous notes', () => {
    expect(() => playPreview(makePatch({ category: 'pad' }))).not.toThrow();
    stopPreview();
    expect(() => playPreview(makePatch({ category: 'keys' }))).not.toThrow();
  });

  it('plays fm mode end-to-end through playPreview', () => {
    const patch = makePatch({
      mode: 'fm',
      modulator1: { transpose: 0, cents: 0, retrigPhase: 0 },
      modulator2: { transpose: 7, cents: 0, retrigPhase: 0, toModulator1: 0 },
      params: { ...makePatch().params, modulator1Amount: '7FFFFFFF' },
    });
    expect(() => playPreview(patch)).not.toThrow();
  });
});
