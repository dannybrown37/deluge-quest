import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { historyVault, BLOBS_DIR, SAVE_POINTS_DIR } from './historyVault';
import type { SavePoint } from './historyStore';

class FakeFile {
  constructor(private data: string) {}
  async text(): Promise<string> {
    return this.data;
  }
}

class FakeWritable {
  private pending = '';
  constructor(private handle: FakeFileHandle) {}
  async write(data: string): Promise<void> {
    this.pending = data;
  }
  async close(): Promise<void> {
    this.handle.content = this.pending;
  }
}

class FakeFileHandle {
  kind = 'file' as const;
  constructor(
    public name: string,
    public content = '',
  ) {}
  async getFile() {
    return new FakeFile(this.content) as unknown as File;
  }
  async createWritable() {
    return new FakeWritable(this) as unknown as FileSystemWritableFileStream;
  }
}

class FakeDirHandle {
  kind = 'directory' as const;
  children = new Map<string, FakeDirHandle | FakeFileHandle>();
  constructor(public name = 'VAULT') {}

  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    let child = this.children.get(name);
    if (!child) {
      if (!opts?.create) throw new Error(`NotFoundError: ${name}`);
      child = new FakeDirHandle(name);
      this.children.set(name, child);
    }
    return child as unknown as FileSystemDirectoryHandle;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }) {
    let child = this.children.get(name);
    if (!child) {
      if (!opts?.create) throw new Error(`NotFoundError: ${name}`);
      child = new FakeFileHandle(name);
      this.children.set(name, child);
    }
    return child as unknown as FileSystemFileHandle;
  }

  async removeEntry(name: string) {
    if (!this.children.has(name)) throw new Error(`NotFoundError: ${name}`);
    this.children.delete(name);
  }

  async *values() {
    for (const child of this.children.values()) yield child;
  }

  async queryPermission() {
    return 'granted';
  }
  async requestPermission() {
    return 'granted';
  }
}

/**
 * By-reference IndexedDB stand-in. fake-indexeddb structured-clones what it stores, which
 * strips a directory handle's queryPermission/requestPermission methods — real Chromium keeps
 * the live object. Same reason cardStore.test.ts hand-rolls its own fake.
 */
class FakeRequest {
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  result: unknown = undefined;
}

function makeFakeIndexedDb(store: Map<string, unknown>) {
  return {
    open: () => {
      const req = new FakeRequest() as FakeRequest & { onupgradeneeded: (() => void) | null };
      req.onupgradeneeded = null;
      req.result = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => undefined,
        close: () => undefined,
        transaction: () => {
          const tx: { oncomplete: (() => void) | null; onerror: (() => void) | null; objectStore: () => unknown } = {
            oncomplete: null,
            onerror: null,
            objectStore: () => ({
              get: (key: string) => {
                const r = new FakeRequest();
                r.result = store.get(key);
                queueMicrotask(() => {
                  r.onsuccess?.();
                  tx.oncomplete?.();
                });
                return r;
              },
              put: (value: unknown, key: string) => {
                store.set(key, value);
                queueMicrotask(() => tx.oncomplete?.());
                return new FakeRequest();
              },
              delete: (key: string) => {
                store.delete(key);
                queueMicrotask(() => tx.oncomplete?.());
                return new FakeRequest();
              },
            }),
          };
          return tx;
        },
      };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  };
}

function draft(files: Record<string, string>, label = 'sp'): Omit<SavePoint, 'id'> {
  return {
    cardName: 'DELUGE',
    takenAt: Date.now(),
    label,
    entries: Object.entries(files).map(([path, hash]) => ({
      path,
      kind: 'song' as const,
      hash,
      size: 10,
    })),
  };
}

function blobs(map: Record<string, string>) {
  return new Map(Object.entries(map).map(([hash, xml]) => [hash, { xml, size: xml.length }]));
}

function filesIn(root: FakeDirHandle, dirName: string): string[] {
  const dir = root.children.get(dirName) as FakeDirHandle | undefined;
  return dir ? [...dir.children.keys()].sort() : [];
}

let root: FakeDirHandle;
let persisted: Map<string, unknown>;

beforeEach(async () => {
  root = new FakeDirHandle('MY-HISTORY');
  persisted = new Map();
  vi.stubGlobal('indexedDB', makeFakeIndexedDb(persisted));
  historyVault.handle = root as unknown as FileSystemDirectoryHandle;
});

afterEach(async () => {
  historyVault.handle = null;
  await historyVault.forget();
  vi.unstubAllGlobals();
});

