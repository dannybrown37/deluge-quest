import { render, fireEvent, screen, cleanup } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('astro:transitions/client', () => ({ navigate: vi.fn() }));

vi.mock('../lib/homeAudio', () => ({
  homeAudio: {
    isPlaying: false,
    songLoaded: false,
    loadedSongIndex: -1,
    currentSongIndex: 0,
    songs: [{ name: 'First Song' }, { name: 'Second Song' }],
    currentSong: { name: 'First Song' },
    elapsed: 0,
    duration: 100,
    playOffset: 0,
    analyserNode: null,
    onNavigate: null,
    formatTime: vi.fn(() => '0:00 / 1:40'),
    subscribe: vi.fn(() => vi.fn()),
    fetchSongList: vi.fn().mockResolvedValue(undefined),
    initAudio: vi.fn().mockResolvedValue(undefined),
    loadSong: vi.fn().mockResolvedValue(true),
    togglePlay: vi.fn().mockResolvedValue(undefined),
    stepSong: vi.fn().mockResolvedValue(undefined),
    updateVolume: vi.fn(),
    updateFilter: vi.fn(),
    updateReverb: vi.fn(),
    updateDelay: vi.fn(),
    updatePlaybackRate: vi.fn(),
  },
}));

const { padPlay } = vi.hoisted(() => ({ padPlay: vi.fn() }));

vi.mock('../lib/padSounds', () => ({
  PAD_SOUNDS: Array.from({ length: 8 }, (_, i) => ({
    name: `sound${i}`,
    color: '#D4A847',
    play: padPlay,
  })),
  velocityForPosition: vi.fn(() => 0.5),
  glowForVelocity: vi.fn(() => 0.5),
  PadEffectsChain: class {
    input = {};
    updateVolume = vi.fn();
    updateFilter = vi.fn();
    updateReverb = vi.fn();
    updateDelay = vi.fn();
  },
}));

vi.mock('../lib/audioVisualizer', () => ({
  AudioVisualizer: class {
    connected = false;
    mode = 'bars';
    resize = vi.fn();
    start = vi.fn();
    connect = vi.fn();
    destroy = vi.fn();
  },
}));

import DelugeUI from './DelugeUI.svelte';
import { homeAudio } from '../lib/homeAudio';
import { navigate } from 'astro:transitions/client';

type MockAudio = {
  isPlaying: boolean;
  songLoaded: boolean;
  loadedSongIndex: number;
  currentSongIndex: number;
  songs: { name: string }[];
  currentSong: { name: string } | null;
  playOffset: number;
  analyserNode: unknown;
  onNavigate: unknown;
  formatTime: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  fetchSongList: ReturnType<typeof vi.fn>;
  initAudio: ReturnType<typeof vi.fn>;
  loadSong: ReturnType<typeof vi.fn>;
  togglePlay: ReturnType<typeof vi.fn>;
  updateVolume: ReturnType<typeof vi.fn>;
  updateFilter: ReturnType<typeof vi.fn>;
  updateReverb: ReturnType<typeof vi.fn>;
  updateDelay: ReturnType<typeof vi.fn>;
  updatePlaybackRate: ReturnType<typeof vi.fn>;
};

const audio = homeAudio as unknown as MockAudio;
const mockNavigate = navigate as unknown as ReturnType<typeof vi.fn>;

// `new AudioContext()` in ensurePadAudio(); happy-dom has no Web Audio.
class FakeAudioContext {
  state = 'running';
  resume = vi.fn();
  close = vi.fn();
}

// An arrow function cannot be called with `new`, so a stub context needs a real
// constructor. Returning an object from one overrides the instance.
function stubAudioContext(ctx = new FakeAudioContext()) {
  const built: FakeAudioContext[] = [];
  function Ctor(this: unknown) {
    built.push(ctx);
    return ctx;
  }
  vi.stubGlobal('AudioContext', Ctor);
  return { ctx, built };
}

