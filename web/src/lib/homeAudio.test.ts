import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { HomeAudioPlayer } from './homeAudio';

function createMockBiquadFilter() {
  return {
    type: 'lowpass',
    frequency: { value: 350, setTargetAtTime: vi.fn() },
    Q: { value: 0, setTargetAtTime: vi.fn() },
    gain: { value: 0 },
    connect: vi.fn(),
  };
}

function createMockGain() {
  return {
    gain: { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
    connect: vi.fn(),
  };
}

function createMockAudioElement() {
  const el: Record<string, unknown> = {
    src: '',
    crossOrigin: null,
    currentTime: 0,
    duration: 10,
    playbackRate: 1,
    paused: true,
    _listeners: {} as Record<string, ((...args: unknown[]) => void)[]>,
    addEventListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const listeners = el._listeners as Record<string, ((...args: unknown[]) => void)[]>;
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    removeEventListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const listeners = el._listeners as Record<string, ((...args: unknown[]) => void)[]>;
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((h) => h !== handler);
      }
    }),
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
    load: vi.fn(() => {
      const listeners = el._listeners as Record<string, ((...args: unknown[]) => void)[]>;
      const handlers = listeners['canplaythrough'] || [];
      for (const h of handlers) h();
    }),
  };
  return el;
}

function createMockAudioContext() {
  return {
    state: 'running',
    currentTime: 0,
    sampleRate: 44100,
    resume: vi.fn(),
    createBiquadFilter: vi.fn(() => createMockBiquadFilter()),
    createGain: vi.fn(() => createMockGain()),
    createConvolver: vi.fn(() => ({ buffer: null, connect: vi.fn() })),
    createDelay: vi.fn(() => ({
      delayTime: { value: 0 },
      connect: vi.fn(),
    })),
    createAnalyser: vi.fn(() => ({
      fftSize: 0,
      connect: vi.fn(),
    })),
    createBuffer: vi.fn(() => ({
      getChannelData: () => new Float32Array(1),
    })),
    createMediaElementSource: vi.fn(() => ({
      connect: vi.fn(),
    })),
    destination: {},
  };
}

describe('HomeAudioPlayer', () => {
  let homeAudio: HomeAudioPlayer;
  let mockCtx: ReturnType<typeof createMockAudioContext>;
  let filters: ReturnType<typeof createMockBiquadFilter>[];
  let mockAudioEl: ReturnType<typeof createMockAudioElement>;

  beforeEach(async () => {
    vi.resetModules();
    filters = [];
    mockCtx = createMockAudioContext();
    mockCtx.createBiquadFilter = vi.fn(() => {
      const f = createMockBiquadFilter();
      filters.push(f);
      return f;
    });

    mockAudioEl = createMockAudioElement();

    vi.stubGlobal('AudioContext', function() { return mockCtx; });
    vi.stubGlobal('Audio', function() { return mockAudioEl; });
    vi.stubGlobal('MediaMetadata', vi.fn());

    const mod = await import('./homeAudio');
    homeAudio = mod.homeAudio;
  });

  it('sets filter cutoff to max (22050) on initAudio', async () => {
    await homeAudio.initAudio();
    const filter = filters.find((f) => f.type === 'lowpass');
    expect(filter).toBeDefined();
    expect(filter!.frequency.value).toBe(22050);
  });

  it('registers mediaSession handlers on togglePlay', async () => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      mediaSession: {
        metadata: null,
        playbackState: 'none',
        setActionHandler: vi.fn((action: string, handler: (...args: unknown[]) => void) => {
          handlers[action] = handler;
        }),
      },
    });

    await homeAudio.initAudio();
    homeAudio.songLoaded = true;
    homeAudio.songs = [{ file: 'test.mp3', name: 'Test' }];

    await homeAudio.togglePlay();

    expect(handlers['play']).toBeDefined();
    expect(handlers['pause']).toBeDefined();
    expect(handlers['nexttrack']).toBeDefined();
    expect(handlers['previoustrack']).toBeDefined();
  });

  it('uses real <audio> element instead of silent keeper', async () => {
    await homeAudio.initAudio();
    expect(homeAudio.mediaElement).toBeDefined();
    expect(mockCtx.createMediaElementSource).toHaveBeenCalled();
    expect((homeAudio as unknown as { keeper?: unknown }).keeper).toBeUndefined();
  });

  it('plays and pauses via the media element', async () => {
    await homeAudio.initAudio();
    homeAudio.songLoaded = true;
    homeAudio.songs = [{ file: 'test.mp3', name: 'Test' }];

    await homeAudio.togglePlay();
    expect(mockAudioEl.play).toHaveBeenCalled();
    expect(homeAudio.isPlaying).toBe(true);

    await homeAudio.togglePlay();
    expect(mockAudioEl.pause).toHaveBeenCalled();
    expect(homeAudio.isPlaying).toBe(false);
  });
});
