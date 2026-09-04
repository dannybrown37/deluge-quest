import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  cardStore,
  walkHandle,
  ext,
  topDir,
  basename,
  normalizePath,
  songHasArrangement,
} from './cardStore';

// Minimal in-memory IndexedDB fake. openIdb() in cardStore.ts only ever needs
// open -> transaction -> objectStore.{put,get,delete} -> oncomplete, so we
// implement that surface directly rather than pulling in a full IDB polyfill.
// Storing by reference (not structured-clone) also matches real Chromium
// behavior for FileSystemHandle values, which our fake handles stand in for.
class FakeIDBRequest {
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  result: unknown = undefined;
}

class FakeIDBTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(private store: Map<string, unknown>) {}

  objectStore() {
    const store = this.store;
    const fireComplete = () => queueMicrotask(() => this.oncomplete?.());
    return {
      put: (value: unknown, key: string) => {
        const req = new FakeIDBRequest();
        store.set(key, value);
        queueMicrotask(() => {
          req.onsuccess?.();
          fireComplete();
        });
        return req;
      },
      get: (key: string) => {
        const req = new FakeIDBRequest();
        queueMicrotask(() => {
          req.result = store.get(key);
          req.onsuccess?.();
          fireComplete();
        });
        return req;
      },
      delete: (key: string) => {
        const req = new FakeIDBRequest();
        store.delete(key);
        queueMicrotask(() => {
          req.onsuccess?.();
          fireComplete();
        });
        return req;
      },
    };
  }
}

class FakeIDBDatabase {
  stores = new Map<string, Map<string, unknown>>();
  objectStoreNames = { contains: (name: string) => this.stores.has(name) };
  createObjectStore(name: string) {
    this.stores.set(name, new Map());
  }
  transaction(name: string) {
    let store = this.stores.get(name);
    if (!store) {
      store = new Map();
      this.stores.set(name, store);
    }
    return new FakeIDBTransaction(store);
  }
  close() {}
}

class FakeIDBFactory {
  private dbs = new Map<string, FakeIDBDatabase>();
  open(name: string) {
    const req: {
      onupgradeneeded: (() => void) | null;
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
      result: FakeIDBDatabase | null;
    } = { onupgradeneeded: null, onsuccess: null, onerror: null, result: null };
    queueMicrotask(() => {
      let db = this.dbs.get(name);
      const isNew = !db;
      if (!db) {
        db = new FakeIDBDatabase();
        this.dbs.set(name, db);
      }
      req.result = db;
      if (isNew) req.onupgradeneeded?.();
      req.onsuccess?.();
    });
    return req;
  }
}

class FakeFileEntry {
  kind = 'file' as const;
  constructor(
    public name: string,
    private content: string,
    public lastModified = 1700000000000,
  ) {}
  async getFile() {
    const content = this.content;
    const lastModified = this.lastModified;
    return {
      text: async () => content,
      arrayBuffer: async () => new TextEncoder().encode(content).buffer,
      size: content.length,
      lastModified,
    } as unknown as File;
  }
}

class FakeDirEntry {
  kind = 'directory' as const;
  children = new Map<string, FakeDirEntry | FakeFileEntry>();
  permission: 'granted' | 'denied' = 'granted';
  constructor(public name: string) {}

  addFile(name: string, content: string): FakeFileEntry {
    const f = new FakeFileEntry(name, content);
    this.children.set(name, f);
    return f;
  }

  addDir(name: string): FakeDirEntry {
    const d = new FakeDirEntry(name);
    this.children.set(name, d);
    return d;
  }

  async *values() {
    for (const child of this.children.values()) yield child;
  }

  async requestPermission() {
    return this.permission;
  }

  async queryPermission() {
    return this.permission;
  }
}

function buildTree(files: Record<string, string>): FakeDirEntry {
  const root = new FakeDirEntry('CARD');
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/');
    const fileName = parts.pop()!;
    let dir = root;
    for (const part of parts) {
      const existing = dir.children.get(part);
      dir = existing instanceof FakeDirEntry ? existing : dir.addDir(part);
    }
    dir.addFile(fileName, content);
  }
  return root;
}

const ARRANGEMENT_XML = `<song clipInstances="0x${'a'.repeat(24)}"></song>`;
const SESSION_XML = `<song clipInstances=""></song>`;

beforeEach(() => {
  (globalThis as unknown as { indexedDB: FakeIDBFactory }).indexedDB = new FakeIDBFactory();
  cardStore.reset();
});

