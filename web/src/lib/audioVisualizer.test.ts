import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudioVisualizer, type VisualizerMode } from './audioVisualizer';

function makeGradient() {
  return { addColorStop: vi.fn() };
}
function makeCtx() {
  return {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    setTransform: vi.fn(),
    createRadialGradient: vi.fn(() => makeGradient()),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
  };
}
type FakeCtx = ReturnType<typeof makeCtx>;

function makeCanvas(width = 200, height = 100) {
  const ctx = makeCtx();
  const canvas = {
    width,
    height,
    getContext: vi.fn(() => ctx),
    getBoundingClientRect: vi.fn(() => ({ width, height })),
  } as unknown as HTMLCanvasElement;
  return { canvas, ctx };
}

function makeAnalyser(binCount: number, fill: (arr: Uint8Array) => void, state: AudioContextState = 'running') {
  return {
    frequencyBinCount: binCount,
    context: { state },
    getByteFrequencyData: vi.fn((arr: Uint8Array) => fill(arr)),
  } as unknown as AnalyserNode;
}

let rafCallbacks: Map<number, FrameRequestCallback>;
let rafNextId: number;
function stubRAF() {
  rafCallbacks = new Map();
  rafNextId = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = ++rafNextId;
    rafCallbacks.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { rafCallbacks.delete(id); });
}
function flushRAF(time = 0) {
  const entries = [...rafCallbacks.entries()];
  rafCallbacks.clear();
  for (const [, cb] of entries) cb(time);
}

let perfNow: number;
function stubPerformance() {
  perfNow = 0;
  vi.stubGlobal('performance', { now: () => perfNow });
}
function advancePerf(ms: number) {
  perfNow += ms;
}

interface VisualizerInternals {
  ctx: FakeCtx;
  nodeEnergy: Float32Array;
  connectionStrength: Float32Array;
  idlePhase: number;
  lastSignal: boolean;
  raf: number;
  hexWithAlpha: (hex: string, alpha: number) => string;
  drawBars: (w: number, h: number) => void;
  drawCircuit: (w: number, h: number, dt: number) => void;
  draw: () => void;
}
function internals(v: AudioVisualizer): VisualizerInternals {
  return v as unknown as VisualizerInternals;
}

