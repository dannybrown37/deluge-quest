<script lang="ts">
  import { loadPyodide, analyzeStats, convertToMusicXML, type SongStats } from "../lib/pyodide";
  import { moveToTrash } from "../lib/softDelete";
  import { cardStore, basename, topDir } from "../lib/cardStore";
  import { trackToolAction } from "../lib/analytics";

  interface DroppedFile {
    file: File;
    path: string;
  }

  type State = "idle" | "indexing" | "loading" | "processing" | "done" | "error";

  let state: State = $state("idle");
  let progress = $state("");
  let progressPct = $state(0);
  let errorMsg = $state("");
  let results: SongStats[] = $state([]);
  let fileContents = $state(new Map<string, string>());
  let sortBy = $state("name");
  let sortAsc = $state(true);
  let dragOver = $state(false);
  let fileCount = $state(0);

  let convertingFile = $state("");
  let convertedFiles = $state(new Map<string, string>());

  let rootHandle = $state<FileSystemDirectoryHandle | null>(null);
  let filePaths = $state(new Map<string, string>());
  let deletingFiles = $state(new Set<string>());
  let reconnectAvailable = $state(false);
  let reconnecting = $state(false);
  let hasFileSystemAccess = $derived(typeof window !== "undefined" && "showDirectoryPicker" in window);

  let filterArr = $state<"all" | "yes" | "no">("all");
  let filterGear = $state<"all" | "deluge" | "external">("all");
  let filterKey = $state("");
  let filterBpmMin = $state("");
  let filterBpmMax = $state("");
  let filterNotesMin = $state("");
  let searchQuery = $state("");

  const ROOTS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  const sortFns: Record<string, (a: SongStats, b: SongStats) => number> = {
    name: (a, b) => a.filename.localeCompare(b.filename),
    bpm: (a, b) => a.bpm - b.bpm,
    key: (a, b) => a.key.localeCompare(b.key),
    duration: (a, b) => a.durationStr.localeCompare(b.durationStr),
    notes: (a, b) => a.totalNotes - b.totalNotes,
    instruments: (a, b) => a.instrumentCount - b.instrumentCount,
    clips: (a, b) => a.clipCount - b.clipCount,
    modified: (a, b) => (a.lastModified ?? 0) - (b.lastModified ?? 0),
  };

  function formatDate(ts?: number): string {
    if (!ts) return "-";
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function formatDateFull(ts?: number): string {
    if (!ts) return "";
    return new Date(ts).toLocaleString();
  }

  let filtered = $derived.by(() => {
    let items = results;
    if (filterArr === "yes") items = items.filter(s => s.hasArrangement);
    else if (filterArr === "no") items = items.filter(s => !s.hasArrangement);
    if (filterGear === "deluge") items = items.filter(s => s.midiCount === 0 && s.cvCount === 0);
    else if (filterGear === "external") items = items.filter(s => s.midiCount > 0 || s.cvCount > 0);
    if (filterKey) items = items.filter(s => s.key === filterKey);
    const bpmMin = filterBpmMin ? parseFloat(filterBpmMin) : 0;
    const bpmMax = filterBpmMax ? parseFloat(filterBpmMax) : Infinity;
    if (bpmMin > 0 || bpmMax < Infinity) items = items.filter(s => s.bpm >= bpmMin && s.bpm <= bpmMax);
    const notesMin = filterNotesMin ? parseInt(filterNotesMin) : 0;
    if (notesMin > 0) items = items.filter(s => s.totalNotes >= notesMin);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      items = items.filter(s => s.filename.toLowerCase().includes(q));
    }
    return items;
  });

  let sorted = $derived.by(() => {
    const fn = sortFns[sortBy] ?? sortFns.name;
    const s = [...filtered].sort(fn);
    return sortAsc ? s : s.reverse();
  });

  let allKeys = $derived.by(() => {
    const keys: Record<string, number> = {};
    for (const s of results) {
      if (!s.key.startsWith("Error")) {
        keys[s.key] = (keys[s.key] || 0) + 1;
      }
    }
    return keys;
  });

  let keyMatrix = $derived.by(() => {
    const scales = new Set<string>();
    const matrix: Record<string, Record<string, number>> = {};
    for (const [key, count] of Object.entries(allKeys)) {
      const parts = key.split(" ");
      const root = parts[0];
      const scale = parts.slice(1).join(" ") || "?";
      scales.add(scale);
      if (!matrix[root]) matrix[root] = {};
      matrix[root][scale] = count;
    }
    const scaleList = [...scales].sort();
    const usedRoots = ROOTS.filter(r => matrix[r]);
    return { scales: scaleList, roots: usedRoots, matrix };
  });

  let summary = $derived.by(() => {
    if (filtered.length === 0) return null;
    const total = filtered.length;
    const arrCount = filtered.filter(s => s.hasArrangement).length;
    const bpms = filtered.map(s => s.bpm).filter(b => b > 0);
    const totalNotes = filtered.reduce((sum, s) => sum + s.totalNotes, 0);
    const totalInst = filtered.reduce((sum, s) => sum + s.instrumentCount, 0);
    const totalClips = filtered.reduce((sum, s) => sum + s.clipCount, 0);
    return {
      total,
      arrCount,
      bpmMin: bpms.length ? Math.min(...bpms) : 0,
      bpmMax: bpms.length ? Math.max(...bpms) : 0,
      bpmAvg: bpms.length ? bpms.reduce((a, b) => a + b, 0) / bpms.length : 0,
      totalNotes,
      totalInst,
      totalClips,
    };
  });

  let hasActiveFilters = $derived(
    filterArr !== "all" || filterGear !== "all" || filterKey !== "" || filterBpmMin !== "" ||
    filterBpmMax !== "" || filterNotesMin !== "" || searchQuery !== ""
  );

  const CACHE_KEY_RESULTS = "deluge-stats-results";
  const IDB_NAME = "deluge-stats";
  const IDB_STORE = "files";

  function openIdb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbPut(db: IDBDatabase, key: string, value: string, store = IDB_STORE): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function idbGetAll(db: IDBDatabase): Promise<Map<string, string>> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const store = tx.objectStore(IDB_STORE);
      const map = new Map<string, string>();
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          map.set(cursor.key as string, cursor.value);
          cursor.continue();
        } else {
          resolve(map);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  function idbClear(db: IDBDatabase, store = IDB_STORE): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function saveToSession() {
    try {
      sessionStorage.setItem(CACHE_KEY_RESULTS, JSON.stringify(results));
    } catch {}
    try {
      const db = await openIdb();
      await idbClear(db);
      for (const [name, content] of fileContents) {
        await idbPut(db, name, content);
      }
      db.close();
    } catch {}
  }

  function adoptCardStore() {
    rootHandle = cardStore.rootHandle;
    filePaths = new Map([...cardStore.songXmls.keys()].map(p => [basename(p), p]));
    fileContents = new Map([...cardStore.songXmls.entries()].map(([p, text]) => [basename(p), text]));
  }

  async function restoreFromSession(): Promise<boolean> {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY_RESULTS);
      if (!raw) return false;
      const cached = JSON.parse(raw);
      if (!cached?.length) return false;
      results = cached;
      fileCount = results.length;
      state = "done";
    } catch {
      return false;
    }
    try {
      const db = await openIdb();
      fileContents = await idbGetAll(db);
      db.close();
    } catch {}
    try {
      if (await cardStore.reconnect()) {
        adoptCardStore();
      } else {
        reconnectAvailable = await cardStore.hasPersistedHandle();
      }
    } catch {}
    return true;
  }

  /** Silently loads from a previously connected card (via persisted handle), same as Kits/Clean. */
  async function tryAutoLoad() {
    if (cardStore.isLoaded && cardStore.songXmls.size > 0) {
      adoptCardStore();
      await processFromCardStore();
      return;
    }
    try {
      if (await cardStore.reconnect()) {
        if (cardStore.songXmls.size > 0) {
          adoptCardStore();
          await processFromCardStore();
        }
      } else {
        reconnectAvailable = await cardStore.hasPersistedHandle();
      }
    } catch {}
  }

  async function reconnectFolder() {
    if (reconnecting) return;
    reconnecting = true;
    try {
      if (await cardStore.requestReconnect()) {
        adoptCardStore();
        reconnectAvailable = false;
      }
    } catch {} finally {
      reconnecting = false;
    }
  }

  function exportCsv() {
    trackToolAction("stats", "export_csv");
    const headers = ["Song", "BPM", "Key", "Duration", "Type", "Instruments", "Synths", "Kits", "Clips", "Notes", "Arrangement", "Modified"];
    const rows = sorted.map(s => [
      s.filename.replace(/\.XML$/i, ""),
      s.bpm > 0 ? s.bpm.toFixed(1) : "",
      s.key,
      s.durationStr,
      [s.synthCount ? "I" : "", s.kitCount ? "K" : "", s.midiCount ? "M" : "", s.cvCount ? "C" : "", s.audioCount ? "A" : ""].filter(Boolean).join("") || "-",
      s.instrumentCount,
      s.synthCount,
      s.kitCount,
      s.clipCount,
      s.totalNotes,
      s.hasArrangement ? "yes" : "no",
      s.lastModified ? new Date(s.lastModified).toISOString().split("T")[0] : "",
    ]);
    const csv = [headers, ...rows].map(r => r.map(c => {
      const str = String(c);
      return str.includes(",") || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
    }).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `deluge-stats-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  restoreFromSession()
    .then((hadCache) => { if (!hadCache) tryAutoLoad(); })
    .catch(() => tryAutoLoad());

  async function readEntryRecursive(entry: FileSystemEntry, basePath = ""): Promise<DroppedFile[]> {
    const entryPath = basePath ? `${basePath}/${entry.name}` : entry.name;
    if (entry.isFile) {
      return new Promise((resolve) => {
        (entry as FileSystemFileEntry).file(
          (f) => resolve(f.name.toLowerCase().endsWith(".xml") ? [{ file: f, path: entryPath }] : []),
          () => resolve([]),
        );
      });
    }
    if (entry.isDirectory) {
      if (APP_MANAGED_DIRS.has(entry.name.toUpperCase())) return [];
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const entries = await new Promise<FileSystemEntry[]>((resolve) => {
        const all: FileSystemEntry[] = [];
        const readBatch = () => {
          reader.readEntries((batch) => {
            if (batch.length === 0) { resolve(all); return; }
            all.push(...batch);
            readBatch();
          }, () => resolve(all));
        };
        readBatch();
      });
      const nested = await Promise.all(entries.map(e => readEntryRecursive(e, entryPath)));
      return nested.flat();
    }
    return [];
  }

  const SOFT_DELETE_DIR_NAME = "SOFT_DELETE";
  const APP_MANAGED_DIRS = new Set([SOFT_DELETE_DIR_NAME, "REPAIR_BACKUP"]);

  /** SOFT_DELETE/ and REPAIR_BACKUP/ are app-managed, not card content — never analyze or list them. */
  function isSoftDeletePath(path: string): boolean {
    const segments = new Set(path.toUpperCase().split("/"));
    return [...APP_MANAGED_DIRS].some(d => segments.has(d));
  }

  /** If any dropped/browsed file lives under a SONGS/ dir, keep only those — drops of the SD card
   * root otherwise pull in KITS/SYNTHS XMLs too. Falls back to everything when no SONGS/ dir is found
   * (e.g. the user dropped the SONGS folder's contents directly). */
  function filterToSongsDir(entries: DroppedFile[]): DroppedFile[] {
    const withoutTrash = entries.filter(e => !isSoftDeletePath(e.path));
    const songEntries = withoutTrash.filter(e => topDir(e.path).toUpperCase() === "SONGS");
    return songEntries.length > 0 ? songEntries : withoutTrash;
  }

  async function openFolderWithAccess() {
    state = "indexing";
    progress = "Indexing card";
    progressPct = 0;
    try {
      await cardStore.pickDirectory((stage, done, total) => {
        progress = total > 0 ? `${stage} (${done}/${total})` : stage;
        progressPct = total > 0 ? Math.round((done / total) * 100) : 0;
      });

      if (cardStore.songXmls.size === 0) {
        state = "error";
        errorMsg = "Not a Deluge SD card: no SONGS directory found. Select the SD card root folder so deleted songs land in SOFT_DELETE/SONGS/... at the root.";
        return;
      }

      adoptCardStore();
      await processFromCardStore();
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        state = "error";
        errorMsg = e.message || "Failed to open folder";
      }
    }
  }

  async function processFromCardStore() {
    const entries = [...cardStore.songXmls.entries()];
    fileCount = entries.length;
    state = "loading";

    try {
      const pyodide = await loadPyodide((stage, pct) => {
        progress = stage;
        progressPct = pct;
      });

      state = "processing";
      progress = `Analyzing ${entries.length} file${entries.length > 1 ? "s" : ""}`;
      progressPct = 85;

      const fileData = entries.map(([path, content]) => ({ name: basename(path), content }));
      const stats = await analyzeStats(fileData, pyodide);
      results = stats.map(s => {
        const path = filePaths.get(s.filename);
        return { ...s, lastModified: path ? cardStore.songLastModified.get(path) : undefined };
      });
      state = "done";
      progressPct = 100;
      saveToSession();
      trackToolAction("stats", "analyze_card");
    } catch (e: any) {
      state = "error";
      errorMsg = e.message || "Analysis failed";
      trackToolAction("stats", "analyze_error");
    }
  }

  async function deleteSong(filename: string) {
    if (!rootHandle || deletingFiles.has(filename)) return;
    const path = filePaths.get(filename);
    if (!path) return;
    if (!confirm(`Move "${filename}" to ${SOFT_DELETE_DIR_NAME}/? You can restore it from there later.`)) return;

    const next = new Set(deletingFiles);
    next.add(filename);
    deletingFiles = next;

    try {
      await moveToTrash(rootHandle, path);
      trackToolAction("stats", "delete_song");
      results = results.filter(s => s.filename !== filename);
      const contents = new Map(fileContents);
      contents.delete(filename);
      fileContents = contents;
      const paths = new Map(filePaths);
      paths.delete(filename);
      filePaths = paths;
      cardStore.songXmls.delete(path);
      saveToSession();
    } catch (e: any) {
      console.error(`Failed to delete ${filename}:`, e);
    } finally {
      const rm = new Set(deletingFiles);
      rm.delete(filename);
      deletingFiles = rm;
    }
  }

  async function processFiles(entries: DroppedFile[]) {
    if (entries.length === 0) {
      state = "error";
      errorMsg = "No .XML files found. Drop your Deluge SD card, or its SONGS folder.";
      return;
    }

    fileCount = entries.length;
    state = "loading";

    try {
      const pyodide = await loadPyodide((stage, pct) => {
        progress = stage;
        progressPct = pct;
      });

      state = "processing";
      progress = `Analyzing ${entries.length} file${entries.length > 1 ? "s" : ""}`;
      progressPct = 85;

      const timestamps = new Map(entries.map(e => [e.file.name, e.file.lastModified]));
      const fileData = await Promise.all(
        entries.map(async e => ({ name: e.file.name, content: await e.file.text() }))
      );

      fileContents = new Map(fileData.map(f => [f.name, f.content]));
      filePaths = new Map(entries.map(e => [e.file.name, e.path]));

      const stats = await analyzeStats(fileData, pyodide);
      results = stats.map(s => ({ ...s, lastModified: timestamps.get(s.filename) }));
      state = "done";
      progressPct = 100;
      saveToSession();
      trackToolAction("stats", "analyze_drop");
      await cardStore.saveSongCache(
        "your dropped folder",
        entries.map(e => ({ path: e.path, xml: fileContents.get(e.file.name) ?? "" })),
      );
    } catch (e: any) {
      state = "error";
      errorMsg = e.message || "Analysis failed";
    }
  }

  /** Chrome/Edge only: a dropped folder can hand back a real, persistable FileSystemDirectoryHandle
   * instead of the one-shot FileSystemEntry tree — using it means /preview and /score can silently
   * reconnect to this same card later, exactly as if "Load SD card" had been used. */
  async function tryAdoptDroppedDirectoryHandle(items: DataTransferItemList): Promise<boolean> {
    const item = Array.from(items).find(i => i.kind === "file");
    const getAsFileSystemHandle = (item as any)?.getAsFileSystemHandle;
    if (!item || typeof getAsFileSystemHandle !== "function") return false;

    const handle = await getAsFileSystemHandle.call(item);
    if (!handle || handle.kind !== "directory") return false;

    try {
      await (handle as any).requestPermission?.({ mode: "readwrite" });
    } catch {}

    state = "indexing";
    progress = "Indexing card";
    progressPct = 0;
    try {
      await cardStore.adoptHandle(handle as FileSystemDirectoryHandle, (stage, done, total) => {
        progress = total > 0 ? `${stage} (${done}/${total})` : stage;
        progressPct = total > 0 ? Math.round((done / total) * 100) : 0;
      });
      if (cardStore.songXmls.size === 0) {
        state = "error";
        errorMsg = "Not a Deluge SD card: no SONGS directory found. Drop the SD card root folder.";
        return true;
      }
      adoptCardStore();
      await processFromCardStore();
    } catch (e: any) {
      state = "error";
      errorMsg = e.message || "Failed to read dropped folder";
    }
    return true;
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;

    const items = e.dataTransfer?.items;
    if (items && (await tryAdoptDroppedDirectoryHandle(items))) return;

    if (items) {
      const entries = Array.from(items)
        .map(item => item.webkitGetAsEntry?.())
        .filter((e): e is FileSystemEntry => e != null);

      if (entries.length > 0) {
        const allEntries = (await Promise.all(entries.map(en => readEntryRecursive(en)))).flat();
        await processFiles(filterToSongsDir(allEntries));
        return;
      }
    }

    const files = e.dataTransfer?.files;
    if (files?.length) {
      const entries = Array.from(files)
        .filter(f => f.name.toLowerCase().endsWith(".xml"))
        .map(f => ({ file: f, path: (f as any).webkitRelativePath || f.name }));
      await processFiles(filterToSongsDir(entries));
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    dragOver = true;
  }

  function handleDragLeave() {
    dragOver = false;
  }

  function handleInputChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (!files?.length) return;
    const entries = Array.from(files)
      .filter(f => f.name.toLowerCase().endsWith(".xml"))
      .map(f => ({ file: f, path: (f as any).webkitRelativePath || f.name }));
    processFiles(filterToSongsDir(entries));
  }

  function setSort(col: string) {
    if (sortBy === col) {
      sortAsc = !sortAsc;
    } else {
      sortBy = col;
      sortAsc = true;
    }
  }

  function clearFilters() {
    filterArr = "all";
    filterGear = "all";
    filterKey = "";
    filterBpmMin = "";
    filterBpmMax = "";
    filterNotesMin = "";
    searchQuery = "";
  }

  function filterByKey(key: string) {
    filterKey = filterKey === key ? "" : key;
  }

  async function convertScore(filename: string) {
    if (convertedFiles.get(filename)) {
      downloadMusicXml(filename);
      return;
    }
    const content = fileContents.get(filename);
    if (!content) return;
    convertingFile = filename;
    try {
      const pyodide = await loadPyodide();
      const musicxml = await convertToMusicXML(content, pyodide);
      convertedFiles = new Map(convertedFiles).set(filename, musicxml);
      trackToolAction("stats", "convert_score");
      downloadMusicXml(filename);
    } catch (e: any) {
      errorMsg = `Score conversion failed for ${filename}: ${e.message}`;
    } finally {
      convertingFile = "";
    }
  }

  function downloadMusicXml(filename: string) {
    const xml = convertedFiles.get(filename);
    if (!xml) return;
    const blob = new Blob([xml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename.replace(/\.XML$/i, ".musicxml");
    a.click();
    URL.revokeObjectURL(url);
  }

  function openInPreview(filename: string) {
    const content = fileContents.get(filename);
    if (!content) return;
    trackToolAction("stats", "open_in_preview");
    sessionStorage.setItem("deluge-preview-file", JSON.stringify({ name: filename, content }));
    window.location.href = "/preview";
  }

  function reset() {
    state = "idle";
    results = [];
    errorMsg = "";
    fileCount = 0;
    fileContents = new Map();
    rootHandle = null;
    filePaths = new Map();
    reconnectAvailable = false;
    clearFilters();
    try {
      sessionStorage.removeItem(CACHE_KEY_RESULTS);
    } catch {}
    openIdb().then(db => idbClear(db).then(() => db.close())).catch(() => {});
  }
</script>

{#if state === "idle"}
  <div
    class="dropzone"
    class:dropzone--over={dragOver}
    role="button"
    tabindex="0"
    ondrop={handleDrop}
    ondragover={handleDragOver}
    ondragleave={handleDragLeave}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') document.getElementById('stats-file-input')?.click(); }}
  >
    <div class="dropzone-content">
      <span class="dropzone-icon">#</span>
      <p class="dropzone-title">Drop your SD card or SONGS folder</p>
      <p class="dropzone-sub">or browse for a <label class="dropzone-browse">folder<input id="stats-folder-input" type="file" webkitdirectory onchange={handleInputChange} hidden /></label> or <label class="dropzone-browse">files<input id="stats-file-input" type="file" accept=".xml,.XML" multiple onchange={handleInputChange} hidden /></label></p>
      <p class="dropzone-hint">Recursively finds SONGS/*.XML — other folders (KITS, SYNTHS, SAMPLES) are ignored</p>
      {#if hasFileSystemAccess}
        <p class="dropzone-hint">
          <button type="button" class="dropzone-browse dropzone-browse--btn" onclick={(e) => { e.stopPropagation(); openFolderWithAccess(); }}>
            Open SD card root for delete access
          </button>
        </p>
        <p class="dropzone-hint">Opening the SD card root also connects it on Kits and Card Analysis — no need to load it twice.</p>
      {/if}
    </div>
  </div>

{:else if state === "indexing"}
  <div class="status-card">
    <div class="status-pipeline">
      <div class="pipeline-step pipeline-step--active">
        <span class="pipeline-dot"></span>
        <span>{progress || "Indexing card"}</span>
      </div>
    </div>
    <div class="progress-bar">
      <div class="progress-fill" style="width: {progressPct}%"></div>
    </div>
  </div>

{:else if state === "loading" || state === "processing"}
  <div class="status-card">
    <div class="status-pipeline">
      <div class="pipeline-step" class:pipeline-step--active={progressPct < 40}>
        <span class="pipeline-dot"></span>
        <span>Loading runtime</span>
      </div>
      <div class="pipeline-step" class:pipeline-step--active={progressPct >= 40 && progressPct < 70}>
        <span class="pipeline-dot"></span>
        <span>Loading tools</span>
      </div>
      <div class="pipeline-step" class:pipeline-step--active={progressPct >= 70 && progressPct < 100}>
        <span class="pipeline-dot"></span>
        <span>Analyzing {fileCount} file{fileCount > 1 ? 's' : ''}</span>
      </div>
      <div class="pipeline-step" class:pipeline-step--active={progressPct >= 100}>
        <span class="pipeline-dot"></span>
        <span>Done</span>
      </div>
    </div>
    <div class="progress-bar">
      <div class="progress-fill" style="width: {progressPct}%"></div>
    </div>
  </div>

{:else if state === "done"}
  <div class="results">
    <!-- Filters -->
    <div class="filters">
      <div class="filter-row">
        <input
          class="filter-search"
          type="text"
          placeholder="Search songs..."
          bind:value={searchQuery}
        />
        <select class="filter-select" bind:value={filterArr}>
          <option value="all">All songs</option>
          <option value="yes">With arrangement</option>
          <option value="no">No arrangement</option>
        </select>
        <select class="filter-select" bind:value={filterGear}>
          <option value="all">All gear</option>
          <option value="deluge">Deluge-only</option>
          <option value="external">Uses external gear</option>
        </select>
        <select class="filter-select" bind:value={filterKey}>
          <option value="">All keys</option>
          {#each Object.entries(allKeys).sort((a, b) => b[1] - a[1]) as [key, count]}
            <option value={key}>{key} ({count})</option>
          {/each}
        </select>
      </div>
      <div class="filter-row">
        <div class="filter-range">
          <span class="filter-label">BPM</span>
          <input class="filter-input" type="number" placeholder="min" bind:value={filterBpmMin} />
          <span class="filter-sep">&ndash;</span>
          <input class="filter-input" type="number" placeholder="max" bind:value={filterBpmMax} />
        </div>
        <div class="filter-range">
          <span class="filter-label">Notes</span>
          <input class="filter-input" type="number" placeholder="min" bind:value={filterNotesMin} />
          <span class="filter-sep">+</span>
        </div>
        {#if hasActiveFilters}
          <button class="btn btn-sm btn-ghost" onclick={clearFilters}>Clear filters</button>
        {/if}
        <div class="filter-spacer"></div>
        <span class="results-count">{filtered.length}/{results.length} songs</span>
        {#if reconnectAvailable}
          <button class="btn btn-secondary btn-sm" onclick={reconnectFolder} disabled={reconnecting}>
            {reconnecting ? "Reconnecting…" : "Reconnect folder to enable delete"}
          </button>
        {/if}
        <button class="btn btn-secondary btn-sm" onclick={exportCsv}>Export CSV</button>
        <button class="btn btn-secondary btn-sm" onclick={reset}>Analyze more</button>
      </div>
    </div>

    <!-- Table -->
    <div class="table-wrap">
      <table>
        <colgroup>
          <col class="col-name" />
          <col class="col-bpm" />
          <col class="col-key" />
          <col class="col-duration" />
          <col class="col-type" />
          <col class="col-instruments" />
          <col class="col-clips" />
          <col class="col-notes" />
          <col class="col-modified col-hide-narrow" />
        </colgroup>
        <thead>
          <tr>
            {#each [
              { id: 'name', label: 'Song' },
              { id: 'bpm', label: 'BPM' },
              { id: 'key', label: 'Key' },
              { id: 'duration', label: 'Duration' },
              { id: 'type', label: 'Type' },
              { id: 'instruments', label: 'Inst' },
              { id: 'clips', label: 'Clips' },
              { id: 'notes', label: 'Notes' },
              { id: 'modified', label: 'Modified', hide: 'col-hide-narrow' },
            ] as col}
              <th class={col.hide ?? ''} title={col.id === 'type' ? 'I = Internal synth, K = Kit, M = MIDI out, C = CV out, A = Audio' : undefined}>
                {#if sortFns[col.id] || col.id === 'arr'}
                  <button
                    class="sort-btn"
                    class:sort-btn--active={sortBy === col.id}
                    onclick={() => setSort(col.id)}
                  >
                    {col.label}
                    {#if sortBy === col.id}
                      <span class="sort-arrow">{sortAsc ? '▲' : '▼'}</span>
                    {/if}
                  </button>
                {:else}
                  {col.label}
                {/if}
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each sorted as s}
            {@const name = s.filename.replace(/\.XML$/i, '')}
            <tr class:row--error={s.key.startsWith('Error')}>
              <td class="cell-name">
                <span class="cell-name-text" title={filePaths.get(s.filename) ?? name}>{name}</span>
                {#if ((s.hasArrangement || s.totalNotes > 0) && fileContents.has(s.filename)) || (rootHandle && filePaths.has(s.filename))}
                  <span class="cell-name-actions">
                    {#if (s.hasArrangement || s.totalNotes > 0) && fileContents.has(s.filename)}
                      {#if convertingFile === s.filename}
                        <span class="score-btn score-btn--busy">Converting…</span>
                      {:else}
                        <button class="score-btn" class:score-btn--done={convertedFiles.has(s.filename)} title={convertedFiles.has(s.filename) ? "Download MusicXML" : "Convert to MusicXML"} onclick={() => convertScore(s.filename)}>
                          {convertedFiles.has(s.filename) ? "Download" : "Score"}
                        </button>
                      {/if}
                      <button class="score-btn inspect-btn" title="Preview song" onclick={() => openInPreview(s.filename)}>Preview</button>
                    {/if}
                    {#if rootHandle && filePaths.has(s.filename)}
                      <button
                        class="score-btn delete-btn"
                        title="Move to {SOFT_DELETE_DIR_NAME}/"
                        disabled={deletingFiles.has(s.filename)}
                        onclick={() => deleteSong(s.filename)}
                      >
                        {deletingFiles.has(s.filename) ? "…" : "Delete"}
                      </button>
                    {/if}
                  </span>
                {/if}
              </td>
              <td class="cell-num" title={s.bpm > 0 ? s.bpm.toFixed(1) : ''}>{s.bpm > 0 ? s.bpm.toFixed(0) : '-'}</td>
              <td title={s.key}>
                {#if s.key.startsWith('Error')}
                  <span class="key-error">Error</span>
                {:else}
                  <button class="key-chip" class:key-chip--active={filterKey === s.key} onclick={() => filterByKey(s.key)}>{s.key}</button>
                {/if}
              </td>
              <td class="cell-num" title={s.durationStr}>{s.durationStr}</td>
              <td class="cell-type" title="I = Internal synth, K = Kit, M = MIDI out, C = CV out, A = Audio">
                {#if s.synthCount}<span class="type-badge type-badge--synth">I</span>{/if}
                {#if s.kitCount}<span class="type-badge type-badge--kit">K</span>{/if}
                {#if s.midiCount}<span class="type-badge type-badge--midi">M</span>{/if}
                {#if s.cvCount}<span class="type-badge type-badge--cv">C</span>{/if}
                {#if s.audioCount}<span class="type-badge type-badge--audio">A</span>{/if}
                {#if !s.synthCount && !s.kitCount && !s.midiCount && !s.cvCount && !s.audioCount}-{/if}
              </td>
              <td class="cell-num" title={`${s.synthCount} synth, ${s.kitCount} kit${s.midiCount ? `, ${s.midiCount} MIDI` : ''}${s.cvCount ? `, ${s.cvCount} CV` : ''}${s.audioCount ? `, ${s.audioCount} audio` : ''}`}>{s.instrumentCount || '-'}</td>
              <td class="cell-num" title={`${s.clipCount} clips`}>{s.clipCount || '-'}</td>
              <td class="cell-num" title={s.totalNotes.toLocaleString()}>{s.totalNotes > 0 ? s.totalNotes.toLocaleString() : '-'}</td>
              <td class="cell-date col-hide-narrow" title={formatDateFull(s.lastModified)}>{formatDate(s.lastModified)}</td>
            </tr>
          {/each}
          {#if sorted.length === 0}
            <tr><td colspan="99" class="cell-empty">No songs match filters</td></tr>
          {/if}
        </tbody>
      </table>
    </div>

    <!-- Summary -->
    {#if summary}
      <div class="summary">
        <div class="summary-stats">
          <div class="stat">
            <span class="stat-value">{summary.arrCount}/{summary.total}</span>
            <span class="stat-label">with arrangement</span>
          </div>
          {#if summary.bpmMin > 0}
            <div class="stat">
              <span class="stat-value">{summary.bpmMin.toFixed(0)}&ndash;{summary.bpmMax.toFixed(0)}</span>
              <span class="stat-label">BPM range (avg {summary.bpmAvg.toFixed(0)})</span>
            </div>
          {/if}
          <div class="stat">
            <span class="stat-value">{summary.totalNotes.toLocaleString()}</span>
            <span class="stat-label">total notes</span>
          </div>
          <div class="stat">
            <span class="stat-value">{summary.totalInst}</span>
            <span class="stat-label">total instruments</span>
          </div>
          <div class="stat">
            <span class="stat-value">{summary.totalClips}</span>
            <span class="stat-label">total clips</span>
          </div>
        </div>

        {#if keyMatrix.roots.length > 0}
          <div class="key-matrix">
            <h4 class="matrix-title">Key usage</h4>
            <div class="matrix-wrap">
              <table class="matrix-table">
                <thead>
                  <tr>
                    <th></th>
                    {#each keyMatrix.scales as scale}
                      <th title={scale}>{scale}</th>
                    {/each}
                  </tr>
                </thead>
                <tbody>
                  {#each keyMatrix.roots as root}
                    <tr>
                      <th>{root}</th>
                      {#each keyMatrix.scales as scale}
                        {@const count = keyMatrix.matrix[root]?.[scale] ?? 0}
                        {@const fullKey = `${root} ${scale}`}
                        <td
                          class="matrix-cell"
                          class:matrix-cell--filled={count > 0}
                          class:matrix-cell--active={filterKey === fullKey}
                          title={count > 0 ? `${fullKey}: ${count} song${count !== 1 ? 's' : ''}` : ''}
                        >
                          {#if count > 0}
                            <button class="matrix-btn" onclick={() => filterByKey(fullKey)}>{count}</button>
                          {/if}
                        </td>
                      {/each}
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </div>

{:else if state === "error"}
  <div class="error-card">
    <p class="error-msg">{errorMsg}</p>
    <button class="btn btn-secondary" onclick={reset}>Try again</button>
  </div>
{/if}

<style>
  .dropzone {
    border: 2px dashed var(--border);
    border-radius: 10px;
    padding: 4rem 2rem;
    text-align: center;
    cursor: pointer;
    transition: border-color 0.05s, background 0.05s;
  }
  .dropzone:hover,
  .dropzone--over {
    border-color: var(--accent);
    background: var(--accent-dim);
  }
  .dropzone:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .dropzone-icon {
    font-family: 'DM Mono', monospace;
    font-size: 2.5rem;
    display: block;
    margin-bottom: 0.75rem;
    opacity: 0.7;
  }
  .dropzone-title {
    font-family: 'DM Mono', monospace;
    font-size: 1rem;
    font-weight: 500;
    margin-bottom: 0.25rem;
  }
  .dropzone-sub {
    font-size: 0.9rem;
    color: var(--text-secondary);
  }
  .dropzone-browse {
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
  }
  .dropzone-browse--btn {
    background: none;
    border: none;
    font: inherit;
    padding: 0;
  }
  .dropzone-hint {
    font-size: 0.8rem;
    color: var(--text-secondary);
    margin-top: 0.75rem;
    opacity: 0.7;
  }

  .status-card, .error-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 2rem;
  }

  .status-pipeline {
    display: flex;
    gap: 1.5rem;
    margin-bottom: 1.25rem;
    flex-wrap: wrap;
  }
  .pipeline-step {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-family: 'DM Mono', monospace;
    font-size: 0.8rem;
    color: var(--text-secondary);
    transition: color 0.05s;
  }
  .pipeline-step--active {
    color: var(--accent);
    font-weight: 500;
  }
  .pipeline-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--border);
    transition: background 0.05s;
  }
  .pipeline-step--active .pipeline-dot {
    background: var(--accent);
  }

  .progress-bar {
    height: 3px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
    transition: width 0.4s ease;
  }

  /* Filters */
  .filters {
    margin-bottom: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .filter-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .filter-search {
    flex: 1;
    min-width: 140px;
    font-family: 'DM Mono', monospace;
    font-size: 0.8rem;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--surface);
    color: var(--text);
  }
  .filter-search:focus {
    outline: none;
    border-color: var(--accent);
  }
  .filter-search::placeholder {
    color: var(--text-secondary);
  }
  .filter-select {
    font-family: 'DM Mono', monospace;
    font-size: 0.78rem;
    padding: 0.4rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
  }
  .filter-select:focus {
    outline: none;
    border-color: var(--accent);
  }
  .filter-range {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  .filter-label {
    font-family: 'DM Mono', monospace;
    font-size: 0.75rem;
    color: var(--text-secondary);
  }
  .filter-input {
    width: 60px;
    font-family: 'DM Mono', monospace;
    font-size: 0.78rem;
    padding: 0.35rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--surface);
    color: var(--text);
  }
  .filter-input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .filter-input::placeholder {
    color: var(--text-secondary);
  }
  .filter-sep {
    color: var(--text-secondary);
    font-size: 0.8rem;
  }
  .filter-spacer {
    flex: 1;
  }

  .results-count {
    font-family: 'DM Mono', monospace;
    font-size: 0.78rem;
    color: var(--text-secondary);
    white-space: nowrap;
  }

  /* Table */
  .table-wrap {
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
  }

  table {
    width: 100%;
    table-layout: fixed;
    border-collapse: collapse;
    font-size: 0.82rem;
    white-space: nowrap;
  }
  .col-name { width: 34%; }
  .col-bpm { width: 7%; }
  .col-key { width: 7%; }
  .col-duration { width: 9%; }
  .col-type { width: 8%; }
  .col-instruments { width: 7%; }
  .col-clips { width: 7%; }
  .col-notes { width: 9%; }
  .col-modified { width: 12%; }
  thead {
    background: var(--surface);
    box-shadow: inset 0 -1px 0 var(--border);
  }
  th {
    font-family: 'DM Mono', monospace;
    font-weight: 500;
    font-size: 0.78rem;
    text-align: left;
    padding: 0.6rem 0.5rem;
    color: var(--text-secondary);
  }
  td {
    padding: 0.5rem 0.5rem;
    border-top: 1px solid var(--border);
    color: var(--text);
  }
  tbody tr:hover {
    background: var(--surface);
  }

  .cell-name {
    font-family: 'DM Mono', monospace;
    font-weight: 500;
    position: relative;
  }
  .cell-name-text {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cell-name-actions {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    position: absolute;
    right: 0.5rem;
    top: 50%;
    transform: translateY(-50%);
    background: var(--ground);
    padding-left: 0.5rem;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.1s ease;
  }
  tbody tr:hover .cell-name-actions,
  .cell-name-actions:focus-within {
    background: var(--surface);
    opacity: 1;
    pointer-events: auto;
  }
  .score-btn {
    font-family: 'DM Mono', monospace;
    font-size: 0.65rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.15rem 0.45rem;
    border: 1px solid var(--accent);
    border-radius: 3px;
    background: transparent;
    color: var(--accent);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.05s, background 0.05s, color 0.05s;
    vertical-align: middle;
  }
  tbody tr:hover .score-btn {
    opacity: 1;
  }
  .score-btn:hover {
    background: var(--accent);
    color: var(--ground);
  }
  .score-btn--busy {
    opacity: 1;
    cursor: default;
    color: var(--text-secondary);
    border-color: var(--border);
  }
  .score-btn--done {
    border-color: var(--teal);
    color: var(--teal);
  }
  .score-btn--done:hover {
    background: var(--teal);
    color: var(--ground);
  }
  .inspect-btn {
    border-color: var(--teal);
    color: var(--teal);
  }
  .inspect-btn:hover {
    background: var(--teal);
    color: var(--ground);
  }
  .delete-btn {
    border-color: #c47a7a;
    color: #c47a7a;
  }
  .delete-btn:hover:not(:disabled) {
    background: #c47a7a;
    color: var(--ground);
  }
  .delete-btn:disabled {
    opacity: 1;
    cursor: default;
  }
  .cell-num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .cell-type {
    text-align: center;
    white-space: nowrap;
  }
  .type-badge {
    display: inline-block;
    font-family: 'DM Mono', monospace;
    font-size: 0.65rem;
    font-weight: 600;
    width: 1.2em;
    text-align: center;
    border-radius: 2px;
    padding: 0.05rem 0.1rem;
    line-height: 1.2;
  }
  .type-badge--synth { color: #D4A847; }
  .type-badge--kit { color: #5AABAC; }
  .type-badge--midi { color: #7A9EC4; }
  .type-badge--cv { color: #A87AD4; }
  .type-badge--audio { color: #C47A7A; }
  .cell-center {
    text-align: center;
  }
  .cell-date {
    font-variant-numeric: tabular-nums;
    font-size: 0.78rem;
    color: var(--text-secondary);
    white-space: nowrap;
  }
  @media (max-width: 900px) {
    .col-hide-narrow { display: none; }
  }
  .cell-empty {
    text-align: center;
    color: var(--text-secondary);
    padding: 2rem;
    font-style: italic;
  }
  .row--error td {
    color: #c47a7a;
  }

  .sort-btn {
    background: none;
    border: none;
    font: inherit;
    color: inherit;
    cursor: pointer;
    padding: 0;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }
  .sort-btn:hover {
    color: var(--text);
  }
  .sort-btn--active {
    color: var(--accent);
  }
  .sort-arrow {
    font-size: 0.6rem;
  }

  .key-chip {
    background: none;
    border: 1px solid transparent;
    font: inherit;
    font-size: 0.78rem;
    color: inherit;
    cursor: pointer;
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
    transition: border-color 0.05s, background 0.05s;
  }
  .key-chip:hover {
    border-color: var(--accent);
    background: var(--accent-dim);
  }
  .key-error {
    font-size: 0.7rem;
    color: #c47a7a;
    cursor: default;
  }
  .key-chip--active {
    border-color: var(--accent);
    background: var(--accent-dim);
    color: var(--accent);
  }

  /* Summary */
  .summary {
    margin-top: 1.5rem;
    padding: 1.25rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .summary-stats {
    display: flex;
    gap: 2rem;
    flex-wrap: wrap;
    margin-bottom: 1.25rem;
  }
  .stat {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .stat-value {
    font-family: 'DM Mono', monospace;
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--text);
  }
  .stat-label {
    font-size: 0.75rem;
    color: var(--text-secondary);
  }

  /* Key matrix */
  .key-matrix {
    border-top: 1px solid var(--border);
    padding-top: 1rem;
  }
  .matrix-title {
    font-family: 'DM Mono', monospace;
    font-size: 0.82rem;
    font-weight: 500;
    margin-bottom: 0.6rem;
  }
  .matrix-wrap {
    overflow-x: auto;
  }
  .matrix-table {
    border-collapse: collapse;
    font-size: 0.75rem;
    white-space: nowrap;
  }
  .matrix-table th {
    font-family: 'DM Mono', monospace;
    font-weight: 500;
    font-size: 0.7rem;
    padding: 0.3rem 0.5rem;
    color: var(--text-secondary);
    text-align: center;
  }
  .matrix-table tbody th {
    text-align: right;
    padding-right: 0.6rem;
    color: var(--text);
  }
  .matrix-cell {
    text-align: center;
    padding: 0.25rem 0.4rem;
    min-width: 2rem;
  }
  .matrix-cell--filled {
    background: var(--accent-dim);
    border-radius: 3px;
  }
  .matrix-cell--active {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
  }
  .matrix-btn {
    background: none;
    border: none;
    font: inherit;
    font-family: 'DM Mono', monospace;
    font-weight: 500;
    color: var(--accent);
    cursor: pointer;
    padding: 0.15rem 0.3rem;
    border-radius: 3px;
    min-width: 1.5rem;
  }
  .matrix-btn:hover {
    background: var(--accent);
    color: var(--ground);
  }

  .error-card {
    border-color: #c47a7a;
  }
  .error-msg {
    color: #c47a7a;
    margin-bottom: 1rem;
    font-size: 0.9rem;
  }

  .btn {
    font-family: 'DM Mono', monospace;
    font-size: 0.82rem;
    font-weight: 500;
    padding: 0.6rem 1.25rem;
    border-radius: 5px;
    border: none;
    cursor: pointer;
    transition: background 0.05s;
  }
  .btn-sm {
    padding: 0.4rem 0.9rem;
    font-size: 0.78rem;
  }
  .btn-secondary {
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
  }
  .btn-secondary:hover { background: var(--surface); }
  .btn-ghost {
    background: none;
    color: var(--accent);
    border: none;
    padding: 0.4rem 0.5rem;
    font-size: 0.75rem;
    text-decoration: underline;
  }
</style>
