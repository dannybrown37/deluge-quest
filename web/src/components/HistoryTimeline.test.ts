import { render, fireEvent, screen, cleanup, waitFor } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import HistoryTimeline from './HistoryTimeline.svelte';
import type { SavePoint } from '../lib/historyStore';

vi.mock('../lib/cardStore', () => ({
  cardStore: {
    isLoaded: true,
    rootHandle: { name: 'DELUGE' },
    songXmls: new Map<string, string>(),
    presetIndex: new Map<string, string>(),
    reconnect: vi.fn().mockResolvedValue(true),
    pickDirectory: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
  },
}));

vi.mock('../lib/historyStore', () => ({
  historyStore: {
    listSavePoints: vi.fn(),
    createSavePoint: vi.fn(),
    getXml: vi.fn(),
    deleteSavePoint: vi.fn().mockResolvedValue(undefined),
    exportSavePoint: vi.fn(),
    estimateUsage: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../lib/softDelete', () => ({
  restoreFile: vi.fn().mockResolvedValue({ backedUp: true, created: false }),
}));

vi.mock('../lib/analytics', () => ({ trackToolAction: vi.fn() }));

import { cardStore } from '../lib/cardStore';
import { historyStore } from '../lib/historyStore';
import { restoreFile } from '../lib/softDelete';
import { trackToolAction } from '../lib/analytics';

const store = historyStore as unknown as Record<string, ReturnType<typeof vi.fn>>;
const card = cardStore as unknown as {
  isLoaded: boolean;
  rootHandle: { name: string } | null;
  songXmls: Map<string, string>;
  presetIndex: Map<string, string>;
  reconnect: ReturnType<typeof vi.fn>;
  pickDirectory: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
};

const SONG_OLD = '<song timePerTimerTick="525" timerTickFraction="0" xScroll="0"/>';
const SONG_NEW = '<song timePerTimerTick="420" timerTickFraction="0" xScroll="48"/>';

function savePoint(id: number, files: Record<string, string>, label = `sp-${id}`): SavePoint {
  return {
    id,
    cardName: 'DELUGE',
    takenAt: id * 100000,
    label,
    entries: Object.entries(files).map(([path, hash]) => ({
      path,
      kind: path.startsWith('KITS') ? ('kit' as const) : ('song' as const),
      hash,
      size: 100,
    })),
  };
}

/** Newest first, the order listSavePoints returns. */
const TWO_POINTS = [
  savePoint(2, { 'SONGS/A.XML': 'newhash', 'KITS/K.XML': 'kit-same' }),
  savePoint(1, { 'SONGS/A.XML': 'oldhash', 'KITS/K.XML': 'kit-same' }),
];

beforeEach(() => {
  vi.clearAllMocks();
  card.isLoaded = true;
  card.rootHandle = { name: 'DELUGE' };
  store.listSavePoints.mockResolvedValue([]);
  store.estimateUsage.mockResolvedValue(null);
  store.getXml.mockImplementation(async (hash: string) =>
    hash === 'oldhash' ? SONG_OLD : hash === 'newhash' ? SONG_NEW : '<song/>',
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function confirmWith(answer: boolean) {
  vi.stubGlobal('confirm', vi.fn(() => answer));
}

describe('empty state', () => {
  it('explains what a save point is when there are none', async () => {
    render(HistoryTimeline);
    expect(await screen.findByText(/No save points yet/)).toBeTruthy();
  });

  it('says samples are never included, so nobody expects them', async () => {
    render(HistoryTimeline);
    expect(await screen.findByText(/Samples are never included/)).toBeTruthy();
  });
});

describe('taking a save point', () => {
  it('passes the card maps and the typed label through', async () => {
    card.songXmls = new Map([['SONGS/A.XML', SONG_NEW]]);
    card.presetIndex = new Map([['KITS/K.XML', '<kit/>']]);
    store.createSavePoint.mockResolvedValue(savePoint(1, { 'SONGS/A.XML': 'h' }));
    render(HistoryTimeline);

    await fireEvent.input(screen.getByLabelText('Save point name'), {
      target: { value: 'before the gig' },
    });
    await fireEvent.click(screen.getByText('Take save point'));

    await waitFor(() => expect(store.createSavePoint).toHaveBeenCalled());
    const [source, label] = store.createSavePoint.mock.calls[0];
    expect(source.songXmls.size).toBe(1);
    expect(source.presetIndex.size).toBe(1);
    expect(label).toBe('before the gig');
  });

  it('sends no label when the box is empty, so the date is used', async () => {
    store.createSavePoint.mockResolvedValue(savePoint(1, {}));
    render(HistoryTimeline);
    await fireEvent.click(screen.getByText('Take save point'));
    await waitFor(() => expect(store.createSavePoint).toHaveBeenCalled());
    expect(store.createSavePoint.mock.calls[0][1]).toBeUndefined();
  });

  it('reports how many files were saved', async () => {
    store.createSavePoint.mockResolvedValue(savePoint(1, { 'SONGS/A.XML': 'h' }));
    render(HistoryTimeline);
    await fireEvent.click(screen.getByText('Take save point'));
    expect(await screen.findByText(/Saved 1 files/)).toBeTruthy();
  });

  it('shows the failure instead of pretending it saved', async () => {
    store.createSavePoint.mockRejectedValue(new Error('Browser storage is unavailable'));
    render(HistoryTimeline);
    await fireEvent.click(screen.getByText('Take save point'));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Browser storage is unavailable',
    );
  });

  it('tracks the action', async () => {
    store.createSavePoint.mockResolvedValue(savePoint(1, { 'SONGS/A.XML': 'h' }));
    render(HistoryTimeline);
    await fireEvent.click(screen.getByText('Take save point'));
    await waitFor(() =>
      expect(trackToolAction).toHaveBeenCalledWith('history', 'save_point', expect.anything()),
    );
  });
});

describe('the timeline', () => {
  beforeEach(() => {
    store.listSavePoints.mockResolvedValue(TWO_POINTS);
  });

  it('lists every save point, newest first', async () => {
    render(HistoryTimeline);
    expect(await screen.findByText('sp-2')).toBeTruthy();
    expect(screen.getByText('sp-1')).toBeTruthy();
  });

  it('selects the newest and compares it against the one before', async () => {
    render(HistoryTimeline);
    expect(await screen.findByText('sp-1 → sp-2')).toBeTruthy();
  });

  it('counts what changed', async () => {
    const { container } = render(HistoryTimeline);
    await screen.findByText('sp-1 → sp-2');
    const summary = container.querySelector('.diff-summary');
    expect(summary?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '1 changed · 0 added · 0 removed',
    );
  });

  it('says so when the earliest save point is selected', async () => {
    render(HistoryTimeline);
    await fireEvent.click(await screen.findByText('sp-1'));
    expect(await screen.findByText(/earliest save point/)).toBeTruthy();
  });

  it('deletes a save point after asking', async () => {
    confirmWith(true);
    render(HistoryTimeline);
    await fireEvent.click((await screen.findAllByText('delete'))[0]);
    await waitFor(() => expect(store.deleteSavePoint).toHaveBeenCalledWith(2));
  });

  it('does not delete when the question is declined', async () => {
    confirmWith(false);
    render(HistoryTimeline);
    await fireEvent.click((await screen.findAllByText('delete'))[0]);
    expect(store.deleteSavePoint).not.toHaveBeenCalled();
  });
});

describe('the diff', () => {
  beforeEach(() => {
    store.listSavePoints.mockResolvedValue(TWO_POINTS);
  });

  it('lists only files that changed', async () => {
    render(HistoryTimeline);
    expect(await screen.findByText('SONGS/A.XML')).toBeTruthy();
    expect(screen.queryByText('KITS/K.XML')).toBeNull();
  });

  it('shows changes in words when a file is opened', async () => {
    render(HistoryTimeline);
    await fireEvent.click(await screen.findByText('SONGS/A.XML'));
    expect(await screen.findByText('BPM')).toBeTruthy();
    expect(screen.getByText('105 -> 131.3')).toBeTruthy();
  });

  it('keeps view-only changes behind a count instead of hiding them', async () => {
    render(HistoryTimeline);
    await fireEvent.click(await screen.findByText('SONGS/A.XML'));
    const toggle = await screen.findByText(/1 view-only changes/);
    expect(screen.queryByText('Scroll position')).toBeNull();
    await fireEvent.click(toggle);
    expect(await screen.findByText('Scroll position')).toBeTruthy();
  });

  it('closes an open file when it is clicked again', async () => {
    render(HistoryTimeline);
    await fireEvent.click(await screen.findByText('SONGS/A.XML'));
    expect(await screen.findByText('BPM')).toBeTruthy();
    await fireEvent.click(screen.getByText('SONGS/A.XML'));
    await waitFor(() => expect(screen.queryByText('BPM')).toBeNull());
  });

  it('says so when the stored copy has been collected', async () => {
    store.getXml.mockResolvedValue(null);
    render(HistoryTimeline);
    await fireEvent.click(await screen.findByText('SONGS/A.XML'));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('cannot be compared'),
    );
  });

  it('filters by kind', async () => {
    store.listSavePoints.mockResolvedValue([
      savePoint(2, { 'SONGS/A.XML': 'newhash', 'KITS/K.XML': 'kit2' }),
      savePoint(1, { 'SONGS/A.XML': 'oldhash', 'KITS/K.XML': 'kit1' }),
    ]);
    render(HistoryTimeline);
    await fireEvent.click(await screen.findByText('Kits'));
    expect(await screen.findByText('KITS/K.XML')).toBeTruthy();
    expect(screen.queryByText('SONGS/A.XML')).toBeNull();
  });
});

describe('restoring', () => {
  beforeEach(() => {
    store.listSavePoints.mockResolvedValue(TWO_POINTS);
    confirmWith(true);
  });

  it('writes the older version back through restoreFile', async () => {
    render(HistoryTimeline);
    await fireEvent.click((await screen.findAllByText('restore this version'))[0]);
    await waitFor(() =>
      expect(restoreFile).toHaveBeenCalledWith({ name: 'DELUGE' }, 'SONGS/A.XML', SONG_OLD),
    );
  });

  it('tells the user where the overwritten version went', async () => {
    render(HistoryTimeline);
    await fireEvent.click((await screen.findAllByText('restore this version'))[0]);
    expect(await screen.findByText(/HISTORY_BACKUP/)).toBeTruthy();
  });

  it('does nothing when the question is declined', async () => {
    confirmWith(false);
    render(HistoryTimeline);
    await fireEvent.click((await screen.findAllByText('restore this version'))[0]);
    expect(restoreFile).not.toHaveBeenCalled();
  });

  it('refuses without a card, rather than failing deep in the write', async () => {
    card.rootHandle = null;
    render(HistoryTimeline);
    await fireEvent.click((await screen.findAllByText('restore this version'))[0]);
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Connect the card before restoring.',
    );
    expect(restoreFile).not.toHaveBeenCalled();
  });

  it('surfaces a failed restore', async () => {
    vi.mocked(restoreFile).mockRejectedValueOnce(new Error('card is read-only'));
    render(HistoryTimeline);
    await fireEvent.click((await screen.findAllByText('restore this version'))[0]);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'card is read-only');
  });
});

