import { render, fireEvent, screen, cleanup, waitFor } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SongStats } from '../lib/pyodide';
import SongAnalyzer from './SongAnalyzer.svelte';

vi.mock('../lib/pyodide', () => ({
  loadPyodide: vi.fn(),
  analyzeStats: vi.fn(),
  convertToMusicXML: vi.fn(),
}));

vi.mock('../lib/softDelete', () => ({
  moveToTrash: vi.fn(),
}));

vi.mock('../lib/analytics', () => ({
  trackToolAction: vi.fn(),
}));

vi.mock('../lib/cardStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/cardStore')>();
  return {
    ...actual,
    cardStore: {
      isLoaded: false,
      songXmls: new Map<string, string>(),
      songLastModified: new Map<string, number>(),
      rootHandle: null,
      reconnect: vi.fn().mockResolvedValue(false),
      hasPersistedHandle: vi.fn().mockResolvedValue(false),
      requestReconnect: vi.fn().mockResolvedValue(false),
      pickDirectory: vi.fn().mockResolvedValue(undefined),
      adoptHandle: vi.fn().mockResolvedValue(undefined),
      saveSongCache: vi.fn().mockResolvedValue(undefined),
    },
  };
});

import { loadPyodide, analyzeStats, convertToMusicXML } from '../lib/pyodide';
import { moveToTrash } from '../lib/softDelete';
import { trackToolAction } from '../lib/analytics';
import { cardStore } from '../lib/cardStore';

const mockLoadPyodide = loadPyodide as unknown as ReturnType<typeof vi.fn>;
const mockAnalyzeStats = analyzeStats as unknown as ReturnType<typeof vi.fn>;
const mockConvertToMusicXML = convertToMusicXML as unknown as ReturnType<typeof vi.fn>;
const mockMoveToTrash = moveToTrash as unknown as ReturnType<typeof vi.fn>;
const mockTrack = trackToolAction as unknown as ReturnType<typeof vi.fn>;
const mockCardStore = cardStore as unknown as {
  isLoaded: boolean;
  songXmls: Map<string, string>;
  songLastModified: Map<string, number>;
  rootHandle: { name: string } | null;
  reconnect: ReturnType<typeof vi.fn>;
  hasPersistedHandle: ReturnType<typeof vi.fn>;
  requestReconnect: ReturnType<typeof vi.fn>;
  pickDirectory: ReturnType<typeof vi.fn>;
  adoptHandle: ReturnType<typeof vi.fn>;
  saveSongCache: ReturnType<typeof vi.fn>;
};

function stat(overrides: Partial<SongStats> = {}): SongStats {
  return {
    filename: 'song.XML',
    bpm: 120,
    key: 'C major',
    hasArrangement: true,
    instrumentCount: 2,
    synthCount: 1,
    kitCount: 1,
    midiCount: 0,
    cvCount: 0,
    audioCount: 0,
    clipCount: 4,
    totalNotes: 100,
    durationStr: '1:30',
    ...overrides,
  };
}

function xmlFile(name: string, content = '<song></song>'): File {
  return new File([content], name, { type: 'application/xml' });
}

