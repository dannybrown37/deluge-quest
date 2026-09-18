import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NUM_STEPS,
  SequencerEngine,
  type SequencerEngineOptions,
} from "./sequencerAudio";

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
    setTargetAtTime: vi.fn(function (this: { value: number }, v: number) {
      this.value = v;
    }),
  };
}

function makeGainNode() {
  return {
    gain: createParam(1),
    connect: vi.fn((d: unknown) => d),
    disconnect: vi.fn(),
  };
}
function makeBufferSourceNode() {
  return {
    buffer: null as unknown,
    connect: vi.fn((d: unknown) => d),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

class FakeAudioContext {
  currentTime = 0;
  sampleRate = 44100;
  destination = {};
  state: "running" | "suspended" | "closed" = "running";
  createGain = vi.fn(() => makeGainNode());
  createBufferSource = vi.fn(() => makeBufferSourceNode());
  decodeAudioData = vi.fn(
    async () =>
      ({
        duration: 1,
        length: 44100,
        sampleRate: 44100,
        numberOfChannels: 1,
        getChannelData: () => new Float32Array(44100),
      }) as unknown as AudioBuffer,
  );
  resume = vi.fn(() => {
    this.state = "running";
  });
  close = vi.fn(() => {
    this.state = "closed";
  });
}

let contexts: FakeAudioContext[] = [];
function stubAudioContext() {
  contexts = [];
  vi.stubGlobal("AudioContext", function AudioContextStub() {
    const c = new FakeAudioContext();
    contexts.push(c);
    return c;
  });
}
function currentFakeCtx(): FakeAudioContext {
  return contexts[contexts.length - 1];
}

let rafCallbacks: Map<number, FrameRequestCallback>;
let rafNextId: number;
function stubRAF() {
  rafCallbacks = new Map();
  rafNextId = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = ++rafNextId;
    rafCallbacks.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafCallbacks.delete(id);
  });
}
function flushRAF(time = 0) {
  const entries = [...rafCallbacks.entries()];
  rafCallbacks.clear();
  for (const [, cb] of entries) cb(time);
}

interface SequencerEngineInternals {
  ctx: FakeAudioContext | null;
  masterGain: ReturnType<typeof makeGainNode> | null;
  rowGains: ReturnType<typeof makeGainNode>[];
  sampleBuffers: (AudioBuffer | null)[];
  scheduleChunk: () => void;
  stepDurationSec: () => number;
}
function internals(e: SequencerEngine): SequencerEngineInternals {
  return e as unknown as SequencerEngineInternals;
}

function makeFileHandle(
  arrayBuffer: () => Promise<ArrayBuffer>,
): FileSystemFileHandle {
  return {
    getFile: vi.fn(async () => ({ arrayBuffer })),
  } as unknown as FileSystemFileHandle;
}

function makeEngine(opts: SequencerEngineOptions = {}): SequencerEngine {
  return new SequencerEngine(opts);
}

