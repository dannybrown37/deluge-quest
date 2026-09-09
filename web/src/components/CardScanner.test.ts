import { render, fireEvent, screen, cleanup, waitFor } from '@testing-library/svelte';
import { within } from '@testing-library/dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import CardScanner from './CardScanner.svelte';

vi.mock('../lib/analytics', () => ({
  trackToolAction: vi.fn(),
}));

vi.mock('../lib/softDelete', () => ({
  TRASH_DIR: 'SOFT_DELETE',
  HISTORY_BACKUP_DIR: 'HISTORY_BACKUP',
  getOrCreateDir: vi.fn(),
  moveToTrash: vi.fn(),
}));

vi.mock('../lib/cardStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/cardStore')>();
  return {
    ...actual,
    walkHandle: vi.fn().mockResolvedValue(undefined),
    cardStore: {
      rootHandle: null,
      songXmls: new Map<string, string>(),
      presetIndex: new Map<string, string>(),
      sampleIndex: new Map<string, { handle: { getFile: ReturnType<typeof vi.fn> }; size: number; path: string }>(),
      songLastModified: new Map<string, number>(),
      pickDirectory: vi.fn().mockResolvedValue(undefined),
      requestReconnect: vi.fn().mockResolvedValue(false),
      hasPersistedHandle: vi.fn().mockResolvedValue(false),
      reconnect: vi.fn().mockResolvedValue(false),
    },
  };
});

import { trackToolAction } from '../lib/analytics';
import { moveToTrash, getOrCreateDir } from '../lib/softDelete';
import { cardStore, walkHandle } from '../lib/cardStore';

const mockTrack = trackToolAction as unknown as ReturnType<typeof vi.fn>;
const mockMoveToTrash = moveToTrash as unknown as ReturnType<typeof vi.fn>;
const mockGetOrCreateDir = getOrCreateDir as unknown as ReturnType<typeof vi.fn>;
const mockWalkHandle = walkHandle as unknown as ReturnType<typeof vi.fn>;
const mockCardStore = cardStore as unknown as {
  rootHandle: { name: string } | null;
  songXmls: Map<string, string>;
  presetIndex: Map<string, string>;
  sampleIndex: Map<string, { handle: { getFile: ReturnType<typeof vi.fn> }; size: number; path: string }>;
  songLastModified: Map<string, number>;
  pickDirectory: ReturnType<typeof vi.fn>;
  requestReconnect: ReturnType<typeof vi.fn>;
  hasPersistedHandle: ReturnType<typeof vi.fn>;
  reconnect: ReturnType<typeof vi.fn>;
};

function fakeSample(path: string, content: string) {
  const file = new File([content], path.split('/').pop()!);
  return { handle: { getFile: vi.fn().mockResolvedValue(file) }, size: file.size, path };
}

const SONG1_XML = `<song>
  <instruments>
    <sound name="Kick"><osc1 fileName="SAMPLES/kick.wav" /></sound>
    <sound name="Ghost"><osc1 fileName="SAMPLES/missing.wav" /></sound>
  </instruments>
</song>`;

const BAD_KIT_XML = `<kit isPlaying="0" isPlaying="1"><thing /></kit>`;
const UNFIXABLE_KIT_XML = `<kit><thing></kit>`;
const MIXED_SONG_XML = `<song><instruments><sound name="Kick"><osc1 fileName="SAMPLES/kick.wav" /></sound><midi channel="1" /></instruments></song>`;
const EXTERNAL_SONG_XML = `<song><instruments><midi channel="1" /></instruments></song>`;

function seedCard() {
  mockCardStore.rootHandle = { name: 'MY_CARD' };
  mockCardStore.sampleIndex.set('samples/kick.wav', fakeSample('SAMPLES/kick.wav', 'kick-data-unique'));
  mockCardStore.sampleIndex.set('samples/unused.wav', fakeSample('SAMPLES/unused.wav', 'unused-data'));
  mockCardStore.sampleIndex.set('samples/dup1.wav', fakeSample('SAMPLES/dup1.wav', 'duplicate-bytes-xyz'));
  mockCardStore.sampleIndex.set('samples/dup2.wav', fakeSample('SAMPLES/dup2.wav', 'duplicate-bytes-xyz'));
  mockCardStore.songXmls.set('SONGS/song1.XML', SONG1_XML);
  mockCardStore.presetIndex.set('KITS/badkit.XML', BAD_KIT_XML);
}

async function scanAndWait() {
  render(CardScanner);
  await fireEvent.click(screen.getByText('Browse for folder'));
  await waitFor(() => expect(screen.getByText('Sample Library (4)')).toBeTruthy(), { timeout: 3000 });
}

async function expandSamplesFolder() {
  await fireEvent.click(screen.getByText('SAMPLES/'));
}

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('showDirectoryPicker', vi.fn());
  mockCardStore.rootHandle = null;
  mockCardStore.songXmls = new Map();
  mockCardStore.presetIndex = new Map();
  mockCardStore.sampleIndex = new Map();
  mockCardStore.songLastModified = new Map();
  mockCardStore.pickDirectory.mockResolvedValue(undefined);
  mockCardStore.requestReconnect.mockResolvedValue(false);
  mockCardStore.hasPersistedHandle.mockResolvedValue(false);
  mockCardStore.reconnect.mockResolvedValue(false);
  mockGetOrCreateDir.mockReset();
  mockWalkHandle.mockReset().mockResolvedValue(undefined);
  sessionStorage.clear();
  seedCard();
});

