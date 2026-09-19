import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewNoteRow, PreviewPatch, PreviewTrack } from "./pyodide";
import { type EQBand, type SongPlaybackOptions, SongPlayer } from "./songAudio";

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
function makeOscillatorNode() {
  return {
    type: "",
    frequency: createParam(440),
    detune: createParam(0),
    connect: vi.fn((d: unknown) => d),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
}
function makeBiquadFilterNode() {
  return {
    type: "",
    frequency: createParam(350),
    Q: createParam(1),
    gain: createParam(0),
    connect: vi.fn((d: unknown) => d),
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
function makeCompressorNode() {
  return {
    threshold: createParam(-24),
    ratio: createParam(12),
    connect: vi.fn((d: unknown) => d),
  };
}
function makeAudioBuffer(channels: number, length: number): AudioBuffer {
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  return { getChannelData: (ch: number) => data[ch] } as unknown as AudioBuffer;
}

class FakeAudioContext {
  currentTime = 0;
  sampleRate = 44100;
  destination = {};
  state: "running" | "suspended" | "closed" = "running";
  createOscillator = vi.fn(() => makeOscillatorNode());
  createGain = vi.fn(() => makeGainNode());
  createBiquadFilter = vi.fn(() => makeBiquadFilterNode());
  createBufferSource = vi.fn(() => makeBufferSourceNode());
  createBuffer = vi.fn((channels: number, length: number) =>
    makeAudioBuffer(channels, length),
  );
  createDynamicsCompressor = vi.fn(() => makeCompressorNode());
  resume = vi.fn(() => {
    this.state = "running";
  });
  suspend = vi.fn(() => {
    this.state = "suspended";
  });
  close = vi.fn(() => {
    this.state = "closed";
  });
}

class FakeOfflineAudioContext extends FakeAudioContext {
  length: number;
  numberOfChannels: number;
  constructor(channels: number, length: number, sampleRate: number) {
    super();
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
  }
  startRendering = vi.fn(async (): Promise<AudioBuffer> => {
    return makeAudioBuffer(this.numberOfChannels, this.length);
  });
}

let contexts: FakeAudioContext[] = [];
let offlineContexts: FakeOfflineAudioContext[] = [];

function stubAudioContext() {
  contexts = [];
  vi.stubGlobal("AudioContext", function AudioContextStub() {
    const c = new FakeAudioContext();
    contexts.push(c);
    return c;
  });
}
function stubOfflineAudioContext() {
  offlineContexts = [];
  vi.stubGlobal(
    "OfflineAudioContext",
    function OfflineAudioContextStub(
      channels: number,
      length: number,
      sampleRate: number,
    ) {
      const c = new FakeOfflineAudioContext(channels, length, sampleRate);
      offlineContexts.push(c);
      return c;
    },
  );
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

function makeNoteRow(overrides: Partial<PreviewNoteRow> = {}): PreviewNoteRow {
  return { y: 60, drumName: null, samplePath: null, notes: [], ...overrides };
}
function makeClip(
  overrides: Partial<PreviewTrack["clips"][number]> = {},
): PreviewTrack["clips"][number] {
  return {
    positionTicks: 0,
    lengthTicks: 96,
    clipLengthTicks: 96,
    clipIndex: 0,
    noteCount: 0,
    rowCount: 0,
    noteRows: [],
    ...overrides,
  };
}
function makePatch(overrides: Partial<PreviewPatch> = {}): PreviewPatch {
  return {
    mode: "subtractive",
    polyphonic: "poly",
    lpfMode: "24dB",
    osc1: { type: "saw", transpose: 0, cents: 0 },
    osc2: { type: "square", transpose: 0, cents: 0 },
    modulator1: null,
    modulator2: null,
    lfo1Type: "sine",
    lfo2Type: "sine",
    unisonNum: 1,
    unisonDetune: 0,
    arpMode: "off",
    arpOctaves: 1,
    arpSyncLevel: 0,
    params: { lpfFrequency: "7FFFFFFF", lpfResonance: "00000000" },
    envelope1: {
      attack: "00000000",
      decay: "00000000",
      sustain: "7FFFFFFF",
      release: "00000000",
    },
    envelope2: {
      attack: "00000000",
      decay: "00000000",
      sustain: "7FFFFFFF",
      release: "00000000",
    },
    patchCables: [],
    ...overrides,
  };
}
function makeTrack(overrides: Partial<PreviewTrack> = {}): PreviewTrack {
  return {
    name: "Track",
    isKit: false,
    instrumentType: "synth",
    midiChannel: null,
    cvChannel: null,
    patch: null,
    clips: [],
    ...overrides,
  };
}
function makeOpts(
  overrides: Partial<SongPlaybackOptions> = {},
): SongPlaybackOptions {
  return {
    bpm: 120,
    ticksPerQuarter: 48,
    tracks: [],
    durationTicks: 480,
    ...overrides,
  };
}

interface NoteInternal {
  trackIdx: number;
  midi: number;
  isKit: boolean;
  drumType: "kick" | "snare" | "hihat" | "clap" | "tom" | "cymbal" | "perc";
  samplePath: string | null;
  startSec: number;
  durSec: number;
  vel: number;
}
interface SongPlayerInternals {
  ctx: AudioContext | null;
  flatNotes: NoteInternal[];
  totalDurationSec: number;
  secPerTick: number;
  trackGains: { gain: ReturnType<typeof createParam> }[];
  noiseBuffer: AudioBuffer | null;
  scheduled: { sources: unknown[]; outputs: unknown[]; endTime: number }[];
  sampleBuffers: Map<string, AudioBuffer>;
  scheduleNote: (note: NoteInternal, when: number) => void;
  scheduleChunk: () => void;
}
function internals(p: SongPlayer): SongPlayerInternals {
  return p as unknown as SongPlayerInternals;
}

beforeEach(() => {
  stubAudioContext();
  stubOfflineAudioContext();
  stubRAF();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("flattenNotes (via constructor)", () => {
  it("flattens a single note with no looping", () => {
    const track = makeTrack({
      isKit: true,
      clips: [
        makeClip({
          noteRows: [
            makeNoteRow({
              drumName: "KICK",
              notes: [{ pos: 0, len: 12, vel: 100 }],
            }),
          ],
        }),
      ],
    });
    const p = new SongPlayer(makeOpts({ tracks: [track] }));
    const notes = internals(p).flatNotes;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      drumType: "kick",
      startSec: 0,
      vel: 100 / 127,
    });
  });

  it("repeats notes across clip-instance loops and truncates the final partial loop", () => {
    const track = makeTrack({
      isKit: true,
      clips: [
        makeClip({
          lengthTicks: 90,
          clipLengthTicks: 24,
          noteRows: [
            makeNoteRow({
              drumName: "SNARE",
              notes: [{ pos: 0, len: 4, vel: 80 }],
            }),
          ],
        }),
      ],
    });
    const p = new SongPlayer(makeOpts({ tracks: [track] }));
    const notes = internals(p).flatNotes;
    // ceil(90/24) = 4 loops, but a note at tick 3*24=72 is within [0,90); loop 4 would start at 96, excluded by ceil already at 4 loops (0,24,48,72)
    expect(notes).toHaveLength(4);
    expect(notes.map((n) => n.startSec)).toEqual(
      [0, 24, 48, 72].map((t) => t * internals(p).secPerTick),
    );
  });

  it("defaults note-row midi to 60 when y is null", () => {
    const track = makeTrack({
      isKit: true,
      clips: [
        makeClip({
          noteRows: [
            makeNoteRow({
              y: null,
              drumName: "PERC",
              notes: [{ pos: 0, len: 4, vel: 100 }],
            }),
          ],
        }),
      ],
    });
    const p = new SongPlayer(makeOpts({ tracks: [track] }));
    expect(internals(p).flatNotes[0].midi).toBe(60);
  });

  it.each([
    ["KICK", "kick"],
    ["BD", "kick"],
    ["SNARE", "snare"],
    ["SD", "snare"],
    ["HIHAT", "hihat"],
    ["HH", "hihat"],
    ["CLAP", "clap"],
    ["HAND CLAP", "clap"],
    ["TOM", "tom"],
    ["CRASH", "cymbal"],
    ["RIDE", "cymbal"],
    ["COWBELL", "perc"],
    ["SHAKER", "perc"],
  ] as const)("classifies drum name %s as %s", (name, expected) => {
    const track = makeTrack({
      isKit: true,
      clips: [
        makeClip({
          noteRows: [
            makeNoteRow({
              drumName: name,
              notes: [{ pos: 0, len: 4, vel: 100 }],
            }),
          ],
        }),
      ],
    });
    const p = new SongPlayer(makeOpts({ tracks: [track] }));
    expect(internals(p).flatNotes[0].drumType).toBe(expected);
  });

  it.each([
    [30, "kick"],
    [45, "snare"],
    [75, "hihat"],
    [60, "perc"],
  ] as const)(
    "falls back to midi range %d -> %s when no drum name",
    (midi, expected) => {
      const track = makeTrack({
        isKit: true,
        clips: [
          makeClip({
            noteRows: [
              makeNoteRow({
                y: midi,
                drumName: null,
                notes: [{ pos: 0, len: 4, vel: 100 }],
              }),
            ],
          }),
        ],
      });
      const p = new SongPlayer(makeOpts({ tracks: [track] }));
      expect(internals(p).flatNotes[0].drumType).toBe(expected);
    },
  );

  it("forces perc drumType for non-kit tracks regardless of midi", () => {
    const track = makeTrack({
      isKit: false,
      clips: [
        makeClip({
          noteRows: [
            makeNoteRow({ y: 30, notes: [{ pos: 0, len: 4, vel: 100 }] }),
          ],
        }),
      ],
    });
    const p = new SongPlayer(makeOpts({ tracks: [track] }));
    expect(internals(p).flatNotes[0].drumType).toBe("perc");
  });

  it("clamps note duration to the remaining instance length and floors it at 0.02s", () => {
    const track = makeTrack({
      isKit: true,
      clips: [
        makeClip({
          lengthTicks: 5,
          clipLengthTicks: 96,
          noteRows: [
            makeNoteRow({
              drumName: "KICK",
              notes: [{ pos: 0, len: 999, vel: 100 }],
            }),
          ],
        }),
      ],
    });
    const p = new SongPlayer(makeOpts({ tracks: [track] }));
    const [note] = internals(p).flatNotes;
    expect(note.durSec).toBeCloseTo(5 * internals(p).secPerTick, 6);
  });
});

describe("currentTick", () => {
  it("reports startOffsetSec/secPerTick while not playing", () => {
    const p = new SongPlayer(makeOpts());
    expect(p.currentTick).toBe(0);
  });
});

describe("play()", () => {
  it("builds the audio graph: compressor, EQ, filter, master, per-track gains, noise buffer", () => {
    const tracks = [makeTrack(), makeTrack()];
    const p = new SongPlayer(makeOpts({ tracks }));
    p.play();
    const ctx = currentFakeCtx();
    expect(ctx.createDynamicsCompressor).toHaveBeenCalledTimes(1);
    expect(ctx.createBiquadFilter).toHaveBeenCalled(); // eqLow, eqMid, eqHigh, filterNode
    expect(ctx.createGain).toHaveBeenCalled(); // masterGain + 2 track gains
    expect(ctx.createBuffer).toHaveBeenCalledWith(
      1,
      ctx.sampleRate,
      ctx.sampleRate,
    );
    expect(p.isPlaying).toBe(true);
    expect(p.isPaused).toBe(false);
    expect(internals(p).trackGains).toHaveLength(2);
    expect(internals(p).noiseBuffer).not.toBeNull();
  });

  it("narrows per-track gain by 1/sqrt(trackCount)", () => {
    const tracks = [makeTrack(), makeTrack(), makeTrack(), makeTrack()];
    const p = new SongPlayer(makeOpts({ tracks }));
    p.play();
    const g = internals(p).trackGains[0].gain.value;
    expect(g).toBeCloseTo(0.7 / 2, 5);
  });

  it("resumes in place instead of rebuilding the graph when unpausing", () => {
    const p = new SongPlayer(makeOpts({ tracks: [makeTrack()] }));
    p.play();
    p.pause();
    expect(contexts).toHaveLength(1);
    p.play();
    expect(contexts).toHaveLength(1);
    expect(currentFakeCtx().resume).toHaveBeenCalledTimes(1);
  });
});

describe("pause/stop/seek/dispose", () => {
  it("pause suspends the context and freezes the offset", () => {
    const p = new SongPlayer(makeOpts({ tracks: [makeTrack()] }));
    p.play();
    p.pause();
    expect(p.isPlaying).toBe(false);
    expect(p.isPaused).toBe(true);
    expect(currentFakeCtx().suspend).toHaveBeenCalledTimes(1);
  });

  it("stop resets the offset to 0 and reports tick 0", () => {
    const onTick = vi.fn();
    const p = new SongPlayer(makeOpts({ tracks: [makeTrack()], onTick }));
    p.play();
    p.stop();
    expect(p.isPlaying).toBe(false);
    expect(onTick).toHaveBeenCalledWith(0);
    expect(internals(p).ctx).toBeNull();
  });

  it("seek while playing restarts playback at the new tick", () => {
    const onTick = vi.fn();
    const p = new SongPlayer(makeOpts({ tracks: [makeTrack()], onTick }));
    p.play();
    p.seek(100);
    expect(onTick).toHaveBeenCalledWith(100);
    expect(p.isPlaying).toBe(true);
    expect(contexts).toHaveLength(2); // stopped + replayed -> new context
  });

  it("seek while paused updates the offset without resuming playback", () => {
    const p = new SongPlayer(makeOpts({ tracks: [makeTrack()] }));
    p.play();
    p.pause();
    p.seek(50);
    expect(p.isPlaying).toBe(false);
    expect(p.isPaused).toBe(false);
  });

  it("stops and disconnects any in-flight scheduled nodes", () => {
    const p = new SongPlayer(
      makeOpts({ tracks: [makeTrack({ isKit: true })] }),
    );
    p.play();
    internals(p).scheduleNote(
      {
        trackIdx: 0,
        midi: 45,
        isKit: true,
        drumType: "kick",
        samplePath: null,
        startSec: 0,
        durSec: 0.1,
        vel: 1,
      },
      0,
    );
    expect(internals(p).scheduled.length).toBeGreaterThan(0);
    expect(() => p.stop()).not.toThrow();
    expect(internals(p).scheduled).toHaveLength(0);
  });

  it("dispose stops playback and resets the offset", () => {
    const p = new SongPlayer(makeOpts({ tracks: [makeTrack()] }));
    p.play();
    p.dispose();
    expect(p.isPlaying).toBe(false);
    expect(p.currentTick).toBe(0);
  });
});

describe("track volume / mute", () => {
  it("defaults to volume 1 and unmuted", () => {
    const p = new SongPlayer(makeOpts({ tracks: [makeTrack()] }));
    expect(p.getTrackVolume(0)).toBe(1);
    expect(p.isTrackMuted(0)).toBe(false);
  });

  it("setTrackVolume scales the live gain node once playing", () => {
    const p = new SongPlayer(makeOpts({ tracks: [makeTrack()] }));
    p.play();
    p.setTrackVolume(0, 0.5);
    expect(p.getTrackVolume(0)).toBe(0.5);
    expect(internals(p).trackGains[0].gain.setTargetAtTime).toHaveBeenCalled();
  });

  it("setTrackMuted zeroes the live gain node", () => {
    const p = new SongPlayer(makeOpts({ tracks: [makeTrack()] }));
    p.play();
    p.setTrackMuted(0, true);
    expect(p.isTrackMuted(0)).toBe(true);
    expect(internals(p).trackGains[0].gain.value).toBe(0);
  });

  it("is a no-op before play() has created any nodes", () => {
    const p = new SongPlayer(makeOpts({ tracks: [makeTrack()] }));
    expect(() => p.setTrackVolume(0, 0.5)).not.toThrow();
  });
});

describe("EQ and filter controls", () => {
  it.each(["low", "mid", "high"] as EQBand[])(
    "getEQ/setEQ round-trips band %s",
    (band) => {
      const p = new SongPlayer(makeOpts({ tracks: [makeTrack()] }));
      p.setEQ(band, 3);
      expect(p.getEQ(band)).toBe(3);
    },
  );

  it.each(["low", "mid", "high"] as EQBand[])(
    "setEQ updates the live node once playing (%s)",
    (band) => {
      const p = new SongPlayer(makeOpts({ tracks: [makeTrack()] }));
      p.play();
      expect(() => p.setEQ(band, -6)).not.toThrow();
    },
  );

  it("defaults filter cutoff/resonance and updates the live node once playing", () => {
    const p = new SongPlayer(makeOpts({ tracks: [makeTrack()] }));
    expect(p.getFilterCutoff()).toBe(20000);
    expect(p.getFilterRes()).toBe(0.5);
    p.play();
    p.setFilterCutoff(8000);
    p.setFilterRes(4);
    expect(p.getFilterCutoff()).toBe(8000);
    expect(p.getFilterRes()).toBe(4);
  });
});

describe("scheduleNote dispatch", () => {
  function playerWithTracks(tracks: PreviewTrack[]) {
    const p = new SongPlayer(makeOpts({ tracks }));
    p.play();
    return p;
  }
  function note(overrides: Partial<NoteInternal>): NoteInternal {
    return {
      trackIdx: 0,
      midi: 60,
      isKit: false,
      drumType: "perc",
      samplePath: null,
      startSec: 0,
      durSec: 0.1,
      vel: 1,
      ...overrides,
    };
  }

  it("plays a resolved sample buffer when one is cached for the note path", () => {
    const p = playerWithTracks([makeTrack({ isKit: true })]);
    const buf = makeAudioBuffer(1, 100);
    internals(p).sampleBuffers.set("kit/x.wav", buf);
    const before = internals(p).scheduled.length;
    internals(p).scheduleNote(
      note({ isKit: true, samplePath: "kit/x.wav" }),
      0,
    );
    expect(internals(p).scheduled.length).toBe(before + 1);
    expect(currentFakeCtx().createBufferSource).toHaveBeenCalled();
  });

  it.each(["kick", "snare", "hihat", "clap", "tom", "cymbal", "perc"] as const)(
    "schedules a %s drum voice without throwing",
    (drumType) => {
      const p = playerWithTracks([makeTrack({ isKit: true })]);
      const before = internals(p).scheduled.length;
      expect(() =>
        internals(p).scheduleNote(note({ isKit: true, drumType, midi: 45 }), 0),
      ).not.toThrow();
      expect(internals(p).scheduled.length).toBeGreaterThan(before);
    },
  );

  it("kick voice ramps a sine oscillator from 150Hz down toward 30Hz", () => {
    const p = playerWithTracks([makeTrack({ isKit: true })]);
    const ctx = currentFakeCtx();
    internals(p).scheduleNote(note({ isKit: true, drumType: "kick" }), 0);
    const osc = ctx.createOscillator.mock.results.at(-1)!.value as ReturnType<
      typeof makeOscillatorNode
    >;
    expect(osc.type).toBe("sine");
    expect(osc.frequency.setValueAtTime).toHaveBeenCalledWith(150, 0);
  });

  it("routes through the synth patch voice path for non-kit tracks with a patch", () => {
    const p = playerWithTracks([makeTrack({ patch: makePatch() })]);
    const ctx = currentFakeCtx();
    const gainCallsBefore = ctx.createGain.mock.calls.length;
    expect(() =>
      internals(p).scheduleNote(note({ isKit: false }), 0),
    ).not.toThrow();
    expect(ctx.createGain.mock.calls.length).toBeGreaterThan(gainCallsBefore);
    expect(ctx.createBiquadFilter).toHaveBeenCalled();
  });

  it("routes through the FM patch voice path when patch.mode is fm", () => {
    const p = playerWithTracks([
      makeTrack({ patch: makePatch({ mode: "fm" }) }),
    ]);
    expect(() =>
      internals(p).scheduleNote(note({ isKit: false }), 0),
    ).not.toThrow();
  });

  it("falls back to a plain oscillator for non-kit tracks with no patch", () => {
    const p = playerWithTracks([
      makeTrack({ patch: null }),
      makeTrack({ patch: null }),
    ]);
    const before = internals(p).scheduled.length;
    internals(p).scheduleNote(note({ trackIdx: 1, isKit: false }), 0);
    expect(internals(p).scheduled.length).toBe(before + 1);
  });

  it("is a no-op when the note references a track with no gain node", () => {
    const p = playerWithTracks([makeTrack()]);
    const before = internals(p).scheduled.length;
    internals(p).scheduleNote(note({ trackIdx: 5 }), 0);
    expect(internals(p).scheduled.length).toBe(before);
  });
});

describe("scheduleChunk / onEnd", () => {
  it("schedules a note that falls inside the lookahead window on play()", async () => {
    const track = makeTrack({
      isKit: true,
      clips: [
        makeClip({
          noteRows: [
            makeNoteRow({
              drumName: "KICK",
              notes: [{ pos: 0, len: 4, vel: 100 }],
            }),
          ],
        }),
      ],
    });
    const p = new SongPlayer(makeOpts({ tracks: [track] }));
    p.play();
    await Promise.resolve();
    await Promise.resolve();
    expect(internals(p).scheduled.length).toBeGreaterThan(0);
  });

  it("stops and fires onEnd once elapsed time passes the total duration", () => {
    const onEnd = vi.fn();
    const p = new SongPlayer(
      makeOpts({ tracks: [makeTrack()], durationTicks: 48, onEnd }),
    );
    p.play();
    const ctx = internals(p).ctx as unknown as FakeAudioContext;
    ctx.currentTime = internals(p).totalDurationSec + 1;
    internals(p).scheduleChunk(); // first call advances scheduledUpToSec past the horizon
    internals(p).scheduleChunk(); // second call sees scheduledUpToSec >= total and elapsed >= total -> stop
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(p.isPlaying).toBe(false);
  });

  it("prunes finished voices from scheduled array on next chunk", () => {
    const p = new SongPlayer(
      makeOpts({ tracks: [makeTrack({ isKit: true })] }),
    );
    p.play();
    const ctx = internals(p).ctx as unknown as FakeAudioContext;
    internals(p).scheduleNote(
      {
        trackIdx: 0,
        midi: 45,
        isKit: true,
        drumType: "kick",
        samplePath: null,
        startSec: 0,
        durSec: 0.1,
        vel: 1,
      },
      0,
    );
    expect(internals(p).scheduled.length).toBeGreaterThan(0);
    const outputs = internals(p).scheduled[0].outputs;
    ctx.currentTime = 1;
    internals(p).scheduleChunk();
    expect(internals(p).scheduled).toHaveLength(0);
    expect(outputs[0].disconnect).toHaveBeenCalled();
  });

  it("tracks patch voice nodes for cleanup", () => {
    const p = new SongPlayer(
      makeOpts({ tracks: [makeTrack({ patch: makePatch() })] }),
    );
    p.play();
    internals(p).scheduleNote(
      {
        trackIdx: 0,
        midi: 60,
        isKit: false,
        drumType: "perc",
        samplePath: null,
        startSec: 0,
        durSec: 0.5,
        vel: 1,
      },
      0,
    );
    expect(internals(p).scheduled.length).toBeGreaterThan(0);
    const voice = internals(p).scheduled.at(-1)!;
    expect(voice.outputs.length).toBeGreaterThan(0);
    expect(voice.endTime).toBeGreaterThan(0);
  });

  it("patch voice scheduled entry includes child oscillator nodes from createSubVoice", () => {
    const p = new SongPlayer(
      makeOpts({ tracks: [makeTrack({ patch: makePatch() })] }),
    );
    p.play();
    internals(p).scheduleNote(
      {
        trackIdx: 0,
        midi: 60,
        isKit: false,
        drumType: "perc",
        samplePath: null,
        startSec: 0,
        durSec: 0.5,
        vel: 1,
      },
      0,
    );
    const voice = internals(p).scheduled.at(-1)!;
    expect(voice.sources.length).toBeGreaterThan(0);
    expect(voice.outputs.length).toBeGreaterThan(2);
  });

  it("evicts oldest voices when exceeding MAX_VOICES (64)", () => {
    const p = new SongPlayer(
      makeOpts({ tracks: [makeTrack({ isKit: true })] }),
    );
    p.play();
    const ctx = internals(p).ctx as unknown as FakeAudioContext;
    for (let i = 0; i < 70; i++) {
      internals(p).scheduleNote(
        {
          trackIdx: 0,
          midi: 45,
          isKit: true,
          drumType: "kick",
          samplePath: null,
          startSec: i * 0.1,
          durSec: 0.1,
          vel: 1,
        },
        i * 0.1,
      );
    }
    expect(internals(p).scheduled.length).toBe(70);
    ctx.currentTime = 0;
    internals(p).scheduleChunk();
    expect(internals(p).scheduled.length).toBeLessThanOrEqual(64);
  });

  it("fetches samples through the resolver and caches them before scheduling", async () => {
    const buf = makeAudioBuffer(1, 10);
    const resolver = vi.fn(async () => buf);
    const track = makeTrack({
      isKit: true,
      clips: [
        makeClip({
          noteRows: [
            makeNoteRow({
              drumName: "KICK",
              samplePath: "kit/kick.wav",
              notes: [{ pos: 0, len: 4, vel: 100 }],
            }),
          ],
        }),
      ],
    });
    const p = new SongPlayer(
      makeOpts({ tracks: [track], sampleResolver: resolver }),
    );
    p.play();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolver).toHaveBeenCalledWith("kit/kick.wav", expect.anything());
    expect(internals(p).sampleBuffers.get("kit/kick.wav")).toBe(buf);
  });
});

describe("animation loop", () => {
  it("reports currentTick via onTick on each animation frame", () => {
    const onTick = vi.fn();
    const p = new SongPlayer(makeOpts({ tracks: [makeTrack()], onTick }));
    p.play();
    flushRAF();
    expect(onTick).toHaveBeenCalled();
  });

  it("stops and fires onEnd from the animation loop once past the duration", () => {
    const onEnd = vi.fn();
    const p = new SongPlayer(
      makeOpts({ tracks: [makeTrack()], durationTicks: 48, onEnd }),
    );
    p.play();
    const ctx = internals(p).ctx as unknown as FakeAudioContext;
    ctx.currentTime = internals(p).totalDurationSec + 1;
    flushRAF();
    expect(onEnd).toHaveBeenCalled();
    expect(p.isPlaying).toBe(false);
  });
});
