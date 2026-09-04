import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  historyStore,
  hashXml,
  classifyPath,
  MAX_SAVE_POINTS,
  type CardSource,
} from './historyStore';
import { historyVault } from './historyVault';

function source(
  songs: Record<string, string> = {},
  presets: Record<string, string> = {},
  cardName = 'DELUGE',
): CardSource {
  return {
    cardName,
    songXmls: new Map(Object.entries(songs)),
    presetIndex: new Map(Object.entries(presets)),
  };
}

const SONG_A = '<song><bpm>120</bpm></song>';
const SONG_B = '<song><bpm>132</bpm></song>';

beforeEach(async () => {
  await historyStore.clear();
});

describe('classifyPath', () => {
  it.each([
    ['SONGS/ACID2.XML', 'song'],
    ['songs/nested/ACID2.xml', 'song'],
    ['KITS/BREAKS.XML', 'kit'],
    ['SYNTHS/PAD03.XML', 'patch'],
    ['SAMPLES/kick.wav', null],
    ['SONGS/README.txt', null],
    ['ACID2.XML', null],
    ['SOFT_DELETE/SONGS/ACID2.XML', null],
    ['HISTORY_BACKUP/SONGS/ACID2.XML', null],
  ])('%s -> %s', (path, kind) => {
    expect(classifyPath(path)).toBe(kind);
  });
});