describe('storage warning', () => {
  it('warns when browser storage is nearly full', async () => {
    store.listSavePoints.mockResolvedValue(TWO_POINTS);
    store.estimateUsage.mockResolvedValue({ usage: 90, quota: 100, percent: 90 });
    render(HistoryTimeline);
    expect(await screen.findByText(/Browser storage is 90% full/)).toBeTruthy();
  });

  it('stays quiet when there is room', async () => {
    store.listSavePoints.mockResolvedValue(TWO_POINTS);
    store.estimateUsage.mockResolvedValue({ usage: 10, quota: 100, percent: 10 });
    render(HistoryTimeline);
    await screen.findByText('sp-2');
    expect(screen.queryByText(/Browser storage/)).toBeNull();
  });
});

describe('connecting the card', () => {
  beforeEach(() => {
    card.isLoaded = false;
    card.reconnect.mockResolvedValue(false);
  });

  it('offers to connect when no card is open', async () => {
    render(HistoryTimeline);
    expect(await screen.findByText('Connect card')).toBeTruthy();
  });

  it('opens the picker when asked', async () => {
    render(HistoryTimeline);
    await fireEvent.click(await screen.findByText('Connect card'));
    await waitFor(() => expect(card.pickDirectory).toHaveBeenCalled());
  });

  it('shows why the card could not be opened', async () => {
    card.pickDirectory.mockRejectedValueOnce(new Error('The user aborted a request.'));
    render(HistoryTimeline);
    await fireEvent.click(await screen.findByText('Connect card'));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'The user aborted a request.',
    );
  });

  it('names the card once it is open', async () => {
    card.isLoaded = true;
    render(HistoryTimeline);
    expect(await screen.findByText('card: DELUGE')).toBeTruthy();
  });
});