afterEach(() => {
  cardStore.reset();
});

describe('pure path helpers', () => {
  it.each([
    ['song.xml', 'xml'],
    ['SAMPLES/kick.WAV', 'wav'],
    ['noext', ''],
    ['a.b.c', 'c'],
  ])('ext(%s) === %s', (name, expected) => {
    expect(ext(name)).toBe(expected);
  });

  it.each([
    ['SAMPLES/DRUMS/kick.wav', 'SAMPLES'],
    ['song.xml', 'song.xml'],
  ])('topDir(%s) === %s', (path, expected) => {
    expect(topDir(path)).toBe(expected);
  });

  it.each([
    ['SAMPLES/DRUMS/kick.wav', 'kick.wav'],
    ['song.xml', 'song.xml'],
  ])('basename(%s) === %s', (path, expected) => {
    expect(basename(path)).toBe(expected);
  });

  it.each([
    ['/SAMPLES/Kick.wav', 'samples/kick.wav'],
    ['SAMPLES/Kick.wav', 'samples/kick.wav'],
  ])('normalizePath(%s) === %s', (path, expected) => {
    expect(normalizePath(path)).toBe(expected);
  });

  it.each([
    [ARRANGEMENT_XML, true],
    [SESSION_XML, false],
    ['<song></song>', false],
  ])('songHasArrangement detects clipInstances payload', (xml, expected) => {
    expect(songHasArrangement(xml)).toBe(expected);
  });
});

describe('walkHandle', () => {
  it('flattens nested directories into path/handle pairs', async () => {
    const root = buildTree({
      'SONGS/one.xml': 'a',
      'SAMPLES/DRUMS/kick.wav': 'b',
    });
    const out: { path: string; handle: FileSystemFileHandle }[] = [];
    await walkHandle(root as unknown as FileSystemDirectoryHandle, '', out);
    const paths = out.map((o) => o.path).sort();
    expect(paths).toEqual(['SAMPLES/DRUMS/kick.wav', 'SONGS/one.xml']);
  });

  it('skips app-managed directories', async () => {
    const root = buildTree({
      'SONGS/one.xml': 'a',
      'SOFT_DELETE/deleted.xml': 'b',
      'MOVE_BACKUP/x.xml': 'c',
      'REPAIR_BACKUP/y.xml': 'd',
      'HISTORY_BACKUP/SONGS/old.xml': 'e',
    });
    const out: { path: string; handle: FileSystemFileHandle }[] = [];
    await walkHandle(root as unknown as FileSystemDirectoryHandle, '', out);
    expect(out.map((o) => o.path)).toEqual(['SONGS/one.xml']);
  });
});

describe('cardStore.adoptHandle indexing', () => {
  it('indexes SONGS, KITS/SYNTHS, and SAMPLES into their respective maps', async () => {
    const root = buildTree({
      'SONGS/track1.xml': ARRANGEMENT_XML,
      'KITS/KIT001.XML': '<kit/>',
      'SYNTHS/SYNT001.XML': '<synth/>',
      'SAMPLES/DRUMS/kick.wav': 'audio',
      'SAMPLES/notes.txt': 'ignored, not an audio ext',
    });

    await cardStore.adoptHandle(root as unknown as FileSystemDirectoryHandle);

    expect(cardStore.isLoaded).toBe(true);
    expect(cardStore.songXmls.get('SONGS/track1.xml')).toBe(ARRANGEMENT_XML);
    expect(cardStore.presetIndex.has('KITS/KIT001.XML')).toBe(true);
    expect(cardStore.presetIndex.has('SYNTHS/SYNT001.XML')).toBe(true);
    expect(cardStore.sampleIndex.has('samples/drums/kick.wav')).toBe(true);
    expect(cardStore.sampleIndex.has('samples/notes.txt')).toBe(false);
  });

  it('ignores app-managed dirs while indexing', async () => {
    const root = buildTree({
      'SONGS/track1.xml': ARRANGEMENT_XML,
      'SOFT_DELETE/SONGS/gone.xml': ARRANGEMENT_XML,
    });

    await cardStore.adoptHandle(root as unknown as FileSystemDirectoryHandle);

    expect(cardStore.songXmls.size).toBe(1);
  });
});