/** In-memory writable directory handle: getOrCreateDir returns this for any path. */
function fakeWritableDir(initialFiles: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const removeEntry = vi.fn(async (name: string) => {
    files.delete(name);
  });
  const getFileHandle = vi.fn(async (name: string, opts?: { create?: boolean }) => {
    if (!files.has(name) && !opts?.create) throw new Error(`not found: ${name}`);
    if (!files.has(name)) files.set(name, '');
    return {
      getFile: async () => new File([files.get(name) ?? ''], name),
      createWritable: async () => ({
        write: async (data: string | ArrayBuffer) => {
          files.set(name, typeof data === 'string' ? data : new TextDecoder().decode(data));
        },
        close: async () => {},
      }),
    };
  });
  return { files, removeEntry, getFileHandle, getDirectoryHandle: vi.fn(), values: async function* () {} };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CardScanner', () => {
  it('renders the idle dropzone with a folder-access browse button', () => {
    render(CardScanner);
    expect(screen.getByText('Select your SD card folder')).toBeTruthy();
    expect(screen.getByText('Browse for folder')).toBeTruthy();
  });

  it('scans a card and reports sample/reference/unused/broken-ref counts', async () => {
    await scanAndWait();

    const stats = Array.from(document.querySelectorAll('.stat-value')).map((n) => n.textContent);
    expect(stats).toEqual(['4', '2', '3', '1']);
    expect(mockTrack).toHaveBeenCalledWith('manage', 'scan', expect.objectContaining({ samples: 4 }));
  });

  it('matches sample refs case-insensitively (FAT32)', async () => {
    mockCardStore.sampleIndex = new Map();
    mockCardStore.sampleIndex.set('samples/drums/kick.wav', fakeSample('SAMPLES/Drums/kick.wav', 'k'));
    mockCardStore.songXmls = new Map();
    mockCardStore.songXmls.set('SONGS/s.XML', '<song><osc1 fileName="SAMPLES/DRUMS/KICK.WAV" /></song>');
    mockCardStore.presetIndex = new Map();

    render(CardScanner);
    await fireEvent.click(screen.getByText('Browse for folder'));
    await waitFor(() => expect(screen.getByText('Sample Library (1)')).toBeTruthy(), { timeout: 3000 });

    const stats = Array.from(document.querySelectorAll('.stat-value')).map((n) => n.textContent);
    expect(stats).toEqual(['1', '1']);
  });

  it('strips leading slashes from XML refs', async () => {
    mockCardStore.sampleIndex = new Map();
    mockCardStore.sampleIndex.set('samples/hit.wav', fakeSample('SAMPLES/HIT.WAV', 'h'));
    mockCardStore.songXmls = new Map();
    mockCardStore.songXmls.set('SONGS/s.XML', '<song><osc1 fileName="/SAMPLES/HIT.WAV" /></song>');
    mockCardStore.presetIndex = new Map();

    render(CardScanner);
    await fireEvent.click(screen.getByText('Browse for folder'));
    await waitFor(() => expect(screen.getByText('Sample Library (1)')).toBeTruthy(), { timeout: 3000 });

    const stats = Array.from(document.querySelectorAll('.stat-value')).map((n) => n.textContent);
    expect(stats).toEqual(['1', '1']);
  });

  it('lists songs by gear category on the songs tab', async () => {
    await scanAndWait();
    await fireEvent.click(screen.getByText(/^Songs/));

    expect(screen.getByText('song1')).toBeTruthy();
  });

  it('shows unused samples and duplicates on the analysis tab', async () => {
    await scanAndWait();
    await fireEvent.click(screen.getByText('Analysis'));

    expect(screen.getByText(/Unused samples/)).toBeTruthy();
    expect(screen.getByText(/Duplicate samples/)).toBeTruthy();
  });

  it('deletes an unused sample from the analysis tab', async () => {
    mockMoveToTrash.mockResolvedValue(undefined);
    await scanAndWait();
    await fireEvent.click(screen.getByText('Analysis'));
    const unusedSection = screen.getByText(/Unused samples/).closest('.analysis-section') as HTMLElement;
    await fireEvent.click(within(unusedSection).getByText('SAMPLES/'));

    const unusedRow = screen.getByText('unused.wav').closest('.tree-file') as HTMLElement;
    const moveBtn = within(unusedRow).getByTitle('Move to SOFT_DELETE/');
    await fireEvent.click(moveBtn);

    await waitFor(() => expect(mockMoveToTrash).toHaveBeenCalledWith(mockCardStore.rootHandle, 'SAMPLES/unused.wav'));
    expect(mockTrack).toHaveBeenCalledWith('manage', 'delete_sample');
  });

  it('filters the sample list by search text without looping forever', async () => {
    await scanAndWait();
    const search = document.querySelector('.sample-search') as HTMLInputElement;
    await fireEvent.input(search, { target: { value: 'kick' } });

    await waitFor(() => expect(screen.getByText('1 / 4')).toBeTruthy());
    expect(screen.getByText('kick.wav')).toBeTruthy();
  });

  it('filters the sample list to unused only', async () => {
    await scanAndWait();
    await fireEvent.click(screen.getByText('Unused'));

    expect(screen.getByText('3 / 4')).toBeTruthy();
  });

  it('plays and stops a sample preview', async () => {
    const playSpy = vi.fn();
    const pauseSpy = vi.fn();
    vi.stubGlobal(
      'Audio',
      class {
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        src = '';
        constructor(src: string) {
          this.src = src;
        }
        play = playSpy;
        pause = pauseSpy;
      },
    );
    URL.createObjectURL = vi.fn().mockReturnValue('blob:mock');
    URL.revokeObjectURL = vi.fn();

    await scanAndWait();
    await expandSamplesFolder();
    const playBtn = screen.getAllByTitle('Play')[0];
    await fireEvent.click(playBtn);

    expect(playSpy).toHaveBeenCalled();
    expect(screen.getAllByTitle('Stop').length).toBeGreaterThan(0);
  });

  it('exports the report as JSON', async () => {
    const createUrl = vi.fn().mockReturnValue('blob:mock');
    const revokeUrl = vi.fn();
    URL.createObjectURL = createUrl;
    URL.revokeObjectURL = revokeUrl;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await scanAndWait();
    await fireEvent.click(screen.getByText('Export JSON'));

    expect(createUrl).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith('manage', 'export_json');

    clickSpy.mockRestore();
  });

  it('resets back to the idle dropzone', async () => {
    await scanAndWait();
    await fireEvent.click(screen.getByText('Scan another'));

    expect(screen.getByText('Select your SD card folder')).toBeTruthy();
  });

  it('shows a backup diff after picking a destination folder', async () => {
    const backupFiles: [string, { kind: 'file'; name: string; getFile: () => Promise<File> }][] = [];
    const backupDir = {
      name: 'BACKUP_DEST',
      values: () => {
        let i = 0;
        return {
          [Symbol.asyncIterator]() {
            return this;
          },
          next: async () => {
            if (i < backupFiles.length) return { value: backupFiles[i++][1], done: false };
            return { value: undefined, done: true };
          },
        };
      },
    };
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue(backupDir));

    await scanAndWait();
    await fireEvent.click(screen.getByText('Backup'));
    await fireEvent.click(screen.getByText('Choose backup folder'));

    await waitFor(() => expect(screen.getByText(/new/)).toBeTruthy());
    expect(screen.getByText('BACKUP_DEST')).toBeTruthy();
  });

  it('shows an error when the card has no SAMPLES directory, and resets on retry', async () => {
    mockCardStore.sampleIndex = new Map();
    render(CardScanner);
    await fireEvent.click(screen.getByText('Browse for folder'));

    await waitFor(() => expect(screen.getByText(/Not a Deluge SD card/)).toBeTruthy());

    await fireEvent.click(screen.getByText('Try again'));
    expect(screen.getByText('Select your SD card folder')).toBeTruthy();
  });

  it('offers reconnect on the dropzone when a persisted handle exists', async () => {
    mockCardStore.hasPersistedHandle.mockResolvedValue(true);
    mockCardStore.reconnect.mockResolvedValue(false);

    render(CardScanner);

    await waitFor(() => expect(screen.getByText('Reconnect previously loaded SD card')).toBeTruthy());
  });

  it('reconnects via cardStore.reconnect() and scans automatically', async () => {
    mockCardStore.reconnect.mockResolvedValue(true);

    render(CardScanner);

    await waitFor(() => expect(screen.getByText('Sample Library (4)')).toBeTruthy(), { timeout: 3000 });
  });

  it('scans via drag-and-drop of a file list', async () => {
    const file = new File(['kick-data'], 'kick.wav');
    Object.defineProperty(file, 'webkitRelativePath', { value: 'CARD/SAMPLES/kick.wav' });

    render(CardScanner);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, { dataTransfer: { files: [file], items: undefined } });

    await waitFor(() => expect(screen.getByText('Sample Library (1)')).toBeTruthy(), { timeout: 3000 });
  });

  it('shows an error for drag-and-drop with no SAMPLES directory', async () => {
    const file = new File(['x'], 'song.xml');
    Object.defineProperty(file, 'webkitRelativePath', { value: 'CARD/SONGS/song.xml' });

    render(CardScanner);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, { dataTransfer: { files: [file], items: undefined } });

    await waitFor(() => expect(screen.getByText(/Not a Deluge SD card/)).toBeTruthy());
  });

  it('scans via the webkitdirectory file input when File System Access is unavailable', async () => {
    // @ts-expect-error deliberately removing the feature to test the fallback path
    delete window.showDirectoryPicker;
    const file = new File(['kick-data'], 'kick.wav');
    Object.defineProperty(file, 'webkitRelativePath', { value: 'CARD/SAMPLES/kick.wav' });

    render(CardScanner);
    const input = document.getElementById('clean-folder-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file] });
    await fireEvent.change(input);

    await waitFor(() => expect(screen.getByText('Sample Library (1)')).toBeTruthy(), { timeout: 3000 });
  });

  it('filters the sample list to referenced only', async () => {
    await scanAndWait();
    await fireEvent.click(screen.getByText('Referenced'));

    expect(screen.getByText('1 / 4')).toBeTruthy();
  });

  it('expands referencing songs for a sample and collapses all folders', async () => {
    await scanAndWait();
    await expandSamplesFolder();

    const refBtn = screen.getByText('1 ref');
    await fireEvent.click(refBtn);
    expect(screen.getByText('song1.XML')).toBeTruthy();

    await fireEvent.click(refBtn);
    expect(screen.queryByText('song1.XML')).toBeFalsy();
  });

  it('toggles expand/collapse all sample folders', async () => {
    await scanAndWait();
    const toggleBtn = screen.getByText('Expand');
    await fireEvent.click(toggleBtn);

    expect(screen.getByText('Collapse')).toBeTruthy();
    await fireEvent.click(screen.getByText('Collapse'));
    expect(screen.getByText('Expand')).toBeTruthy();
  });

  it('clicking the unused stat jumps to the analysis tab', async () => {
    await scanAndWait();
    await fireEvent.click(screen.getByText('unused').closest('button') as HTMLElement);

    expect(screen.getByText(/Unused samples/)).toBeTruthy();
  });

  it('clicking the broken refs stat jumps to samples and expands broken refs', async () => {
    await scanAndWait();
    await fireEvent.click(screen.getByText('broken refs').closest('button') as HTMLElement);

    expect(screen.getByText('Sample Library (4)')).toBeTruthy();
  });

  it('logs an error and leaves the sample listed when moveToTrash fails', async () => {
    mockMoveToTrash.mockRejectedValue(new Error('disk full'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await scanAndWait();
    await fireEvent.click(screen.getByText('Analysis'));
    const unusedSection = screen.getByText(/Unused samples/).closest('.analysis-section') as HTMLElement;
    await fireEvent.click(within(unusedSection).getByText('SAMPLES/'));
    const unusedRow = screen.getByText('unused.wav').closest('.tree-file') as HTMLElement;
    await fireEvent.click(within(unusedRow).getByTitle('Move to SOFT_DELETE/'));

    await waitFor(() => expect(errSpy).toHaveBeenCalled());
    expect(screen.getByText('unused.wav')).toBeTruthy();
    errSpy.mockRestore();
  });

  it('shows duplicate sample groups on the analysis tab', async () => {
    await scanAndWait();
    await fireEvent.click(screen.getByText('Analysis'));

    expect(screen.getByText(/Duplicate samples/)).toBeTruthy();
    expect(screen.getAllByText('dup1.wav').length).toBeGreaterThan(0);
    expect(screen.getAllByText('dup2.wav').length).toBeGreaterThan(0);
  });

  it('flags a genuinely malformed XML file as needing manual review', async () => {
    mockCardStore.presetIndex.set('KITS/unfixable.XML', UNFIXABLE_KIT_XML);

    await scanAndWait();
    await fireEvent.click(screen.getByText('Analysis'));

    expect(screen.getByText(/Invalid XML files/)).toBeTruthy();
    expect(screen.getByText('needs manual review')).toBeTruthy();
  });

  it('shows broken references with their referencing files on the analysis tab', async () => {
    await scanAndWait();
    await fireEvent.click(screen.getByText('Analysis'));

    expect(screen.getByText(/Broken references/)).toBeTruthy();
    expect(screen.getByText('missing.wav')).toBeTruthy();
    expect(screen.getByText('song1.XML')).toBeTruthy();
  });

  it('shows the folder view for songs and toggles a folder open', async () => {
    await scanAndWait();
    await fireEvent.click(screen.getByText(/^Songs/));
    await fireEvent.click(screen.getByText('Show folders'));

    await fireEvent.click(screen.getByText('SONGS/'));
    expect(screen.getByText('song1')).toBeTruthy();
  });

  it('sorts all songs into DELUGE_ONLY / EXTERNAL_GEAR via "Sort all songs"', async () => {
    const dir = fakeWritableDir({ 'song1.XML': SONG1_XML });
    mockGetOrCreateDir.mockResolvedValue(dir);

    await scanAndWait();
    await fireEvent.click(screen.getByText(/^Songs/));
    await fireEvent.click(screen.getByText('Sort all songs'));

    await waitFor(() => expect(mockTrack).toHaveBeenCalledWith('manage', 'sort_songs', expect.objectContaining({ songs: expect.any(Number) })));
  });

  it('shows "no issues found" when the report has nothing to flag', async () => {
    mockCardStore.sampleIndex = new Map();
    mockCardStore.sampleIndex.set('samples/kick.wav', fakeSample('SAMPLES/kick.wav', 'k'));
    mockCardStore.songXmls = new Map();
    mockCardStore.songXmls.set('SONGS/s.XML', '<song><osc1 fileName="SAMPLES/KICK.WAV" /></song>');
    mockCardStore.presetIndex = new Map();

    render(CardScanner);
    await fireEvent.click(screen.getByText('Browse for folder'));
    await waitFor(() => expect(screen.getByText('Sample Library (1)')).toBeTruthy(), { timeout: 3000 });

    await fireEvent.click(screen.getByText('Analysis'));
    expect(screen.getByText('No issues found.')).toBeTruthy();
  });

  it('stops a currently playing sample when clicked again', async () => {
    const playSpy = vi.fn();
    const pauseSpy = vi.fn();
    vi.stubGlobal(
      'Audio',
      class {
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        src = '';
        constructor(src: string) {
          this.src = src;
        }
        play = playSpy;
        pause = pauseSpy;
      },
    );
    URL.createObjectURL = vi.fn().mockReturnValue('blob:mock');
    URL.revokeObjectURL = vi.fn();

    await scanAndWait();
    await expandSamplesFolder();
    const playBtn = screen.getAllByTitle('Play')[0];
    await fireEvent.click(playBtn);
    const stopBtn = screen.getAllByTitle('Stop')[0];
    await fireEvent.click(stopBtn);

    expect(pauseSpy).toHaveBeenCalled();
    expect(screen.getAllByTitle('Play').length).toBeGreaterThan(0);
  });

  it('shows a backup error when the destination folder scan fails', async () => {
    mockWalkHandle.mockRejectedValue(new Error('permission denied'));
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue({ name: 'BACKUP_DEST' }));

    await scanAndWait();
    await fireEvent.click(screen.getByText('Backup'));
    await fireEvent.click(screen.getByText('Choose backup folder'));

    await waitFor(() => expect(screen.getByText('permission denied')).toBeTruthy());
  });

  it('does not show a backup error when the picker is dismissed (AbortError)', async () => {
    const abortErr = new Error('cancelled');
    abortErr.name = 'AbortError';
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockRejectedValue(abortErr));

    await scanAndWait();
    await fireEvent.click(screen.getByText('Backup'));
    await fireEvent.click(screen.getByText('Choose backup folder'));

    await waitFor(() => expect(screen.getByText('Choose backup folder')).toBeTruthy());
  });

  it('runs a full backup after diffing, copying new files', async () => {
    const dir = fakeWritableDir({
      'song1.XML': SONG1_XML,
      'badkit.XML': BAD_KIT_XML,
      'kick.wav': 'kick-data-unique',
      'unused.wav': 'unused-data',
      'dup1.wav': 'duplicate-bytes-xyz',
      'dup2.wav': 'duplicate-bytes-xyz',
    });
    mockGetOrCreateDir.mockResolvedValue(dir);
    mockWalkHandle.mockResolvedValue(undefined);
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue({ name: 'BACKUP_DEST' }));

    await scanAndWait();
    await fireEvent.click(screen.getByText('Backup'));
    await fireEvent.click(screen.getByText('Choose backup folder'));

    await waitFor(() => expect(screen.getByText(/new/)).toBeTruthy());
    await fireEvent.click(screen.getByText('Back Up Now'));

    await waitFor(() => expect(screen.getByText(/Backup complete/)).toBeTruthy(), { timeout: 3000 });
    expect(mockTrack).toHaveBeenCalledWith('manage', 'backup', expect.objectContaining({ files: expect.any(Number) }));
  });

  it('shows an error when the directory picker fails for a non-abort reason', async () => {
    mockCardStore.pickDirectory.mockRejectedValue(new Error('device disconnected'));

    render(CardScanner);
    await fireEvent.click(screen.getByText('Browse for folder'));

    await waitFor(() => expect(screen.getByText('device disconnected')).toBeTruthy());
  });

  it('reports "already sorted" when a song is moved to the category it is already in', async () => {
    mockCardStore.songXmls = new Map();
    mockCardStore.songXmls.set('SONGS/DELUGE_ONLY/song1.XML', SONG1_XML);
    const dir = fakeWritableDir({ 'song1.XML': SONG1_XML });
    mockGetOrCreateDir.mockResolvedValue(dir);

    render(CardScanner);
    await fireEvent.click(screen.getByText('Browse for folder'));
    await waitFor(() => expect(screen.getByText('Sample Library (4)')).toBeTruthy(), { timeout: 3000 });
    await fireEvent.click(screen.getByText(/^Songs/));
    await fireEvent.click(screen.getByText('Move'));

    await waitFor(() => expect(screen.getByText('already sorted')).toBeTruthy());
  });

  it('stops any playing sample audio when resetting to the dropzone', async () => {
    const pauseSpy = vi.fn();
    vi.stubGlobal(
      'Audio',
      class {
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        src = '';
        constructor(src: string) {
          this.src = src;
        }
        play = vi.fn();
        pause = pauseSpy;
      },
    );
    URL.createObjectURL = vi.fn().mockReturnValue('blob:mock');
    URL.revokeObjectURL = vi.fn();

    await scanAndWait();
    await expandSamplesFolder();
    await fireEvent.click(screen.getAllByTitle('Play')[0]);
    await fireEvent.click(screen.getByText('Scan another'));

    expect(pauseSpy).toHaveBeenCalled();
    expect(screen.getByText('Select your SD card folder')).toBeTruthy();
  });

  it('restores a cached report from sessionStorage on mount without re-scanning', async () => {
    sessionStorage.setItem(
      'deluge-clean-report',
      JSON.stringify({
        totalSamples: 2,
        totalSamplesBytes: 100,
        totalReferences: 1,
        unusedSamples: ['SAMPLES/unused.wav'],
        missingReferences: [],
        unusedPresets: [],
        reclaimableBytes: 50,
      }),
    );
    sessionStorage.setItem('deluge-clean-name', 'CACHED_CARD');

    render(CardScanner);

    await waitFor(() => expect(screen.getByText('CACHED_CARD')).toBeTruthy());
    expect(mockCardStore.pickDirectory).not.toHaveBeenCalled();
  });

  it('scans a dropped folder via DataTransferItem entries (webkitGetAsEntry)', async () => {
    const fileEntry = {
      isFile: true,
      isDirectory: false,
      file: (cb: (f: File) => void) => {
        const f = new File(['kick-data'], 'kick.wav');
        Object.defineProperty(f, 'webkitRelativePath', { value: 'CARD/SAMPLES/kick.wav' });
        cb(f);
      },
    };
    const dirEntry = {
      isFile: false,
      isDirectory: true,
      name: 'SAMPLES',
      createReader: () => {
        let done = false;
        return {
          readEntries: (cb: (e: unknown[]) => void) => {
            if (done) { cb([]); return; }
            done = true;
            cb([{ ...fileEntry, name: 'kick.wav' }]);
          },
        };
      },
    };
    const rootEntry = {
      isFile: false,
      isDirectory: true,
      name: 'CARD',
      createReader: () => {
        let done = false;
        return {
          readEntries: (cb: (e: unknown[]) => void) => {
            if (done) { cb([]); return; }
            done = true;
            cb([dirEntry]);
          },
        };
      },
    };

    render(CardScanner);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, {
      dataTransfer: {
        items: [{ webkitGetAsEntry: () => rootEntry }],
        files: [],
      },
    });

    await waitFor(() => expect(screen.getByText('Sample Library (1)')).toBeTruthy(), { timeout: 3000 });
  });

  it('flags files present only in the backup destination', async () => {
    const backupFiles: [string, { kind: 'file'; name: string; getFile: () => Promise<File> }][] = [
      ['orphan.wav', { kind: 'file', name: 'orphan.wav', getFile: async () => new File(['x'], 'orphan.wav') }],
    ];
    const backupDir = {
      name: 'BACKUP_DEST',
      values: () => {
        let i = 0;
        return {
          [Symbol.asyncIterator]() { return this; },
          next: async () => {
            if (i < backupFiles.length) return { value: backupFiles[i++][1], done: false };
            return { value: undefined, done: true };
          },
        };
      },
    };
    mockWalkHandle.mockImplementation(async (_handle: unknown, _prefix: string, out: { path: string; handle: unknown }[]) => {
      out.push({ path: 'orphan.wav', handle: backupFiles[0][1] });
    });
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue(backupDir));

    await scanAndWait();
    await fireEvent.click(screen.getByText('Backup'));
    await fireEvent.click(screen.getByText('Choose backup folder'));

    await waitFor(() => expect(screen.getByText(/only in backup/)).toBeTruthy());
  });

  it('reconnects via requestReconnect from the dropzone button', async () => {
    mockCardStore.reconnect.mockResolvedValue(false);
    mockCardStore.hasPersistedHandle.mockResolvedValue(true);
    mockCardStore.requestReconnect.mockImplementation(async () => {
      mockCardStore.rootHandle = { name: 'RECONNECTED' };
      return true;
    });

    render(CardScanner);
    await waitFor(() => expect(screen.getByText('Reconnect previously loaded SD card')).toBeTruthy());
    await fireEvent.click(screen.getByText('Reconnect previously loaded SD card'));

    await waitFor(() => expect(screen.getByText('Sample Library (4)')).toBeTruthy(), { timeout: 3000 });
  });

  it('returns to idle when requestReconnect fails', async () => {
    mockCardStore.reconnect.mockResolvedValue(false);
    mockCardStore.hasPersistedHandle.mockResolvedValue(true);
    mockCardStore.requestReconnect.mockResolvedValue(false);

    render(CardScanner);
    await waitFor(() => expect(screen.getByText('Reconnect previously loaded SD card')).toBeTruthy());
    await fireEvent.click(screen.getByText('Reconnect previously loaded SD card'));

    await waitFor(() => expect(screen.getByText('Select your SD card folder')).toBeTruthy());
  });

  it('handles dragover and dragleave on the dropzone', async () => {
    render(CardScanner);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.dragOver(dropzone);
    expect(dropzone.classList.contains('dropzone--over')).toBe(true);
    await fireEvent.dragLeave(dropzone);
    expect(dropzone.classList.contains('dropzone--over')).toBe(false);
  });

  it('shows reclaimable bytes on the analysis tab', async () => {
    await scanAndWait();
    await fireEvent.click(screen.getByText('Analysis'));
    expect(screen.getByText(/reclaimable/)).toBeTruthy();
  });

  it('classifies songs with both internal and external gear as mixed', async () => {
    mockCardStore.songXmls.set('SONGS/mixed.XML', MIXED_SONG_XML);
    await scanAndWait();
    await fireEvent.click(screen.getByText(/^Songs/));

    expect(screen.getByText(/External gear/)).toBeTruthy();
    expect(screen.getByText('mixed')).toBeTruthy();
  });

  it('classifies songs with only external gear as externalOnly', async () => {
    mockCardStore.songXmls.set('SONGS/external.XML', EXTERNAL_SONG_XML);
    await scanAndWait();
    await fireEvent.click(screen.getByText(/^Songs/));

    expect(screen.getByText('external')).toBeTruthy();
  });

  it('moves a song into a new category and shows its destination path', async () => {
    const dir = fakeWritableDir({ 'song1.XML': SONG1_XML });
    mockGetOrCreateDir.mockResolvedValue(dir);
    await scanAndWait();
    await fireEvent.click(screen.getByText(/^Songs/));
    await fireEvent.click(screen.getByText('Move'));

    await waitFor(() => expect(screen.getByText(/→/)).toBeTruthy());
  });

  it('shows a Chromium-only message on the backup tab without File System Access', async () => {
    // @ts-expect-error deliberately removing the feature to test the fallback path
    delete window.showDirectoryPicker;
    const file = new File(['kick-data'], 'kick.wav');
    Object.defineProperty(file, 'webkitRelativePath', { value: 'CARD/SAMPLES/kick.wav' });

    render(CardScanner);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, { dataTransfer: { files: [file], items: undefined } });
    await waitFor(() => expect(screen.getByText('Sample Library (1)')).toBeTruthy(), { timeout: 3000 });

    await fireEvent.click(screen.getByText('Backup'));
    expect(screen.getByText(/requires a Chromium-based browser/)).toBeTruthy();
  });

  it('shows a direct-folder-access message on the backup tab after a drag-and-drop scan', async () => {
    const file = new File(['kick-data'], 'kick.wav');
    Object.defineProperty(file, 'webkitRelativePath', { value: 'CARD/SAMPLES/kick.wav' });

    render(CardScanner);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, { dataTransfer: { files: [file], items: undefined } });
    await waitFor(() => expect(screen.getByText('Sample Library (1)')).toBeTruthy(), { timeout: 3000 });

    await fireEvent.click(screen.getByText('Backup'));
    expect(screen.getByText(/requires direct folder access/)).toBeTruthy();
  });

  it('does not show Sort/Move controls on the songs tab after a drag-and-drop scan', async () => {
    const file = new File(['song-data'], 'song1.xml');
    Object.defineProperty(file, 'webkitRelativePath', { value: 'CARD/SAMPLES/kick.wav' });
    const songFile = new File(['song-data'], 'song1.xml');
    Object.defineProperty(songFile, 'webkitRelativePath', { value: 'CARD/SONGS/song1.xml' });

    render(CardScanner);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, { dataTransfer: { files: [file, songFile], items: undefined } });
    await waitFor(() => expect(screen.getByText('Sample Library (1)')).toBeTruthy(), { timeout: 3000 });

    await fireEvent.click(screen.getByText(/^Songs/));
    expect(screen.queryByText('Sort all songs')).toBeFalsy();
    expect(screen.queryByText('Move')).toBeFalsy();
  });

  it('marks a backup file as changed when the destination copy has a different size', async () => {
    mockWalkHandle.mockImplementation(async (_h: unknown, _p: string, out: { path: string; handle: unknown }[]) => {
      out.push({ path: 'SONGS/song1.XML', handle: { getFile: async () => new File(['different-size-content'], 'song1.XML') } });
    });
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue({ name: 'BACKUP_DEST' }));

    await scanAndWait();
    await fireEvent.click(screen.getByText('Backup'));
    await fireEvent.click(screen.getByText('Choose backup folder'));

    await waitFor(() => expect(screen.getByText(/1 changed/)).toBeTruthy());
  });

  it('marks a backup file as changed when only the modification time differs', async () => {
    mockCardStore.songLastModified.set('SONGS/song1.XML', 999999);
    mockWalkHandle.mockImplementation(async (_h: unknown, _p: string, out: { path: string; handle: unknown }[]) => {
      out.push({ path: 'SONGS/song1.XML', handle: { getFile: async () => new File([SONG1_XML], 'song1.XML', { lastModified: 12345 }) } });
    });
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue({ name: 'BACKUP_DEST' }));

    await scanAndWait();
    await fireEvent.click(screen.getByText('Backup'));
    await fireEvent.click(screen.getByText('Choose backup folder'));

    await waitFor(() => expect(screen.getByText(/1 changed/)).toBeTruthy());
  });

  it('shows sample sizes in kilobytes and megabytes when large enough', async () => {
    mockCardStore.sampleIndex = new Map();
    mockCardStore.sampleIndex.set('samples/small.wav', fakeSample('SAMPLES/small.wav', 'x'.repeat(2048)));
    mockCardStore.sampleIndex.set('samples/big.wav', fakeSample('SAMPLES/big.wav', 'y'.repeat(2 * 1024 * 1024)));
    mockCardStore.songXmls = new Map();
    mockCardStore.presetIndex = new Map();

    render(CardScanner);
    await fireEvent.click(screen.getByText('Browse for folder'));
    await waitFor(() => expect(screen.getByText('Sample Library (2)')).toBeTruthy(), { timeout: 3000 });
    await expandSamplesFolder();

    expect(screen.getByText('2 KB')).toBeTruthy();
    expect(screen.getByText('2.0 MB')).toBeTruthy();
  });

  it('shows a moved badge for a song in the folder view after sorting', async () => {
    const dir = fakeWritableDir({ 'song1.XML': SONG1_XML });
    mockGetOrCreateDir.mockResolvedValue(dir);
    await scanAndWait();
    await fireEvent.click(screen.getByText(/^Songs/));
    await fireEvent.click(screen.getByText('Move'));
    await waitFor(() => expect(screen.getByText(/→/)).toBeTruthy());

    await fireEvent.click(screen.getByText('Show folders'));
    await fireEvent.click(screen.getByText('SONGS/'));

    expect(screen.getByText(/→/)).toBeTruthy();
  });

  it('shows a moved badge for an unused sample after deleting it', async () => {
    mockMoveToTrash.mockResolvedValue(undefined);
    await scanAndWait();
    await fireEvent.click(screen.getByText('Analysis'));
    const unusedSection = screen.getByText(/Unused samples/).closest('.analysis-section') as HTMLElement;
    await fireEvent.click(within(unusedSection).getByText('SAMPLES/'));
    const unusedRow = screen.getByText('unused.wav').closest('.tree-file') as HTMLElement;
    await fireEvent.click(within(unusedRow).getByTitle('Move to SOFT_DELETE/'));

    await waitFor(() => expect(screen.getByText('moved')).toBeTruthy());
  });

  it('shows "No songs found" in the folder view when there are no songs', async () => {
    mockCardStore.songXmls = new Map();
    await scanAndWait();
    await fireEvent.click(screen.getByText(/^Songs/));
    await fireEvent.click(screen.getByText('Show folders'));

    expect(screen.getByText('No songs found.')).toBeTruthy();
  });

  it('does not show an error message when the directory picker is dismissed (AbortError)', async () => {
    const abortErr = new Error('cancelled');
    abortErr.name = 'AbortError';
    mockCardStore.pickDirectory.mockRejectedValue(abortErr);

    render(CardScanner);
    await fireEvent.click(screen.getByText('Browse for folder'));

    expect(screen.queryByText('Try again')).toBeFalsy();
  });

  it('does nothing when the folder input change event has no files', async () => {
    // @ts-expect-error deliberately removing the feature to test the fallback path
    delete window.showDirectoryPicker;
    render(CardScanner);
    const input = document.getElementById('clean-folder-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [] });
    await fireEvent.change(input);

    expect(screen.getByText('Select your SD card folder')).toBeTruthy();
  });

  it('moves an external-gear song and shows its destination path', async () => {
    mockCardStore.songXmls.set('SONGS/external.XML', EXTERNAL_SONG_XML);
    const dir = fakeWritableDir({ 'external.XML': EXTERNAL_SONG_XML });
    mockGetOrCreateDir.mockResolvedValue(dir);
    await scanAndWait();
    await fireEvent.click(screen.getByText(/^Songs/));
    const externalRow = screen.getByText('external').closest('.tree-file') as HTMLElement;
    await fireEvent.click(within(externalRow).getByText('Move'));

    await waitFor(() => expect(within(externalRow).getByText(/→/)).toBeTruthy());
  });

  it('does not re-toggle broken refs on a second click of the stat', async () => {
    await scanAndWait();
    const brokenBtn = screen.getByText('broken refs').closest('button') as HTMLElement;
    await fireEvent.click(brokenBtn);
    await fireEvent.click(brokenBtn);
    expect(screen.getByText('Sample Library (4)')).toBeTruthy();
  });

  it('does not show a delete button for unused samples after a drag-and-drop scan', async () => {
    const kick = new File(['kick-data'], 'kick.wav');
    Object.defineProperty(kick, 'webkitRelativePath', { value: 'CARD/SAMPLES/kick.wav' });
    const unused = new File(['unused-data'], 'unused.wav');
    Object.defineProperty(unused, 'webkitRelativePath', { value: 'CARD/SAMPLES/unused.wav' });

    render(CardScanner);
    const dropzone = document.querySelector('.dropzone') as HTMLElement;
    await fireEvent.drop(dropzone, { dataTransfer: { files: [kick, unused], items: undefined } });
    await waitFor(() => expect(screen.getByText('Sample Library (2)')).toBeTruthy(), { timeout: 3000 });

    await fireEvent.click(screen.getByText('Analysis'));
    await fireEvent.click(screen.getByText('SAMPLES/'));
    expect(screen.queryByTitle(/Move to/)).toBeFalsy();
  });

  it('says everything is up to date when the backup destination already matches', async () => {
    const dir = fakeWritableDir({
      'song1.XML': SONG1_XML,
      'badkit.XML': BAD_KIT_XML,
      'kick.wav': 'kick-data-unique',
      'unused.wav': 'unused-data',
      'dup1.wav': 'duplicate-bytes-xyz',
      'dup2.wav': 'duplicate-bytes-xyz',
    });
    mockWalkHandle.mockImplementation(async (_h: unknown, _p: string, out: { path: string; handle: unknown }[]) => {
      out.push({ path: 'SONGS/song1.XML', handle: { getFile: async () => new File([SONG1_XML], 'song1.XML') } });
      out.push({ path: 'KITS/badkit.XML', handle: { getFile: async () => new File([BAD_KIT_XML], 'badkit.XML') } });
      out.push({ path: 'SAMPLES/kick.wav', handle: { getFile: async () => new File(['kick-data-unique'], 'kick.wav') } });
      out.push({ path: 'SAMPLES/unused.wav', handle: { getFile: async () => new File(['unused-data'], 'unused.wav') } });
      out.push({ path: 'SAMPLES/dup1.wav', handle: { getFile: async () => new File(['duplicate-bytes-xyz'], 'dup1.wav') } });
      out.push({ path: 'SAMPLES/dup2.wav', handle: { getFile: async () => new File(['duplicate-bytes-xyz'], 'dup2.wav') } });
    });
    mockGetOrCreateDir.mockResolvedValue(dir);
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue({ name: 'BACKUP_DEST' }));

    await scanAndWait();
    await fireEvent.click(screen.getByText('Backup'));
    await fireEvent.click(screen.getByText('Choose backup folder'));

    await waitFor(() => expect(screen.getByText('Everything is up to date.')).toBeTruthy());
  });

  it('re-scans and changes the backup folder after a completed backup', async () => {
    const dir = fakeWritableDir({
      'song1.XML': SONG1_XML,
      'badkit.XML': BAD_KIT_XML,
      'kick.wav': 'kick-data-unique',
      'unused.wav': 'unused-data',
      'dup1.wav': 'duplicate-bytes-xyz',
      'dup2.wav': 'duplicate-bytes-xyz',
    });
    mockGetOrCreateDir.mockResolvedValue(dir);
    mockWalkHandle.mockResolvedValue(undefined);
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue({ name: 'BACKUP_DEST' }));

    await scanAndWait();
    await fireEvent.click(screen.getByText('Backup'));
    await fireEvent.click(screen.getByText('Choose backup folder'));
    await waitFor(() => expect(screen.getByText(/new/)).toBeTruthy());
    await fireEvent.click(screen.getByText('Back Up Now'));
    await waitFor(() => expect(screen.getByText(/Backup complete/)).toBeTruthy(), { timeout: 3000 });

    await fireEvent.click(screen.getByText('Re-scan'));
    await waitFor(() => expect(screen.getByText(/new/)).toBeTruthy());

    await fireEvent.click(screen.getByText('Back Up Now'));
    await waitFor(() => expect(screen.getByText(/Backup complete/)).toBeTruthy(), { timeout: 3000 });
    await fireEvent.click(screen.getByText('Change folder'));

    expect(screen.getByText('Choose backup folder')).toBeTruthy();
  });
});