describe('hashXml', () => {
  it('is stable for the same content', async () => {
    expect(await hashXml(SONG_A)).toBe(await hashXml(SONG_A));
  });

  it('differs for different content', async () => {
    expect(await hashXml(SONG_A)).not.toBe(await hashXml(SONG_B));
  });

  it('is 16 hex characters', async () => {
    expect(await hashXml(SONG_A)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('createSavePoint', () => {
  it('records songs, kits and patches with their kinds', async () => {
    const sp = await historyStore.createSavePoint(
      source({ 'SONGS/A.XML': SONG_A }, { 'KITS/K.XML': '<kit/>', 'SYNTHS/S.XML': '<sound/>' }),
    );
    expect(sp.entries.map((e) => e.kind).sort()).toEqual(['kit', 'patch', 'song']);
    expect(sp.cardName).toBe('DELUGE');
    expect(sp.id).toBeGreaterThan(0);
  });

  it('ignores files that are not songs, kits or patches', async () => {
    const sp = await historyStore.createSavePoint(source({}, { 'SAMPLES/k.wav': 'x' }));
    expect(sp.entries).toEqual([]);
  });

  it('sorts entries by path', async () => {
    const sp = await historyStore.createSavePoint(
      source({ 'SONGS/B.XML': SONG_B, 'SONGS/A.XML': SONG_A }),
    );
    expect(sp.entries.map((e) => e.path)).toEqual(['SONGS/A.XML', 'SONGS/B.XML']);
  });

  it('uses the given label', async () => {
    const named = await historyStore.createSavePoint(source(), 'before the gig');
    expect(named.label).toBe('before the gig');
  });

  it('falls back to the date and time taken', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 8, 4, 16, 4).getTime());
    const unnamed = await historyStore.createSavePoint(source());
    vi.restoreAllMocks();
    expect(unnamed.label).toBe('2026-09-04 16:04');
  });

  it('records byte size per entry', async () => {
    const sp = await historyStore.createSavePoint(source({ 'SONGS/A.XML': SONG_A }));
    expect(sp.entries[0].size).toBe(SONG_A.length);
  });
});

describe('content addressing', () => {
  it('stores one blob when two files share content', async () => {
    await historyStore.createSavePoint(
      source({ 'SONGS/A.XML': SONG_A, 'SONGS/COPY.XML': SONG_A }),
    );
    expect(await historyStore.blobCount()).toBe(1);
  });

  it('adds no blobs when nothing changed between save points', async () => {
    await historyStore.createSavePoint(source({ 'SONGS/A.XML': SONG_A }));
    const before = await historyStore.blobCount();
    await historyStore.createSavePoint(source({ 'SONGS/A.XML': SONG_A }));
    expect(await historyStore.blobCount()).toBe(before);
  });

  it('adds one blob when one file changed', async () => {
    await historyStore.createSavePoint(source({ 'SONGS/A.XML': SONG_A }));
    await historyStore.createSavePoint(source({ 'SONGS/A.XML': SONG_B }));
    expect(await historyStore.blobCount()).toBe(2);
  });

  it('keeps every save point complete, so old content is still readable', async () => {
    const first = await historyStore.createSavePoint(source({ 'SONGS/A.XML': SONG_A }));
    await historyStore.createSavePoint(source({ 'SONGS/A.XML': SONG_B }));
    expect(await historyStore.getXml(first.entries[0].hash)).toBe(SONG_A);
  });

  it('returns null for an unknown hash', async () => {
    expect(await historyStore.getXml('deadbeefdeadbeef')).toBeNull();
  });
});

describe('listSavePoints', () => {
  it('is empty to start', async () => {
    expect(await historyStore.listSavePoints()).toEqual([]);
  });

  it('returns newest first', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(2000);
    const a = await historyStore.createSavePoint(source());
    const b = await historyStore.createSavePoint(source());
    vi.restoreAllMocks();
    expect((await historyStore.listSavePoints()).map((s) => s.id)).toEqual([b.id, a.id]);
  });
});

describe('deleteSavePoint', () => {
  it('removes the save point', async () => {
    const sp = await historyStore.createSavePoint(source({ 'SONGS/A.XML': SONG_A }));
    await historyStore.deleteSavePoint(sp.id);
    expect(await historyStore.listSavePoints()).toEqual([]);
  });

  it('collects blobs nothing points at any more', async () => {
    const sp = await historyStore.createSavePoint(source({ 'SONGS/A.XML': SONG_A }));
    await historyStore.deleteSavePoint(sp.id);
    expect(await historyStore.blobCount()).toBe(0);
  });

  it('keeps blobs another save point still points at', async () => {
    const first = await historyStore.createSavePoint(source({ 'SONGS/A.XML': SONG_A }));
    await historyStore.createSavePoint(source({ 'SONGS/A.XML': SONG_A }));
    await historyStore.deleteSavePoint(first.id);
    expect(await historyStore.blobCount()).toBe(1);
  });

  it('does nothing for an unknown id', async () => {
    await historyStore.createSavePoint(source({ 'SONGS/A.XML': SONG_A }));
    await historyStore.deleteSavePoint(9999);
    expect(await historyStore.listSavePoints()).toHaveLength(1);
  });
});

describe('pruning', () => {
  it('keeps at most MAX_SAVE_POINTS, dropping the oldest', async () => {
    for (let i = 0; i < MAX_SAVE_POINTS + 3; i++) {
      await historyStore.createSavePoint(source({ 'SONGS/A.XML': `<song>${i}</song>` }), `sp-${i}`);
    }
    const list = await historyStore.listSavePoints();
    expect(list).toHaveLength(MAX_SAVE_POINTS);
    expect(list[0].label).toBe(`sp-${MAX_SAVE_POINTS + 2}`);
    expect(list[list.length - 1].label).toBe('sp-3');
  });

  it('collects the blobs of pruned save points', async () => {
    for (let i = 0; i < MAX_SAVE_POINTS + 3; i++) {
      await historyStore.createSavePoint(source({ 'SONGS/A.XML': `<song>${i}</song>` }));
    }
    expect(await historyStore.blobCount()).toBe(MAX_SAVE_POINTS);
  });
});

describe('exportSavePoint', () => {
  it('bundles the save point with every file it holds', async () => {
    const sp = await historyStore.createSavePoint(source({ 'SONGS/A.XML': SONG_A }), 'gig');
    const json = JSON.parse((await historyStore.exportSavePoint(sp.id))!);
    expect(json.label).toBe('gig');
    expect(json.cardName).toBe('DELUGE');
    expect(json.files['SONGS/A.XML']).toBe(SONG_A);
  });

  it('returns null for an unknown id', async () => {
    expect(await historyStore.exportSavePoint(9999)).toBeNull();
  });
});

describe('estimateUsage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports usage as a percentage of quota', async () => {
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ usage: 25, quota: 100 }) } });
    expect(await historyStore.estimateUsage()).toEqual({ usage: 25, quota: 100, percent: 25 });
  });

  it('returns null when the browser cannot estimate', async () => {
    vi.stubGlobal('navigator', {});
    expect(await historyStore.estimateUsage()).toBeNull();
  });

  it('returns null when the estimate call fails', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        estimate: async () => {
          throw new Error('denied');
        },
      },
    });
    expect(await historyStore.estimateUsage()).toBeNull();
  });

  it('returns null when quota is zero', async () => {
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ usage: 0, quota: 0 }) } });
    expect(await historyStore.estimateUsage()).toBeNull();
  });
});