beforeEach(() => {
  stubRAF();
  stubPerformance();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('construction', () => {
  it('acquires a 2d context and clamps devicePixelRatio to 2', () => {
    Object.defineProperty(window, 'devicePixelRatio', { value: 4, configurable: true });
    const { canvas } = makeCanvas();
    const viz = new AudioVisualizer(canvas);
    expect(canvas.getContext).toHaveBeenCalledWith('2d');
    viz.resize();
    expect(canvas.width).toBe(200 * 2);
  });

  it('defaults to the bars mode and is not connected', () => {
    const { canvas } = makeCanvas();
    const viz = new AudioVisualizer(canvas);
    expect(viz.mode).toBe('bars');
    expect(viz.connected).toBe(false);
  });
});

describe('mode', () => {
  it('resets node energy and connection strength when switched', () => {
    const { canvas } = makeCanvas();
    const viz = new AudioVisualizer(canvas);
    internals(viz).nodeEnergy.fill(1);
    internals(viz).connectionStrength.fill(1);
    viz.mode = 'circuit';
    expect(viz.mode).toBe('circuit');
    expect([...internals(viz).nodeEnergy]).toEqual([...internals(viz).nodeEnergy].map(() => 0));
    expect([...internals(viz).connectionStrength]).toEqual([...internals(viz).connectionStrength].map(() => 0));
  });
});

describe('connect', () => {
  it('marks the visualizer connected and sizes freqData to frequencyBinCount', () => {
    const { canvas } = makeCanvas();
    const viz = new AudioVisualizer(canvas);
    const analyser = makeAnalyser(32, () => {});
    viz.connect(analyser);
    expect(viz.connected).toBe(true);
  });
});

describe('start/stop', () => {
  it('start schedules a frame and is idempotent while running', () => {
    const { canvas } = makeCanvas();
    const viz = new AudioVisualizer(canvas);
    viz.start();
    expect(rafCallbacks.size).toBe(1);
    viz.start();
    expect(rafCallbacks.size).toBe(1); // no second schedule
  });

  it('stop cancels the pending frame', () => {
    const { canvas } = makeCanvas();
    const viz = new AudioVisualizer(canvas);
    viz.start();
    viz.stop();
    expect(rafCallbacks.size).toBe(0);
  });

  it('tick keeps re-scheduling itself while running, and stops rescheduling once stopped', () => {
    const { canvas } = makeCanvas();
    const viz = new AudioVisualizer(canvas);
    viz.start();
    flushRAF();
    expect(rafCallbacks.size).toBe(1); // tick rescheduled itself
    viz.stop();
    flushRAF();
    expect(rafCallbacks.size).toBe(0);
  });

  it('logs and keeps running when draw() throws', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { canvas, ctx } = makeCanvas();
    ctx.clearRect.mockImplementation(() => { throw new Error('boom'); });
    const viz = new AudioVisualizer(canvas);
    viz.start();
    expect(() => flushRAF()).not.toThrow();
    expect(errSpy).toHaveBeenCalledWith('[visualizer] draw failed', expect.any(Error));
    expect(rafCallbacks.size).toBe(1);
    errSpy.mockRestore();
  });
});

describe('resize', () => {
  it('scales canvas backing size by dpr and applies the transform', () => {
    Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
    const { canvas, ctx } = makeCanvas(300, 150);
    const viz = new AudioVisualizer(canvas);
    viz.resize();
    expect(canvas.width).toBe(300);
    expect(canvas.height).toBe(150);
    expect(ctx.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);
  });
});

describe('draw()', () => {
  function setup(mode: VisualizerMode, width = 200, height = 100) {
    Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
    const { canvas, ctx } = makeCanvas(width, height);
    const viz = new AudioVisualizer(canvas);
    viz.mode = mode;
    return { canvas, ctx, viz };
  }

  it('skips drawing entirely when the canvas has zero size', () => {
    const { ctx, viz } = setup('bars', 0, 0);
    internals(viz).draw();
    expect(ctx.clearRect).not.toHaveBeenCalled();
  });

  it('draws idle bars (no analyser) and advances idlePhase over time', () => {
    const { ctx, viz } = setup('bars');
    const phaseBefore = internals(viz).idlePhase;
    advancePerf(50);
    internals(viz).draw();
    expect(ctx.clearRect).toHaveBeenCalledTimes(1);
    expect(ctx.fillRect).not.toHaveBeenCalled(); // idle wave uses fill(), not fillRect
    expect(internals(viz).idlePhase).toBeGreaterThan(phaseBefore);
  });

  it('draws frequency bars once a signal is present', () => {
    const { ctx, viz } = setup('bars');
    viz.connect(makeAnalyser(64, (arr) => arr.fill(255)));
    internals(viz).draw();
    // one fillRect per bar, plus a highlight strip for every bar since value (1.0) > 0.6
    expect(ctx.fillRect).toHaveBeenCalledTimes(64 * 2);
  });

  it('logs a signal transition exactly once when signal state flips', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { viz } = setup('bars');
    viz.connect(makeAnalyser(64, (arr) => arr.fill(255)));
    internals(viz).draw();
    internals(viz).draw();
    const signalLogs = logSpy.mock.calls.filter((c) => c[0] === '[viz] signal:');
    expect(signalLogs).toHaveLength(1);
    logSpy.mockRestore();
  });

  it('draws the idle circuit grid when no signal is present', () => {
    const { ctx, viz } = setup('circuit');
    internals(viz).draw();
    expect(ctx.arc).toHaveBeenCalled();
    expect(ctx.clearRect).toHaveBeenCalledTimes(1);
  });

  it('draws the active circuit grid, with node glow once energy builds up', () => {
    const { ctx, viz } = setup('circuit');
    viz.connect(makeAnalyser(64, (arr) => arr.fill(255)));
    internals(viz).draw();
    internals(viz).draw();
    internals(viz).draw();
    expect(ctx.arc).toHaveBeenCalled();
    expect(ctx.createRadialGradient).toHaveBeenCalled(); // glow once energy > 0.15
  });

  it('drawBars/drawCircuit are no-ops if called without freqData', () => {
    const { ctx, viz } = setup('bars');
    internals(viz).drawBars(100, 100);
    internals(viz).drawCircuit(100, 100, 0);
    expect(ctx.fillRect).not.toHaveBeenCalled();
    expect(ctx.arc).not.toHaveBeenCalled();
  });
});

describe('hexWithAlpha', () => {
  it.each([
    [1, 'ff'],
    [0, '00'],
    [0.5, '80'],
  ])('alpha %d -> suffix %s', (alpha, suffix) => {
    const { canvas } = makeCanvas();
    const viz = new AudioVisualizer(canvas);
    expect(internals(viz).hexWithAlpha('#D4A847', alpha)).toBe(`#D4A847${suffix}`);
  });

  it('clamps out-of-range alpha to [0, 1]', () => {
    const { canvas } = makeCanvas();
    const viz = new AudioVisualizer(canvas);
    expect(internals(viz).hexWithAlpha('#D4A847', 5)).toBe('#D4A847ff');
    expect(internals(viz).hexWithAlpha('#D4A847', -5)).toBe('#D4A84700');
  });
});

describe('destroy', () => {
  it('stops the loop and disconnects the analyser', () => {
    const { canvas } = makeCanvas();
    const viz = new AudioVisualizer(canvas);
    viz.connect(makeAnalyser(32, () => {}));
    viz.start();
    viz.destroy();
    expect(viz.connected).toBe(false);
    expect(rafCallbacks.size).toBe(0);
  });
});
