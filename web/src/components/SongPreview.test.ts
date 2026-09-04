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

class FakeResizeObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  vi.clearAllMocks();
  playerInstances.length = 0;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  mockLoadPyodide.mockResolvedValue({});
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
});
