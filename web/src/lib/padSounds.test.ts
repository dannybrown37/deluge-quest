import { describe, expect, it, vi } from "vitest";
import {
  glowForVelocity,
  PAD_SOUNDS,
  PadEffectsChain,
  velocityForPosition,
} from "./padSounds";

function createParam(initial = 0) {
  return {
    value: initial,
    setValueAtTime: vi.fn(function (this: { value: number }, v: number) {
      this.value = v;
    }),
    exponentialRampToValueAtTime: vi.fn(function (
      this: { value: number },
      v: number,
    ) {
      this.value = v;
    }),
    linearRampToValueAtTime: vi.fn(function (
      this: { value: number },
      v: number,
    ) {
      this.value = v;
    }),
  };
}

function makeGainNode() {
  return { gain: createParam(1), connect: vi.fn((dest: unknown) => dest) };
}
function makeOscillatorNode() {
  return {
    type: "",
    frequency: createParam(440),
    connect: vi.fn((dest: unknown) => dest),
    start: vi.fn(),
    stop: vi.fn(),
  };
}
function makeBiquadFilterNode() {
  return {
    type: "",
    frequency: createParam(350),
    Q: createParam(1),
    connect: vi.fn((dest: unknown) => dest),
  };
}
function makeBufferSourceNode() {
  return {
    buffer: null,
    connect: vi.fn((dest: unknown) => dest),
    start: vi.fn(),
    stop: vi.fn(),
  };
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

function createFakeAudioContext(): AudioContext {
  return {
    currentTime: 0,
    sampleRate: 44100,
    destination: {},
    createOscillator: () => makeOscillatorNode(),
    createGain: () => makeGainNode(),
    createBiquadFilter: () => makeBiquadFilterNode(),
    createBufferSource: () => makeBufferSourceNode(),
    createBuffer: (channels: number, length: number) =>
      makeAudioBuffer(channels, length),
    createDelay: () => makeDelayNode(),
    createConvolver: () => makeConvolverNode(),
  } as unknown as AudioContext;
}

describe("velocityForPosition", () => {
  it("is max velocity at the top-left of a 4x4 block", () => {
    expect(velocityForPosition(0, 0)).toBe(1.0);
  });

  it("is min velocity at the bottom-right of a 4x4 block", () => {
    expect(velocityForPosition(3, 3)).toBeCloseTo(0.15, 5);
  });

  it("decreases monotonically as row/col increase", () => {
    const values: number[] = [];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) values.push(velocityForPosition(r, c));
    }
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeLessThan(values[i - 1]);
    }
  });
});

describe("glowForVelocity", () => {
  it.each([
    [0, 0.2],
    [1, 0.9],
    [0.5, 0.55],
  ])("glowForVelocity(%d) === %d", (v, expected) => {
    expect(glowForVelocity(v)).toBeCloseTo(expected, 5);
  });
});

describe("PAD_SOUNDS", () => {
  it("has 8 uniquely-named sounds", () => {
    expect(PAD_SOUNDS).toHaveLength(8);
    expect(new Set(PAD_SOUNDS.map((s) => s.name)).size).toBe(8);
  });

  it.each(PAD_SOUNDS.map((s) => [s.name, s] as const))(
    "%s plays without throwing",
    (_name, sound) => {
      const ctx = createFakeAudioContext();
      const dest = {} as AudioNode;
      expect(() => sound.play(ctx, dest, 0.8)).not.toThrow();
    },
  );
});

describe("PadEffectsChain", () => {
  function makeChain() {
    const ctx = createFakeAudioContext();
    const chain = new PadEffectsChain(ctx);
    return chain as unknown as {
      filter: ReturnType<typeof makeBiquadFilterNode>;
      dryGain: ReturnType<typeof makeGainNode>;
      wetGain: ReturnType<typeof makeGainNode>;
      delay: ReturnType<typeof makeDelayNode>;
      delayFeedback: ReturnType<typeof makeGainNode>;
      delayWet: ReturnType<typeof makeGainNode>;
      master: ReturnType<typeof makeGainNode>;
      updateVolume: (v: number) => void;
      updateFilter: (cutoff: number, resonance: number) => void;
      updateReverb: (v: number) => void;
      updateDelay: (time: number, feedback: number) => void;
    };
  }

  it("defaults the filter to fully open, not muffled", () => {
    // Regression guard: the same "BiquadFilterNode defaults to 350Hz" trap
    // documented in CLAUDE.md for homeAudio.ts also applies here.
    const chain = makeChain();
    expect(chain.filter.frequency.value).toBeGreaterThan(20000);
  });

  it("updateVolume maps 0-127 to master gain 0-1", () => {
    const chain = makeChain();
    chain.updateVolume(0);
    expect(chain.master.gain.value).toBe(0);
    chain.updateVolume(127);
    expect(chain.master.gain.value).toBeCloseTo(1, 5);
  });

  it("updateFilter maps cutoff exponentially and resonance linearly", () => {
    const chain = makeChain();
    chain.updateFilter(0, 0);
    expect(chain.filter.frequency.value).toBeCloseTo(80, 5);
    expect(chain.filter.Q.value).toBeCloseTo(0.5, 5);

    chain.updateFilter(127, 127);
    expect(chain.filter.frequency.value).toBeGreaterThan(20000);
    expect(chain.filter.Q.value).toBeCloseTo(25, 5);
  });

  it("updateReverb crossfades dry/wet gain", () => {
    const chain = makeChain();
    chain.updateReverb(0);
    expect(chain.dryGain.gain.value).toBe(1);
    expect(chain.wetGain.gain.value).toBe(0);

    chain.updateReverb(127);
    expect(chain.dryGain.gain.value).toBeCloseTo(0.5, 5);
    expect(chain.wetGain.gain.value).toBeCloseTo(1, 5);
  });

  it("updateDelay mutes the wet signal only when both time and feedback are zero", () => {
    const chain = makeChain();
    chain.updateDelay(0, 0);
    expect(chain.delayWet.gain.value).toBe(0);

    chain.updateDelay(10, 0);
    expect(chain.delayWet.gain.value).toBeCloseTo(0.4, 5);

    chain.updateDelay(0, 10);
    expect(chain.delayWet.gain.value).toBeCloseTo(0.4, 5);
  });

  it("updateDelay maps time and feedback into their ranges", () => {
    const chain = makeChain();
    chain.updateDelay(127, 127);
    expect(chain.delay.delayTime.value).toBeCloseTo(0.8, 5);
    expect(chain.delayFeedback.gain.value).toBeCloseTo(0.85, 5);
  });
});
