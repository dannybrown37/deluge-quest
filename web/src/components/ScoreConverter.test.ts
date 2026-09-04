import { render, fireEvent, screen, cleanup } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ScoreConverter from './ScoreConverter.svelte';

vi.mock('../lib/pyodide', () => ({
  loadPyodide: vi.fn(),
  convertToMusicXML: vi.fn(),
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
  },
  songHasArrangement: vi.fn(() => true),
}));

import { loadPyodide, convertToMusicXML } from '../lib/pyodide';
import { trackToolAction } from '../lib/analytics';
import { cardStore } from '../lib/cardStore';

const mockLoadPyodide = loadPyodide as unknown as ReturnType<typeof vi.fn>;
const mockConvert = convertToMusicXML as unknown as ReturnType<typeof vi.fn>;
const mockTrack = trackToolAction as unknown as ReturnType<typeof vi.fn>;
const mockCardStore = cardStore as unknown as {
  isLoaded: boolean;
  songXmls: Map<string, string>;
  rootHandle: { name: string } | null;
  eligibleSongs: ReturnType<typeof vi.fn>;
  loadCachedSongs: ReturnType<typeof vi.fn>;
};

function xmlFile(name: string, content = '<song></song>'): File {
  return new File([content], name, { type: 'application/xml' });
}

function dropEvent(file: File | undefined) {
  return { dataTransfer: { files: file ? [file] : [] } } as unknown as DragEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadPyodide.mockResolvedValue({});
  mockConvert.mockResolvedValue('<score></score>');
  mockCardStore.isLoaded = false;
  mockCardStore.songXmls = new Map();
  mockCardStore.rootHandle = null;
  mockCardStore.eligibleSongs.mockReturnValue([]);
  mockCardStore.loadCachedSongs.mockResolvedValue(null);
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('ScoreConverter', () => {
  it('renders the dropzone with no cached songs', async () => {
    render(ScoreConverter);
    await Promise.resolve();
    expect(screen.getByText('Drop a Deluge song file')).toBeTruthy();
    expect(screen.getByText(/No songs cached yet/)).toBeTruthy();
  });

  it('rejects a non-XML file with an error', async () => {
    render(ScoreConverter);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(new File(['x'], 'song.mid')));
    expect(screen.getByText('Please drop a Deluge .XML song file')).toBeTruthy();
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it('converts a dropped XML file and shows the result', async () => {
    render(ScoreConverter);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockConvert).toHaveBeenCalledWith('<song></song>', {});
    expect(screen.getByText('Conversion complete')).toBeTruthy();
    expect(mockTrack).toHaveBeenCalledWith('score', 'convert');
  });

  it('shows an error card when conversion fails', async () => {
    mockConvert.mockRejectedValue(new Error('bad xml'));
    render(ScoreConverter);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByText('bad xml')).toBeTruthy();
    expect(mockTrack).toHaveBeenCalledWith('score', 'convert_error');
  });

  it('resets from error and done states', async () => {
    render(ScoreConverter);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await fireEvent.click(screen.getByRole('button', { name: 'Convert another' }));
    expect(screen.getByText('Drop a Deluge song file')).toBeTruthy();
  });

  it('toggles drag-over state', async () => {
    render(ScoreConverter);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.dragOver(dropzone);
    expect(dropzone.className).toContain('dropzone--over');
    await fireEvent.dragLeave(dropzone);
    expect(dropzone.className).not.toContain('dropzone--over');
  });

  it('converts a file chosen via the file input', async () => {
    render(ScoreConverter);
    const input = document.getElementById('file-input') as HTMLInputElement;
    const file = xmlFile('picked.XML');
    Object.defineProperty(input, 'files', { value: [file] });

    await fireEvent.change(input);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockConvert).toHaveBeenCalled();
    expect(screen.getByText('Conversion complete')).toBeTruthy();
  });

  it('downloads the result MusicXML', async () => {
    render(ScoreConverter);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, dropEvent(xmlFile('song.XML')));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const createUrl = vi.fn().mockReturnValue('blob:mock');
    const revokeUrl = vi.fn();
    URL.createObjectURL = createUrl;
    URL.revokeObjectURL = revokeUrl;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await fireEvent.click(screen.getByRole('button', { name: 'Download MusicXML' }));

    expect(createUrl).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeUrl).toHaveBeenCalledWith('blob:mock');
    expect(mockTrack).toHaveBeenCalledWith('score', 'download');

    clickSpy.mockRestore();
  });

  it('activates the file picker on Enter/Space keydown', async () => {
    render(ScoreConverter);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    const input = document.getElementById('file-input') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click').mockImplementation(() => {});

    await fireEvent.keyDown(dropzone, { key: 'Enter' });
    expect(clickSpy).toHaveBeenCalledTimes(1);
    await fireEvent.keyDown(dropzone, { key: ' ' });
    expect(clickSpy).toHaveBeenCalledTimes(2);
    await fireEvent.keyDown(dropzone, { key: 'a' });
    expect(clickSpy).toHaveBeenCalledTimes(2);

    clickSpy.mockRestore();
  });

  it('loads songs already indexed on cardStore', async () => {
    mockCardStore.isLoaded = true;
    mockCardStore.songXmls = new Map([['song1.XML', '<song></song>']]);
    mockCardStore.rootHandle = { name: 'MY_CARD' };
    mockCardStore.eligibleSongs.mockReturnValue([{ path: 'song1.XML', xml: '<song></song>' }]);

    render(ScoreConverter);
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByText(/song with arrangement data on MY_CARD/)).toBeTruthy();
    expect(screen.getByText('song1.XML')).toBeTruthy();
  });

  it('converts a song picked from the cached card list', async () => {
    mockCardStore.loadCachedSongs.mockResolvedValue({
      songs: [{ path: 'cached.XML', xml: '<song></song>' }],
      cardName: 'CACHED_CARD',
      savedAt: 1000,
    });

    render(ScoreConverter);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await fireEvent.click(screen.getByText('cached.XML'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockConvert).toHaveBeenCalledWith('<song></song>', {});
    expect(screen.getByText('Conversion complete')).toBeTruthy();
  });

  it('resumes a stats-page song stashed in sessionStorage', async () => {
    sessionStorage.setItem(
      'deluge-score-file',
      JSON.stringify({ name: 'stashed.XML', content: '<song></song>' }),
    );

    render(ScoreConverter);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockConvert).toHaveBeenCalledWith('<song></song>', {});
    expect(sessionStorage.getItem('deluge-score-file')).toBeNull();
  });

  it('shows a resume banner when stats results are cached', async () => {
    sessionStorage.setItem('deluge-stats-results', JSON.stringify([{ a: 1 }, { b: 2 }]));

    render(ScoreConverter);
    await Promise.resolve();

    expect(screen.getByText('2 songs loaded in Song Stats')).toBeTruthy();
  });
});