beforeEach(() => {
  vi.clearAllMocks();
  audio.isPlaying = false;
  audio.songLoaded = false;
  audio.loadedSongIndex = -1;
  audio.currentSongIndex = 0;
  audio.songs = [{ name: 'First Song' }, { name: 'Second Song' }];
  audio.currentSong = { name: 'First Song' };
  audio.playOffset = 0;
  audio.formatTime.mockReturnValue('0:00 / 1:40');
  audio.subscribe.mockReturnValue(vi.fn());
  audio.fetchSongList.mockResolvedValue(undefined);
  audio.initAudio.mockResolvedValue(undefined);
  audio.loadSong.mockResolvedValue(true);
  audio.togglePlay.mockResolvedValue(undefined);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});


const soundPad = (i: number) => screen.getAllByLabelText(`sound${i}`)[0];
const oled = (c: HTMLElement) => c.querySelector('.oled-text')?.textContent?.trim();
const sub = (c: HTMLElement) => c.querySelector('.oled-subtext')?.textContent?.trim();

describe('DelugeUI', () => {
  describe('grid', () => {
    it('renders 16 main pads and 2 sidebar pads on each of 8 rows', () => {
      const { container } = render(DelugeUI);
      expect(container.querySelectorAll('.pad')).toHaveLength(8 * (16 + 2));
    });

    it('fills the main grid with the 8 drum sounds, one per 4x4 block', () => {
      render(DelugeUI);
      for (let i = 0; i < 8; i++) {
        expect(screen.getAllByLabelText(`sound${i}`)).toHaveLength(16);
      }
    });

    it('gives the right sidebar one pad per tool', () => {
      render(DelugeUI);
      for (const label of [
        'Card Management',
        'Song Stats',
        'Song Preview',
        'Score Converter',
        'Kit Builder',
        'Patch Generator',
        'MIDI Import',
        'Card History',
      ]) {
        expect(screen.getByLabelText(label)).toBeTruthy();
      }
    });

    it('gives the left sidebar the site links', () => {
      render(DelugeUI);
      expect(screen.getAllByLabelText('GitHub')).toHaveLength(3);
      expect(screen.getAllByLabelText('Songs')).toHaveLength(3);
      expect(screen.getAllByLabelText('FAQ')).toHaveLength(2);
    });
  });

  describe('screen', () => {
    it('shows the brand text when no songs are available', async () => {
      audio.songs = [];
      const { container } = render(DelugeUI);
      await vi.waitFor(() => expect(oled(container)).toBe('DELUGE.QUEST'));
    });

    it('shows the current song name once the list loads', async () => {
      const { container } = render(DelugeUI);
      await vi.waitFor(() => expect(oled(container)).toBe('FIRST SONG'));
      expect(sub(container)).toBe('press load');
    });

    it('says "press play" when the current song is already loaded', async () => {
      audio.loadedSongIndex = 0;
      const { container } = render(DelugeUI);
      await vi.waitFor(() => expect(sub(container)).toBe('press play'));
    });

    it('shows the sound name and velocity while hovering a drum pad', async () => {
      const { container } = render(DelugeUI);
      await vi.waitFor(() => expect(oled(container)).toBe('FIRST SONG'));
      await fireEvent.mouseEnter(soundPad(0));
      await vi.waitFor(() => expect(oled(container)).toBe('SOUND0'));
      expect(sub(container)).toBe('velocity 50%');
    });

    it('shows the tool description while hovering a tool pad', async () => {
      const { container } = render(DelugeUI);
      await vi.waitFor(() => expect(oled(container)).toBe('FIRST SONG'));
      await fireEvent.mouseEnter(screen.getByLabelText('Card Management'));
      await vi.waitFor(() => expect(oled(container)).toBe('CARD MANAGEMENT'));
      expect(sub(container)).toBe('organize samples & songs');
    });

    it('shows the site-link description while hovering a left sidebar pad', async () => {
      const { container } = render(DelugeUI);
      await vi.waitFor(() => expect(oled(container)).toBe('FIRST SONG'));
      await fireEvent.mouseEnter(screen.getAllByLabelText('GitHub')[0]);
      await vi.waitFor(() => expect(sub(container)).toBe('view source code'));
    });

    it('restores the song name when the pointer leaves', async () => {
      const { container } = render(DelugeUI);
      await vi.waitFor(() => expect(oled(container)).toBe('FIRST SONG'));
      await fireEvent.mouseEnter(soundPad(0));
      await fireEvent.mouseLeave(soundPad(0));
      await vi.waitFor(() => expect(oled(container)).toBe('FIRST SONG'));
      expect(sub(container)).toBe('press load');
    });

    it('scrolls the marquee when the song name overflows the screen', async () => {
      const { container } = render(DelugeUI);
      await vi.waitFor(() => expect(oled(container)).toBe('FIRST SONG'));
      const oledText = container.querySelector('.oled-text') as HTMLElement;
      const inner = oledText.firstElementChild as HTMLElement;
      Object.defineProperty(inner, 'scrollWidth', { value: 500, configurable: true });
      Object.defineProperty(oledText, 'clientWidth', { value: 100, configurable: true });
      await fireEvent.mouseEnter(screen.getByLabelText('Card Management'));
      await vi.waitFor(() => expect(oledText.classList.contains('is-scrolling')).toBe(true));
    });

    it('shows the elapsed time instead of a hint while playing', async () => {
      audio.isPlaying = true;
      const { container } = render(DelugeUI);
      await fireEvent.mouseEnter(soundPad(0));
      await fireEvent.mouseLeave(soundPad(0));
      await vi.waitFor(() => expect(sub(container)).toBe('0:00 / 1:40'));
    });
  });

  describe('pads', () => {
    it('plays the drum sound at the pad velocity on click', async () => {
      render(DelugeUI);
      await fireEvent.click(soundPad(3));
      expect(padPlay).toHaveBeenCalledTimes(1);
      expect(padPlay.mock.calls[0][2]).toBe(0.5);
    });

    it('reuses one AudioContext across many pad hits', async () => {
      const { built } = stubAudioContext();
      render(DelugeUI);
      await fireEvent.click(soundPad(0));
      await fireEvent.click(soundPad(1));
      expect(padPlay).toHaveBeenCalledTimes(2);
      expect(built).toHaveLength(1);
    });

    it('resumes a suspended AudioContext', async () => {
      const suspended = new FakeAudioContext();
      suspended.state = 'suspended';
      const { ctx } = stubAudioContext(suspended);
      render(DelugeUI);
      await fireEvent.click(soundPad(0));
      expect(ctx.resume).toHaveBeenCalled();
    });

    it('navigates in-app when a tool pad is clicked', async () => {
      render(DelugeUI);
      await fireEvent.click(screen.getByLabelText('Card Management'));
      expect(mockNavigate).toHaveBeenCalledWith('/manage');
      expect(padPlay).not.toHaveBeenCalled();
    });

    it('opens an external link in a new tab instead of navigating', async () => {
      const open = vi.fn();
      vi.stubGlobal('open', open);
      render(DelugeUI);
      await fireEvent.click(screen.getAllByLabelText('GitHub')[0]);
      expect(open).toHaveBeenCalledWith(
        'https://github.com/dannybrown37/deluge',
        '_blank',
        'noopener',
      );
      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });

  describe('transport', () => {
    it('starts the audio engine and toggles playback on play', async () => {
      render(DelugeUI);
      await fireEvent.click(screen.getByLabelText('Play'));
      await vi.waitFor(() => expect(audio.initAudio).toHaveBeenCalled());
      await vi.waitFor(() => expect(audio.togglePlay).toHaveBeenCalledWith(1));
    });

    it('shows a pause label while playing', async () => {
      audio.isPlaying = true;
      render(DelugeUI);
      await vi.waitFor(() => expect(screen.getByLabelText('Pause')).toBeTruthy());
    });

    it('reports the paused position after stopping mid-song', async () => {
      audio.playOffset = 30;
      const { container } = render(DelugeUI);
      await fireEvent.click(screen.getByLabelText('Play'));
      await vi.waitFor(() => expect(sub(container)).toBe('paused · 0:00 / 1:40'));
    });
  });

  describe('song browser', () => {
    it('opens and lists every song', async () => {
      render(DelugeUI);
      await fireEvent.click(screen.getByLabelText('Load song'));
      expect(screen.getByRole('listbox', { name: 'Song list' })).toBeTruthy();
      expect(screen.getByText('First Song')).toBeTruthy();
      expect(screen.getByText('Second Song')).toBeTruthy();
    });

    it('closes on a second press', async () => {
      render(DelugeUI);
      await fireEvent.click(screen.getByLabelText('Load song'));
      await fireEvent.click(screen.getByLabelText('Load song'));
      expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('stays closed when there are no songs', async () => {
      audio.songs = [];
      render(DelugeUI);
      await fireEvent.click(screen.getByLabelText('Load song'));
      expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('closes on Escape', async () => {
      render(DelugeUI);
      await fireEvent.click(screen.getByLabelText('Load song'));
      await fireEvent.keyDown(window, { key: 'Escape' });
      await vi.waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    });

    it('closes on a click outside the browser', async () => {
      render(DelugeUI);
      await fireEvent.click(screen.getByLabelText('Load song'));
      await fireEvent.mouseDown(document.body);
      await vi.waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    });

    it('moves the cursor on mouse hover over a song option', async () => {
      render(DelugeUI);
      await fireEvent.click(screen.getByLabelText('Load song'));
      const option = screen.getByText('Second Song').closest('.song-option') as HTMLElement;
      await fireEvent.mouseEnter(option);
    });

    it('stays open when the click lands inside the browser', async () => {
      render(DelugeUI);
      await fireEvent.click(screen.getByLabelText('Load song'));
      await fireEvent.mouseDown(screen.getByText('Second Song'));
      expect(screen.queryByRole('listbox')).toBeTruthy();
    });

    it('moves the cursor with the arrow keys and loads on Enter', async () => {
      render(DelugeUI);
      await fireEvent.click(screen.getByLabelText('Load song'));
      await fireEvent.keyDown(window, { key: 'ArrowDown' });
      await fireEvent.keyDown(window, { key: 'Enter' });
      await vi.waitFor(() => expect(audio.loadSong).toHaveBeenCalledWith(1));
    });

    it('wraps the cursor past the top of the list', async () => {
      render(DelugeUI);
      await fireEvent.click(screen.getByLabelText('Load song'));
      await fireEvent.keyDown(window, { key: 'ArrowUp' });
      await fireEvent.keyDown(window, { key: 'Enter' });
      await vi.waitFor(() => expect(audio.loadSong).toHaveBeenCalledWith(1));
    });

    it('loads the clicked song and navigates to its page', async () => {
      render(DelugeUI);
      await fireEvent.click(screen.getByLabelText('Load song'));
      await fireEvent.click(screen.getByText('Second Song'));
      await vi.waitFor(() => expect(audio.loadSong).toHaveBeenCalledWith(1));
      expect(mockNavigate).toHaveBeenCalledWith('/songs/second-song');
    });

    it('reports a failed load on the screen', async () => {
      audio.loadSong.mockResolvedValue(false);
      const { container } = render(DelugeUI);
      await fireEvent.click(screen.getByLabelText('Load song'));
      await fireEvent.click(screen.getByText('Second Song'));
      await vi.waitFor(() => expect(oled(container)).toBe('ERROR'));
      expect(sub(container)).toBe('load failed');
    });
  });

  describe('knobs', () => {
    it('shows the knob name and value on the screen while turning', async () => {
      const { container } = render(DelugeUI);
      await vi.waitFor(() => expect(oled(container)).toBe('FIRST SONG'));
      await fireEvent.wheel(screen.getByLabelText('output'), { deltaY: -100 });
      await vi.waitFor(() => expect(oled(container)).toBe('OUTPUT'));
      expect(sub(container)).toBe('102');
    });

    it('routes each knob to its own audio parameter', async () => {
      render(DelugeUI);
      await fireEvent.wheel(screen.getByLabelText('delay time'), { deltaY: -100 });
      await fireEvent.wheel(screen.getByLabelText('filter'), { deltaY: -100 });
      await fireEvent.wheel(screen.getByLabelText('reverb'), { deltaY: -100 });
      await fireEvent.wheel(screen.getByLabelText('tempo'), { deltaY: -100 });
      await fireEvent.wheel(screen.getByLabelText('output'), { deltaY: -100 });
      expect(audio.updateDelay).toHaveBeenCalled();
      expect(audio.updateFilter).toHaveBeenCalled();
      expect(audio.updateReverb).toHaveBeenCalled();
      expect(audio.updatePlaybackRate).toHaveBeenCalled();
      expect(audio.updateVolume).toHaveBeenCalled();
    });

    it('clamps a knob at its maximum', async () => {
      render(DelugeUI);
      const knob = screen.getByLabelText('output');
      for (let i = 0; i < 40; i++) {
        await fireEvent.wheel(knob, { deltaY: -100 });
      }
      expect(knob.getAttribute('aria-valuenow')).toBe('127');
    });

    it('clamps a knob at its minimum', async () => {
      render(DelugeUI);
      const knob = screen.getByLabelText('output');
      for (let i = 0; i < 60; i++) {
        await fireEvent.wheel(knob, { deltaY: 100 });
      }
      expect(knob.getAttribute('aria-valuenow')).toBe('0');
    });

    it('changes the value on a mouse drag', async () => {
      const { container } = render(DelugeUI);
      await fireEvent.mouseDown(screen.getByLabelText('output'), { clientY: 100 });
      await fireEvent.mouseMove(window, { clientY: 50 });
      await vi.waitFor(() => expect(oled(container)).toBe('OUTPUT'));
      expect(audio.updateVolume).toHaveBeenCalled();
      await fireEvent.mouseUp(window);
    });

    it('changes the value on a touch drag', async () => {
      const { container } = render(DelugeUI);
      await fireEvent.touchStart(screen.getByLabelText('filter'), {
        touches: [{ clientY: 100 }],
      });
      await fireEvent.touchMove(window, { touches: [{ clientY: 50 }] });
      await vi.waitFor(() => expect(oled(container)).toBe('FILTER'));
      expect(audio.updateFilter).toHaveBeenCalled();
      await fireEvent.touchEnd(window);
    });

    it('ignores pointer movement when no knob is held', async () => {
      render(DelugeUI);
      await fireEvent.mouseMove(window, { clientY: 50 });
      expect(audio.updateVolume).not.toHaveBeenCalled();
    });

    it.each(['delay time', 'delay fdbk', 'filter', 'resonance', 'reverb', 'tempo', 'output'])(
      'starts a drag on mousedown and touchstart for every knob: %s',
      async (label) => {
        render(DelugeUI);
        const knob = screen.getByLabelText(label);
        await fireEvent.mouseDown(knob, { clientY: 100 });
        await fireEvent.mouseUp(window);
        await fireEvent.touchStart(knob, { touches: [{ clientY: 100 }] });
        await fireEvent.touchEnd(window);
        await fireEvent.wheel(knob, { deltaY: -10 });
      },
    );

    it('applies the held knob display after releasing a knob, while playing', async () => {
      vi.useFakeTimers();
      audio.isPlaying = true;
      const { container } = render(DelugeUI);
      await fireEvent.mouseDown(screen.getByLabelText('output'), { clientY: 100 });
      await fireEvent.mouseMove(window, { clientY: 50 });
      await fireEvent.mouseUp(window);
      await vi.advanceTimersByTimeAsync(800);
      expect(sub(container)).toBe('0:00 / 1:40');
      vi.useRealTimers();
    });

    it('applies the held knob display after releasing a knob, while idle', async () => {
      vi.useFakeTimers();
      const { container } = render(DelugeUI);
      await fireEvent.mouseDown(screen.getByLabelText('output'), { clientY: 100 });
      await fireEvent.mouseMove(window, { clientY: 50 });
      await fireEvent.mouseUp(window);
      await vi.advanceTimersByTimeAsync(800);
      expect(sub(container)).toBe('press load');
      vi.useRealTimers();
    });

    it('plays back faster once the tempo knob is turned above center', async () => {
      render(DelugeUI);
      const tempo = screen.getByLabelText('tempo');
      for (let i = 0; i < 20; i++) {
        await fireEvent.wheel(tempo, { deltaY: -100 });
      }
      await fireEvent.click(screen.getByLabelText('Play'));
      await vi.waitFor(() => expect(audio.togglePlay).toHaveBeenCalled());
      expect(audio.togglePlay.mock.calls[0][0]).toBeGreaterThan(1);
    });

    it('re-applies knob levels to the pad effects chain once a pad has primed audio', async () => {
      stubAudioContext();
      render(DelugeUI);
      await fireEvent.click(soundPad(0));
      await fireEvent.click(screen.getByLabelText('Play'));
      await vi.waitFor(() => expect(audio.initAudio).toHaveBeenCalled());
    });

    it('restores every default on reset', async () => {
      const { container } = render(DelugeUI);
      await fireEvent.wheel(screen.getByLabelText('output'), { deltaY: 100 });
      audio.updateVolume.mockClear();
      await fireEvent.click(screen.getByLabelText('Reset knobs to default'));
      expect(audio.updateVolume).toHaveBeenCalledWith(100);
      expect(audio.updateFilter).toHaveBeenCalledWith(127, 0);
      await vi.waitFor(() => expect(sub(container)).toBe('knobs reset'));
    });
  });

  describe('visualizer', () => {
    it('switches mode when the toggle is pressed', async () => {
      const { container } = render(DelugeUI);
      const toggle = container.querySelector('.viz-toggle') as HTMLElement;
      expect(toggle).toBeTruthy();
      await fireEvent.click(toggle);
      await fireEvent.click(toggle);
    });

    it('switches visualizer mode via the mode-switch button', async () => {
      const { container } = render(DelugeUI);
      const toggles = container.querySelectorAll('.viz-toggle');
      const modeToggle = toggles[1] as HTMLElement;
      expect(modeToggle.title).toBe('Switch visualizer mode');
      await fireEvent.click(modeToggle);
      await fireEvent.click(modeToggle);
    });

    it('connects the visualizer to the analyser when audio is already loaded on mount', async () => {
      audio.analyserNode = {};
      audio.songLoaded = true;
      render(DelugeUI);
      await vi.waitFor(() => expect(audio.subscribe).toHaveBeenCalled());
    });

    it('resizes the visualizer on a window resize', async () => {
      render(DelugeUI);
      await fireEvent(window, new Event('resize'));
    });

    it('re-syncs from audio when the store notifies a change', async () => {
      render(DelugeUI);
      const cb = audio.subscribe.mock.calls[0][0];
      cb();
    });
  });

  describe('lifecycle', () => {
    it('clears the shared navigate hook so the home page advances in place', () => {
      audio.onNavigate = () => {};
      render(DelugeUI);
      expect(audio.onNavigate).toBeNull();
    });

    it('selects the song named by initialSongName', async () => {
      render(DelugeUI, { initialSongName: 'Second Song' });
      await vi.waitFor(() => expect(audio.currentSongIndex).toBe(1));
    });

    it('ignores an initialSongName that matches nothing', async () => {
      render(DelugeUI, { initialSongName: 'Nope' });
      await vi.waitFor(() => expect(audio.fetchSongList).toHaveBeenCalled());
      expect(audio.currentSongIndex).toBe(0);
    });

    it('unsubscribes from the audio store on destroy', () => {
      const unsub = vi.fn();
      audio.subscribe.mockReturnValue(unsub);
      const { unmount } = render(DelugeUI);
      unmount();
      expect(unsub).toHaveBeenCalled();
    });

    it('closes the pad AudioContext on destroy', async () => {
      const { ctx } = stubAudioContext();
      const { unmount } = render(DelugeUI);
      await fireEvent.click(soundPad(0));
      unmount();
      expect(ctx.close).toHaveBeenCalled();
    });
  });
});
