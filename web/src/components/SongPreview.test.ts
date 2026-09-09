import { render, fireEvent, screen, cleanup, waitFor } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PreviewData } from '../lib/pyodide';
import SongPreview from './SongPreview.svelte';

vi.mock('../lib/pyodide', () => ({
  loadPyodide: vi.fn(),
  inspectSong: vi.fn(),
}));

vi.mock('../lib/analytics', () => ({
  trackToolAction: vi.fn(),
}));

vi.mock('../lib/cardStore', () => ({
  cardStore: {
    isLoaded: false,
    songXmls: new Map(),
    rootHandle: null,
    eligibleSongs: vi.fn(() => []),
    loadCachedSongs: vi.fn().mockResolvedValue(null),
    getSampleBuffer: vi.fn(),
  },
}));

type FakePlayer = {
  onTick?: (tick: number) => void;
  onEnd?: () => void;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  seek: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  setEQ: ReturnType<typeof vi.fn>;
  setFilterCutoff: ReturnType<typeof vi.fn>;
  setFilterRes: ReturnType<typeof vi.fn>;
  setTrackVolume: ReturnType<typeof vi.fn>;
  setTrackMuted: ReturnType<typeof vi.fn>;
};

const playerInstances: FakePlayer[] = [];
vi.mock('../lib/songAudio', () => ({
  SongPlayer: vi.fn().mockImplementation(function (this: FakePlayer, opts: Partial<FakePlayer>) {
    Object.assign(this, opts, {
      play: vi.fn(),
      pause: vi.fn(),
      stop: vi.fn(),
      seek: vi.fn(),
      dispose: vi.fn(),
      setEQ: vi.fn(),
      setFilterCutoff: vi.fn(),
      setFilterRes: vi.fn(),
      setTrackVolume: vi.fn(),
      setTrackMuted: vi.fn(),
    });
    playerInstances.push(this);
  }),
}));

import { loadPyodide, inspectSong } from '../lib/pyodide';
import { trackToolAction } from '../lib/analytics';
import { cardStore } from '../lib/cardStore';

const mockLoadPyodide = loadPyodide as unknown as ReturnType<typeof vi.fn>;
const mockInspectSong = inspectSong as unknown as ReturnType<typeof vi.fn>;
const mockTrack = trackToolAction as unknown as ReturnType<typeof vi.fn>;
const mockCardStore = cardStore as unknown as {
  isLoaded: boolean;
  songXmls: Map<string, string>;
  rootHandle: { name: string } | null;
  eligibleSongs: ReturnType<typeof vi.fn>;
  loadCachedSongs: ReturnType<typeof vi.fn>;
};

function previewData(overrides: Partial<PreviewData> = {}): PreviewData {
  return {
    bpm: 120,
    key: 'C major',
    durationTicks: 384,
    durationStr: '0:04',
    ticksPerQuarter: 48,
    trackCount: 1,
    totalNotes: 2,
    hasArrangement: true,
    tracks: [
      {
        name: 'Synth 1',
        isKit: false,
        instrumentType: 'synth',
        midiChannel: null,
        cvChannel: null,
        patch: null,
        clips: [
          {
            positionTicks: 0,
            lengthTicks: 192,
            clipLengthTicks: 192,
            clipIndex: 0,
            noteCount: 2,
            rowCount: 1,
            noteRows: [],
          },
        ],
      },
    ],
    ...overrides,
  };
}

function xmlFile(name: string, content = '<song></song>'): File {
  return new File([content], name, { type: 'application/xml' });
}

function dropEvent(file: File | undefined) {
  return { dataTransfer: { files: file ? [file] : [] } } as unknown as DragEvent;
}