beforeEach(() => {
  stubAudioContext();
  stubRAF();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("pattern state", () => {
  it("addRow appends an empty 16-step row", () => {
    const e = makeEngine();
    e.addRow();
    expect(e.pattern).toHaveLength(1);
    expect(e.pattern[0]).toHaveLength(NUM_STEPS);
    expect(e.pattern[0].every((s) => s === false)).toBe(true);
  });

  it("toggleStep flips a step on then off", () => {
    const e = makeEngine();
    e.addRow();
    e.toggleStep(0, 3);
    expect(e.pattern[0][3]).toBe(true);
    e.toggleStep(0, 3);
    expect(e.pattern[0][3]).toBe(false);
  });

  it("toggleStep is a no-op for an out-of-range row", () => {
    const e = makeEngine();
    expect(() => e.toggleStep(0, 0)).not.toThrow();
    expect(e.pattern).toHaveLength(0);
  });

  it("clearRow zeros a single row without touching others", () => {
    const e = makeEngine();
    e.addRow();
    e.addRow();
    e.toggleStep(0, 0);
    e.toggleStep(1, 0);
    e.clearRow(0);
    expect(e.pattern[0].every((s) => s === false)).toBe(true);
    expect(e.pattern[1][0]).toBe(true);
  });

  it("clearAll zeros every row", () => {
    const e = makeEngine();
    e.addRow();
    e.addRow();
    e.toggleStep(0, 1);
    e.toggleStep(1, 2);
    e.clearAll();
    expect(e.pattern.every((row) => row.every((s) => s === false))).toBe(true);
  });

  it("removeRow removes the correct row and shifts remaining rows down", () => {
    const e = makeEngine();
    e.addRow();
    e.addRow();
    e.addRow();
    e.toggleStep(0, 0);
    e.toggleStep(1, 1);
    e.toggleStep(2, 2);
    e.removeRow(1);
    expect(e.pattern).toHaveLength(2);
    expect(e.pattern[0][0]).toBe(true);
    expect(e.pattern[1][2]).toBe(true);
  });

  it.each([-1, 5])("removeRow(%i) out of bounds is a no-op", (idx) => {
    const e = makeEngine();
    e.addRow();
    e.removeRow(idx);
    expect(e.pattern).toHaveLength(1);
  });

  it("setPattern / getPattern round-trips", () => {
    const e = makeEngine();
    const p = [
      [true, false],
      [false, true],
    ];
    e.setPattern(p);
    expect(e.getPattern()).toEqual(p);
  });

  it("getPattern returns a deep copy that mutation does not affect", () => {
    const e = makeEngine();
    e.addRow();
    e.toggleStep(0, 0);
    const copy = e.getPattern();
    copy[0][0] = false;
    copy.push([true]);
    expect(e.pattern[0][0]).toBe(true);
    expect(e.pattern).toHaveLength(1);
  });
});

describe("transport", () => {
  it("play() creates an AudioContext and sets isPlaying", () => {
    const e = makeEngine();
    e.addRow();
    expect(e.isPlaying).toBe(false);
    e.play();
    expect(contexts).toHaveLength(1);
    expect(e.isPlaying).toBe(true);
  });

  it("play() is a no-op if already playing", () => {
    const e = makeEngine();
    e.addRow();
    e.play();
    e.play();
    expect(contexts).toHaveLength(1);
  });

  it("stop() closes the context, resets state, and fires onStop", () => {
    const onStop = vi.fn();
    const e = makeEngine({ onStop });
    e.addRow();
    e.play();
    const ctx = currentFakeCtx();
    e.stop();
    expect(ctx.close).toHaveBeenCalled();
    expect(e.isPlaying).toBe(false);
    expect(e.currentStep).toBe(0);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("setBpm updates the reported bpm", () => {
    const e = makeEngine({ bpm: 100 });
    expect(e.bpm).toBe(100);
    e.setBpm(140);
    expect(e.bpm).toBe(140);
  });
});

describe("scheduling", () => {
  it("advancing the audio clock fires onStep via the RAF loop", () => {
    const onStep = vi.fn();
    const e = makeEngine({ bpm: 120, onStep });
    e.addRow();
    e.play();
    const ctx = currentFakeCtx();

    ctx.currentTime = internals(e).stepDurationSec() * 2;
    flushRAF();

    expect(onStep).toHaveBeenCalledWith(2);
    expect(e.currentStep).toBe(2);
  });

  it("steps wrap from 15 back to 0", () => {
    const onStep = vi.fn();
    const e = makeEngine({ bpm: 120, onStep });
    e.addRow();
    e.play();
    const ctx = currentFakeCtx();

    ctx.currentTime = internals(e).stepDurationSec() * NUM_STEPS;
    flushRAF();

    expect(e.currentStep).toBe(0);
  });

  it("only active steps create buffer sources when scheduled", async () => {
    const e = makeEngine({ bpm: 120 });
    e.addRow();
    e.toggleStep(0, 0);
    const handle = makeFileHandle(async () => new ArrayBuffer(8));
    await e.loadSample(0, handle);

    e.play();
    const ctx = currentFakeCtx();

    expect(ctx.createBufferSource).toHaveBeenCalledTimes(1);
  });

  it("rows without a loaded sample stay silent (no buffer source created)", () => {
    const e = makeEngine({ bpm: 120 });
    e.addRow();
    e.toggleStep(0, 0);

    e.play();
    const ctx = currentFakeCtx();

    expect(ctx.createBufferSource).not.toHaveBeenCalled();
  });

  it("changing bpm changes the computed step duration", () => {
    const e = makeEngine({ bpm: 120 });
    const dur120 = internals(e).stepDurationSec();
    e.setBpm(60);
    const dur60 = internals(e).stepDurationSec();
    expect(dur60).toBeCloseTo(dur120 * 2, 6);
  });

  it("the schedule timer ticks scheduleChunk every SCHEDULE_INTERVAL_MS", () => {
    vi.useFakeTimers();
    const e = makeEngine({ bpm: 120 });
    e.addRow();
    e.play();
    const ctx = currentFakeCtx();
    const spy = vi.spyOn(
      e as unknown as { scheduleChunk: () => void },
      "scheduleChunk" as never,
    );

    ctx.currentTime = 10;
    vi.advanceTimersByTime(300);

    expect(spy).toHaveBeenCalled();
  });
});

describe("setBuffer", () => {
  it("directly sets a buffer at the given row index", () => {
    const e = makeEngine();
    e.addRow();
    const buf = { duration: 1 } as unknown as AudioBuffer;
    e.setBuffer(0, buf);
    expect(internals(e).sampleBuffers[0]).toBe(buf);
  });

  it("is a no-op for an out-of-range row index", () => {
    const e = makeEngine();
    e.addRow();
    const buf = { duration: 1 } as unknown as AudioBuffer;
    e.setBuffer(5, buf);
    expect(internals(e).sampleBuffers[0]).toBeNull();
  });

  it("is a no-op for a negative row index", () => {
    const e = makeEngine();
    e.addRow();
    const buf = { duration: 1 } as unknown as AudioBuffer;
    e.setBuffer(-1, buf);
    expect(internals(e).sampleBuffers[0]).toBeNull();
  });
});

describe("sample loading", () => {
  it("loadSample decodes audio into sampleBuffers[row]", async () => {
    const e = makeEngine();
    e.addRow();
    const decoded = { duration: 2 } as unknown as AudioBuffer;
    const handle = makeFileHandle(async () => new ArrayBuffer(4));

    const decodeSpy = vi.fn(async () => decoded);
    vi.stubGlobal(
      "AudioContext",
      function AudioContextStub(this: FakeAudioContext) {
        const c = new FakeAudioContext();
        c.decodeAudioData = decodeSpy;
        contexts.push(c);
        return c;
      },
    );

    await e.loadSample(0, handle);

    expect(decodeSpy).toHaveBeenCalled();
    expect(internals(e).sampleBuffers[0]).toBe(decoded);
  });

  it("a failed decode leaves the row silent and does not throw", async () => {
    const e = makeEngine();
    e.addRow();
    const handle = makeFileHandle(async () => {
      throw new Error("bad file");
    });

    await expect(e.loadSample(0, handle)).resolves.toBeUndefined();
    expect(internals(e).sampleBuffers[0]).toBeNull();
  });

  it("a decodeAudioData rejection leaves the row silent and does not throw", async () => {
    const e = makeEngine();
    e.addRow();
    const handle = makeFileHandle(async () => new ArrayBuffer(4));
    vi.stubGlobal("AudioContext", function AudioContextStub() {
      const c = new FakeAudioContext();
      c.decodeAudioData = vi.fn(async () => {
        throw new Error("cannot decode");
      });
      contexts.push(c);
      return c;
    });

    await expect(e.loadSample(0, handle)).resolves.toBeUndefined();
    expect(internals(e).sampleBuffers[0]).toBeNull();
  });
});

describe("dispose", () => {
  it("stops playback and cleans up state", () => {
    const onStop = vi.fn();
    const e = makeEngine({ onStop });
    e.addRow();
    e.play();
    const ctx = currentFakeCtx();

    e.dispose();

    expect(ctx.close).toHaveBeenCalled();
    expect(e.isPlaying).toBe(false);
    expect(onStop).toHaveBeenCalled();
    expect(e.pattern).toHaveLength(0);
  });

  it("dispose is safe to call when never played", () => {
    const e = makeEngine();
    e.addRow();
    expect(() => e.dispose()).not.toThrow();
    expect(e.isPlaying).toBe(false);
  });
});
