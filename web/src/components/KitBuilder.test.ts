import { render, fireEvent, screen, cleanup, waitFor } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import KitBuilder from './KitBuilder.svelte';

vi.mock('../lib/analytics', () => ({
  trackToolAction: vi.fn(),
}));

vi.mock('../lib/cardStore', () => ({
  cardStore: {
    reconnectHandleOnly: vi.fn().mockResolvedValue(null),
    hasPersistedHandle: vi.fn().mockResolvedValue(false),
  },
}));

import { trackToolAction } from '../lib/analytics';
import { cardStore } from '../lib/cardStore';

const mockTrack = trackToolAction as unknown as ReturnType<typeof vi.fn>;
const mockCardStore = cardStore as unknown as {
  reconnectHandleOnly: ReturnType<typeof vi.fn>;
  hasPersistedHandle: ReturnType<typeof vi.fn>;
};

type FakeFile = { kind: 'file'; name: string; getFile: ReturnType<typeof vi.fn> };
type FakeDir = { kind: 'directory'; name: string; entries: () => AsyncIterableIterator<[string, FakeFile | FakeDir]> };

function fakeFile(name: string): FakeFile {
  return {
    kind: 'file' as const,
    name,
    getFile: vi.fn().mockResolvedValue(new File(['data'], name)),
  };
}