describe('cardStore.eligibleSongs', () => {
  it('filters to arrangement songs by default and sorts by path', async () => {
    const root = buildTree({
      'SONGS/b_session.xml': SESSION_XML,
      'SONGS/a_arranged.xml': ARRANGEMENT_XML,
    });
    await cardStore.adoptHandle(root as unknown as FileSystemDirectoryHandle);

    const songs = cardStore.eligibleSongs();
    expect(songs).toEqual([{ path: 'SONGS/a_arranged.xml', xml: ARRANGEMENT_XML }]);
  });

  it('returns all songs sorted by path when arrangementOnly is false', async () => {
    const root = buildTree({
      'SONGS/b_session.xml': SESSION_XML,
      'SONGS/a_arranged.xml': ARRANGEMENT_XML,
    });
    await cardStore.adoptHandle(root as unknown as FileSystemDirectoryHandle);

    const songs = cardStore.eligibleSongs(false);
    expect(songs.map((s) => s.path)).toEqual(['SONGS/a_arranged.xml', 'SONGS/b_session.xml']);
  });
});

describe('cardStore.getSampleBuffer', () => {
  function fakeAudioContext() {
    let decodeCalls = 0;
    return {
      ctx: {
        decodeAudioData: async () => {
          decodeCalls++;
          return { id: decodeCalls } as unknown as AudioBuffer;
        },
      } as unknown as AudioContext,
      getDecodeCalls: () => decodeCalls,
    };
  }

  it('returns null for a path not on the card', async () => {
    const root = buildTree({});
    await cardStore.adoptHandle(root as unknown as FileSystemDirectoryHandle);
    const { ctx } = fakeAudioContext();
    expect(await cardStore.getSampleBuffer('SAMPLES/missing.wav', ctx)).toBeNull();
  });

  it('decodes once and serves subsequent reads from cache', async () => {
    const root = buildTree({ 'SAMPLES/kick.wav': 'audio' });
    await cardStore.adoptHandle(root as unknown as FileSystemDirectoryHandle);
    const { ctx, getDecodeCalls } = fakeAudioContext();

    const first = await cardStore.getSampleBuffer('SAMPLES/kick.wav', ctx);
    const second = await cardStore.getSampleBuffer('SAMPLES/kick.wav', ctx);

    expect(first).toBe(second);
    expect(getDecodeCalls()).toBe(1);
  });

  it('evicts the least-recently-used buffer once the cache exceeds capacity', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 65; i++) files[`SAMPLES/s${i}.wav`] = `audio${i}`;
    const root = buildTree(files);
    await cardStore.adoptHandle(root as unknown as FileSystemDirectoryHandle);
    const { ctx, getDecodeCalls } = fakeAudioContext();

    for (let i = 0; i < 65; i++) {
      await cardStore.getSampleBuffer(`SAMPLES/s${i}.wav`, ctx);
    }
    expect(getDecodeCalls()).toBe(65);

    // s0 was evicted (LRU, cache size 64) -> re-fetching it decodes again.
    await cardStore.getSampleBuffer('SAMPLES/s0.wav', ctx);
    expect(getDecodeCalls()).toBe(66);

    // s64 (most recently used before eviction pressure) is still cached.
    await cardStore.getSampleBuffer('SAMPLES/s64.wav', ctx);
    expect(getDecodeCalls()).toBe(66);
  });
});