describe('connecting', () => {
  it('is not connected until a folder is picked', () => {
    historyVault.handle = null;
    expect(historyVault.isConnected).toBe(false);
    expect(historyVault.name).toBe('');
  });

  it('names the folder once connected', () => {
    expect(historyVault.isConnected).toBe(true);
    expect(historyVault.name).toBe('MY-HISTORY');
  });

  it('opens the picker and remembers the choice', async () => {
    historyVault.handle = null;
    const picked = new FakeDirHandle('PICKED');
    vi.stubGlobal('window', { showDirectoryPicker: vi.fn().mockResolvedValue(picked) });
    expect(await historyVault.pick()).toBe(true);
    expect(historyVault.name).toBe('PICKED');
    expect(await historyVault.hasRemembered()).toBe(true);
  });

  it('reconnects the remembered folder', async () => {
    const picked = new FakeDirHandle('PICKED');
    vi.stubGlobal('window', { showDirectoryPicker: vi.fn().mockResolvedValue(picked) });
    await historyVault.pick();
    historyVault.handle = null;
    expect(await historyVault.reconnect()).toBe(true);
    expect(historyVault.name).toBe('PICKED');
  });

  it('does not reconnect when nothing was remembered', async () => {
    await historyVault.forget();
    historyVault.handle = null;
    expect(await historyVault.reconnect()).toBe(false);
  });

  it('does not reconnect when permission has lapsed', async () => {
    const picked = new FakeDirHandle('PICKED');
    picked.queryPermission = async () => 'prompt';
    vi.stubGlobal('window', { showDirectoryPicker: vi.fn().mockResolvedValue(picked) });
    await historyVault.pick();
    historyVault.handle = null;
    expect(await historyVault.reconnect()).toBe(false);
  });

  it('asks for permission when told to prompt', async () => {
    const picked = new FakeDirHandle('PICKED');
    picked.queryPermission = async () => 'prompt';
    const request = vi.fn().mockResolvedValue('granted');
    picked.requestPermission = request;
    vi.stubGlobal('window', { showDirectoryPicker: vi.fn().mockResolvedValue(picked) });
    await historyVault.pick();
    historyVault.handle = null;
    expect(await historyVault.reconnect(true)).toBe(true);
    expect(request).toHaveBeenCalled();
  });

  it('forgets the folder without touching what is in it', async () => {
    await historyVault.writeSavePoint(draft({ 'SONGS/A.XML': 'aaa' }), blobs({ aaa: '<song/>' }));
    await historyVault.forget();
    expect(historyVault.isConnected).toBe(false);
    expect(filesIn(root, BLOBS_DIR)).toEqual(['aaa.xml']);
  });

  it('refuses to work with no folder connected', async () => {
    historyVault.handle = null;
    await expect(historyVault.listSavePoints()).rejects.toThrow(/No save point folder/);
  });
});

describe('writing save points', () => {
  it('writes one json file per save point and one xml per blob', async () => {
    await historyVault.writeSavePoint(
      draft({ 'SONGS/A.XML': 'aaa', 'KITS/K.XML': 'bbb' }),
      blobs({ aaa: '<song/>', bbb: '<kit/>' }),
    );
    expect(filesIn(root, SAVE_POINTS_DIR)).toEqual(['0001.json']);
    expect(filesIn(root, BLOBS_DIR)).toEqual(['aaa.xml', 'bbb.xml']);
  });

  it('pads the file name so the folder sorts like the timeline', async () => {
    await historyVault.writeSavePoint(draft({}), blobs({}));
    expect(filesIn(root, SAVE_POINTS_DIR)).toEqual(['0001.json']);
  });

  it('gives each save point the next id', async () => {
    const first = await historyVault.writeSavePoint(draft({}), blobs({}));
    const second = await historyVault.writeSavePoint(draft({}), blobs({}));
    expect([first.id, second.id]).toEqual([1, 2]);
  });

  it('never reuses an id after a delete', async () => {
    await historyVault.writeSavePoint(draft({}), blobs({}));
    const second = await historyVault.writeSavePoint(draft({}), blobs({}));
    await historyVault.deleteSavePoint(second.id);
    const third = await historyVault.writeSavePoint(draft({}), blobs({}));
    expect(third.id).toBe(3);
  });

  it('picks up where a hand-made folder left off when meta.json is missing', async () => {
    const dir = (await root.getDirectoryHandle(SAVE_POINTS_DIR, {
      create: true,
    })) as unknown as FakeDirHandle;
    dir.children.set('0009.json', new FakeFileHandle('0009.json', '{"id":9,"entries":[]}'));
    const next = await historyVault.writeSavePoint(draft({}), blobs({}));
    expect(next.id).toBe(10);
  });

  it('ignores an unreadable meta.json rather than failing the save', async () => {
    root.children.set('meta.json', new FakeFileHandle('meta.json', 'not json'));
    const savePoint = await historyVault.writeSavePoint(draft({}), blobs({}));
    expect(savePoint.id).toBe(1);
  });

  it('writes readable json, so the folder is useful without this site', async () => {
    await historyVault.writeSavePoint(draft({ 'SONGS/A.XML': 'aaa' }, 'before the gig'), blobs({}));
    const dir = root.children.get(SAVE_POINTS_DIR) as FakeDirHandle;
    const file = dir.children.get('0001.json') as FakeFileHandle;
    expect(file.content).toContain('\n');
    expect(JSON.parse(file.content).label).toBe('before the gig');
  });

  it('does not rewrite a blob that is already there', async () => {
    await historyVault.writeSavePoint(draft({ 'SONGS/A.XML': 'aaa' }), blobs({ aaa: '<v1/>' }));
    await historyVault.writeSavePoint(draft({ 'SONGS/A.XML': 'aaa' }), blobs({ aaa: '<v2/>' }));
    expect(await historyVault.readBlob('aaa')).toBe('<v1/>');
    expect(await historyVault.blobCount()).toBe(1);
  });
});

