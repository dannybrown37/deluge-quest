export interface SampleInfo {
  handle: FileSystemFileHandle;
  size: number;
  /** Original (non-normalized) path as found on the card. */
  path: string;
}

export type ProgressCallback = (stage: string, done: number, total: number) => void;

const IDB_NAME = "deluge-card-store";
const IDB_META = "meta";
const KEY_HANDLE = "rootHandle";
/** App-managed dirs — trash and pre-fix backups, not real card content. Never scanned. */
const APP_MANAGED_DIRS = new Set(["SOFT_DELETE", "REPAIR_BACKUP"]);
const AUDIO_EXTENSIONS = new Set(["wav", "aif", "aiff"]);

export function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function topDir(path: string): string {
  const i = path.indexOf("/");
  return i >= 0 ? path.slice(0, i) : path;
}

export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

export function normalizePath(path: string): string {
  return path.replace(/^\/+/, "").toLowerCase();
}

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_META)) db.createObjectStore(IDB_META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

class CardStoreImpl {
  rootHandle: FileSystemDirectoryHandle | null = null;
  isLoaded = false;
  /** SONGS/**\/*.XML — path -> XML text */
  songXmls = new Map<string, string>();
  /** SONGS path -> File.lastModified */
  songLastModified = new Map<string, number>();
  /** KITS/**, SYNTHS/** — path -> XML text */
  presetIndex = new Map<string, string>();
  /** normalized SAMPLES/** path -> handle + size */
  sampleIndex = new Map<string, SampleInfo>();

  private sampleBufferCache = new Map<string, AudioBuffer>();
  private sampleBufferOrder: string[] = [];
  private readonly MAX_CACHED_BUFFERS = 64;

  private async saveHandle(handle: FileSystemDirectoryHandle) {
    try {
      const db = await openIdb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(IDB_META, "readwrite");
        tx.objectStore(IDB_META).put(handle, KEY_HANDLE);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch {}
  }

  private async loadHandle(): Promise<FileSystemDirectoryHandle | null> {
    try {
      const db = await openIdb();
      const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
        const tx = db.transaction(IDB_META, "readonly");
        const req = tx.objectStore(IDB_META).get(KEY_HANDLE);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      });
      db.close();
      return handle;
    } catch {
      return null;
    }
  }

  async hasPersistedHandle(): Promise<boolean> {
    return (await this.loadHandle()) !== null;
  }

  /**
   * Grabs the persisted root handle without walking the card — for callers (like /kits) that only
   * need a directory handle, not the full song/sample index. Does not touch isLoaded or the maps.
   */
  async reconnectHandleOnly(requestPermission = false): Promise<FileSystemDirectoryHandle | null> {
    const handle = await this.loadHandle();
    if (!handle) return null;
    const perm = requestPermission
      ? await (handle as any).requestPermission({ mode: "readwrite" })
      : await (handle as any).queryPermission?.({ mode: "readwrite" });
    if (perm !== "granted") return null;
    this.rootHandle = handle;
    return handle;
  }

  /** Opens the native directory picker, walks the card, and persists the handle for future reconnects. */
  async pickDirectory(onProgress?: ProgressCallback): Promise<void> {
    const handle = await (window as any).showDirectoryPicker({ mode: "readwrite" });
    await this.loadFromHandle(handle, onProgress);
    await this.saveHandle(handle);
  }

  /** Silently re-requests permission on the previously persisted handle (no prompt). */
  async reconnect(onProgress?: ProgressCallback): Promise<boolean> {
    const handle = await this.loadHandle();
    if (!handle) return false;
    const perm = await (handle as any).queryPermission?.({ mode: "readwrite" });
    if (perm !== "granted") return false;
    await this.loadFromHandle(handle, onProgress);
    return true;
  }

  /** Re-requests permission with a browser prompt — must be called from a user gesture. */
  async requestReconnect(onProgress?: ProgressCallback): Promise<boolean> {
    const handle = await this.loadHandle();
    if (!handle) return false;
    const perm = await (handle as any).requestPermission({ mode: "readwrite" });
    if (perm !== "granted") return false;
    await this.loadFromHandle(handle, onProgress);
    return true;
  }

  private async loadFromHandle(handle: FileSystemDirectoryHandle, onProgress?: ProgressCallback) {
    this.rootHandle = handle;
    this.isLoaded = false;
    this.songXmls = new Map();
    this.songLastModified = new Map();
    this.presetIndex = new Map();
    this.sampleIndex = new Map();
    this.sampleBufferCache.clear();
    this.sampleBufferOrder = [];

    const allEntries: { path: string; handle: FileSystemFileHandle }[] = [];
    onProgress?.("Indexing files", 0, 0);
    await this.walk(handle, "", allEntries);

    const total = allEntries.length;
    let done = 0;
    for (const { path, handle: fh } of allEntries) {
      done++;
      const dir = topDir(path).toUpperCase();
      const extension = ext(path);
      if (dir === "SONGS" && extension === "xml") {
        const file = await fh.getFile();
        this.songXmls.set(path, await file.text());
        this.songLastModified.set(path, file.lastModified);
      } else if ((dir === "KITS" || dir === "SYNTHS") && extension === "xml") {
        const file = await fh.getFile();
        this.presetIndex.set(path, await file.text());
      } else if (dir === "SAMPLES" && AUDIO_EXTENSIONS.has(extension)) {
        const file = await fh.getFile();
        this.sampleIndex.set(normalizePath(path), { handle: fh, size: file.size, path });
      }
      if (done % 25 === 0 || done === total) {
        onProgress?.("Indexing files", done, total);
      }
    }

    this.isLoaded = true;
  }

  private async walk(
    dirHandle: FileSystemDirectoryHandle,
    path: string,
    out: { path: string; handle: FileSystemFileHandle }[],
  ) {
    for await (const entry of (dirHandle as any).values()) {
      if (entry.kind === "directory" && APP_MANAGED_DIRS.has(entry.name)) continue;
      const entryPath = path ? `${path}/${entry.name}` : entry.name;
      if (entry.kind === "file") {
        out.push({ path: entryPath, handle: entry as FileSystemFileHandle });
      } else if (entry.kind === "directory") {
        await this.walk(entry as FileSystemDirectoryHandle, entryPath, out);
      }
    }
  }

  /** Decodes and caches (LRU) a sample by SAMPLES-relative path. Returns null if not on the card. */
  async getSampleBuffer(path: string, ctx: AudioContext): Promise<AudioBuffer | null> {
    const key = normalizePath(path);
    const cached = this.sampleBufferCache.get(key);
    if (cached) {
      this.touch(key);
      return cached;
    }
    const info = this.sampleIndex.get(key);
    if (!info) return null;
    const file = await info.handle.getFile();
    const arrayBuf = await file.arrayBuffer();
    const audioBuf = await ctx.decodeAudioData(arrayBuf);
    this.sampleBufferCache.set(key, audioBuf);
    this.touch(key);
    this.evictIfNeeded();
    return audioBuf;
  }

  private touch(key: string) {
    const i = this.sampleBufferOrder.indexOf(key);
    if (i >= 0) this.sampleBufferOrder.splice(i, 1);
    this.sampleBufferOrder.push(key);
  }

  private evictIfNeeded() {
    while (this.sampleBufferOrder.length > this.MAX_CACHED_BUFFERS) {
      const oldest = this.sampleBufferOrder.shift();
      if (oldest) this.sampleBufferCache.delete(oldest);
    }
  }

  reset() {
    this.rootHandle = null;
    this.isLoaded = false;
    this.songXmls = new Map();
    this.songLastModified = new Map();
    this.presetIndex = new Map();
    this.sampleIndex = new Map();
    this.sampleBufferCache.clear();
    this.sampleBufferOrder = [];
  }
}

export const cardStore = new CardStoreImpl();