let lastResizeCallback: ((entries: { contentRect: { width: number } }[]) => void) | undefined;
class FakeResizeObserver {
  constructor(cb: (entries: { contentRect: { width: number } }[]) => void) {
    lastResizeCallback = cb;
  }
  observe() {}
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  vi.clearAllMocks();
  playerInstances.length = 0;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  mockLoadPyodide.mockImplementation(async (onProgress?: (stage: string, pct: number) => void) => {
    onProgress?.('Loading runtime', 10);
    return {};
  });
  mockInspectSong.mockResolvedValue(previewData());
  mockCardStore.isLoaded = false;
  mockCardStore.songXmls = new Map();
  mockCardStore.rootHandle = null;
  mockCardStore.eligibleSongs.mockReturnValue([]);
  mockCardStore.loadCachedSongs.mockResolvedValue(null);
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SongPreview', () => {
  it('renders the dropzone with no cached songs', async () => {
    render(SongPreview);
    await Promise.resolve();
    expect(screen.getByText('Drop a Deluge song file')).toBeTruthy();
    expect(screen.getByText(/No songs cached yet/)).toBeTruthy();
  });

  it('rejects a non-XML file with an error', async () => {
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(new File(['x'], 'song.mid')));
    expect(screen.getByText('Please drop a Deluge .XML song file')).toBeTruthy();
  });

  it('inspects a dropped file and shows the timeline panel', async () => {
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());

    expect(screen.getByText('C major')).toBeTruthy();
    expect(screen.getAllByText('Synth 1').length).toBeGreaterThan(0);
    expect(mockTrack).toHaveBeenCalledWith('preview', 'inspect');
  });

  it('shows an error when the song has no tracks', async () => {
    mockInspectSong.mockResolvedValue(previewData({ tracks: [] }));
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText(/No tracks found/)).toBeTruthy());
  });

  it('resets back to the dropzone', async () => {
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());

    await fireEvent.click(screen.getByText('Inspect another'));
    expect(screen.getByText('Drop a Deluge song file')).toBeTruthy();
  });

  it('toggles play/pause and creates a player on first play', async () => {
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());

    const playBtn = document.querySelector('.transport-btn[title="Play"]') as HTMLElement;
    await fireEvent.click(playBtn);

    expect(playerInstances.length).toBe(1);
    expect(playerInstances[0].play).toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith('preview', 'play');
    expect(document.querySelector('.transport-btn[title="Pause"]')).toBeTruthy();

    await fireEvent.click(document.querySelector('.transport-btn[title="Pause"]') as HTMLElement);
    expect(playerInstances[0].pause).toHaveBeenCalled();
  });

  it('stops playback and resets the playhead', async () => {
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());

    await fireEvent.click(document.querySelector('.transport-btn[title="Play"]') as HTMLElement);
    const stopBtn = document.querySelector('.transport-btn[title="Stop"]') as HTMLButtonElement;
    expect(stopBtn.disabled).toBe(false);

    await fireEvent.click(stopBtn);
    expect(playerInstances[0].stop).toHaveBeenCalled();
  });

  it('mutes a track and adjusts its volume', async () => {
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());

    await fireEvent.click(document.querySelector('.transport-btn[title="Play"]') as HTMLElement);

    const muteBtn = screen.getByTitle('Mute');
    await fireEvent.click(muteBtn);
    expect(playerInstances[0].setTrackMuted).toHaveBeenCalledWith(0, true);

    const slider = document.querySelector('.track-volume-slider') as HTMLInputElement;
    await fireEvent.input(slider, { target: { value: '0.5' } });
    expect(playerInstances[0].setTrackVolume).toHaveBeenCalledWith(0, 0.5);
  });

  it('adjusts a knob by dragging', async () => {
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());

    await fireEvent.click(document.querySelector('.transport-btn[title="Play"]') as HTMLElement);

    const cutoffKnob = document.querySelector('.knob-hitbox[title="Cutoff"]') as HTMLElement;
    await fireEvent.mouseDown(cutoffKnob, { clientY: 100 });
    await fireEvent.mouseMove(document, { clientY: 40 });
    await fireEvent.mouseUp(document);

    expect(playerInstances[0].setFilterCutoff).toHaveBeenCalled();
  });

  it('seeks on timeline click', async () => {
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());

    const svg = document.querySelector('.timeline-svg') as SVGSVGElement;
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 100, width: 800, height: 100, x: 0, y: 0, toJSON() {},
    });
    await fireEvent.click(svg, { clientX: 300, clientY: 20 });

    expect(playerInstances.length).toBe(1);
    expect(playerInstances[0].seek).toHaveBeenCalled();
  });

  it('shows and hides a clip tooltip on hover', async () => {
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());

    const clipRect = document.querySelector('.timeline-svg rect[style*="cursor: pointer"]') as SVGRectElement;
    await fireEvent.mouseEnter(clipRect, { clientX: 100, clientY: 50 });
    expect(document.querySelector('.tooltip')).toBeTruthy();

    await fireEvent.mouseLeave(clipRect);
    expect(document.querySelector('.tooltip')).toBeNull();
  });

  it('loads and picks a cached card song on the idle screen', async () => {
    mockCardStore.isLoaded = true;
    mockCardStore.songXmls = new Map([['song1.XML', '<song></song>']]);
    mockCardStore.rootHandle = { name: 'MY_CARD' };
    mockCardStore.eligibleSongs.mockReturnValue([{ path: 'song1.XML', xml: '<song></song>' }]);

    render(SongPreview);
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByText(/song with arrangement data on MY_CARD/)).toBeTruthy();
    await fireEvent.click(screen.getByText('song1.XML'));

    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());
  });

  it('resumes a stats-page song stashed in sessionStorage', async () => {
    sessionStorage.setItem(
      'deluge-preview-file',
      JSON.stringify({ name: 'stashed.XML', content: '<song></song>' }),
    );

    render(SongPreview);

    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());
    expect(sessionStorage.getItem('deluge-preview-file')).toBeNull();
  });

  it('shows a resume banner when stats results are cached', async () => {
    sessionStorage.setItem('deluge-stats-results', JSON.stringify([{ a: 1 }, { b: 2 }]));

    render(SongPreview);
    await Promise.resolve();

    expect(screen.getByText('2 songs loaded in Song Stats')).toBeTruthy();
  });

  it('adjusts the EQ Low knob by dragging', async () => {
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());

    await fireEvent.click(document.querySelector('.transport-btn[title="Play"]') as HTMLElement);

    const lowKnob = document.querySelector('.knob-hitbox[title="Low"]') as HTMLElement;
    await fireEvent.mouseDown(lowKnob, { clientY: 100 });
    await fireEvent.mouseMove(document, { clientY: 40 });
    await fireEvent.mouseUp(document);

    expect(playerInstances[0].setEQ).toHaveBeenCalledWith('low', expect.any(Number));
  });

  it('adjusts the Res knob by dragging', async () => {
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());

    await fireEvent.click(document.querySelector('.transport-btn[title="Play"]') as HTMLElement);

    const resKnob = document.querySelector('.knob-hitbox[title="Res"]') as HTMLElement;
    await fireEvent.mouseDown(resKnob, { clientY: 100 });
    await fireEvent.mouseMove(document, { clientY: 10 });
    await fireEvent.mouseUp(document);

    expect(playerInstances[0].setFilterRes).toHaveBeenCalled();
  });

  it('renders a Session chip and loop tooltip for session-mode clips', async () => {
    mockInspectSong.mockResolvedValue(
      previewData({
        hasArrangement: false,
        tracks: [
          {
            name: 'Drum Kit',
            isKit: true,
            instrumentType: 'kit',
            midiChannel: null,
            cvChannel: null,
            patch: null,
            clips: [
              {
                positionTicks: 0,
                lengthTicks: 576,
                clipLengthTicks: 192,
                clipIndex: 0,
                noteCount: 5,
                rowCount: 2,
                noteRows: [],
              },
            ],
          },
        ],
      }),
    );

    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());

    expect(screen.getByText('Session')).toBeTruthy();

    const clipRect = document.querySelector('.timeline-svg rect[style*="cursor: pointer"]') as SVGRectElement;
    await fireEvent.mouseEnter(clipRect, { clientX: 100, clientY: 50 });
    const tooltip = document.querySelector('.tooltip') as HTMLElement;
    expect(tooltip).toBeTruthy();
    const text = tooltip.textContent ?? '';
    expect(text).toMatch(/loops \dx/);
    expect(text).not.toMatch(/beat/);

    await fireEvent.mouseMove(clipRect, { clientX: 120, clientY: 60 });
    await fireEvent.mouseLeave(clipRect);
    expect(document.querySelector('.tooltip')).toBeNull();
  });

  it('shows fractional bar length in the tooltip', async () => {
    mockInspectSong.mockResolvedValue(
      previewData({
        tracks: [
          {
            name: 'Synth 1',
            isKit: false,
            instrumentType: 'synth',
            midiChannel: null,
            cvChannel: null,
            patch: null,
            clips: [
              {
                positionTicks: 0,
                lengthTicks: 96,
                clipLengthTicks: 96,
                clipIndex: 0,
                noteCount: 3,
                rowCount: 1,
                noteRows: [],
              },
            ],
          },
        ],
      }),
    );

    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());

    const clipRect = document.querySelector('.timeline-svg rect[style*="cursor: pointer"]') as SVGRectElement;
    await fireEvent.mouseEnter(clipRect, { clientX: 100, clientY: 50 });
    const text = (document.querySelector('.tooltip') as HTMLElement).textContent ?? '';
    expect(text).toMatch(/0\.5 bars/);
  });

  it('auto-scrolls the timeline as the playhead advances', async () => {
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());

    await fireEvent.click(document.querySelector('.transport-btn[title="Play"]') as HTMLElement);

    const scrollEl = document.querySelector('.timeline-scroll') as HTMLDivElement;
    Object.defineProperty(scrollEl, 'clientWidth', { value: 100, configurable: true });
    Object.defineProperty(scrollEl, 'scrollLeft', { value: 0, writable: true, configurable: true });

    playerInstances[0].onTick?.(10000);

    expect(scrollEl.scrollLeft).not.toBe(0);
  });

  it('mutes and adjusts volume for a second track', async () => {
    mockInspectSong.mockResolvedValue(
      previewData({
        trackCount: 2,
        tracks: [
          {
            name: 'Synth 1', isKit: false, instrumentType: 'synth', midiChannel: null, cvChannel: null, patch: null,
            clips: [{ positionTicks: 0, lengthTicks: 192, clipLengthTicks: 192, clipIndex: 0, noteCount: 2, rowCount: 1, noteRows: [] }],
          },
          {
            name: 'Kit 1', isKit: true, instrumentType: 'kit', midiChannel: null, cvChannel: null, patch: null,
            clips: [{ positionTicks: 0, lengthTicks: 192, clipLengthTicks: 192, clipIndex: 0, noteCount: 4, rowCount: 3, noteRows: [] }],
          },
        ],
      }),
    );

    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());

    await fireEvent.click(document.querySelector('.transport-btn[title="Play"]') as HTMLElement);

    const muteBtns = screen.getAllByTitle('Mute');
    await fireEvent.click(muteBtns[1]);
    expect(playerInstances[0].setTrackMuted).toHaveBeenCalledWith(1, true);

    const sliders = document.querySelectorAll('.track-volume-slider');
    await fireEvent.input(sliders[1], { target: { value: '0.2' } });
    expect(playerInstances[0].setTrackVolume).toHaveBeenCalledWith(1, 0.2);
  });

  it('fully resets from the error state', async () => {
    mockInspectSong.mockResolvedValue(previewData({ tracks: [] }));
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText(/No tracks found/)).toBeTruthy());

    await fireEvent.click(screen.getByText('Try again'));
    expect(screen.getByText('Drop a Deluge song file')).toBeTruthy();
  });

  it('displays midi and cv channel details on track rows', async () => {
    mockInspectSong.mockResolvedValue(
      previewData({
        tracks: [
          {
            name: 'Midi Out', isKit: false, instrumentType: 'midi', midiChannel: 3, cvChannel: null, patch: null,
            clips: [{ positionTicks: 0, lengthTicks: 192, clipLengthTicks: 192, clipIndex: 0, noteCount: 1, rowCount: 1, noteRows: [] }],
          },
          {
            name: 'CV Out', isKit: false, instrumentType: 'cv', midiChannel: null, cvChannel: 1, patch: null,
            clips: [{ positionTicks: 0, lengthTicks: 192, clipLengthTicks: 192, clipIndex: 0, noteCount: 1, rowCount: 1, noteRows: [] }],
          },
        ],
      }),
    );

    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());

    expect(screen.getByText('Ch 4')).toBeTruthy();
    expect(screen.getByText('Ch 2')).toBeTruthy();
  });

  it('shows the cached-scan banner with a saved timestamp', async () => {
    mockCardStore.isLoaded = false;
    mockCardStore.loadCachedSongs.mockResolvedValue({
      songs: [{ path: 'song1.XML', xml: '<song></song>' }],
      cardName: 'MY_CARD',
      savedAt: Date.now(),
    });

    render(SongPreview);
    await waitFor(() => expect(screen.getByText(/From your last card scan/)).toBeTruthy());
  });

  it('opens the file picker on Enter/Space over the dropzone', async () => {
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    const input = document.getElementById('preview-file-input') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click').mockImplementation(() => {});

    await fireEvent.keyDown(dropzone, { key: 'Enter' });
    expect(clickSpy).toHaveBeenCalledTimes(1);

    await fireEvent.keyDown(dropzone, { key: ' ' });
    expect(clickSpy).toHaveBeenCalledTimes(2);

    await fireEvent.keyDown(dropzone, { key: 'a' });
    expect(clickSpy).toHaveBeenCalledTimes(2);
  });

  it('moves the tooltip position while hovering a clip', async () => {
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());

    const clipRect = document.querySelector('.timeline-svg rect[style*="cursor: pointer"]') as SVGRectElement;
    await fireEvent.mouseEnter(clipRect, { clientX: 100, clientY: 50 });
    await fireEvent.mouseMove(clipRect, { clientX: 150, clientY: 80 });

    const tooltip = document.querySelector('.tooltip') as HTMLElement;
    expect(tooltip.getAttribute('style')).toContain('left: 162px');
  });

  it('handles dragover and dragleave on the dropzone', async () => {
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;

    await fireEvent.dragOver(dropzone);
    expect(dropzone.classList.contains('dropzone--over')).toBe(true);

    await fireEvent.dragLeave(dropzone);
    expect(dropzone.classList.contains('dropzone--over')).toBe(false);
  });

  it('handles file input change', async () => {
    render(SongPreview);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [xmlFile('input-song.XML')],
      configurable: true,
    });
    await fireEvent.change(input);

    await waitFor(() => expect(mockInspectSong).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());
  });

  it('does nothing when dropping with no files', async () => {
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(undefined));
    expect(screen.getByText('Drop a Deluge song file')).toBeTruthy();
  });

  it('ignores malformed sessionStorage payloads', async () => {
    sessionStorage.setItem('deluge-preview-file', '{not json');
    sessionStorage.setItem('deluge-stats-results', '{not json either');

    render(SongPreview);
    await Promise.resolve();

    expect(screen.getByText('Drop a Deluge song file')).toBeTruthy();
  });

  it('swallows errors loading cached card songs', async () => {
    mockCardStore.loadCachedSongs.mockRejectedValue(new Error('boom'));
    render(SongPreview);
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByText('Drop a Deluge song file')).toBeTruthy();
  });

  it('shows singular wording for one cached song and one stats result', async () => {
    sessionStorage.setItem('deluge-stats-results', JSON.stringify([{ a: 1 }]));
    mockCardStore.loadCachedSongs.mockResolvedValue({
      songs: [{ path: 'only.XML', xml: '<song></song>' }],
      cardName: 'CARD',
      savedAt: 0,
    });

    render(SongPreview);
    await waitFor(() => expect(screen.getByText('1 song loaded in Song Stats')).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/1 song with arrangement data on CARD/)).toBeTruthy());
    expect(document.querySelector('.card-picker-sub')?.textContent).not.toMatch(/\(/);
  });

  it('unmutes a track after a second mute click', async () => {
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());
    await fireEvent.click(document.querySelector('.transport-btn[title="Play"]') as HTMLElement);

    const muteBtn = screen.getByTitle('Mute');
    await fireEvent.click(muteBtn);
    expect(playerInstances[0].setTrackMuted).toHaveBeenCalledWith(0, true);

    const unmuteBtn = screen.getByTitle('Unmute');
    await fireEvent.click(unmuteBtn);
    expect(playerInstances[0].setTrackMuted).toHaveBeenCalledWith(0, false);
  });

  it('ignores timeline clicks left of the label column', async () => {
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());

    const svg = document.querySelector('.timeline-svg') as SVGSVGElement;
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 100, width: 800, height: 100, x: 0, y: 0, toJSON() {},
    });
    await fireEvent.click(svg, { clientX: 5, clientY: 20 });

    expect(playerInstances.length).toBe(0);
  });

  it('seeks without creating a new player while already playing', async () => {
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());

    await fireEvent.click(document.querySelector('.transport-btn[title="Play"]') as HTMLElement);
    expect(playerInstances.length).toBe(1);

    const svg = document.querySelector('.timeline-svg') as SVGSVGElement;
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 100, width: 800, height: 100, x: 0, y: 0, toJSON() {},
    });
    await fireEvent.click(svg, { clientX: 300, clientY: 20 });

    expect(playerInstances.length).toBe(1);
    expect(playerInstances[0].seek).toHaveBeenCalled();
  });

  it('shows positive EQ gain with a plus sign', async () => {
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());
    await fireEvent.click(document.querySelector('.transport-btn[title="Play"]') as HTMLElement);

    const midKnob = document.querySelector('.knob-hitbox[title="Mid"]') as HTMLElement;
    await fireEvent.mouseDown(midKnob, { clientY: 100 });
    await fireEvent.mouseMove(document, { clientY: -50 });
    await fireEvent.mouseUp(document);

    expect(screen.getByText(/^\+\d+$/)).toBeTruthy();
  });

  it('creates a session-mode clip without loop repeats', async () => {
    mockInspectSong.mockResolvedValue(
      previewData({
        hasArrangement: false,
        tracks: [
          {
            name: 'Custom Track',
            isKit: false,
            instrumentType: 'custom',
            midiChannel: null,
            cvChannel: null,
            patch: null,
            clips: [
              {
                positionTicks: 0,
                lengthTicks: 192,
                clipLengthTicks: 192,
                clipIndex: 0,
                noteCount: 1,
                rowCount: 1,
                noteRows: [],
              },
            ],
          },
        ],
      }),
    );

    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());

    const clipRect = document.querySelector('.timeline-svg rect[style*="cursor: pointer"]') as SVGRectElement;
    expect(clipRect).toBeTruthy();
    expect(screen.getAllByText('Custom Track').length).toBeGreaterThan(0);
  });

  it('resets playing state and uses card sample resolver when card is loaded', async () => {
    mockCardStore.isLoaded = true;
    mockCardStore.songXmls = new Map([['song1.XML', '<song></song>']]);
    mockCardStore.rootHandle = { name: 'MY_CARD' };
    mockCardStore.eligibleSongs.mockReturnValue([]);

    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());

    await fireEvent.click(document.querySelector('.transport-btn[title="Play"]') as HTMLElement);
    expect(playerInstances.length).toBe(1);

    const resolver = (playerInstances[0] as unknown as { sampleResolver: (p: string, c: unknown) => unknown })
      .sampleResolver;
    resolver('sample.wav', {});
    expect((cardStore as unknown as { getSampleBuffer: ReturnType<typeof vi.fn> }).getSampleBuffer)
      .toHaveBeenCalledWith('sample.wav', {});
  });

  it('scales ruler step marks for very long songs', async () => {
    mockInspectSong.mockResolvedValue(
      previewData({
        durationTicks: 48 * 4 * 250,
        tracks: [
          {
            name: 'Synth 1', isKit: false, instrumentType: 'synth', midiChannel: null, cvChannel: null, patch: null,
            clips: [{ positionTicks: 0, lengthTicks: 192, clipLengthTicks: 192, clipIndex: 0, noteCount: 1, rowCount: 1, noteRows: [] }],
          },
        ],
      }),
    );

    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());

    const rulerLabels = Array.from(document.querySelectorAll('.ruler-text')).map((t) => t.textContent);
    expect(rulerLabels).toContain('17');
  });

  it('shows the thrown error message when inspection fails', async () => {
    mockInspectSong.mockRejectedValue(new Error('parse blew up'));
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('parse blew up')).toBeTruthy());
    expect(mockTrack).toHaveBeenCalledWith('preview', 'inspect_error');
  });

  it('falls back to a generic error message when inspection throws without one', async () => {
    mockInspectSong.mockRejectedValue({});
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('Failed to parse song')).toBeTruthy());
  });

  it('adjusts the EQ High knob by dragging', async () => {
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());
    await fireEvent.click(document.querySelector('.transport-btn[title="Play"]') as HTMLElement);

    const highKnob = document.querySelector('.knob-hitbox[title="High"]') as HTMLElement;
    await fireEvent.mouseDown(highKnob, { clientY: 100 });
    await fireEvent.mouseMove(document, { clientY: 40 });
    await fireEvent.mouseUp(document);

    expect(playerInstances[0].setEQ).toHaveBeenCalledWith('high', expect.any(Number));
  });

  it('resizes the timeline when the container is resized', async () => {
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());

    expect(lastResizeCallback).toBeTruthy();
    lastResizeCallback?.([{ contentRect: { width: 1200 } }]);
    await Promise.resolve();

    expect(document.querySelector('.timeline-svg')).toBeTruthy();
  });

  it('ignores mousemove when no knob is being dragged', async () => {
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());

    await fireEvent.mouseMove(document, { clientY: 40 });
    expect(playerInstances.length).toBe(0);
  });

  it('formats a single-bar clip without a trailing s', async () => {
    mockInspectSong.mockResolvedValue(
      previewData({
        tracks: [
          {
            name: 'Synth 1', isKit: false, instrumentType: 'synth', midiChannel: null, cvChannel: null, patch: null,
            clips: [{ positionTicks: 0, lengthTicks: 192, clipLengthTicks: 192, clipIndex: 0, noteCount: 1, rowCount: 1, noteRows: [] }],
          },
        ],
      }),
    );

    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());

    const clipRect = document.querySelector('.timeline-svg rect[style*="cursor: pointer"]') as SVGRectElement;
    await fireEvent.mouseEnter(clipRect, { clientX: 100, clientY: 50 });
    const text = (document.querySelector('.tooltip') as HTMLElement).textContent ?? '';
    expect(text).toMatch(/1 bar(?!s)/);
  });

  it('falls back to instrumentType-derived type when instrumentType is absent', async () => {
    mockInspectSong.mockResolvedValue(
      previewData({
        tracks: [
          {
            name: 'Kit Track', isKit: true, instrumentType: undefined as unknown as string, midiChannel: null, cvChannel: null, patch: null,
            clips: [{ positionTicks: 0, lengthTicks: 192, clipLengthTicks: 192, clipIndex: 0, noteCount: 1, rowCount: 1, noteRows: [] }],
          },
        ],
      }),
    );

    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());

    expect(screen.getAllByText('Kit').length).toBeGreaterThan(0);
  });

  it('shows plural songs and no card name when the card has no root handle', async () => {
    mockCardStore.isLoaded = true;
    mockCardStore.songXmls = new Map([['a.XML', '<song></song>'], ['b.XML', '<song></song>']]);
    mockCardStore.rootHandle = null;
    mockCardStore.eligibleSongs.mockReturnValue([
      { path: 'a.XML', xml: '<song></song>' },
      { path: 'b.XML', xml: '<song></song>' },
    ]);

    render(SongPreview);
    await Promise.resolve();
    await Promise.resolve();

    const title = document.querySelector('.card-picker-title')?.textContent ?? '';
    expect(title).toMatch(/2 songs with arrangement data\s*$/);
  });

  it('resets playState to stopped when onEnd fires', async () => {
    render(SongPreview);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await waitFor(() => expect(screen.getByText('120 BPM')).toBeTruthy());

    await fireEvent.click(screen.getByTitle('Play'));
    expect(playerInstances.length).toBeGreaterThan(0);
    const player = playerInstances[playerInstances.length - 1];
    player.onEnd?.();

    await waitFor(() => expect(screen.getByTitle('Play')).toBeTruthy());
  });
});