describe('reading save points', () => {
  it('is empty for a fresh folder', async () => {
    expect(await historyVault.listSavePoints()).toEqual([]);
  });

  it('reads back what it wrote, newest first', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(2000);
    const first = await historyVault.writeSavePoint(draft({}, 'older'), blobs({}));
    const second = await historyVault.writeSavePoint(draft({}, 'newer'), blobs({}));
    vi.restoreAllMocks();
    const list = await historyVault.listSavePoints();
    expect(list.map((s) => s.id)).toEqual([second.id, first.id]);
    expect(list[0].label).toBe('newer');
  });

  it('keeps entries intact through the round trip', async () => {
    await historyVault.writeSavePoint(draft({ 'SONGS/A.XML': 'aaa' }), blobs({ aaa: '<song/>' }));
    const [savePoint] = await historyVault.listSavePoints();
    expect(savePoint.entries).toEqual([
      { path: 'SONGS/A.XML', kind: 'song', hash: 'aaa', size: 10 },
    ]);
  });

  it('skips files it did not write instead of failing the whole list', async () => {
    await historyVault.writeSavePoint(draft({}), blobs({}));
    const dir = root.children.get(SAVE_POINTS_DIR) as FakeDirHandle;
    dir.children.set('notes.txt', new FakeFileHandle('notes.txt', 'hello'));
    dir.children.set('broken.json', new FakeFileHandle('broken.json', '{ not json'));
    dir.children.set('other.json', new FakeFileHandle('other.json', '{"unrelated":true}'));
    expect(await historyVault.listSavePoints()).toHaveLength(1);
  });

  it('returns null for a blob that is not there', async () => {
    expect(await historyVault.readBlob('missing')).toBeNull();
  });
});

describe('deleting', () => {
  it('removes the save point file', async () => {
    const savePoint = await historyVault.writeSavePoint(draft({}), blobs({}));
    await historyVault.deleteSavePoint(savePoint.id);
    expect(filesIn(root, SAVE_POINTS_DIR)).toEqual([]);
  });

  it('collects blobs nothing points at any more', async () => {
    const savePoint = await historyVault.writeSavePoint(
      draft({ 'SONGS/A.XML': 'aaa' }),
      blobs({ aaa: '<song/>' }),
    );
    await historyVault.deleteSavePoint(savePoint.id);
    expect(await historyVault.blobCount()).toBe(0);
  });

  it('keeps blobs another save point still points at', async () => {
    const first = await historyVault.writeSavePoint(
      draft({ 'SONGS/A.XML': 'aaa' }),
      blobs({ aaa: '<song/>' }),
    );
    await historyVault.writeSavePoint(draft({ 'SONGS/A.XML': 'aaa' }), blobs({ aaa: '<song/>' }));
    await historyVault.deleteSavePoint(first.id);
    expect(await historyVault.blobCount()).toBe(1);
  });

  it('does nothing for an id that is not there', async () => {
    await historyVault.writeSavePoint(draft({ 'SONGS/A.XML': 'aaa' }), blobs({ aaa: '<song/>' }));
    await historyVault.deleteSavePoint(999);
    expect(await historyVault.listSavePoints()).toHaveLength(1);
    expect(await historyVault.blobCount()).toBe(1);
  });

  it('clear empties both folders but leaves the folder itself', async () => {
    await historyVault.writeSavePoint(draft({ 'SONGS/A.XML': 'aaa' }), blobs({ aaa: '<song/>' }));
    await historyVault.clear();
    expect(await historyVault.listSavePoints()).toEqual([]);
    expect(await historyVault.blobCount()).toBe(0);
    expect(root.children.has(SAVE_POINTS_DIR)).toBe(true);
  });
});