function dropEvent(files: File[]) {
  return { dataTransfer: { items: undefined, files } } as unknown as DragEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mockLoadPyodide.mockResolvedValue({});
  mockAnalyzeStats.mockResolvedValue([stat()]);
  mockConvertToMusicXML.mockResolvedValue('<score></score>');
  mockCardStore.isLoaded = false;
  mockCardStore.songXmls = new Map();
  mockCardStore.songLastModified = new Map();
  mockCardStore.rootHandle = null;
  mockCardStore.reconnect.mockResolvedValue(false);
  mockCardStore.hasPersistedHandle.mockResolvedValue(false);
  mockCardStore.requestReconnect.mockResolvedValue(false);
  vi.stubGlobal('confirm', vi.fn(() => true));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SongAnalyzer', () => {
  it('renders the dropzone in the idle state', async () => {
    render(SongAnalyzer);
    await Promise.resolve();
    expect(screen.getByText('Drop your SD card or SONGS folder')).toBeTruthy();
  });

  it('analyzes dropped XML files and renders a results table', async () => {
    render(SongAnalyzer);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;

    await fireEvent.drop(dropzone, dropEvent([xmlFile('song.XML')]));
    await waitFor(() => expect(screen.getByText('song')).toBeTruthy());

    expect(mockAnalyzeStats).toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith('stats', 'analyze_drop');
    expect(screen.getByText('120')).toBeTruthy();
  });

  it('shows an error when dropped files contain no XML', async () => {
    render(SongAnalyzer);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;

    await fireEvent.drop(dropzone, dropEvent([new File(['x'], 'readme.txt')]));
    await waitFor(() =>
      expect(screen.getByText(/No \.XML files found/)).toBeTruthy(),
    );

    await fireEvent.click(screen.getByText('Try again'));
    expect(screen.getByText('Drop your SD card or SONGS folder')).toBeTruthy();
  });

  it('auto-loads from an already-scanned card store', async () => {
    mockCardStore.isLoaded = true;
    mockCardStore.songXmls = new Map([['SONGS/song.XML', '<song></song>']]);
    mockCardStore.rootHandle = { name: 'CARD' };

    render(SongAnalyzer);

    await waitFor(() => expect(mockAnalyzeStats).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('song')).toBeTruthy());
  });

  it('filters results by search query', async () => {
    mockAnalyzeStats.mockResolvedValue([
      stat({ filename: 'kick.XML' }),
      stat({ filename: 'snare.XML' }),
    ]);
    render(SongAnalyzer);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent([xmlFile('kick.XML'), xmlFile('snare.XML')]));
    await waitFor(() => expect(screen.getByText('kick')).toBeTruthy());

    const search = document.querySelector('.filter-search') as HTMLInputElement;
    await fireEvent.input(search, { target: { value: 'kick' } });

    expect(screen.getByText('kick')).toBeTruthy();
    expect(screen.queryByText('snare')).toBeNull();
    expect(screen.getByText('1/2 songs')).toBeTruthy();
  });

  it('sorts the table when a sortable column header is clicked', async () => {
    mockAnalyzeStats.mockResolvedValue([
      stat({ filename: 'b.XML', bpm: 200 }),
      stat({ filename: 'a.XML', bpm: 100 }),
    ]);
    render(SongAnalyzer);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent([xmlFile('b.XML'), xmlFile('a.XML')]));
    await waitFor(() => expect(screen.getByText('a')).toBeTruthy());

    const bpmHeader = Array.from(document.querySelectorAll('.sort-btn')).find(
      (b) => b.textContent?.trim().startsWith('BPM'),
    ) as HTMLElement;
    await fireEvent.click(bpmHeader);

    const rows = Array.from(document.querySelectorAll('.cell-name-text')).map((n) => n.textContent);
    expect(rows).toEqual(['a', 'b']);
  });

  it('sorts duration numerically, not as text', async () => {
    mockAnalyzeStats.mockResolvedValue([
      stat({ filename: 'short.XML', durationStr: '7s' }),
      stat({ filename: 'long.XML', durationStr: '6:54' }),
    ]);
    render(SongAnalyzer);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent([xmlFile('short.XML'), xmlFile('long.XML')]));
    await waitFor(() => expect(screen.getByText('short')).toBeTruthy());

    const durationHeader = Array.from(document.querySelectorAll('.sort-btn')).find(
      (b) => b.textContent?.trim().startsWith('Duration'),
    ) as HTMLElement;
    await fireEvent.click(durationHeader);

    const rows = Array.from(document.querySelectorAll('.cell-name-text')).map((n) => n.textContent);
    expect(rows).toEqual(['short', 'long']);
  });

  it('exports CSV', async () => {
    const createUrl = vi.fn().mockReturnValue('blob:mock');
    const revokeUrl = vi.fn();
    URL.createObjectURL = createUrl;
    URL.revokeObjectURL = revokeUrl;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(SongAnalyzer);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent([xmlFile('song.XML')]));
    await waitFor(() => expect(screen.getByText('song')).toBeTruthy());

    await fireEvent.click(screen.getByText('Export CSV'));

    expect(createUrl).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith('stats', 'export_csv');

    clickSpy.mockRestore();
  });

  it('deletes a song when a root handle is available', async () => {
    mockCardStore.isLoaded = true;
    mockCardStore.songXmls = new Map([['SONGS/song.XML', '<song></song>']]);
    mockCardStore.rootHandle = { name: 'CARD' };
    mockMoveToTrash.mockResolvedValue(undefined);

    render(SongAnalyzer);
    await waitFor(() => expect(screen.getByText('song')).toBeTruthy());

    await fireEvent.click(screen.getByTitle('Move to SOFT_DELETE/'));
    await waitFor(() => expect(mockMoveToTrash).toHaveBeenCalled());

    expect(mockTrack).toHaveBeenCalledWith('stats', 'delete_song');
    await waitFor(() => expect(screen.queryByText('song')).toBeNull());
  });

  it('converts a song to MusicXML and downloads it', async () => {
    const createUrl = vi.fn().mockReturnValue('blob:mock');
    const revokeUrl = vi.fn();
    URL.createObjectURL = createUrl;
    URL.revokeObjectURL = revokeUrl;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(SongAnalyzer);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent([xmlFile('song.XML')]));
    await waitFor(() => expect(screen.getByText('song')).toBeTruthy());

    await fireEvent.click(screen.getByTitle('Convert to MusicXML'));
    await waitFor(() => expect(mockConvertToMusicXML).toHaveBeenCalled());

    expect(mockTrack).toHaveBeenCalledWith('stats', 'convert_score');
    expect(clickSpy).toHaveBeenCalled();

    clickSpy.mockRestore();
  });

  it('opens a song in the preview page', async () => {
    render(SongAnalyzer);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent([xmlFile('song.XML')]));
    await waitFor(() => expect(screen.getByText('song')).toBeTruthy());

    await fireEvent.click(screen.getByTitle('Preview song'));

    expect(mockTrack).toHaveBeenCalledWith('stats', 'open_in_preview');
    expect(JSON.parse(sessionStorage.getItem('deluge-preview-file') ?? '{}').name).toBe('song.XML');
  });

  it('filters by clicking a key chip', async () => {
    mockAnalyzeStats.mockResolvedValue([
      stat({ filename: 'a.XML', key: 'C major' }),
      stat({ filename: 'b.XML', key: 'D minor' }),
    ]);
    render(SongAnalyzer);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent([xmlFile('a.XML'), xmlFile('b.XML')]));
    await waitFor(() => expect(screen.getByText('a')).toBeTruthy());

    await fireEvent.click(screen.getByText('C major'));

    expect(screen.getByText('a')).toBeTruthy();
    expect(screen.queryByText('b')).toBeNull();
    expect(screen.getByText('Clear filters')).toBeTruthy();

    await fireEvent.click(screen.getByText('Clear filters'));
    expect(screen.getByText('b')).toBeTruthy();
  });

  it('shows a reconnect button when a persisted handle is available but not connected', async () => {
    mockCardStore.hasPersistedHandle.mockResolvedValue(true);
    render(SongAnalyzer);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent([xmlFile('song.XML')]));
    await waitFor(() => expect(screen.getByText('song')).toBeTruthy());

    await waitFor(() => expect(screen.getByText('Reconnect folder to enable delete')).toBeTruthy());

    mockCardStore.requestReconnect.mockImplementation(async () => {
      mockCardStore.rootHandle = { name: 'CARD' };
      return true;
    });
    await fireEvent.click(screen.getByText('Reconnect folder to enable delete'));
    await waitFor(() => expect(screen.queryByText('Reconnect folder to enable delete')).toBeNull());
  });

  it('resets back to idle', async () => {
    render(SongAnalyzer);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent([xmlFile('song.XML')]));
    await waitFor(() => expect(screen.getByText('song')).toBeTruthy());

    await fireEvent.click(screen.getByText('Analyze more'));
    expect(screen.getByText('Drop your SD card or SONGS folder')).toBeTruthy();
  });
});