describe('comparing two chosen save points', () => {
  const THREE_POINTS = [
    savePoint(3, { 'SONGS/A.XML': 'newhash' }),
    savePoint(2, { 'SONGS/A.XML': 'midhash' }),
    savePoint(1, { 'SONGS/A.XML': 'oldhash' }),
  ];

  beforeEach(() => {
    store.listSavePoints.mockResolvedValue(THREE_POINTS);
  });

  it('compares against the one before by default', async () => {
    render(HistoryTimeline);
    expect(await screen.findByText('sp-2 → sp-3')).toBeTruthy();
  });

  it('compares against any save point that is picked', async () => {
    render(HistoryTimeline);
    await fireEvent.click((await screen.findAllByText('compare'))[2]);
    expect(await screen.findByText('sp-1 → sp-3')).toBeTruthy();
  });

  it('goes back to the default when the same one is picked again', async () => {
    render(HistoryTimeline);
    await fireEvent.click((await screen.findAllByText('compare'))[2]);
    await screen.findByText('sp-1 → sp-3');
    await fireEvent.click(await screen.findByText('comparing'));
    expect(await screen.findByText('sp-2 → sp-3')).toBeTruthy();
  });
});

describe('exporting', () => {
  beforeEach(() => {
    store.listSavePoints.mockResolvedValue(TWO_POINTS);
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:fake'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('downloads the save point as a JSON file', async () => {
    store.exportSavePoint.mockResolvedValue('{"id":2}');
    const click = vi.fn();
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag);
      if (tag === 'a') (el as HTMLAnchorElement).click = click;
      return el;
    });

    render(HistoryTimeline);
    await fireEvent.click((await screen.findAllByText('export'))[0]);

    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(store.exportSavePoint).toHaveBeenCalledWith(2);
    expect(trackToolAction).toHaveBeenCalledWith('history', 'export_save_point');
    vi.restoreAllMocks();
  });

  it('does nothing when the save point has already gone', async () => {
    store.exportSavePoint.mockResolvedValue(null);
    render(HistoryTimeline);
    await fireEvent.click((await screen.findAllByText('export'))[0]);
    await waitFor(() => expect(store.exportSavePoint).toHaveBeenCalled());
    expect(trackToolAction).not.toHaveBeenCalledWith('history', 'export_save_point');
  });
});

