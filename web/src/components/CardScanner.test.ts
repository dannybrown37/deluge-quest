import { render, fireEvent, screen, cleanup, waitFor } from '@testing-library/svelte';
import { within } from '@testing-library/dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import CardScanner from './CardScanner.svelte';

vi.mock('../lib/analytics', () => ({
  trackToolAction: vi.fn(),
}));

vi.mock('../lib/softDelete', () => ({
  TRASH_DIR: 'SOFT_DELETE',
  MOVE_BACKUP_DIR: 'MOVE_BACKUP',
  getOrCreateDir: vi.fn(),
  moveToTrash: vi.fn(),
  moveFile: vi.fn(),
  updateXmlReferences: vi.fn(),
}));

vi.mock('../lib/cardStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/cardStore')>();
  return {
    ...actual,
    cardStore: {
      rootHandle: null,
      songXmls: new Map<string, string>(),
      presetIndex: new Map<string, string>(),
      sampleIndex: new Map<string, { handle: { getFile: ReturnType<typeof vi.fn> }; size: number; path: string }>(),
      songLastModified: new Map<string, number>(),
      pickDirectory: vi.fn().mockResolvedValue(undefined),
      requestReconnect: vi.fn().mockResolvedValue(false),
      hasPersistedHandle: vi.fn().mockResolvedValue(false),
    },
  };
});

import { trackToolAction } from '../lib/analytics';
import { moveToTrash } from '../lib/softDelete';
import { cardStore } from '../lib/cardStore';

const mockTrack = trackToolAction as unknown as ReturnType<typeof vi.fn>;
const mockMoveToTrash = moveToTrash as unknown as ReturnType<typeof vi.fn>;
const mockCardStore = cardStore as unknown as {
  rootHandle: { name: string } | null;
  songXmls: Map<string, string>;
  presetIndex: Map<string, string>;
  sampleIndex: Map<string, { handle: { getFile: ReturnType<typeof vi.fn> }; size: number; path: string }>;
  songLastModified: Map<string, number>;
  pickDirectory: ReturnType<typeof vi.fn>;
  requestReconnect: ReturnType<typeof vi.fn>;
  hasPersistedHandle: ReturnType<typeof vi.fn>;
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
  sessionStorage.clear();
  seedCard();
});

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

  it('batch-selects and deletes samples with confirmation', async () => {
    mockMoveToTrash.mockResolvedValue(undefined);
    await scanAndWait();
    await expandSamplesFolder();

    const checkboxes = document.querySelectorAll('.file-checkbox');
    await fireEvent.click(checkboxes[0]);

    expect(screen.getByText('1 selected')).toBeTruthy();
    await fireEvent.click(screen.getByText('Delete'));
    expect(screen.getByText(/Delete 1 file\?/)).toBeTruthy();

    await fireEvent.click(screen.getAllByText('Delete')[screen.getAllByText('Delete').length - 1]);
    await waitFor(() => expect(mockMoveToTrash).toHaveBeenCalled());
    expect(mockTrack).toHaveBeenCalledWith('manage', 'batch_delete', expect.objectContaining({ deleted: 1 }));
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
});
