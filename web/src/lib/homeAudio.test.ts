import { describe, it, expect, beforeEach, vi } from 'vitest';

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
  const el: Record<string, any> = {
    src: '',
    crossOrigin: null,
    currentTime: 0,
    duration: 10,
    playbackRate: 1,
    paused: true,
    _listeners: {} as Record<string, Function[]>,
    addEventListener: vi.fn((event: string, handler: Function, _opts?: any) => {
      if (!el._listeners[event]) el._listeners[event] = [];
      el._listeners[event].push(handler);
    }),
    removeEventListener: vi.fn((event: string, handler: Function) => {
      if (el._listeners[event]) {
        el._listeners[event] = el._listeners[event].filter((h: Function) => h !== handler);
      }
    }),
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
    load: vi.fn(() => {
      const handlers = el._listeners['canplaythrough'] || [];
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
  let homeAudio: any;
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
    const filter = filters.find((f: any) => f.type === 'lowpass');
    expect(filter).toBeDefined();
    expect(filter!.frequency.value).toBe(22050);
  });

  it('registers mediaSession handlers on togglePlay', async () => {
    const handlers: Record<string, any> = {};
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      mediaSession: {
        metadata: null,
        playbackState: 'none',
        setActionHandler: vi.fn((action: string, handler: any) => {
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
    expect((homeAudio as any).keeper).toBeUndefined();
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
