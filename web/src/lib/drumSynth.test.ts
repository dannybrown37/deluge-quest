import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  create808Kit,
  DEFAULT_808_PATTERN,
  DRUM_808_NAMES,
  render808Buffers,
} from "./drumSynth";
import { NUM_STEPS } from "./sequencerAudio";

function createParam(initial = 0) {
  return {
    value: initial,
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
  };
}

function makeFakeOfflineAudioContext() {
  const fakeBuffer = {
    duration: 1,
    length: 44100,
    sampleRate: 44100,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array(44100),
  } as unknown as AudioBuffer;

  return {
    sampleRate: 44100,
    destination: {},
    createOscillator: vi.fn(() => ({
      type: "sine",
      frequency: createParam(440),
      connect: vi.fn(function (this: unknown, d: unknown) {
        return d;
      }),
      start: vi.fn(),
      stop: vi.fn(),
    })),
    createGain: vi.fn(() => ({
      gain: createParam(1),
      connect: vi.fn(function (this: unknown, d: unknown) {
        return d;
      }),
    })),
    createBufferSource: vi.fn(() => ({
      buffer: null,
      connect: vi.fn(function (this: unknown, d: unknown) {
        return d;
      }),
      start: vi.fn(),
      stop: vi.fn(),
    })),
    createBuffer: vi.fn(
      (_channels: number, length: number, _sampleRate: number) => ({
        getChannelData: vi.fn(() => new Float32Array(length)),
      }),
    ),
    createBiquadFilter: vi.fn(() => ({
      type: "lowpass",
      frequency: createParam(350),
      Q: createParam(1),
      connect: vi.fn(function (this: unknown, d: unknown) {
        return d;
      }),
    })),
    startRendering: vi.fn(async () => fakeBuffer),
  };
}

let offlineCtxInstances: ReturnType<typeof makeFakeOfflineAudioContext>[];

beforeEach(() => {
  offlineCtxInstances = [];
  vi.stubGlobal(
    "OfflineAudioContext",
    vi.fn(function OfflineAudioContextStub() {
      const ctx = makeFakeOfflineAudioContext();
      offlineCtxInstances.push(ctx);
      return ctx;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DRUM_808_NAMES", () => {
  it("has 8 drum names", () => {
    expect(DRUM_808_NAMES).toHaveLength(8);
  });

  it("includes the classic 808 sounds", () => {
    expect(DRUM_808_NAMES).toContain("KICK");
    expect(DRUM_808_NAMES).toContain("SNARE");
    expect(DRUM_808_NAMES).toContain("CL HAT");
    expect(DRUM_808_NAMES).toContain("COWBELL");
  });
});

describe("DEFAULT_808_PATTERN", () => {
  it("has one row per drum", () => {
    expect(DEFAULT_808_PATTERN).toHaveLength(DRUM_808_NAMES.length);
  });

  it("each row has NUM_STEPS steps", () => {
    for (const row of DEFAULT_808_PATTERN) {
      expect(row).toHaveLength(NUM_STEPS);
    }
  });

  it("kick hits on beats 1, 7, and 9 (indices 0, 6, 8)", () => {
    const kickRow = DEFAULT_808_PATTERN[0];
    expect(kickRow[0]).toBe(true);
    expect(kickRow[6]).toBe(true);
    expect(kickRow[8]).toBe(true);
  });

  it("closed hat has 8th-note pattern", () => {
    const hatRow = DEFAULT_808_PATTERN[2];
    for (let i = 0; i < NUM_STEPS; i++) {
      expect(hatRow[i]).toBe(i % 2 === 0);
    }
  });
});

describe("create808Kit", () => {
  it("returns a kit with 8 rows matching DRUM_808_NAMES", () => {
    const kit = create808Kit();
    expect(kit.name).toBe("808");
    expect(kit.rows).toHaveLength(8);
    expect(kit.rows.map((r) => r.name)).toEqual(DRUM_808_NAMES);
    expect(kit.selectedIndex).toBe(0);
  });

  it("rows have empty sample paths and default settings", () => {
    const kit = create808Kit();
    for (const row of kit.rows) {
      expect(row.samplePath).toBe("");
      expect(row.volume).toBe(80);
      expect(row.loopMode).toBe("once");
    }
  });
});

describe("render808Buffers", () => {
  it("renders one AudioBuffer per drum name", async () => {
    const buffers = await render808Buffers();
    expect(buffers.size).toBe(DRUM_808_NAMES.length);
    for (const name of DRUM_808_NAMES) {
      expect(buffers.has(name)).toBe(true);
    }
  });

  it("creates one OfflineAudioContext per drum", async () => {
    await render808Buffers();
    expect(offlineCtxInstances).toHaveLength(DRUM_808_NAMES.length);
  });

  it("calls startRendering on each context", async () => {
    await render808Buffers();
    for (const ctx of offlineCtxInstances) {
      expect(ctx.startRendering).toHaveBeenCalledOnce();
    }
  });
});
