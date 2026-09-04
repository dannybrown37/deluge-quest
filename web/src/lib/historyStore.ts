export type SaveKind = "song" | "kit" | "patch";

export interface SaveEntry {
  path: string;
  kind: SaveKind;
  /** Content address of the XML — see hashXml(). */
  hash: string;
  size: number;
}

export interface SavePoint {
  id: number;
  cardName: string;
  takenAt: number;
  label: string;
  entries: SaveEntry[];
}

/** The slice of cardStore a save point is built from. Samples are deliberately absent. */
export interface CardSource {
  cardName: string;
  songXmls: Map<string, string>;
  presetIndex: Map<string, string>;
}

export interface StorageUsage {
  usage: number;
  quota: number;
  percent: number;
}

const IDB_NAME = "deluge-history";
const IDB_VERSION = 1;
const STORE_BLOBS = "blobs";
const STORE_SAVE_POINTS = "savePoints";

export const MAX_SAVE_POINTS = 50;

const KIND_BY_TOP_DIR: Record<string, SaveKind> = {
  SONGS: "song",
  KITS: "kit",
  SYNTHS: "patch",
};

/**
 * Which kind of preset a card path holds, or null if history does not track it.
 * Samples are excluded by size; app-managed dirs are excluded because they are our own
 * backups, not card content.
 */
export function classifyPath(path: string): SaveKind | null {
  const parts = path.split("/");
  if (parts.length < 2) return null;
  if (!path.toLowerCase().endsWith(".xml")) return null;
  return KIND_BY_TOP_DIR[parts[0].toUpperCase()] ?? null;
}

/**
 * Content address for an XML file. SHA-256 truncated to 64 bits — with a ceiling of ~50k
 * stored files, collision odds are negligible, and short keys keep the entry lists small.
 */