describe('when IndexedDB is unavailable', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports empty rather than throwing', async () => {
    vi.stubGlobal('indexedDB', undefined);
    expect(await historyStore.listSavePoints()).toEqual([]);
    expect(await historyStore.getXml('abc')).toBeNull();
    expect(await historyStore.blobCount()).toBe(0);
    expect(await historyStore.exportSavePoint(1)).toBeNull();
    await expect(historyStore.deleteSavePoint(1)).resolves.toBeUndefined();
    await expect(historyStore.clear()).resolves.toBeUndefined();
  });

  it('falls back when a read fails after the database opened', async () => {
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => {
      throw new Error('store missing');
    });
    expect(await historyStore.listSavePoints()).toEqual([]);
    vi.restoreAllMocks();
  });

  it('throws on save, because a save that stored nothing must not look like success', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(historyStore.createSavePoint(source())).rejects.toThrow(/storage/i);
  });
});

describe('with a save point folder connected', () => {
  class FakeFileHandle {
    kind = 'file' as const;
    constructor(
      public name: string,
      public content = '',
    ) {}
    async getFile() {
      return { text: async () => this.content } as unknown as File;
    }
    async createWritable() {
      let pending = '';
      return {
        write: async (data: string) => {
          pending = data;
        },
        close: async () => {
          this.content = pending;
        },
      } as unknown as FileSystemWritableFileStream;
    }
  }

  class FakeDirHandle {
    kind = 'directory' as const;
    children = new Map<string, FakeDirHandle | FakeFileHandle>();
    constructor(public name = 'MY-HISTORY') {}
    async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
      let child = this.children.get(name);
      if (!child) {
        if (!opts?.create) throw new Error('NotFoundError');
        child = new FakeDirHandle(name);
        this.children.set(name, child);
      }
      return child as unknown as FileSystemDirectoryHandle;
    }
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      let child = this.children.get(name);
      if (!child) {
        if (!opts?.create) throw new Error('NotFoundError');
        child = new FakeFileHandle(name);
        this.children.set(name, child);
      }
      return child as unknown as FileSystemFileHandle;
    }
    async removeEntry(name: string) {
      if (!this.children.has(name)) throw new Error('NotFoundError');
      this.children.delete(name);
    }
    async *values() {
      for (const child of this.children.values()) yield child;
    }
  }

  let vaultRoot: FakeDirHandle;

  beforeEach(() => {
    vaultRoot = new FakeDirHandle();
    historyVault.handle = vaultRoot as unknown as FileSystemDirectoryHandle;
  });

  afterEach(() => {
    historyVault.handle = null;
  });

  it('reports which home is in use', async () => {
    expect(historyStore.backend).toBe('vault');
    historyVault.handle = null;
    expect(historyStore.backend).toBe('browser');
  });

  it('writes save points to the folder, not to browser storage', async () => {
    await historyStore.createSavePoint(source({ 'SONGS/A.XML': SONG_A }));
    expect(await historyStore.listSavePoints()).toHaveLength(1);
    expect(await historyStore.browserSavePointCount()).toBe(0);
  });

  it('reads blobs back out of the folder', async () => {
    const sp = await historyStore.createSavePoint(source({ 'SONGS/A.XML': SONG_A }));
    expect(await historyStore.getXml(sp.entries[0].hash)).toBe(SONG_A);
  });

  it('still shares content between save points', async () => {
    await historyStore.createSavePoint(source({ 'SONGS/A.XML': SONG_A }));
    await historyStore.createSavePoint(source({ 'SONGS/A.XML': SONG_A }));
    expect(await historyStore.blobCount()).toBe(1);
  });

  it('deletes from the folder', async () => {
    const sp = await historyStore.createSavePoint(source({ 'SONGS/A.XML': SONG_A }));
    await historyStore.deleteSavePoint(sp.id);
    expect(await historyStore.listSavePoints()).toEqual([]);
  });

  it('exports from the folder', async () => {
    const sp = await historyStore.createSavePoint(source({ 'SONGS/A.XML': SONG_A }), 'gig');
    const json = JSON.parse((await historyStore.exportSavePoint(sp.id))!);
    expect(json.files['SONGS/A.XML']).toBe(SONG_A);
  });

  it('returns null exporting a save point the folder does not hold', async () => {
    expect(await historyStore.exportSavePoint(999)).toBeNull();
  });

  it('reports no quota, because a folder on disk has none', async () => {
    expect(await historyStore.estimateUsage()).toBeNull();
  });

  it('clears the folder', async () => {
    await historyStore.createSavePoint(source({ 'SONGS/A.XML': SONG_A }));
    await historyStore.clear();
    expect(await historyStore.listSavePoints()).toEqual([]);
  });
});

