import type { SavePoint } from "./historyStore";

/**
 * A folder on disk that holds save points as plain files:
 *
 *   <vault>/blobs/<hash>.xml         content-addressed, shared between save points
 *   <vault>/save-points/0007.json    { id, label, takenAt, cardName, entries[] }
 *
 * Plain files on purpose — back the folder up, sync it, or commit it to Git, and read it
 * without this site. Chromium only, like every other write feature here.
 */

const IDB_NAME = "deluge-history-vault";
const IDB_VERSION = 1;
const IDB_META = "meta";
const KEY_HANDLE = "vaultHandle";

export const BLOBS_DIR = "blobs";
export const SAVE_POINTS_DIR = "save-points";
export const META_FILE = "meta.json";

export interface BlobRecord {
  xml: string;
  size: number;
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
      if (!db.objectStoreNames.contains(IDB_META)) db.createObjectStore(IDB_META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(key: string): Promise<T | null> {
  return openIdb()
    .then(
      (db) =>
        new Promise<T | null>((resolve, reject) => {
          const tx = db.transaction(IDB_META, "readonly");
          const req = tx.objectStore(IDB_META).get(key);
          req.onsuccess = () => resolve((req.result as T) ?? null);
          req.onerror = () => reject(req.error);
          tx.oncomplete = () => db.close();
        }),
    )
    .catch(() => null);
}

async function idbPut(key: string, value: unknown): Promise<void> {
  try {
    const db = await openIdb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_META, "readwrite");
      tx.objectStore(IDB_META).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* the vault still works this session, it just will not be remembered */
  }
}

async function idbDelete(key: string): Promise<void> {
  try {
    const db = await openIdb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_META, "readwrite");
      tx.objectStore(IDB_META).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* nothing persisted, nothing to forget */
  }
}

async function writeFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  contents: string,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(contents);
  await writable.close();
}