export async function hashXml(xml: string): Promise<string> {
  const bytes = new TextEncoder().encode(xml);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest, 0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Autoincrement ids never reset, so a date reads better than "Save point 137". */
function defaultLabel(takenAt: number): string {
  const d = new Date(takenAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined" || !indexedDB) {
      reject(new Error("Browser storage is unavailable"));
      return;
    }
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_BLOBS)) db.createObjectStore(STORE_BLOBS);
      if (!db.objectStoreNames.contains(STORE_SAVE_POINTS)) {
        db.createObjectStore(STORE_SAVE_POINTS, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

interface BlobRecord {
  xml: string;
  size: number;
}

class HistoryStoreImpl {
  /**
   * Snapshots every song, kit and patch the card scan loaded. Always the complete set, so any
   * save point can be read back as a whole card state; unchanged files cost no extra storage
   * because blobs are keyed by content.
   */
  async createSavePoint(src: CardSource, label?: string): Promise<SavePoint> {
    const files: { path: string; kind: SaveKind; xml: string }[] = [];
    for (const map of [src.songXmls, src.presetIndex]) {
      for (const [path, xml] of map) {
        const kind = classifyPath(path);
        if (kind) files.push({ path, kind, xml });
      }
    }
    files.sort((a, b) => a.path.localeCompare(b.path));

    const entries: SaveEntry[] = [];
    const blobs = new Map<string, BlobRecord>();
    for (const { path, kind, xml } of files) {
      const hash = await hashXml(xml);
      entries.push({ path, kind, hash, size: xml.length });
      if (!blobs.has(hash)) blobs.set(hash, { xml, size: xml.length });
    }

    const db = await openIdb();
    try {
      const tx = db.transaction([STORE_BLOBS, STORE_SAVE_POINTS], "readwrite");
      const blobStore = tx.objectStore(STORE_BLOBS);
      for (const [hash, record] of blobs) {
        const existing = await request(blobStore.count(hash));
        if (!existing) blobStore.put(record, hash);
      }
      const savePointStore = tx.objectStore(STORE_SAVE_POINTS);
      const takenAt = Date.now();
      const draft = {
        cardName: src.cardName,
        takenAt,
        label: label || defaultLabel(takenAt),
        entries,
      };
      const id = (await request(savePointStore.add(draft))) as number;
      const saved: SavePoint = { ...draft, id };
      await done(tx);
      await this.pruneWith(db);
      return saved;
    } finally {
      db.close();
    }
  }

  /** Every save point, newest first. */
  async listSavePoints(): Promise<SavePoint[]> {
    return this.read(async (db) => {
      const tx = db.transaction(STORE_SAVE_POINTS, "readonly");
      const all = await request(tx.objectStore(STORE_SAVE_POINTS).getAll());
      return (all as SavePoint[]).sort((a, b) => b.takenAt - a.takenAt || b.id - a.id);
    }, []);
  }

  /** The XML behind a content hash, or null if it has been collected. */
  async getXml(hash: string): Promise<string | null> {
    return this.read(async (db) => {
      const tx = db.transaction(STORE_BLOBS, "readonly");
      const record = (await request(tx.objectStore(STORE_BLOBS).get(hash))) as
        | BlobRecord
        | undefined;
      return record?.xml ?? null;
    }, null);
  }

  async blobCount(): Promise<number> {
    return this.read(async (db) => {
      const tx = db.transaction(STORE_BLOBS, "readonly");
      return await request(tx.objectStore(STORE_BLOBS).count());
    }, 0);
  }

  async deleteSavePoint(id: number): Promise<void> {
    await this.read(async (db) => {
      const tx = db.transaction(STORE_SAVE_POINTS, "readwrite");
      tx.objectStore(STORE_SAVE_POINTS).delete(id);
      await done(tx);
      await this.collectBlobs(db);
      return undefined;
    }, undefined);
  }

  /** A save point plus the full text of every file in it, for taking history out of the browser. */
  async exportSavePoint(id: number): Promise<string | null> {
    return this.read(async (db) => {
      const tx = db.transaction([STORE_SAVE_POINTS, STORE_BLOBS], "readonly");
      const savePoint = (await request(tx.objectStore(STORE_SAVE_POINTS).get(id))) as
        | SavePoint
        | undefined;
      if (!savePoint) return null;
      const blobStore = tx.objectStore(STORE_BLOBS);
      const files: Record<string, string> = {};
      for (const entry of savePoint.entries) {
        const record = (await request(blobStore.get(entry.hash))) as BlobRecord | undefined;
        if (record) files[entry.path] = record.xml;
      }
      return JSON.stringify({ ...savePoint, files }, null, 2);
    }, null);
  }

  /** How much of the browser's storage allowance is used, or null if it cannot be measured. */
  async estimateUsage(): Promise<StorageUsage | null> {
    const estimate = navigator?.storage?.estimate;
    if (!estimate) return null;
    try {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      if (!quota) return null;
      return { usage, quota, percent: (usage / quota) * 100 };
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    await this.read(async (db) => {
      const tx = db.transaction([STORE_SAVE_POINTS, STORE_BLOBS], "readwrite");
      tx.objectStore(STORE_SAVE_POINTS).clear();
      tx.objectStore(STORE_BLOBS).clear();
      await done(tx);
      return undefined;
    }, undefined);
  }

  private async pruneWith(db: IDBDatabase): Promise<void> {
    const tx = db.transaction(STORE_SAVE_POINTS, "readwrite");
    const store = tx.objectStore(STORE_SAVE_POINTS);
    const all = ((await request(store.getAll())) as SavePoint[]).sort(
      (a, b) => a.takenAt - b.takenAt || a.id - b.id,
    );
    const excess = all.length - MAX_SAVE_POINTS;
    if (excess <= 0) return;
    for (const savePoint of all.slice(0, excess)) store.delete(savePoint.id);
    await done(tx);
    await this.collectBlobs(db);
  }

  /** Drops blobs no surviving save point points at. */
  private async collectBlobs(db: IDBDatabase): Promise<void> {
    const readTx = db.transaction([STORE_SAVE_POINTS, STORE_BLOBS], "readonly");
    const savePoints = (await request(
      readTx.objectStore(STORE_SAVE_POINTS).getAll(),
    )) as SavePoint[];
    const hashes = (await request(readTx.objectStore(STORE_BLOBS).getAllKeys())) as string[];

    const live = new Set<string>();
    for (const savePoint of savePoints) {
      for (const entry of savePoint.entries) live.add(entry.hash);
    }
    const dead = hashes.filter((hash) => !live.has(hash));
    if (!dead.length) return;

    const writeTx = db.transaction(STORE_BLOBS, "readwrite");
    const store = writeTx.objectStore(STORE_BLOBS);
    for (const hash of dead) store.delete(hash);
    await done(writeTx);
  }

  /** Reads degrade to a fallback when storage is blocked; only saving is allowed to throw. */
  private async read<T>(work: (db: IDBDatabase) => Promise<T>, fallback: T): Promise<T> {
    let db: IDBDatabase;
    try {
      db = await openIdb();
    } catch {
      return fallback;
    }
    try {
      return await work(db);
    } catch {
      return fallback;
    } finally {
      db.close();
    }
  }
}

export const historyStore = new HistoryStoreImpl();