describe('moving browser save points into a folder', () => {
  class FakeDir {
    kind = 'directory' as const;
    children = new Map<string, FakeDir | { name: string; content: string; kind: 'file' }>();
    constructor(public name = 'MY-HISTORY') {}
    async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
      let child = this.children.get(name);
      if (!child) {
        if (!opts?.create) throw new Error('NotFoundError');
        child = new FakeDir(name);
        this.children.set(name, child);
      }
      return child as unknown as FileSystemDirectoryHandle;
    }
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      let child = this.children.get(name) as { name: string; content: string; kind: 'file' };
      if (!child) {
        if (!opts?.create) throw new Error('NotFoundError');
        child = { name, content: '', kind: 'file' };
        this.children.set(name, child);
      }
      return {
        getFile: async () => ({ text: async () => child.content }),
        createWritable: async () => {
          let pending = '';
          return {
            write: async (d: string) => {
              pending = d;
            },
            close: async () => {
              child.content = pending;
            },
          };
        },
      } as unknown as FileSystemFileHandle;
    }
    async removeEntry(name: string) {
      this.children.delete(name);
    }
    async *values() {
      for (const child of this.children.values()) yield child;
    }
  }

  afterEach(() => {
    historyVault.handle = null;
  });

  it('copies every browser save point across, oldest first', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(2000);
    await historyStore.createSavePoint(source({ 'SONGS/A.XML': SONG_A }), 'older');
    await historyStore.createSavePoint(source({ 'SONGS/A.XML': SONG_B }), 'newer');
    vi.restoreAllMocks();

    historyVault.handle = new FakeDir() as unknown as FileSystemDirectoryHandle;
    expect(await historyStore.migrateToVault()).toEqual({ moved: 2, skipped: 0 });

    const moved = await historyStore.listSavePoints();
    expect(moved.map((s) => s.label)).toEqual(['newer', 'older']);
    expect(await historyStore.getXml(moved[1].entries[0].hash)).toBe(SONG_A);
  });

  it('leaves the browser copies alone, so nothing is lost if the folder goes away', async () => {
    await historyStore.createSavePoint(source({ 'SONGS/A.XML': SONG_A }));
    historyVault.handle = new FakeDir() as unknown as FileSystemDirectoryHandle;
    await historyStore.migrateToVault();
    historyVault.handle = null;
    expect(await historyStore.listSavePoints()).toHaveLength(1);
  });

  it('refuses when no folder is connected', async () => {
    await expect(historyStore.migrateToVault()).rejects.toThrow(/No save point folder/);
  });

  it('does nothing when browser storage is empty', async () => {
    historyVault.handle = new FakeDir() as unknown as FileSystemDirectoryHandle;
    expect(await historyStore.migrateToVault()).toEqual({ moved: 0, skipped: 0 });
  });
});
