<script lang="ts">
  import { TRASH_DIR, getOrCreateDir, moveToTrash } from "../lib/softDelete";

  type State = "idle" | "processing" | "done" | "error";

  interface MissingRef {
    sample: string;
    referencedBy: string[];
  }

  interface DuplicateGroup {
    hash: string;
    size: number;
    files: string[];
  }

  interface CardReport {
    totalSamples: number;
    totalSamplesBytes: number;
    totalReferences: number;
    unusedSamples: string[];
    missingReferences: MissingRef[];
    unusedPresets: string[];
    reclaimableBytes: number;
    duplicates: DuplicateGroup[];
    duplicateWastedBytes: number;
  }

  const AUDIO_EXTENSIONS = new Set(["wav", "aif", "aiff"]);
  const XML_DIRS = ["SONGS", "KITS", "SYNTHS"];
  const FILE_ATTRS = ["fileName", "filePath"];

  let state: State = $state("idle");
  let errorMsg = $state("");
  let report: CardReport | null = $state(null);
  let dragOver = $state(false);
  let cardName = $state("");
  let listCategory = $state<"all" | "samples" | "missing" | "presets" | "duplicates">("all");
  let showList = $state(false);
  let progress = $state("");
  let canWrite = $state(false);
  let rootHandle = $state<FileSystemDirectoryHandle | null>(null);
  let movedFiles = $state(new Set<string>());
  let movingFiles = $state(new Set<string>());
  let fileHandles = $state(new Map<string, File>());
  let playingFile = $state<string | null>(null);
  let currentAudio = $state<HTMLAudioElement | null>(null);

  let movedCount = $derived(movedFiles.size);
  let hasFileSystemAccess = $derived(typeof window !== "undefined" && "showDirectoryPicker" in window);

  function ext(name: string): string {
    const i = name.lastIndexOf(".");
    return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
  }

  function topDir(path: string): string {
    const i = path.indexOf("/");
    return i >= 0 ? path.slice(0, i) : path;
  }

  function extractFileRefs(xmlText: string): Set<string> {
    const refs = new Set<string>();
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, "text/xml");
    if (doc.querySelector("parsererror")) return refs;
    const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_ELEMENT);
    let node: Node | null = walker.currentNode;
    while (node) {
      if (node instanceof Element) {
        for (const attr of FILE_ATTRS) {
          const val = node.getAttribute(attr)?.trim();
          if (val) refs.add(val);
        }
      }
      node = walker.nextNode();
    }
    return refs;
  }

  function extractPresetRefs(xmlText: string): Set<string> {
    const names = new Set<string>();
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, "text/xml");
    if (doc.querySelector("parsererror")) return names;
    const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_ELEMENT);
    let node: Node | null = walker.currentNode;
    while (node) {
      if (node instanceof Element) {
        const pname = node.getAttribute("presetName")?.trim();
        if (pname) names.add(pname);
        const pslot = node.getAttribute("presetSlot");
        if (pslot !== null) {
          const tag = node.tagName.toLowerCase();
          if (tag === "kit" || tag === "sound") {
            const sub = node.getAttribute("presetSubSlot") ?? "";
            const folder = tag === "kit" ? "KITS" : "SYNTHS";
            names.add(`${folder}/${pslot}/${sub}`);
          }
        }
      }
      node = walker.nextNode();
    }
    return names;
  }

  async function readDirHandle(
    dirHandle: FileSystemDirectoryHandle,
    path: string,
    fileMap: Map<string, File>,
  ) {
    for await (const entry of (dirHandle as any).values()) {
      const entryPath = path ? `${path}/${entry.name}` : entry.name;
      if (entry.kind === "file") {
        const file = await (entry as FileSystemFileHandle).getFile();
        fileMap.set(entryPath, file);
      } else if (entry.kind === "directory") {
        if (entry.name === TRASH_DIR) continue;
        await readDirHandle(entry as FileSystemDirectoryHandle, entryPath, fileMap);
      }
    }
  }

  async function scanFromHandle(handle: FileSystemDirectoryHandle) {
    rootHandle = handle;
    canWrite = true;
    cardName = handle.name;

    state = "processing";
    progress = "Indexing files...";
    await new Promise(r => setTimeout(r, 0));

    const filesByPath = new Map<string, File>();
    await readDirHandle(handle, "", filesByPath);
    await runScan(filesByPath, "");
  }

  async function scanCard(files: File[]) {
    canWrite = false;
    rootHandle = null;
    state = "processing";
    progress = "Indexing files...";

    await new Promise(r => setTimeout(r, 0));

    const filesByPath = new Map<string, File>();
    let rootPrefix = "";

    for (const f of files) {
      const rel = (f as any).webkitRelativePath as string || f.name;
      filesByPath.set(rel, f);
    }

    const firstPath = files[0] && ((files[0] as any).webkitRelativePath as string);
    if (firstPath) {
      rootPrefix = firstPath.split("/")[0] + "/";
      cardName = firstPath.split("/")[0];
    }

    await runScan(filesByPath, rootPrefix);
  }

  async function runScan(filesByPath: Map<string, File>, rootPrefix: string) {
    const stripRoot = (p: string) => rootPrefix && p.startsWith(rootPrefix) ? p.slice(rootPrefix.length) : p;

    const hasSamples = [...filesByPath.keys()].some(p => {
      const rel = stripRoot(p);
      return rel.toUpperCase().startsWith("SAMPLES/");
    });
    if (!hasSamples) {
      state = "error";
      errorMsg = "Not a Deluge SD card: no SAMPLES directory found. Select the SD card root folder.";
      return;
    }

    const allSamples = new Map<string, number>();
    for (const [path, file] of filesByPath) {
      const rel = stripRoot(path);
      if (rel.toUpperCase().startsWith("SAMPLES/") && AUDIO_EXTENSIONS.has(ext(rel))) {
        allSamples.set(rel, file.size);
      }
    }

    progress = "Scanning XML references...";
    await new Promise(r => setTimeout(r, 0));

    const refSources = new Map<string, Set<string>>();
    const xmlFiles: [string, File][] = [];
    for (const [path, file] of filesByPath) {
      const rel = stripRoot(path);
      const dir = topDir(rel).toUpperCase();
      if (XML_DIRS.includes(dir) && ext(rel) === "xml") {
        xmlFiles.push([rel, file]);
      }
    }

    let xmlDone = 0;
    for (const [rel, file] of xmlFiles) {
      const text = await file.text();
      for (const ref of extractFileRefs(text)) {
        if (!refSources.has(ref)) refSources.set(ref, new Set());
        refSources.get(ref)!.add(rel);
      }
      xmlDone++;
      if (xmlDone % 20 === 0) {
        progress = `Scanning XML references... ${xmlDone}/${xmlFiles.length}`;
        await new Promise(r => setTimeout(r, 0));
      }
    }

    const sampleRefs = new Map<string, Set<string>>();
    for (const [ref, sources] of refSources) {
      if (ref.startsWith("SAMPLES/")) sampleRefs.set(ref, sources);
    }
    const sampleKeys = new Set(allSamples.keys());
    const unused = [...sampleKeys].filter(k => !sampleRefs.has(k)).sort();
    const missing: MissingRef[] = [...sampleRefs.entries()]
      .filter(([r]) => !sampleKeys.has(r))
      .map(([r, sources]) => ({ sample: r, referencedBy: [...sources].sort() }))
      .sort((a, b) => a.sample.localeCompare(b.sample));
    const totalBytes = [...allSamples.values()].reduce((a, b) => a + b, 0);
    const reclaimable = unused.reduce((sum, k) => sum + (allSamples.get(k) ?? 0), 0);

    progress = "Checking presets...";
    await new Promise(r => setTimeout(r, 0));

    const presetNames = new Set<string>();
    for (const [rel, file] of xmlFiles) {
      if (topDir(rel).toUpperCase() === "SONGS") {
        const text = await file.text();
        for (const name of extractPresetRefs(text)) {
          presetNames.add(name);
        }
      }
    }

    const unusedPresets: string[] = [];
    for (const [rel, file] of xmlFiles) {
      const dir = topDir(rel).toUpperCase();
      if (dir === "KITS" || dir === "SYNTHS") {
        const basename = rel.split("/").pop() ?? "";
        const stem = basename.replace(/\.xml$/i, "");
        const isUsed = [...presetNames].some(n => n === stem || n.includes(stem));
        if (!isUsed) {
          unusedPresets.push(rel);
        }
      }
    }
    unusedPresets.sort();

    const handles = new Map<string, File>();
    for (const [path, file] of filesByPath) {
      const rel = stripRoot(path);
      if (rel.toUpperCase().startsWith("SAMPLES/") && AUDIO_EXTENSIONS.has(ext(rel))) {
        handles.set(rel, file);
      }
    }
    fileHandles = handles;
    movedFiles = new Set();

    progress = "Finding duplicates (grouping by size)...";
    await new Promise(r => setTimeout(r, 0));

    const sizeGroups = new Map<number, string[]>();
    for (const [path, size] of allSamples) {
      const group = sizeGroups.get(size);
      if (group) group.push(path);
      else sizeGroups.set(size, [path]);
    }

    const candidates = new Map<string, File>();
    for (const [size, paths] of sizeGroups) {
      if (paths.length < 2 || size === 0) continue;
      for (const p of paths) {
        const file = handles.get(p);
        if (file) candidates.set(p, file);
      }
    }

    const hashGroups = new Map<string, { size: number; files: string[] }>();
    let hashDone = 0;
    const totalToHash = candidates.size;

    for (const [path, file] of candidates) {
      const buf = await file.arrayBuffer();
      const hashBuf = await crypto.subtle.digest("SHA-256", buf);
      const hashArr = new Uint8Array(hashBuf);
      const hash = Array.from(hashArr, b => b.toString(16).padStart(2, "0")).join("");

      const existing = hashGroups.get(hash);
      if (existing) {
        existing.files.push(path);
      } else {
        hashGroups.set(hash, { size: file.size, files: [path] });
      }

      hashDone++;
      if (hashDone % 50 === 0) {
        progress = `Finding duplicates (hashing ${hashDone}/${totalToHash})...`;
        await new Promise(r => setTimeout(r, 0));
      }
    }

    const duplicates: DuplicateGroup[] = [];
    let duplicateWastedBytes = 0;
    for (const [hash, { size, files }] of hashGroups) {
      if (files.length < 2) continue;
      files.sort();
      duplicates.push({ hash, size, files });
      duplicateWastedBytes += size * (files.length - 1);
    }
    duplicates.sort((a, b) => (b.size * (b.files.length - 1)) - (a.size * (a.files.length - 1)));

    report = {
      totalSamples: allSamples.size,
      totalSamplesBytes: totalBytes,
      totalReferences: sampleRefs.size,
      unusedSamples: unused,
      missingReferences: missing,
      unusedPresets,
      reclaimableBytes: reclaimable,
      duplicates,
      duplicateWastedBytes,
    };
    state = "done";
    saveToSession();
  }

  async function moveSample(samplePath: string) {
    if (!rootHandle || movedFiles.has(samplePath) || movingFiles.has(samplePath)) return;

    const next = new Set(movingFiles);
    next.add(samplePath);
    movingFiles = next;

    try {
      await moveToTrash(rootHandle, samplePath);

      const moved = new Set(movedFiles);
      moved.add(samplePath);
      movedFiles = moved;
    } catch (e: any) {
      console.error(`Failed to move ${samplePath}:`, e);
    } finally {
      const rm = new Set(movingFiles);
      rm.delete(samplePath);
      movingFiles = rm;
    }
  }

  async function moveAllUnused() {
    if (!rootHandle || !report) return;
    const toMove = report.unusedSamples.filter(s => !movedFiles.has(s));
    for (const s of toMove) {
      await moveSample(s);
    }
  }

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  async function openDirectoryPicker() {
    try {
      const handle = await (window as any).showDirectoryPicker({ mode: "readwrite" });
      await scanFromHandle(handle);
    } catch (e: any) {
      if (e.name !== "AbortError") {
        state = "error";
        errorMsg = e.message || "Failed to open directory";
      }
    }
  }

  function handleInputChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (files?.length) scanCard(Array.from(files));
  }

  async function readEntryRecursive(entry: FileSystemEntry): Promise<File[]> {
    if (entry.isFile) {
      return new Promise((resolve) => {
        (entry as FileSystemFileEntry).file(
          (f) => resolve([f]),
          () => resolve([]),
        );
      });
    }
    if (entry.isDirectory) {
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
      const nested = await Promise.all(entries.map(readEntryRecursive));
      return nested.flat();
    }
    return [];
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    const items = e.dataTransfer?.items;
    if (items) {
      const entries = Array.from(items)
        .map(item => item.webkitGetAsEntry?.())
        .filter((e): e is FileSystemEntry => e != null);
      if (entries.length > 0) {
        const allFiles = (await Promise.all(entries.map(readEntryRecursive))).flat();
        await scanCard(allFiles);
        return;
      }
    }
    const files = e.dataTransfer?.files;
    if (files?.length) await scanCard(Array.from(files));
  }

  function exportJson() {
    if (!report) return;
    const data = {
      total_samples: report.totalSamples,
      total_samples_bytes: report.totalSamplesBytes,
      total_references: report.totalReferences,
      unused_samples: report.unusedSamples,
      missing_references: report.missingReferences.map(m => ({ sample: m.sample, referenced_by: m.referencedBy })),
      unused_presets: report.unusedPresets,
      reclaimable_bytes: report.reclaimableBytes,
      duplicates: (report.duplicates ?? []).map(d => ({ hash: d.hash, size: d.size, files: d.files })),
      duplicate_wasted_bytes: report.duplicateWastedBytes ?? 0,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `deluge-clean-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const CACHE_KEY = "deluge-clean-report";
  const CACHE_KEY_NAME = "deluge-clean-name";

  function saveToSession() {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(report));
      sessionStorage.setItem(CACHE_KEY_NAME, cardName);
    } catch {}
  }

  function restoreFromSession(): boolean {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return false;
      const cached = JSON.parse(raw);
      if (!cached) return false;
      cached.duplicates ??= [];
      cached.duplicateWastedBytes ??= 0;
      report = cached;
      cardName = sessionStorage.getItem(CACHE_KEY_NAME) ?? "";
      state = "done";
      return true;
    } catch {
      return false;
    }
  }

  restoreFromSession();

  function reset() {
    if (currentAudio) {
      currentAudio.pause();
      URL.revokeObjectURL(currentAudio.src);
      currentAudio = null;
      playingFile = null;
    }
    state = "idle";
    report = null;
    errorMsg = "";
    cardName = "";
    showList = false;
    fileHandles = new Map();
    rootHandle = null;
    canWrite = false;
    movedFiles = new Set();
    movingFiles = new Set();
    try {
      sessionStorage.removeItem(CACHE_KEY);
      sessionStorage.removeItem(CACHE_KEY_NAME);
    } catch {}
  }

  let filteredUnused = $derived(
    listCategory === "all" || listCategory === "samples" ? (report?.unusedSamples ?? []) : []
  );
  let filteredMissing = $derived(
    listCategory === "all" || listCategory === "missing" ? (report?.missingReferences ?? []) : []
  );
  let filteredPresets = $derived(
    listCategory === "all" || listCategory === "presets" ? (report?.unusedPresets ?? []) : []
  );
  let filteredDuplicates = $derived(
    listCategory === "all" || listCategory === "duplicates" ? (report?.duplicates ?? []) : []
  );

  interface FolderNode {
    name: string;
    files: string[];
    children: Map<string, FolderNode>;
    totalFiles: number;
  }

  function buildTree(paths: string[]): FolderNode {
    const root: FolderNode = { name: "", files: [], children: new Map(), totalFiles: paths.length };
    for (const p of paths) {
      const parts = p.split("/");
      const fileName = parts.pop()!;
      let node = root;
      for (const part of parts) {
        if (!node.children.has(part)) {
          node.children.set(part, { name: part, files: [], children: new Map(), totalFiles: 0 });
        }
        node = node.children.get(part)!;
      }
      node.files.push(fileName);
    }
    function computeTotals(node: FolderNode): number {
      let total = node.files.length;
      for (const child of node.children.values()) {
        total += computeTotals(child);
      }
      node.totalFiles = total;
      return total;
    }
    computeTotals(root);
    return root;
  }

  let unusedTree = $derived(buildTree(filteredUnused));
  let presetsTree = $derived(buildTree(filteredPresets));

  interface MissingFolderNode {
    name: string;
    entries: MissingRef[];
    children: Map<string, MissingFolderNode>;
    totalEntries: number;
  }

  function buildMissingTree(refs: MissingRef[]): MissingFolderNode {
    const root: MissingFolderNode = { name: "", entries: [], children: new Map(), totalEntries: refs.length };
    for (const ref of refs) {
      const parts = ref.sample.split("/");
      const fileName = parts.pop()!;
      let node = root;
      for (const part of parts) {
        if (!node.children.has(part)) {
          node.children.set(part, { name: part, entries: [], children: new Map(), totalEntries: 0 });
        }
        node = node.children.get(part)!;
      }
      node.entries.push({ sample: fileName, referencedBy: ref.referencedBy });
    }
    function computeTotals(node: MissingFolderNode): number {
      let total = node.entries.length;
      for (const child of node.children.values()) total += computeTotals(child);
      node.totalEntries = total;
      return total;
    }
    computeTotals(root);
    return root;
  }

  let missingTree = $derived(buildMissingTree(filteredMissing));
  let expandedDirs = $state(new Set<string>());

  function toggleDir(path: string) {
    const next = new Set(expandedDirs);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    expandedDirs = next;
  }

  function playSample(samplePath: string) {
    if (currentAudio) {
      currentAudio.pause();
      URL.revokeObjectURL(currentAudio.src);
      if (playingFile === samplePath) {
        currentAudio = null;
        playingFile = null;
        return;
      }
    }
    const file = fileHandles.get(samplePath);
    if (!file) return;
    const url = URL.createObjectURL(file);
    const audio = new Audio(url);
    audio.onended = () => {
      URL.revokeObjectURL(url);
      playingFile = null;
      currentAudio = null;
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      playingFile = null;
      currentAudio = null;
    };
    audio.play();
    currentAudio = audio;
    playingFile = samplePath;
  }
</script>

{#if state === "idle"}
  <div
    class="dropzone"
    class:dropzone--over={dragOver}
    role="button"
    tabindex="0"
    ondrop={handleDrop}
    ondragover={(e) => { e.preventDefault(); dragOver = true; }}
    ondragleave={() => { dragOver = false; }}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { if (hasFileSystemAccess) openDirectoryPicker(); else document.getElementById('clean-folder-input')?.click(); }}}
  >
    <div class="dropzone-content">
      <span class="dropzone-icon">#</span>
      <p class="dropzone-title">Select your SD card folder</p>
      <p class="dropzone-sub">
        {#if hasFileSystemAccess}
          <button class="dropzone-browse" onclick={openDirectoryPicker}>Browse for folder</button>
        {:else}
          <label class="dropzone-browse">Browse for folder<input id="clean-folder-input" type="file" webkitdirectory onchange={handleInputChange} hidden /></label>
        {/if}
        or drag &amp; drop
      </p>
      <p class="dropzone-hint">
        Scans SONGS/, KITS/, SYNTHS/, and SAMPLES/ directories
        {#if !hasFileSystemAccess}
          <br/><span class="dropzone-hint-warn">Use Chrome or Edge to enable sample playback and cleanup</span>
        {/if}
      </p>
    </div>
  </div>

{:else if state === "processing"}
  <div class="status-card">
    <div class="status-msg">{progress}</div>
    <div class="progress-bar">
      <div class="progress-fill progress-fill--indeterminate"></div>
    </div>
  </div>

{:else if state === "done" && report}
  <div class="results">
    <div class="summary-card">
      <h2 class="summary-title">{cardName || "Deluge SD Card"}</h2>
      <div class="summary-divider"></div>

      <div class="summary-grid">
        <div class="stat">
          <span class="stat-value">{report.totalSamples.toLocaleString()}</span>
          <span class="stat-label">samples ({formatBytes(report.totalSamplesBytes)})</span>
        </div>
        <div class="stat">
          <span class="stat-value">{report.totalReferences.toLocaleString()}</span>
          <span class="stat-label">referenced</span>
        </div>
        <div class="stat" class:stat--warn={report.unusedSamples.length > 0}>
          <span class="stat-value">{report.unusedSamples.length.toLocaleString()}</span>
          <span class="stat-label">
            unused
            {#if report.reclaimableBytes > 0}
              ({formatBytes(report.reclaimableBytes)} reclaimable)
            {/if}
          </span>
        </div>
        {#if report.missingReferences.length > 0}
          <div class="stat stat--error">
            <span class="stat-value">{report.missingReferences.length.toLocaleString()}</span>
            <span class="stat-label">broken refs (referenced but missing)</span>
          </div>
        {/if}
        {#if report.unusedPresets.length > 0}
          <div class="stat stat--warn">
            <span class="stat-value">{report.unusedPresets.length.toLocaleString()}</span>
            <span class="stat-label">orphan presets (not used by any song)</span>
          </div>
        {/if}
        {#if report.duplicates.length > 0}
          <div class="stat stat--warn">
            <span class="stat-value">{report.duplicates.length.toLocaleString()}</span>
            <span class="stat-label">
              duplicate groups ({report.duplicates.reduce((s, d) => s + d.files.length, 0)} files, {formatBytes(report.duplicateWastedBytes)} wasted)
            </span>
          </div>
        {/if}
      </div>

      {#if movedCount > 0}
        <p class="moved-msg">
          Moved {movedCount} file{movedCount === 1 ? "" : "s"} to {TRASH_DIR}/
        </p>
      {/if}

      {#if report.unusedSamples.length === 0 && report.missingReferences.length === 0 && report.unusedPresets.length === 0 && (report.duplicates?.length ?? 0) === 0}
        <p class="clean-msg">Your card is clean — every sample is referenced, every preset is used, no duplicates.</p>
      {/if}
    </div>

    <div class="actions">
      <button class="btn btn-secondary btn-sm" onclick={() => { showList = !showList; }}>
        {showList ? "Hide" : "Show"} file list
      </button>
      {#if canWrite && report.unusedSamples.length > 0}
        <button
          class="btn btn-accent btn-sm"
          onclick={moveAllUnused}
          disabled={movedCount === report.unusedSamples.length}
        >
          {movedCount === report.unusedSamples.length
            ? `All moved to ${TRASH_DIR}/`
            : movedCount > 0
              ? `Move remaining ${report.unusedSamples.length - movedCount} to ${TRASH_DIR}/`
              : `Move all ${report.unusedSamples.length} unused to ${TRASH_DIR}/`}
        </button>
      {/if}
      <button class="btn btn-secondary btn-sm" onclick={exportJson}>Export JSON</button>
      <button class="btn btn-secondary btn-sm" onclick={reset}>Scan another</button>
    </div>

    {#if showList}
      <div class="list-section">
        <div class="list-tabs">
          {#each [
            { id: "all", label: "All" },
            { id: "samples", label: `Unused (${report.unusedSamples.length})` },
            { id: "missing", label: `Missing (${report.missingReferences.length})` },
            { id: "presets", label: `Presets (${report.unusedPresets.length})` },
            { id: "duplicates", label: `Duplicates (${report.duplicates.length})` },
          ] as tab}
            <button
              class="list-tab"
              class:list-tab--active={listCategory === tab.id}
              onclick={() => { listCategory = tab.id as any; }}
            >{tab.label}</button>
          {/each}
        </div>

        {#if filteredUnused.length > 0}
          <div class="list-group">
            <h4 class="list-heading">Unused samples ({filteredUnused.length})</h4>
            <div class="file-tree">
              {#snippet folderChildren(node: FolderNode, path: string)}
                {#each [...node.children.entries()].sort((a, b) => b[1].totalFiles - a[1].totalFiles) as [name, child]}
                  {@const fullPath = path ? `${path}/${name}` : name}
                  {@const isOpen = expandedDirs.has(fullPath)}
                  <div class="tree-item">
                    <button class="tree-dir" onclick={() => toggleDir(fullPath)}>
                      <span class="tree-arrow">{isOpen ? "▾" : "▸"}</span>
                      <span class="tree-dir-name">{name}/</span>
                      <span class="tree-count">{child.totalFiles}</span>
                    </button>
                    {#if isOpen}
                      <div class="tree-children">
                        {@render folderChildren(child, fullPath)}
                        {#each child.files.sort() as file}
                          {@const filePath = fullPath ? `${fullPath}/${file}` : file}
                          {@const isMoved = movedFiles.has(filePath)}
                          {@const isMoving = movingFiles.has(filePath)}
                          <div class="tree-file tree-file--sample" class:tree-file--moved={isMoved}>
                            {#if !isMoved}
                              <button
                                class="play-btn"
                                class:play-btn--active={playingFile === filePath}
                                onclick={() => playSample(filePath)}
                                title={playingFile === filePath ? "Stop" : "Play"}
                              >{playingFile === filePath ? "◼" : "▶"}</button>
                            {/if}
                            <span class="tree-file-name">{file}</span>
                            {#if isMoved}
                              <span class="tree-file-badge">moved</span>
                            {:else if canWrite}
                              <button
                                class="move-btn"
                                onclick={() => moveSample(filePath)}
                                disabled={isMoving}
                                title="Move to {TRASH_DIR}/"
                              >{isMoving ? "..." : "×"}</button>
                            {/if}
                          </div>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/each}
              {/snippet}
              {@render folderChildren(unusedTree, "")}
            </div>
          </div>
        {/if}

        {#if filteredMissing.length > 0}
          <div class="list-group">
            <h4 class="list-heading">Broken references ({filteredMissing.length})</h4>
            <div class="file-tree">
              {#snippet missingChildren(node: MissingFolderNode, path: string)}
                {#each [...node.children.entries()].sort((a, b) => b[1].totalEntries - a[1].totalEntries) as [name, child]}
                  {@const fullPath = path ? `${path}/${name}` : name}
                  {@const isOpen = expandedDirs.has(fullPath)}
                  <div class="tree-item">
                    <button class="tree-dir" onclick={() => toggleDir(fullPath)}>
                      <span class="tree-arrow">{isOpen ? "▾" : "▸"}</span>
                      <span class="tree-dir-name">{name}/</span>
                      <span class="tree-count">{child.totalEntries}</span>
                    </button>
                    {#if isOpen}
                      <div class="tree-children">
                        {@render missingChildren(child, fullPath)}
                        {#each child.entries.sort((a, b) => a.sample.localeCompare(b.sample)) as entry}
                          <div class="tree-file tree-file--missing">
                            <span>{entry.sample}</span>
                            <span class="missing-source">← {entry.referencedBy.join(", ")}</span>
                          </div>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/each}
              {/snippet}
              {@render missingChildren(missingTree, "")}
            </div>
          </div>
        {/if}

        {#if filteredPresets.length > 0}
          <div class="list-group">
            <h4 class="list-heading">Orphan presets ({filteredPresets.length})</h4>
            <div class="file-tree">
              {#snippet presetChildren(node: FolderNode, path: string)}
                {#each [...node.children.entries()].sort((a, b) => b[1].totalFiles - a[1].totalFiles) as [name, child]}
                  {@const fullPath = path ? `${path}/${name}` : name}
                  {@const isOpen = expandedDirs.has(fullPath)}
                  <div class="tree-item">
                    <button class="tree-dir" onclick={() => toggleDir(fullPath)}>
                      <span class="tree-arrow">{isOpen ? "▾" : "▸"}</span>
                      <span class="tree-dir-name">{name}/</span>
                      <span class="tree-count">{child.totalFiles}</span>
                    </button>
                    {#if isOpen}
                      <div class="tree-children">
                        {@render presetChildren(child, fullPath)}
                        {#each child.files.sort() as file}
                          <div class="tree-file">{file}</div>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/each}
              {/snippet}
              {@render presetChildren(presetsTree, "")}
            </div>
          </div>
        {/if}

        {#if filteredDuplicates.length > 0}
          <div class="list-group">
            <h4 class="list-heading">Duplicate samples ({filteredDuplicates.length} groups)</h4>
            <div class="dup-list">
              {#each filteredDuplicates as group, i}
                <div class="dup-group">
                  <div class="dup-header">
                    <span class="dup-label">Group {i + 1}</span>
                    <span class="dup-meta">{group.files.length} copies · {formatBytes(group.size)} each · {formatBytes(group.size * (group.files.length - 1))} wasted</span>
                  </div>
                  {#each group.files as filePath}
                    <div class="tree-file tree-file--sample">
                      <button
                        class="play-btn"
                        class:play-btn--active={playingFile === filePath}
                        onclick={() => playSample(filePath)}
                        title={playingFile === filePath ? "Stop" : "Play"}
                      >{playingFile === filePath ? "◼" : "▶"}</button>
                      <span class="tree-file-name" title={filePath}>{filePath}</span>
                    </div>
                  {/each}
                </div>
              {/each}
            </div>
          </div>
        {/if}

        {#if filteredUnused.length === 0 && filteredMissing.length === 0 && filteredPresets.length === 0 && filteredDuplicates.length === 0}
          <p class="list-empty">Nothing to list in this category.</p>
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
  .dropzone-hint-warn {
    color: var(--accent);
    opacity: 1;
  }

  .status-card, .error-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 2rem;
  }
  .status-msg {
    font-family: 'DM Mono', monospace;
    font-size: 0.85rem;
    color: var(--text-secondary);
    margin-bottom: 1rem;
  }
  .progress-bar {
    height: 3px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
  }
  .progress-fill--indeterminate {
    height: 100%;
    width: 30%;
    background: var(--accent);
    border-radius: 2px;
    animation: slide 1.2s ease-in-out infinite;
  }
  @keyframes slide {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(400%); }
  }

  .summary-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.5rem;
  }
  .summary-title {
    font-family: 'DM Mono', monospace;
    font-size: 1.1rem;
    font-weight: 500;
    margin-bottom: 0.75rem;
  }
  .summary-divider {
    height: 1px;
    background: var(--border);
    margin-bottom: 1rem;
  }
  .summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 1rem;
  }
  .stat {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .stat-value {
    font-family: 'DM Mono', monospace;
    font-size: 1.1rem;
    font-weight: 500;
    color: var(--text);
  }
  .stat--warn .stat-value { color: var(--accent); }
  .stat--error .stat-value { color: #c47a7a; }
  .stat-label {
    font-size: 0.78rem;
    color: var(--text-secondary);
  }
  .clean-msg {
    margin-top: 1rem;
    font-size: 0.88rem;
    color: var(--teal);
  }
  .moved-msg {
    margin-top: 1rem;
    font-size: 0.85rem;
    font-family: 'DM Mono', monospace;
    color: var(--teal);
  }

  .actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 1rem;
    flex-wrap: wrap;
  }

  .list-section {
    margin-top: 1rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .list-tabs {
    display: flex;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .list-tab {
    font-family: 'DM Mono', monospace;
    font-size: 0.78rem;
    font-weight: 500;
    padding: 0.6rem 1rem;
    border: none;
    background: none;
    color: var(--text-secondary);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .list-tab:hover { color: var(--text); }
  .list-tab--active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  .list-group {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
  }
  .list-group:last-child { border-bottom: none; }
  .list-heading {
    font-family: 'DM Mono', monospace;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--text-secondary);
    margin-bottom: 0.4rem;
  }
  .file-list {
    list-style: none;
    padding: 0;
    margin: 0;
    font-family: 'DM Mono', monospace;
    font-size: 0.78rem;
    max-height: 400px;
    overflow-y: auto;
  }
  .file-list li {
    padding: 0.2rem 0;
    color: var(--text);
  }
  .missing-sample {
    color: var(--text);
  }
  .missing-source {
    color: var(--text-secondary);
    font-size: 0.72rem;
    margin-left: 0.5rem;
  }
  .file-tree {
    font-family: 'DM Mono', monospace;
    font-size: 0.78rem;
    max-height: 500px;
    overflow-y: auto;
  }
  .tree-item {
    margin: 0;
  }
  .tree-dir {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    width: 100%;
    padding: 0.25rem 0;
    border: none;
    background: none;
    color: var(--text);
    cursor: pointer;
    font-family: inherit;
    font-size: inherit;
    text-align: left;
  }
  .tree-dir:hover {
    color: var(--accent);
  }
  .tree-arrow {
    width: 0.8rem;
    flex-shrink: 0;
    color: var(--text-secondary);
  }
  .tree-dir-name {
    font-weight: 500;
  }
  .tree-count {
    color: var(--text-secondary);
    font-size: 0.72rem;
    margin-left: auto;
  }
  .tree-children {
    padding-left: 1.1rem;
    border-left: 1px solid var(--border);
    margin-left: 0.35rem;
  }
  .tree-file {
    padding: 0.15rem 0;
    color: var(--text-secondary);
  }
  .tree-file--sample {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }
  .tree-file--moved {
    opacity: 0.4;
  }
  .tree-file-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tree-file-badge {
    font-size: 0.65rem;
    color: var(--teal);
    border: 1px solid var(--teal);
    border-radius: 3px;
    padding: 0 0.3rem;
    flex-shrink: 0;
  }
  .play-btn {
    flex-shrink: 0;
    width: 1.4rem;
    height: 1.4rem;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: none;
    color: var(--text-secondary);
    font-size: 0.6rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    line-height: 1;
  }
  .play-btn:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
  .play-btn--active {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-dim);
  }
  .move-btn {
    flex-shrink: 0;
    width: 1.4rem;
    height: 1.4rem;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: none;
    color: var(--text-secondary);
    font-size: 0.75rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    line-height: 1;
  }
  .move-btn:hover {
    color: #c47a7a;
    border-color: #c47a7a;
  }
  .move-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .tree-file--missing {
    display: flex;
    flex-wrap: wrap;
    gap: 0 0.5rem;
    color: var(--text);
  }

  .dup-list {
    font-family: 'DM Mono', monospace;
    font-size: 0.78rem;
    max-height: 500px;
    overflow-y: auto;
  }
  .dup-group {
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border);
  }
  .dup-group:last-child { border-bottom: none; }
  .dup-header {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    margin-bottom: 0.3rem;
  }
  .dup-label {
    font-weight: 500;
    color: var(--text);
  }
  .dup-meta {
    font-size: 0.72rem;
    color: var(--text-secondary);
  }

  .list-empty {
    padding: 1.5rem 1rem;
    text-align: center;
    font-size: 0.85rem;
    color: var(--text-secondary);
  }

  .error-card { border-color: #c47a7a; }
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
  .btn-sm { padding: 0.4rem 0.9rem; font-size: 0.78rem; }
  .btn-secondary {
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
  }
  .btn-secondary:hover { background: var(--surface); }
  .btn-accent {
    background: var(--accent);
    color: var(--bg);
    border: 1px solid var(--accent);
  }
  .btn-accent:hover { opacity: 0.9; }
  .btn-accent:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
