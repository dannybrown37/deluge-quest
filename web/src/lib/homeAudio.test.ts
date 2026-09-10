import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { HomeAudioPlayer } from './homeAudio';

vi.mock('./analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./analytics')>();
  return { ...actual, track: vi.fn() };
});

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
  // Starts nonzero: homeAudio.ts treats a lastTickAt of exactly 0 as "clock
  // stopped" and skips accrual on the first tick after that sentinel value.
  perfNow = 1000;
  vi.stubGlobal('performance', { now: () => perfNow });
}
function advancePerf(ms: number) { perfNow += ms; }

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
    disconnect: vi.fn(),
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
      disconnect: vi.fn(),
    })),
    destination: {},
  };
}

describe('HomeAudioPlayer', () => {
  let homeAudio: HomeAudioPlayer;
  let mockCtx: ReturnType<typeof createMockAudioContext>;
  let filters: ReturnType<typeof createMockBiquadFilter>[];
  let mockAudioEl: ReturnType<typeof createMockAudioElement>;
  let trackSpy: ReturnType<typeof vi.fn>;

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
    const analyticsMod = await import('./analytics');
    trackSpy = analyticsMod.track as unknown as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  describe('subscribe', () => {
    it('notifies subscribers and stops after unsubscribing', async () => {
      const listener = vi.fn();
      const unsubscribe = homeAudio.subscribe(listener);
      await homeAudio.initAudio();
      homeAudio.songLoaded = true;
      homeAudio.songs = [{ file: 'test.mp3', name: 'Test' }];
      await homeAudio.togglePlay();
      expect(listener).toHaveBeenCalled();

      unsubscribe();
      listener.mockClear();
      await homeAudio.togglePlay();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('getters', () => {
    it('elapsed/playOffset/duration read from the media element, defaulting to 0', () => {
      expect(homeAudio.elapsed).toBe(0);
      expect(homeAudio.playOffset).toBe(0);
      expect(homeAudio.duration).toBe(0);
    });

    it('elapsed/playOffset/duration reflect the live media element once loaded', async () => {
      await homeAudio.initAudio();
      mockAudioEl.currentTime = 4.5;
      mockAudioEl.duration = 10;
      expect(homeAudio.elapsed).toBe(4.5);
      expect(homeAudio.playOffset).toBe(4.5);
      expect(homeAudio.duration).toBe(10);
    });

    it('duration falls back to 0 for a non-finite value (unloaded media)', async () => {
      await homeAudio.initAudio();
      mockAudioEl.duration = NaN;
      expect(homeAudio.duration).toBe(0);
    });
  });

  describe('fetchSongList', () => {
    it('fetches, shuffles, and stores the song list', async () => {
      const songs = [{ file: 'a.mp3', name: 'A' }, { file: 'b.mp3', name: 'B' }];
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => songs })));
      await homeAudio.fetchSongList();
      expect(homeAudio.songs).toHaveLength(2);
      expect(homeAudio.currentSongIndex).toBe(0);
    });

    it('is a no-op once songs are already loaded', async () => {
      const fetchMock = vi.fn(async () => ({ ok: true, json: async () => [] }));
      vi.stubGlobal('fetch', fetchMock);
      homeAudio.songs = [{ file: 'x.mp3', name: 'X' }];
      await homeAudio.fetchSongList();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('leaves songs empty when the response is not ok', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => [] })));
      await homeAudio.fetchSongList();
      expect(homeAudio.songs).toHaveLength(0);
    });

    it('swallows fetch errors', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
      await expect(homeAudio.fetchSongList()).resolves.toBeUndefined();
      expect(homeAudio.songs).toHaveLength(0);
    });
  });

  describe('createImpulse', () => {
    it('fills both channels with noise decaying toward zero', () => {
      const randSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
      const len = 100;
      const chans = [new Float32Array(len), new Float32Array(len)];
      const fakeCtx = {
        sampleRate: 10,
        createBuffer: vi.fn(() => ({ getChannelData: (c: number) => chans[c] })),
      } as unknown as AudioContext;

      const buf = homeAudio.createImpulse(fakeCtx, len / 10, 2);
      const data = buf.getChannelData(0);
      expect(data[0]).toBeCloseTo(1, 5); // (1*2-1) * (1 - 0/len)^2 == 1
      expect(data[len - 1]).toBeCloseTo(0, 1); // decays toward 0 by the end
      randSpy.mockRestore();
    });
  });

  describe('initAudio', () => {
    it('resumes an existing context instead of rebuilding the graph when suspended', async () => {
      await homeAudio.initAudio();
      const gainCallsBefore = mockCtx.createGain.mock.calls.length;
      mockCtx.state = 'suspended';
      await homeAudio.initAudio();
      expect(mockCtx.resume).toHaveBeenCalledTimes(1);
      expect(mockCtx.createGain.mock.calls.length).toBe(gainCallsBefore);
    });
  });

  describe('newMediaChain "ended" handling', () => {
    it('advances to the next song when a track ends', async () => {
      await homeAudio.initAudio();
      const stepSpy = vi.spyOn(homeAudio, 'stepSong').mockResolvedValue(undefined);
      homeAudio.isPlaying = true;
      const listeners = (mockAudioEl as unknown as { _listeners: Record<string, (() => void)[]> })._listeners;
      listeners['ended'].at(-1)!();
      expect(homeAudio.isPlaying).toBe(false);
      expect(stepSpy).toHaveBeenCalledWith(1, true);
    });
  });

  describe('loadSong', () => {
    it('resolves true and marks the song loaded on canplaythrough', async () => {
      await homeAudio.initAudio();
      const file = 'weird name, comma.mp3';
      homeAudio.songs = [{ file, name: 'Weird' }];
      const ok = await homeAudio.loadSong(0);
      expect(ok).toBe(true);
      expect(homeAudio.songLoaded).toBe(true);
      expect(homeAudio.loadedSongIndex).toBe(0);
      expect(mockAudioEl.src).toBe(`/audio/${encodeURIComponent(file).replace(/%2C/g, ',')}`);
    });

    it('resolves false and logs on load failure', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await homeAudio.initAudio();
      homeAudio.songs = [{ file: 'bad.mp3', name: 'Bad' }];
      mockAudioEl.load = vi.fn(() => {
        const hs = (mockAudioEl as unknown as { _listeners: Record<string, (() => void)[]> })._listeners['error'] || [];
        for (const h of hs) h();
      });
      const ok = await homeAudio.loadSong(0);
      expect(ok).toBe(false);
      expect(homeAudio.songLoaded).toBe(false);
      errSpy.mockRestore();
    });

    it('returns false immediately when there is no media element or no songs', async () => {
      expect(await homeAudio.loadSong(0)).toBe(false);
    });

    it('pauses playback before loading a new song if currently playing', async () => {
      await homeAudio.initAudio();
      homeAudio.songs = [{ file: 'a.mp3', name: 'A' }, { file: 'b.mp3', name: 'B' }];
      homeAudio.isPlaying = true;
      await homeAudio.loadSong(1);
      expect(mockAudioEl.pause).toHaveBeenCalled();
      expect(homeAudio.isPlaying).toBe(false);
    });
  });

  describe('stepSong', () => {
    it('wraps the song index and notifies onNavigate', async () => {
      homeAudio.songs = [{ file: 'a.mp3', name: 'A' }, { file: 'b.mp3', name: 'B' }];
      homeAudio.currentSongIndex = 1;
      const onNavigate = vi.fn();
      homeAudio.onNavigate = onNavigate;
      await homeAudio.stepSong(1);
      expect(homeAudio.currentSongIndex).toBe(0);
      expect(onNavigate).toHaveBeenCalledWith(homeAudio.songs[0]);
    });

    it('resumes playback after stepping if it was already playing', async () => {
      homeAudio.songs = [{ file: 'a.mp3', name: 'A' }, { file: 'b.mp3', name: 'B' }];
      homeAudio.isPlaying = true;
      const toggleSpy = vi.spyOn(homeAudio, 'togglePlay').mockResolvedValue(undefined);
      await homeAudio.stepSong(1);
      expect(toggleSpy).toHaveBeenCalled();
    });
  });

  describe('togglePlay guards', () => {
    it('is a no-op if the song is not yet loaded', async () => {
      await homeAudio.initAudio();
      homeAudio.songLoaded = false;
      await homeAudio.togglePlay();
      expect(homeAudio.isPlaying).toBe(false);
      expect(mockAudioEl.play).not.toHaveBeenCalled();
    });
  });

  describe('togglePlay analytics', () => {
    it('tracks song_play only on the first play of a loaded song', async () => {
      await homeAudio.initAudio();
      homeAudio.songLoaded = true;
      homeAudio.songs = [{ file: 'test.mp3', name: 'Test', slug: 'test-song' }];

      await homeAudio.togglePlay();
      expect(trackSpy).toHaveBeenCalledWith('song_play', { song: 'test-song' });

      trackSpy.mockClear();
      await homeAudio.togglePlay(); // pause
      await homeAudio.togglePlay(); // play again
      expect(trackSpy).not.toHaveBeenCalledWith('song_play', expect.anything());
    });
  });

  describe('listen-time tracking', () => {
    beforeEach(() => {
      stubRAF();
      stubPerformance();
    });

    it('accrues listen seconds and reports progress marks while playing', async () => {
      await homeAudio.initAudio();
      homeAudio.songLoaded = true;
      homeAudio.songs = [{ file: 'test.mp3', name: 'Test' }];
      mockAudioEl.duration = 10;
      mockAudioEl.currentTime = 0;

      await homeAudio.togglePlay();
      mockAudioEl.currentTime = 2.5; // 25% of 10s
      advancePerf(1000);
      flushRAF();

      expect(trackSpy).toHaveBeenCalledWith('song_progress', { song: 'Test', percent: 25 });
    });

    it('flushes unreported listen time on pause, rounded to whole seconds', async () => {
      await homeAudio.initAudio();
      homeAudio.songLoaded = true;
      homeAudio.songs = [{ file: 'test.mp3', name: 'Test' }];

      await homeAudio.togglePlay();
      advancePerf(3200);
      flushRAF();
      await homeAudio.togglePlay(); // pause -> flushListenTime

      expect(trackSpy).toHaveBeenCalledWith('song_listen', { song: 'Test', seconds: 3 });
    });

    it('does not report listen time under 1 second', async () => {
      await homeAudio.initAudio();
      homeAudio.songLoaded = true;
      homeAudio.songs = [{ file: 'test.mp3', name: 'Test' }];

      await homeAudio.togglePlay();
      advancePerf(400);
      flushRAF();
      await homeAudio.togglePlay();

      expect(trackSpy).not.toHaveBeenCalledWith('song_listen', expect.anything());
    });

    it('the animation-frame tick stops rescheduling once playback stops out from under it', async () => {
      await homeAudio.initAudio();
      homeAudio.songLoaded = true;
      homeAudio.songs = [{ file: 'test.mp3', name: 'Test' }];

      await homeAudio.togglePlay();
      expect(rafCallbacks.size).toBe(1);
      homeAudio.isPlaying = false; // simulate playback stopping without going through togglePlay
      flushRAF();
      expect(rafCallbacks.size).toBe(0);
    });
  });

  describe('installUnloadFlush', () => {
    it('flushes listen time when the page becomes hidden', async () => {
      stubRAF();
      stubPerformance();
      await homeAudio.initAudio();
      homeAudio.songLoaded = true;
      homeAudio.songs = [{ file: 'test.mp3', name: 'Test' }];

      await homeAudio.togglePlay();
      advancePerf(1500);
      flushRAF();

      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });

      expect(trackSpy).toHaveBeenCalledWith('song_listen', { song: 'Test', seconds: expect.any(Number) });
    });

    it('flushes listen time on pagehide', async () => {
      stubRAF();
      stubPerformance();
      await homeAudio.initAudio();
      homeAudio.songLoaded = true;
      homeAudio.songs = [{ file: 'test.mp3', name: 'Test' }];

      await homeAudio.togglePlay();
      advancePerf(1500);
      flushRAF();
      window.dispatchEvent(new Event('pagehide'));

      expect(trackSpy).toHaveBeenCalledWith('song_listen', { song: 'Test', seconds: expect.any(Number) });
    });
  });

  describe('parameter update methods', () => {
    it('updateVolume scales 0-127 into gain 0-1', async () => {
      await homeAudio.initAudio();
      homeAudio.updateVolume(127);
      expect(homeAudio.gainNode!.gain.value).toBeCloseTo(1, 5);
    });

    it('updateFilter maps cutoff exponentially and resonance linearly', async () => {
      await homeAudio.initAudio();
      homeAudio.updateFilter(0, 0);
      expect(homeAudio.filterNode!.frequency.value).toBeCloseTo(80, 5);
      expect(homeAudio.filterNode!.Q.value).toBeCloseTo(0.5, 5);
    });

    it('updateReverb crossfades dry/wet gain', async () => {
      await homeAudio.initAudio();
      homeAudio.updateReverb(127);
      expect(homeAudio.dryGain!.gain.value).toBeCloseTo(0.5, 5);
      expect(homeAudio.wetGain!.gain.value).toBeCloseTo(1, 5);
    });

    it('updateDelay maps time and feedback into their ranges', async () => {
      await homeAudio.initAudio();
      homeAudio.updateDelay(127, 127);
      expect(homeAudio.delayNode!.delayTime.value).toBeCloseTo(0.8, 5);
      expect(homeAudio.delayFeedback!.gain.value).toBeCloseTo(0.85, 5);
    });

    it('updatePlaybackRate maps 0-127 into 0.5x-2x pivoting at 64', async () => {
      await homeAudio.initAudio();
      homeAudio.updatePlaybackRate(0);
      expect(homeAudio.mediaElement!.playbackRate).toBeCloseTo(0.5, 5);
      homeAudio.updatePlaybackRate(127);
      expect(homeAudio.mediaElement!.playbackRate).toBeCloseTo(2.0, 3);
    });

    it('all update methods no-op before initAudio has created any nodes', () => {
      expect(() => {
        homeAudio.updateVolume(64);
        homeAudio.updateFilter(64, 64);
        homeAudio.updateReverb(64);
        homeAudio.updateDelay(64, 64);
        homeAudio.updatePlaybackRate(64);
      }).not.toThrow();
    });
  });

  describe('formatTime', () => {
    it.each([
      [0, 0, '0:00 / 0:00'],
      [65, 125, '1:05 / 2:05'],
      [5, 59, '0:05 / 0:59'],
    ])('formatTime(%d, %d) -> %s', (current, total, expected) => {
      expect(homeAudio.formatTime(current, total)).toBe(expected);
    });
  });

  describe('mediaSession action handlers', () => {
    async function setUpWithHandlers() {
      const handlers: Record<string, () => void> = {};
      vi.stubGlobal('navigator', {
        ...globalThis.navigator,
        mediaSession: {
          metadata: null,
          playbackState: 'none',
          setActionHandler: vi.fn((action: string, handler: () => void) => { handlers[action] = handler; }),
        },
      });
      await homeAudio.initAudio();
      homeAudio.songLoaded = true;
      homeAudio.songs = [{ file: 'a.mp3', name: 'A' }, { file: 'b.mp3', name: 'B' }];
      homeAudio.initMediaSession();
      return handlers;
    }

    it('play/pause/stop handlers toggle playback based on current state', async () => {
      const handlers = await setUpWithHandlers();
      const toggleSpy = vi.spyOn(homeAudio, 'togglePlay').mockResolvedValue(undefined);

      homeAudio.isPlaying = false;
      handlers['play']();
      expect(toggleSpy).toHaveBeenCalledTimes(1);

      toggleSpy.mockClear();
      homeAudio.isPlaying = false;
      handlers['pause'](); // already paused -> no-op
      expect(toggleSpy).not.toHaveBeenCalled();

      homeAudio.isPlaying = true;
      handlers['pause']();
      expect(toggleSpy).toHaveBeenCalledTimes(1);

      toggleSpy.mockClear();
      homeAudio.isPlaying = true;
      handlers['stop']();
      expect(toggleSpy).toHaveBeenCalledTimes(1);
    });

    it('nexttrack/previoustrack step the playlist only when there is more than one song', async () => {
      const handlers = await setUpWithHandlers();
      const stepSpy = vi.spyOn(homeAudio, 'stepSong').mockResolvedValue(undefined);

      handlers['nexttrack']();
      expect(stepSpy).toHaveBeenCalledWith(1);
      handlers['previoustrack']();
      expect(stepSpy).toHaveBeenCalledWith(-1);

      stepSpy.mockClear();
      homeAudio.songs = [{ file: 'a.mp3', name: 'A' }];
      handlers['nexttrack']();
      handlers['previoustrack']();
      expect(stepSpy).not.toHaveBeenCalled();
    });
  });

  describe('reassertMediaSession', () => {
    it('re-registers handlers and refreshes metadata when a song is loaded', async () => {
      vi.stubGlobal('navigator', {
        ...globalThis.navigator,
        mediaSession: { metadata: null, playbackState: 'none', setActionHandler: vi.fn() },
      });
      await homeAudio.initAudio();
      homeAudio.songLoaded = true;
      homeAudio.songs = [{ file: 'test.mp3', name: 'Test' }];
      expect(() => homeAudio.reassertMediaSession()).not.toThrow();
    });
  });
});