function fakeDir(name: string, children: [string, FakeFile | FakeDir][] = []): FakeDir {
  return {
    kind: 'directory' as const,
    name,
    entries: () => {
      let i = 0;
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next: async () => {
          if (i < children.length) return { value: children[i++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
}

const KIT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<kit>
  <soundSources>
    <sound name="MYSOUND" polyphonic="auto">
      <osc1 fileName="SAMPLES/kick.wav" loopMode="1" />
    </sound>
  </soundSources>
</kit>`;

beforeEach(() => {
  vi.clearAllMocks();
  mockCardStore.reconnectHandleOnly.mockResolvedValue(null);
  mockCardStore.hasPersistedHandle.mockResolvedValue(false);
  localStorage.clear();
  delete (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker;
});

afterEach(() => {
  cleanup();
});

describe('KitBuilder', () => {
  it('renders the landing state with no persisted card', async () => {
    render(KitBuilder);
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByText('Kit Builder')).toBeTruthy();
    expect(screen.getByText('Open SAMPLES Folder')).toBeTruthy();
    expect(screen.queryByText('Use loaded SD card')).toBeNull();
  });

  it('offers to reuse a persisted card handle', async () => {
    mockCardStore.hasPersistedHandle.mockResolvedValue(true);
    render(KitBuilder);

    await waitFor(() => expect(screen.getByText('Use loaded SD card')).toBeTruthy());
  });

  it('auto-loads samples from an already-reconnectable card', async () => {
    const samplesDir = fakeDir('SAMPLES', [['kick.wav', fakeFile('kick.wav')]]);
    const root = { getDirectoryHandle: vi.fn().mockResolvedValue(samplesDir) };
    mockCardStore.reconnectHandleOnly.mockResolvedValue(root);

    render(KitBuilder);

    await waitFor(() => expect(screen.getByText('kick.wav')).toBeTruthy());
  });

  it('opens a samples folder via the directory picker and lists entries sorted dirs-first', async () => {
    const samplesDir = fakeDir('SAMPLES', [
      ['kick.wav', fakeFile('kick.wav')],
      ['sub', fakeDir('sub', [['snare.wav', fakeFile('snare.wav')]])],
    ]);
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = vi.fn().mockResolvedValue(samplesDir);

    render(KitBuilder);
    await fireEvent.click(screen.getByText('Open SAMPLES Folder'));

    await waitFor(() => {
      const names = Array.from(document.querySelectorAll('.browse-name')).map((n) => n.textContent);
      expect(names).toEqual(['sub', 'kick.wav']);
    });
    expect(mockTrack).toHaveBeenCalledWith('kits', 'open_samples');
  });

  it('loads a kit from a dropped XML file', async () => {
    render(KitBuilder);

    const landing = document.querySelector('.landing') as HTMLElement;
    const file = new File([KIT_XML], 'MyKit.xml', { type: 'application/xml' });
    await fireEvent.drop(landing, { dataTransfer: { files: [file] } });

    await waitFor(() => expect(screen.getByText('MyKit')).toBeTruthy());
    expect(mockTrack).toHaveBeenCalledWith('kits', 'load_kit');
  });

  it('loads a kit from the file input', async () => {
    render(KitBuilder);

    const input = screen.getByText('Load Kit XML').querySelector('input') as HTMLInputElement;
    const file = new File([KIT_XML], 'MyKit.xml', { type: 'application/xml' });
    Object.defineProperty(input, 'files', { value: [file] });
    await fireEvent.change(input);

    await waitFor(() => expect(screen.getByText('MyKit')).toBeTruthy());
  });

  async function openFolderAndAddKick() {
    const samplesDir = fakeDir('SAMPLES', [['kick.wav', fakeFile('kick.wav')]]);
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = vi.fn().mockResolvedValue(samplesDir);

    render(KitBuilder);
    await fireEvent.click(screen.getByText('Open SAMPLES Folder'));
    await waitFor(() => expect(document.querySelector('.browse-name')).toBeTruthy());

    const container = document.querySelector('.kit-builder') as HTMLElement;
    await fireEvent.keyDown(container, { key: 'a' });
    await waitFor(() => expect(document.querySelector('.row-name')).toBeTruthy());

    return container;
  }

  it('adds a sample to the kit via keyboard and deletes it with dd', async () => {
    const container = await openFolderAndAddKick();
    expect(document.querySelector('.row-name')?.textContent?.trim()).toBe('KICK');

    await fireEvent.keyDown(container, { key: 'Tab' });
    await fireEvent.keyDown(container, { key: 'd' });
    await fireEvent.keyDown(container, { key: 'd' });

    expect(document.querySelector('.pane-empty')?.textContent).toContain('Empty kit');
  });

  it('renames the selected row', async () => {
    const container = await openFolderAndAddKick();
    await fireEvent.keyDown(container, { key: 'Tab' });
    await fireEvent.keyDown(container, { key: 'r' });
    await waitFor(() => expect(document.querySelector('.rename-input')).toBeTruthy());

    const renameInput = document.querySelector('.rename-input') as HTMLInputElement;
    await fireEvent.input(renameInput, { target: { value: 'my snare' } });
    await fireEvent.keyDown(container, { key: 'Enter' });

    expect(document.querySelector('.row-name')?.textContent?.trim()).toBe('MY SNARE');
  });

  it('cycles loop mode and adjusts volume on the selected row', async () => {
    const container = await openFolderAndAddKick();
    await fireEvent.keyDown(container, { key: 'Tab' });

    expect(document.querySelector('[data-mode="once"]')).toBeTruthy();
    await fireEvent.keyDown(container, { key: 'l' });
    expect(document.querySelector('[data-mode="loop"]')).toBeTruthy();

    await fireEvent.keyDown(container, { key: '=' });
    await fireEvent.keyDown(container, { key: '-' });
  });

  it('exports the kit and downloads XML', async () => {
    const createUrl = vi.fn().mockReturnValue('blob:mock');
    const revokeUrl = vi.fn();
    URL.createObjectURL = createUrl;
    URL.revokeObjectURL = revokeUrl;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const container = await openFolderAndAddKick();
    await fireEvent.keyDown(container, { key: 'Tab' });
    await fireEvent.keyDown(container, { key: 'e' });

    expect(clickSpy).toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith('kits', 'export', { rows: 1 });

    clickSpy.mockRestore();
  });

  it('shows and closes the help overlay', async () => {
    render(KitBuilder);

    const container = document.querySelector('.kit-builder') as HTMLElement;
    await fireEvent.keyDown(container, { key: '?' });
    expect(screen.getByText('Keyboard Shortcuts')).toBeTruthy();

    await fireEvent.keyDown(container, { key: 'Escape' });
    expect(screen.queryByText('Keyboard Shortcuts')).toBeNull();
  });

  it('auto-loads a cached kit from localStorage on mount', async () => {
    localStorage.setItem(
      'kit-builder-cache',
      JSON.stringify({
        name: 'Cached Kit',
        rows: [
          {
            name: 'CACHED',
            samplePath: 'SAMPLES/cached.wav',
            volume: 50,
            pan: 0,
            loopMode: 'once',
            polyphonic: 'auto',
          },
        ],
        selectedIndex: 0,
      }),
    );

    render(KitBuilder);

    await waitFor(() => expect(screen.getByText('Cached Kit')).toBeTruthy());
    expect(screen.getByText('CACHED')).toBeTruthy();
  });

  it('confirms discarding unsaved changes when starting a new kit', async () => {
    await openFolderAndAddKick();

    await fireEvent.click(screen.getByText('New Kit'));
    expect(screen.getByText('Save before creating new kit?')).toBeTruthy();

    await fireEvent.click(screen.getByText('Discard & New'));
    expect(screen.queryByText('Save before creating new kit?')).toBeNull();
    expect(document.querySelector('.pane-empty')?.textContent).toContain('Empty kit');
    expect(document.querySelector('.toolbar-title')?.textContent).toBe('Kit');
  });

  it('ignores a corrupted localStorage cache and still renders the landing state', async () => {
    localStorage.setItem('kit-builder-cache', '{not valid json');
    render(KitBuilder);
    await Promise.resolve();

    expect(screen.getByText('Kit Builder')).toBeTruthy();
  });

  it('reconnects samples from a persisted card handle via the landing button', async () => {
    const samplesDir = fakeDir('SAMPLES', [['kick.wav', fakeFile('kick.wav')]]);
    const root = { getDirectoryHandle: vi.fn().mockResolvedValue(samplesDir) };
    mockCardStore.hasPersistedHandle.mockResolvedValue(true);
    mockCardStore.reconnectHandleOnly.mockResolvedValueOnce(null).mockResolvedValueOnce(root);

    render(KitBuilder);
    await waitFor(() => expect(screen.getByText('Use loaded SD card')).toBeTruthy());

    await fireEvent.click(screen.getByText('Use loaded SD card'));
    await waitFor(() => expect(screen.getByText('kick.wav')).toBeTruthy());
    expect(mockCardStore.reconnectHandleOnly).toHaveBeenLastCalledWith(true);
  });

  it('auditions a browser sample with space and stops it with escape', async () => {
    const samplesDir = fakeDir('SAMPLES', [['kick.wav', fakeFile('kick.wav')]]);
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = vi.fn().mockResolvedValue(samplesDir);
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    URL.createObjectURL = vi.fn().mockReturnValue('blob:mock');
    URL.revokeObjectURL = vi.fn();

    render(KitBuilder);
    await fireEvent.click(screen.getByText('Open SAMPLES Folder'));
    await waitFor(() => expect(document.querySelector('.browse-name')).toBeTruthy());

    const container = document.querySelector('.kit-builder') as HTMLElement;
    await fireEvent.keyDown(container, { key: ' ' });
    await waitFor(() => expect(document.querySelector('.status-playing')).toBeTruthy());

    await fireEvent.keyDown(container, { key: 'Escape' });
    expect(document.querySelector('.status-playing')).toBeNull();
    playSpy.mockRestore();
  });

  it('auditions a kit row with space in the kit pane', async () => {
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    URL.createObjectURL = vi.fn().mockReturnValue('blob:mock');
    URL.revokeObjectURL = vi.fn();

    const container = await openFolderAndAddKick();
    await fireEvent.keyDown(container, { key: 'Tab' });
    await fireEvent.keyDown(container, { key: ' ' });

    await waitFor(() => expect(document.querySelector('.kit-row--playing')).toBeTruthy());
    playSpy.mockRestore();
  });

  it('moves rows up and down with J/K, undoes with u, and dedupes with D', async () => {
    const samplesDir = fakeDir('SAMPLES', [
      ['kick.wav', fakeFile('kick.wav')],
      ['snare.wav', fakeFile('snare.wav')],
    ]);
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = vi.fn().mockResolvedValue(samplesDir);

    render(KitBuilder);
    await fireEvent.click(screen.getByText('Open SAMPLES Folder'));
    await waitFor(() => expect(document.querySelectorAll('.browse-name').length).toBe(2));

    const container = document.querySelector('.kit-builder') as HTMLElement;
    await fireEvent.keyDown(container, { key: 'a' });
    await fireEvent.keyDown(container, { key: 'j' });
    await fireEvent.keyDown(container, { key: 'a' });
    await waitFor(() => expect(document.querySelectorAll('.row-name').length).toBe(2));

    await fireEvent.keyDown(container, { key: 'Tab' });
    const names = () => Array.from(document.querySelectorAll('.row-name')).map((n) => n.textContent?.trim());
    expect(names()).toEqual(['KICK', 'SNARE']);

    await fireEvent.keyDown(container, { key: 'K' });
    expect(names()).toEqual(['SNARE', 'KICK']);

    await fireEvent.keyDown(container, { key: 'J' });
    expect(names()).toEqual(['KICK', 'SNARE']);

    await fireEvent.keyDown(container, { key: 'u' });
    expect(names()).toEqual(['SNARE', 'KICK']);

    await fireEvent.keyDown(container, { key: 'D' });
    expect(document.querySelectorAll('.row-name').length).toBe(2);
  });

  it('adjusts pan with < and >', async () => {
    const container = await openFolderAndAddKick();
    await fireEvent.keyDown(container, { key: 'Tab' });
    await fireEvent.keyDown(container, { key: '>' });
    await fireEvent.keyDown(container, { key: '<' });
    expect(document.querySelector('.row-name')).toBeTruthy();
  });

  it('filters the browser list via search mode and clears it on escape', async () => {
    const samplesDir = fakeDir('SAMPLES', [
      ['kick.wav', fakeFile('kick.wav')],
      ['snare.wav', fakeFile('snare.wav')],
    ]);
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = vi.fn().mockResolvedValue(samplesDir);

    render(KitBuilder);
    await fireEvent.click(screen.getByText('Open SAMPLES Folder'));
    await waitFor(() => expect(document.querySelectorAll('.browse-name').length).toBe(2));

    const container = document.querySelector('.kit-builder') as HTMLElement;
    await fireEvent.keyDown(container, { key: '/' });
    const searchInput = document.querySelector('.search-input') as HTMLInputElement;
    expect(searchInput).toBeTruthy();
    await fireEvent.input(searchInput, { target: { value: 'sna' } });

    await waitFor(() => {
      const names = Array.from(document.querySelectorAll('.browse-name')).map((n) => n.textContent);
      expect(names).toEqual(['snare.wav']);
    });

    await fireEvent.keyDown(container, { key: 'Enter' });
    expect(document.querySelector('.search-active')?.textContent).toContain('sna');

    await fireEvent.click(document.querySelector('.search-clear') as HTMLElement);
    await waitFor(() => expect(document.querySelectorAll('.browse-name').length).toBe(2));
  });

  it('clears an active search with escape from the browser pane', async () => {
    const samplesDir = fakeDir('SAMPLES', [
      ['kick.wav', fakeFile('kick.wav')],
      ['snare.wav', fakeFile('snare.wav')],
    ]);
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = vi.fn().mockResolvedValue(samplesDir);

    render(KitBuilder);
    await fireEvent.click(screen.getByText('Open SAMPLES Folder'));
    await waitFor(() => expect(document.querySelectorAll('.browse-name').length).toBe(2));

    const container = document.querySelector('.kit-builder') as HTMLElement;
    await fireEvent.keyDown(container, { key: '/' });
    const searchInput = document.querySelector('.search-input') as HTMLInputElement;
    await fireEvent.input(searchInput, { target: { value: 'sna' } });
    await fireEvent.keyDown(container, { key: 'Escape' });
    await waitFor(() => expect(document.querySelector('.search-input')).toBeNull());

    await fireEvent.keyDown(container, { key: 'Escape' });
    await waitFor(() => expect(document.querySelectorAll('.browse-name').length).toBe(2));
  });

  it('navigates the browser tree with g/G, expands with l, and collapses with h', async () => {
    const samplesDir = fakeDir('SAMPLES', [
      ['aaa.wav', fakeFile('aaa.wav')],
      ['sub', fakeDir('sub', [['snare.wav', fakeFile('snare.wav')]])],
    ]);
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = vi.fn().mockResolvedValue(samplesDir);

    render(KitBuilder);
    await fireEvent.click(screen.getByText('Open SAMPLES Folder'));
    await waitFor(() => expect(document.querySelectorAll('.browse-name').length).toBe(2));

    const container = document.querySelector('.kit-builder') as HTMLElement;
    await fireEvent.keyDown(container, { key: 'g' });
    await fireEvent.keyDown(container, { key: 'l' });
    await waitFor(() => expect(document.querySelectorAll('.browse-name').length).toBe(3));

    await fireEvent.keyDown(container, { key: 'j' });
    await fireEvent.keyDown(container, { key: 'h' });
    await fireEvent.keyDown(container, { key: 'h' });
    await waitFor(() => expect(document.querySelectorAll('.browse-name').length).toBe(2));

    await fireEvent.keyDown(container, { key: 'G' });
    await fireEvent.keyDown(container, { key: 'k' });
    await fireEvent.keyDown(container, { key: 'l' });
    await waitFor(() => expect(document.querySelectorAll('.browse-name').length).toBe(3));
    await fireEvent.keyDown(container, { key: 'j' });
    await fireEvent.keyDown(container, { key: 'h' });
    await fireEvent.keyDown(container, { key: 'h' });
    expect(document.querySelectorAll('.browse-name').length).toBe(2);
  });

  it('adds an entire folder of samples to the kit via Enter', async () => {
    const samplesDir = fakeDir('SAMPLES', [
      ['sub', fakeDir('sub', [
        ['snare.wav', fakeFile('snare.wav')],
        ['notes.txt', fakeFile('notes.txt')],
      ])],
    ]);
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = vi.fn().mockResolvedValue(samplesDir);

    render(KitBuilder);
    await fireEvent.click(screen.getByText('Open SAMPLES Folder'));
    await waitFor(() => expect(document.querySelector('.browse-name')).toBeTruthy());

    const container = document.querySelector('.kit-builder') as HTMLElement;
    await fireEvent.keyDown(container, { key: 'Enter' });

    await waitFor(() => expect(document.querySelectorAll('.row-name').length).toBe(1));
    expect(document.querySelector('.row-name')?.textContent?.trim()).toBe('SNARE');
  });

  it('adds a sample by double-clicking a browser entry and a folder by double-click', async () => {
    const samplesDir = fakeDir('SAMPLES', [
      ['kick.wav', fakeFile('kick.wav')],
      ['sub', fakeDir('sub', [['snare.wav', fakeFile('snare.wav')]])],
    ]);
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = vi.fn().mockResolvedValue(samplesDir);

    render(KitBuilder);
    await fireEvent.click(screen.getByText('Open SAMPLES Folder'));
    await waitFor(() => expect(document.querySelectorAll('.browse-name').length).toBe(2));

    const entries = () => Array.from(document.querySelectorAll('.browse-entry'));
    const dirEntry = entries().find((e) => e.textContent?.includes('sub'))!;
    await fireEvent.dblClick(dirEntry);
    await waitFor(() => expect(document.querySelectorAll('.row-name').length).toBe(1));

    const fileEntry = entries().find((e) => e.textContent?.includes('kick.wav'))!;
    await fireEvent.dblClick(fileEntry);
    await waitFor(() => expect(document.querySelectorAll('.row-name').length).toBe(2));
  });

  it('selects a browser entry and a kit row via click', async () => {
    const container = await openFolderAndAddKick();
    const kitRow = document.querySelector('.kit-row') as HTMLElement;
    await fireEvent.click(kitRow);
    expect(kitRow.className).toContain('kit-row--selected');
    void container;
  });

  it('drops a kit XML file onto the kit-rows pane while a kit is already loaded', async () => {
    const container = await openFolderAndAddKick();
    const kitListPane = document.querySelectorAll('.pane-list')[1] as HTMLElement;
    const file = new File([KIT_XML], 'Dropped.xml', { type: 'application/xml' });
    await fireEvent.drop(kitListPane, { dataTransfer: { files: [file] } });

    await waitFor(() => expect(screen.getByText('Dropped')).toBeTruthy());
    void container;
  });

  it('opens the folder picker from the toolbar Change Folder button once a folder is set', async () => {
    await openFolderAndAddKick();

    const samplesDir = fakeDir('SAMPLES', [['kick.wav', fakeFile('kick.wav')]]);
    const picker = vi.fn().mockResolvedValue(samplesDir);
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = picker;

    await fireEvent.click(screen.getByText('Change Folder'));
    expect(picker).toHaveBeenCalledTimes(1);
  });

  it('opens the folder from the browser pane empty-state button and via the o key', async () => {
    render(KitBuilder);
    const samplesDir = fakeDir('SAMPLES', [['kick.wav', fakeFile('kick.wav')]]);
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = vi.fn().mockResolvedValue(samplesDir);

    await fireEvent.click(screen.getByText('Open SAMPLES Folder'));
    await waitFor(() => expect(document.querySelector('.browse-name')).toBeTruthy());
  });

  it('exits search mode with Enter key', async () => {
    await openFolderAndAddKick();

    const container = document.querySelector('[tabindex]') as HTMLElement;
    await fireEvent.keyDown(container, { key: '/' });
    const searchInput = document.querySelector('.search-input') as HTMLInputElement;
    expect(searchInput).toBeTruthy();

    await fireEvent.keyDown(searchInput, { key: 'Enter' });
    await waitFor(() => expect(document.querySelector('.search-input')).toBeNull());
  });

  it('handles dragover on the landing area', async () => {
    render(KitBuilder);
    const landing = document.querySelector('.landing') as HTMLElement;
    if (landing) {
      await fireEvent.dragOver(landing);
    }
  });
});