describe('cardStore.pickDirectory', () => {
  it('opens the native directory picker and adopts the result', async () => {
    const root = buildTree({ 'SONGS/track1.xml': ARRANGEMENT_XML });
    const original = (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    (window as unknown as { showDirectoryPicker: () => Promise<FakeDirEntry> }).showDirectoryPicker =
      async () => root;

    await cardStore.pickDirectory();

    expect(cardStore.isLoaded).toBe(true);
    expect(cardStore.songXmls.size).toBe(1);

    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = original;
  });
});

describe('cardStore.reset', () => {
  it('clears all indexes and rootHandle', async () => {
    const root = buildTree({ 'SONGS/track1.xml': ARRANGEMENT_XML });
    await cardStore.adoptHandle(root as unknown as FileSystemDirectoryHandle);

    cardStore.reset();

    expect(cardStore.rootHandle).toBeNull();
    expect(cardStore.isLoaded).toBe(false);
    expect(cardStore.songXmls.size).toBe(0);
    expect(cardStore.presetIndex.size).toBe(0);
    expect(cardStore.sampleIndex.size).toBe(0);
  });
});

describe('song cache persistence (IndexedDB)', () => {
  it('round-trips through save/load/clear', async () => {
    expect(await cardStore.loadCachedSongs()).toBeNull();

    await cardStore.saveSongCache('MyCard', [{ path: 'SONGS/a.xml', xml: ARRANGEMENT_XML }]);
    const cached = await cardStore.loadCachedSongs();
    expect(cached?.cardName).toBe('MyCard');
    expect(cached?.songs).toEqual([{ path: 'SONGS/a.xml', xml: ARRANGEMENT_XML }]);

    await cardStore.clearSongCache();
    expect(await cardStore.loadCachedSongs()).toBeNull();
  });

  it('adoptHandle persists a rootHandle so hasPersistedHandle becomes true', async () => {
    expect(await cardStore.hasPersistedHandle()).toBe(false);
    const root = buildTree({ 'SONGS/track1.xml': ARRANGEMENT_XML });
    await cardStore.adoptHandle(root as unknown as FileSystemDirectoryHandle);
    expect(await cardStore.hasPersistedHandle()).toBe(true);
  });
});

describe('cardStore reconnect flows', () => {
  it('reconnectHandleOnly returns null with no persisted handle', async () => {
    expect(await cardStore.reconnectHandleOnly()).toBeNull();
  });

  it('reconnectHandleOnly returns the handle when permission is already granted', async () => {
    const root = buildTree({});
    await cardStore.adoptHandle(root as unknown as FileSystemDirectoryHandle);
    cardStore.reset();

    const handle = await cardStore.reconnectHandleOnly();
    expect(handle).toBe(root as unknown as FileSystemDirectoryHandle);
    expect(cardStore.rootHandle).toBe(root as unknown as FileSystemDirectoryHandle);
  });

  it('reconnectHandleOnly returns null when permission is denied', async () => {
    const root = buildTree({});
    await cardStore.adoptHandle(root as unknown as FileSystemDirectoryHandle);
    root.permission = 'denied';
    cardStore.reset();

    expect(await cardStore.reconnectHandleOnly()).toBeNull();
  });

  it('reconnect silently re-walks the card when permission is already granted', async () => {
    const root = buildTree({ 'SONGS/track1.xml': ARRANGEMENT_XML });
    await cardStore.adoptHandle(root as unknown as FileSystemDirectoryHandle);
    cardStore.reset();

    const ok = await cardStore.reconnect();
    expect(ok).toBe(true);
    expect(cardStore.isLoaded).toBe(true);
    expect(cardStore.songXmls.size).toBe(1);
  });

  it('reconnect returns false without prompting when permission is not granted', async () => {
    const root = buildTree({ 'SONGS/track1.xml': ARRANGEMENT_XML });
    await cardStore.adoptHandle(root as unknown as FileSystemDirectoryHandle);
    root.permission = 'denied';
    cardStore.reset();

    expect(await cardStore.reconnect()).toBe(false);
    expect(cardStore.isLoaded).toBe(false);
  });

  it('requestReconnect loads the card once the user grants permission', async () => {
    const root = buildTree({ 'SONGS/track1.xml': ARRANGEMENT_XML });
    await cardStore.adoptHandle(root as unknown as FileSystemDirectoryHandle);
    cardStore.reset();

    const ok = await cardStore.requestReconnect();
    expect(ok).toBe(true);
    expect(cardStore.songXmls.size).toBe(1);
  });

  it('requestReconnect returns false with no persisted handle', async () => {
    expect(await cardStore.requestReconnect()).toBe(false);
  });

  it('reconnectHandleOnly can prompt for permission via requestPermission', async () => {
    const root = buildTree({});
    await cardStore.adoptHandle(root as unknown as FileSystemDirectoryHandle);
    cardStore.reset();

    const handle = await cardStore.reconnectHandleOnly(true);
    expect(handle).toBe(root as unknown as FileSystemDirectoryHandle);
  });
});

describe('cardStore IndexedDB failure handling', () => {
  it('hasPersistedHandle resolves false when IndexedDB is unavailable', async () => {
    (globalThis as unknown as { indexedDB: { open(): never } }).indexedDB = {
      open() {
        throw new Error('IndexedDB blocked');
      },
    };
    expect(await cardStore.hasPersistedHandle()).toBe(false);
  });

  it('loadCachedSongs resolves null when IndexedDB is unavailable', async () => {
    (globalThis as unknown as { indexedDB: { open(): never } }).indexedDB = {
      open() {
        throw new Error('IndexedDB blocked');
      },
    };
    expect(await cardStore.loadCachedSongs()).toBeNull();
  });
});