describe('storage size', () => {
  it('reports the usage in readable units', async () => {
    store.listSavePoints.mockResolvedValue(TWO_POINTS);
    store.estimateUsage.mockResolvedValue({
      usage: 5 * 1024 * 1024,
      quota: 6 * 1024 * 1024,
      percent: 83,
    });
    render(HistoryTimeline);
    expect(await screen.findByText(/5\.0 MB of 6\.0 MB/)).toBeTruthy();
  });
});

describe('edge cases', () => {
  it('carries on when the card handle cannot be reconnected', async () => {
    card.isLoaded = false;
    card.reconnect.mockRejectedValue(new Error('permission lost'));
    render(HistoryTimeline);
    expect(await screen.findByText('Connect card')).toBeTruthy();
  });

  it('counts what changed against the save point before, not the whole card', async () => {
    store.listSavePoints
      .mockResolvedValueOnce(TWO_POINTS)
      .mockResolvedValue([savePoint(3, { 'SONGS/A.XML': 'thirdhash' }), ...TWO_POINTS]);
    store.createSavePoint.mockResolvedValue(savePoint(3, { 'SONGS/A.XML': 'thirdhash' }));
    render(HistoryTimeline);
    await screen.findByText('sp-2');
    await fireEvent.click(screen.getByText('Take save point'));
    expect(await screen.findByText(/2 changed since the one before/)).toBeTruthy();
  });
});