async function readFile(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<string | null> {
  try {
    return await (await (await dir.getFileHandle(name)).getFile()).text();
  } catch {
    return null;
  }
}

/** Zero-padded so the folder sorts the way the timeline does. */
function fileNameFor(id: number): string {
  return `${String(id).padStart(4, "0")}.json`;
}

class HistoryVaultImpl {
  handle: FileSystemDirectoryHandle | null = null;

  get isConnected(): boolean {
    return this.handle !== null;
  }

  get name(): string {
    return this.handle?.name ?? "";
  }

  /** Opens the folder picker and remembers the choice for next time. */
  async pick(): Promise<boolean> {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    this.handle = handle;
    await idbPut(KEY_HANDLE, handle);
    return true;
  }

  /**
   * Re-opens the remembered folder. With `prompt` false this only succeeds if permission is
   * still granted; with it true the browser asks, which needs a user gesture.
   */
  async reconnect(prompt = false): Promise<boolean> {
    const handle = await idbGet<FileSystemDirectoryHandle>(KEY_HANDLE);
    if (!handle) return false;
    try {
      const permission = prompt
        ? await handle.requestPermission({ mode: "readwrite" })
        : await handle.queryPermission?.({ mode: "readwrite" });
      if (permission !== "granted") return false;
    } catch {
      return false;
    }
    this.handle = handle;
    return true;
  }

  async hasRemembered(): Promise<boolean> {
    return (await idbGet<FileSystemDirectoryHandle>(KEY_HANDLE)) !== null;
  }

  /** Stops using the folder. The files in it are left exactly as they are. */
  async forget(): Promise<void> {
    this.handle = null;
    await idbDelete(KEY_HANDLE);
  }

  private require(): FileSystemDirectoryHandle {
    if (!this.handle) throw new Error("No save point folder is connected");
    return this.handle;
  }

  private async dir(name: string): Promise<FileSystemDirectoryHandle> {
    return this.require().getDirectoryHandle(name, { create: true });
  }

  async listSavePoints(): Promise<SavePoint[]> {
    const dir = await this.dir(SAVE_POINTS_DIR);
    const savePoints: SavePoint[] = [];
    for await (const entry of dir.values()) {
      if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
      const text = await readFile(dir, entry.name);
      if (!text) continue;
      try {
        const parsed = JSON.parse(text) as SavePoint;
        if (typeof parsed?.id === "number" && Array.isArray(parsed.entries)) {
          savePoints.push(parsed);
        }
      } catch {
        /* a file we did not write, or a half-written one — skip it rather than fail the list */
      }
    }
    return savePoints.sort((a, b) => b.takenAt - a.takenAt || b.id - a.id);
  }

/**
   * Ids come from a counter in meta.json rather than from the highest file present, so deleting
   * a save point never frees its id for reuse — a reused id would silently rewrite history for
   * anything holding the old number. Falls back to highest-plus-one when meta.json is missing,
   * so a folder assembled by hand still works.
   */
  private async nextId(): Promise<number> {
    const root = this.require();
    const stored = await readFile(root, META_FILE);
    let next = 0;
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as { nextId?: number };
        if (typeof parsed.nextId === "number") next = parsed.nextId;
      } catch {
        /* unreadable meta — fall through to counting files */
      }
    }
    if (!next) {
      const dir = await this.dir(SAVE_POINTS_DIR);
      let highest = 0;
      for await (const entry of dir.values()) {
        const match = /^(\d+)\.json$/.exec(entry.name);
        if (match) highest = Math.max(highest, Number(match[1]));
      }
      next = highest + 1;
    }
    await writeFile(root, META_FILE, JSON.stringify({ nextId: next + 1 }, null, 2));
    return next;
  }

  /** Writes the blobs this save point needs (skipping any already there), then the save point. */
  async writeSavePoint(
    draft: Omit<SavePoint, "id">,
    blobs: Map<string, BlobRecord>,
  ): Promise<SavePoint> {
    const blobDir = await this.dir(BLOBS_DIR);
    const existing = new Set<string>();
    for await (const entry of blobDir.values()) {
      if (entry.name.endsWith(".xml")) existing.add(entry.name.slice(0, -4));
    }
    for (const [hash, record] of blobs) {
      if (!existing.has(hash)) await writeFile(blobDir, `${hash}.xml`, record.xml);
    }

    const savePoint: SavePoint = { ...draft, id: await this.nextId() };
    const dir = await this.dir(SAVE_POINTS_DIR);
    await writeFile(dir, fileNameFor(savePoint.id), JSON.stringify(savePoint, null, 2));
    return savePoint;
  }

  async readBlob(hash: string): Promise<string | null> {
    const dir = await this.dir(BLOBS_DIR);
    return readFile(dir, `${hash}.xml`);
  }

  async blobCount(): Promise<number> {
    const dir = await this.dir(BLOBS_DIR);
    let count = 0;
    for await (const entry of dir.values()) {
      if (entry.name.endsWith(".xml")) count++;
    }
    return count;
  }

  async deleteSavePoint(id: number): Promise<void> {
    const dir = await this.dir(SAVE_POINTS_DIR);
    try {
      await dir.removeEntry(fileNameFor(id));
    } catch {
      return;
    }
    await this.collectBlobs();
  }

  /** Deletes blob files no remaining save point points at. */
  async collectBlobs(): Promise<void> {
    const savePoints = await this.listSavePoints();
    const live = new Set<string>();
    for (const savePoint of savePoints) {
      for (const entry of savePoint.entries) live.add(entry.hash);
    }
    const blobDir = await this.dir(BLOBS_DIR);
    const dead: string[] = [];
    for await (const entry of blobDir.values()) {
      if (!entry.name.endsWith(".xml")) continue;
      if (!live.has(entry.name.slice(0, -4))) dead.push(entry.name);
    }
    for (const name of dead) {
      try {
        await blobDir.removeEntry(name);
      } catch {
        /* already gone */
      }
    }
  }

  /** Removes every save point and blob the vault holds. The folder itself stays. */
  async clear(): Promise<void> {
    for (const dirName of [SAVE_POINTS_DIR, BLOBS_DIR]) {
      const dir = await this.dir(dirName);
      const names: string[] = [];
      for await (const entry of dir.values()) names.push(entry.name);
      for (const name of names) {
        try {
          await dir.removeEntry(name);
        } catch {
          /* already gone */
        }
      }
    }
  }
}

export const historyVault = new HistoryVaultImpl();