describe('empty diffs', () => {
  it('says so when the kind filter leaves nothing', async () => {
    store.listSavePoints.mockResolvedValue(TWO_POINTS);
    render(HistoryTimeline);
    await fireEvent.click(await screen.findByText('Patches'));
    expect(await screen.findByText('Nothing changed between these two.')).toBeTruthy();
  });

  it('says nothing musical changed when only the view moved', async () => {
    store.getXml.mockImplementation(async (hash: string) =>
      hash === 'oldhash'
        ? '<song timePerTimerTick="525" timerTickFraction="0" xScroll="0"/>'
        : '<song timePerTimerTick="525" timerTickFraction="0" xScroll="48"/>',
    );
    store.listSavePoints.mockResolvedValue(TWO_POINTS);
    render(HistoryTimeline);
    await fireEvent.click(await screen.findByText('SONGS/A.XML'));
    expect(await screen.findByText('Nothing musical changed.')).toBeTruthy();
    expect(await screen.findByText(/1 view-only changes/)).toBeTruthy();
  });
});

describe('resetting the card', () => {
  beforeEach(() => {
    store.listSavePoints.mockResolvedValue(TWO_POINTS);
  });

  it('offers a reset once a card is open', async () => {
    render(HistoryTimeline);
    expect(await screen.findByText('Reset card')).toBeTruthy();
  });

  it('drops the current card and opens the picker, so another folder can be used', async () => {
    render(HistoryTimeline);
    await fireEvent.click(await screen.findByText('Reset card'));
    await waitFor(() => expect(card.reset).toHaveBeenCalled());
    expect(card.pickDirectory).toHaveBeenCalled();
  });

  it('names the newly chosen folder', async () => {
    card.pickDirectory.mockImplementation(async () => {
      card.rootHandle = { name: 'BACKUP-2025-12' };
      card.isLoaded = true;
    });
    render(HistoryTimeline);
    await fireEvent.click(await screen.findByText('Reset card'));
    expect(await screen.findByText('card: BACKUP-2025-12')).toBeTruthy();
  });

  it('drops back to disconnected, and says why, when the picker is dismissed', async () => {
    card.pickDirectory.mockRejectedValueOnce(new Error('The user aborted a request.'));
    render(HistoryTimeline);
    await fireEvent.click(await screen.findByText('Reset card'));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(await screen.findByText('Connect card')).toBeTruthy();
  });

  it('shows which card each save point came from', async () => {
    store.listSavePoints.mockResolvedValue([
      { ...savePoint(2, { 'SONGS/A.XML': 'newhash' }), cardName: 'BACKUP-2026-01' },
      { ...savePoint(1, { 'SONGS/A.XML': 'oldhash' }), cardName: 'BACKUP-2025-12' },
    ]);
    render(HistoryTimeline);
    expect(await screen.findByText(/BACKUP-2026-01/)).toBeTruthy();
    expect(await screen.findByText(/BACKUP-2025-12/)).toBeTruthy();
  });

  it('warns when the two sides came from different folders', async () => {
    store.listSavePoints.mockResolvedValue([
      { ...savePoint(2, { 'SONGS/A.XML': 'newhash' }), cardName: 'BACKUP-2026-01' },
      { ...savePoint(1, { 'SONGS/A.XML': 'oldhash' }), cardName: 'BACKUP-2025-12' },
    ]);
    render(HistoryTimeline);
    expect(
      await screen.findByText(/different cards: BACKUP-2025-12 → BACKUP-2026-01/),
    ).toBeTruthy();
  });

  it('says nothing about cards when both sides match', async () => {
    render(HistoryTimeline);
    await screen.findByText('sp-1 → sp-2');
    expect(screen.queryByText(/different cards/)).toBeNull();
  });
});
