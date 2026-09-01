<script lang="ts">
  import {
    type Kit,
    type KitRow,
    createEmptyKit,
    createEmptyRow,
    parseKitXml,
    generateKitXml,
  } from "../lib/kitXml";
  import { cardStore } from "../lib/cardStore";
  import { tick } from "svelte";

  type Pane = "browser" | "kit";
  type Mode = "normal" | "rename" | "help" | "search";

  let kit: Kit = $state(createEmptyKit());
  let mode: Mode = $state("normal");
  let activePane: Pane = $state("browser");
  let pendingD = $state(false);
  let renameValue = $state("");
  let playingAudio: { index: number; audio: HTMLAudioElement; url: string } | null = $state(null);
  let loadedFileName = $state("");

  let samplesDir: FileSystemDirectoryHandle | null = $state(null);
  let reconnectAvailable = $state(false);
  let rootEntries: TreeEntry[] = $state([]);
  let flatEntries: TreeEntry[] = $state([]);
  let browseIndex = $state(0);
  let searchQuery = $state("");
  let searchInput: HTMLInputElement | undefined = $state();
  let renameInput: HTMLInputElement | undefined = $state();
  let containerEl: HTMLDivElement | undefined = $state();
  let browserListEl: HTMLDivElement | undefined = $state();
  let kitListEl: HTMLDivElement | undefined = $state();

  interface TreeEntry {
    name: string;
    path: string;
    kind: "file" | "directory";
    handle: FileSystemHandle;
    depth: number;
    expanded: boolean;
    children: TreeEntry[] | null;
    parent: TreeEntry | null;
  }

  let newRowIndex = $state(-1);

  let selectedRow = $derived(
    kit.selectedIndex >= 0 && kit.selectedIndex < kit.rows.length
      ? kit.rows[kit.selectedIndex]
      : null
  );

  let visibleEntries = $derived.by(() => {
    if (!searchQuery) return flatEntries;
    const q = searchQuery.toLowerCase();
    return flatEntries.filter(
      (e) => e.kind === "directory" || e.name.toLowerCase().includes(q)
    );
  });

  const LOOP_MODES: KitRow["loopMode"][] = ["once", "loop", "cut"];
  const POLY_MODES: KitRow["polyphonic"][] = ["auto", "choke", "mono", "poly"];
  const LOOP_LABELS: Record<KitRow["loopMode"], string> = { once: "ONE", loop: "LOOP", cut: "CUT" };
  const POLY_LABELS: Record<KitRow["polyphonic"], string> = { auto: "AUTO", choke: "CHOKE", mono: "MONO", poly: "POLY" };

  $effect(() => { containerEl?.focus(); });

  $effect(() => {
    void browseIndex;
    void kit.selectedIndex;
    if (activePane === "browser" && browserListEl) {
      const sel = browserListEl.querySelector(".browse-entry--selected");
      sel?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    if (activePane === "kit" && kitListEl) {
      const sel = kitListEl.querySelector(".kit-row--selected");
      sel?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });

  // --- Directory browsing ---

  async function openSamplesDir() {
    try {
      samplesDir = await (window as any).showDirectoryPicker({ mode: "read" });
    } catch { return; }
    rootEntries = await listDirectory(samplesDir!, "", 0, null);
    rebuildFlat();
    browseIndex = 0;
    activePane = "browser";
  }

  /** Loads the SAMPLES/ dir from an already-picked SD card root (from /stats or /clean) instead of prompting again. */
  async function loadSamplesFromRoot(root: FileSystemDirectoryHandle) {
    try {
      samplesDir = await (root as any).getDirectoryHandle("SAMPLES");
    } catch { return; }
    rootEntries = await listDirectory(samplesDir!, "", 0, null);
    rebuildFlat();
    browseIndex = 0;
    activePane = "browser";
  }

  async function tryAutoLoadFromCardStore() {
    try {
      const handle = await cardStore.reconnectHandleOnly();
      if (handle) {
        await loadSamplesFromRoot(handle);
      } else if (await cardStore.hasPersistedHandle()) {
        reconnectAvailable = true;
      }
    } catch {}
  }

  async function reconnectSamplesDir() {
    try {
      const handle = await cardStore.reconnectHandleOnly(true);
      if (handle) {
        reconnectAvailable = false;
        await loadSamplesFromRoot(handle);
      }
    } catch {}
  }

  tryAutoLoadFromCardStore();

  async function listDirectory(
    dir: FileSystemDirectoryHandle, parentPath: string, depth: number, parent: TreeEntry | null
  ): Promise<TreeEntry[]> {
    const entries: TreeEntry[] = [];
    for await (const [name, handle] of (dir as any).entries()) {
      const path = parentPath ? `${parentPath}/${name}` : name;
      entries.push({ name, path, kind: handle.kind, handle, depth, expanded: false, children: null, parent });
    }
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return entries;
  }

  function rebuildFlat() {
    const result: TreeEntry[] = [];
    function walk(entries: TreeEntry[]) {
      for (const e of entries) {
        result.push(e);
        if (e.expanded && e.children) walk(e.children);
      }
    }
    walk(rootEntries);
    flatEntries = result;
  }

  async function expandEntry(entry: TreeEntry) {
    if (entry.kind !== "directory" || entry.expanded) return;
    entry.children = await listDirectory(entry.handle as FileSystemDirectoryHandle, entry.path, entry.depth + 1, entry);
    entry.expanded = true;
    rebuildFlat();
  }

  function collapseEntry(entry: TreeEntry) {
    if (entry.kind !== "directory" || !entry.expanded) return;
    entry.expanded = false;
    rebuildFlat();
    browseIndex = Math.min(browseIndex, visibleEntries.length - 1);
  }

  async function addSampleToKit(entry: TreeEntry) {
    if (entry.kind !== "file") return;
    const dirName = samplesDir?.name ?? "SAMPLES";
    const row = createEmptyRow(
      entry.name.replace(/\.[^.]+$/, "").toUpperCase().slice(0, 16),
      `${dirName}/${entry.path}`
    );
    row.fileHandle = entry.handle as FileSystemFileHandle;
    kit.rows.push(row);
    kit.selectedIndex = kit.rows.length - 1;
    newRowIndex = kit.rows.length - 1;
    await tick();
    if (kitListEl) {
      kitListEl.scrollTop = kitListEl.scrollHeight;
    }
    setTimeout(() => { newRowIndex = -1; }, 1500);
  }

  // --- Audio preview ---

  async function auditionBrowserEntry(entry: TreeEntry) {
    if (entry.kind !== "file") return;
    stopPlayback();
    try {
      const fh = entry.handle as FileSystemFileHandle;
      const file = await fh.getFile();
      if (!file.type.startsWith("audio/") && !file.name.match(/\.(wav|mp3|ogg|flac|aif|aiff)$/i)) return;
      const url = URL.createObjectURL(file);
      const audio = new Audio(url);
      audio.onended = () => { stopPlayback(); };
      audio.play();
      playingAudio = { index: -1, audio, url };
    } catch { /* ignore */ }
  }

  async function auditionKitRow(i: number) {
    stopPlayback();
    const row = kit.rows[i];
    if (!row?.fileHandle) return;
    try {
      const file = await row.fileHandle.getFile();
      const url = URL.createObjectURL(file);
      const audio = new Audio(url);
      audio.onended = () => { stopPlayback(); };
      audio.play();
      playingAudio = { index: i, audio, url };
    } catch { /* ignore */ }
  }

  function stopPlayback() {
    if (!playingAudio) return;
    playingAudio.audio.pause();
    URL.revokeObjectURL(playingAudio.url);
    playingAudio = null;
  }

  // --- Kit row operations ---

  function moveRow(dir: number) {
    const i = kit.selectedIndex;
    const j = i + dir;
    if (i < 0 || j < 0 || j >= kit.rows.length) return;
    [kit.rows[i], kit.rows[j]] = [kit.rows[j], kit.rows[i]];
    kit.selectedIndex = j;
  }

  function deleteRow() {
    if (kit.selectedIndex < 0 || kit.rows.length === 0) return;
    kit.rows.splice(kit.selectedIndex, 1);
    if (kit.selectedIndex >= kit.rows.length) kit.selectedIndex = kit.rows.length - 1;
  }

  function startRename() {
    if (!selectedRow) return;
    renameValue = selectedRow.name;
    mode = "rename";
    setTimeout(() => renameInput?.focus(), 0);
  }

  function confirmRename() {
    if (selectedRow && renameValue.trim()) selectedRow.name = renameValue.trim().toUpperCase();
    mode = "normal";
    setTimeout(() => containerEl?.focus(), 0);
  }

  function cycleLoopMode() {
    if (!selectedRow) return;
    selectedRow.loopMode = LOOP_MODES[(LOOP_MODES.indexOf(selectedRow.loopMode) + 1) % LOOP_MODES.length];
  }

  function cyclePolyMode() {
    if (!selectedRow) return;
    selectedRow.polyphonic = POLY_MODES[(POLY_MODES.indexOf(selectedRow.polyphonic) + 1) % POLY_MODES.length];
  }

  function adjustVolume(delta: number) {
    if (!selectedRow) return;
    selectedRow.volume = Math.max(0, Math.min(100, selectedRow.volume + delta));
  }

  function adjustPan(delta: number) {
    if (!selectedRow) return;
    selectedRow.pan = Math.max(-50, Math.min(50, selectedRow.pan + delta));
  }

  // --- Export / Import ---

  function exportKit() {
    const xml = generateKitXml(kit);
    const blob = new Blob([xml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${kit.name || "Kit"}.XML`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function loadKitFile(file: File) {
    try {
      const text = await file.text();
      kit = parseKitXml(text);
      kit.name = file.name.replace(/\.xml$/i, "");
      loadedFileName = file.name;
    } catch (err: any) {
      console.error("Failed to parse kit XML:", err);
    }
  }

  function handleFileInput(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) loadKitFile(file);
    input.value = "";
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file?.name.toLowerCase().endsWith(".xml")) loadKitFile(file);
  }

  // --- Keyboard ---

  function handleKeydown(e: KeyboardEvent) {
    if (mode === "help") {
      if (e.key === "Escape" || e.key === "?") { mode = "normal"; e.preventDefault(); }
      return;
    }
    if (mode === "rename") {
      if (e.key === "Enter") { confirmRename(); e.preventDefault(); }
      else if (e.key === "Escape") { mode = "normal"; setTimeout(() => containerEl?.focus(), 0); e.preventDefault(); }
      return;
    }
    if (mode === "search") {
      if (e.key === "Escape") { searchQuery = ""; mode = "normal"; setTimeout(() => containerEl?.focus(), 0); e.preventDefault(); }
      else if (e.key === "Enter") { mode = "normal"; setTimeout(() => containerEl?.focus(), 0); e.preventDefault(); }
      return;
    }

    if (e.key === "?") { mode = "help"; e.preventDefault(); return; }
    if (e.key === "Tab") {
      activePane = activePane === "browser" ? "kit" : "browser";
      e.preventDefault();
      return;
    }

    if (activePane === "browser") handleBrowserKey(e);
    else handleKitKey(e);
  }

  function handleBrowserKey(e: KeyboardEvent) {
    const entries = visibleEntries;
    const entry = entries[browseIndex];

    if (e.key === "j" || e.key === "ArrowDown") {
      browseIndex = Math.min(browseIndex + 1, entries.length - 1);
      e.preventDefault();
    } else if (e.key === "k" || e.key === "ArrowUp") {
      browseIndex = Math.max(browseIndex - 1, 0);
      e.preventDefault();
    } else if (e.key === "G") {
      browseIndex = entries.length - 1;
      e.preventDefault();
    } else if (e.key === "g") {
      browseIndex = 0;
      e.preventDefault();
    } else if (e.key === "l" || e.key === "ArrowRight") {
      if (entry) expandEntry(entry);
      e.preventDefault();
    } else if (e.key === "h" || e.key === "ArrowLeft") {
      if (entry) {
        if (entry.kind === "directory" && entry.expanded) collapseEntry(entry);
        else if (entry.parent) {
          const pi = entries.indexOf(entry.parent);
          if (pi >= 0) browseIndex = pi;
        }
      }
      e.preventDefault();
    } else if (e.key === "Enter" || e.key === "a") {
      if (entry) {
        if (entry.kind === "directory") expandEntry(entry);
        else addSampleToKit(entry);
      }
      e.preventDefault();
    } else if (e.key === " ") {
      if (entry) auditionBrowserEntry(entry);
      e.preventDefault();
    } else if (e.key === "/") {
      mode = "search";
      setTimeout(() => searchInput?.focus(), 0);
      e.preventDefault();
    } else if (e.key === "Escape") {
      if (searchQuery) { searchQuery = ""; }
      else { stopPlayback(); }
      e.preventDefault();
    } else if (e.key === "o") {
      openSamplesDir();
      e.preventDefault();
    }
  }

  function handleKitKey(e: KeyboardEvent) {
    const { key } = e;
    if (key === "j" || key === "ArrowDown") {
      if (kit.rows.length > 0) kit.selectedIndex = Math.min(kit.selectedIndex + 1, kit.rows.length - 1);
      e.preventDefault();
    } else if (key === "k" || key === "ArrowUp") {
      if (kit.rows.length > 0) kit.selectedIndex = Math.max(kit.selectedIndex - 1, 0);
      e.preventDefault();
    } else if (key === "J") { moveRow(1); e.preventDefault();
    } else if (key === "K") { moveRow(-1); e.preventDefault();
    } else if (key === "d") {
      if (pendingD) { deleteRow(); pendingD = false; }
      else { pendingD = true; setTimeout(() => pendingD = false, 500); }
      e.preventDefault();
    } else if (key === "r") { startRename(); e.preventDefault();
    } else if (key === " ") { if (kit.selectedIndex >= 0) auditionKitRow(kit.selectedIndex); e.preventDefault();
    } else if (key === "l") { cycleLoopMode(); e.preventDefault();
    } else if (key === "p") { cyclePolyMode(); e.preventDefault();
    } else if (key === "e") { exportKit(); e.preventDefault();
    } else if (key === "=" || key === "+") { adjustVolume(5); e.preventDefault();
    } else if (key === "-") { adjustVolume(-5); e.preventDefault();
    } else if (key === ">") { adjustPan(5); e.preventDefault();
    } else if (key === "<") { adjustPan(-5); e.preventDefault();
    } else if (key === "Escape") { kit.selectedIndex = -1; pendingD = false; e.preventDefault();
    } else { pendingD = false; }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="kit-builder"
  bind:this={containerEl}
  tabindex="0"
  onkeydown={handleKeydown}
>
  {#if !samplesDir && kit.rows.length === 0 && !loadedFileName}
    <!-- Landing state -->
    <div
      class="landing"
      role="button"
      tabindex="-1"
      ondragover={(e) => e.preventDefault()}
      ondrop={handleDrop}
    >
      <div class="landing-content">
        <div class="landing-icon">⬡</div>
        <h2 class="landing-title">Kit Builder</h2>
        <p class="landing-desc">Browse your SD card samples and build Deluge drum kits.</p>
        <div class="landing-actions">
          {#if reconnectAvailable}
            <button class="btn btn-primary" onclick={reconnectSamplesDir}>Use loaded SD card</button>
          {/if}
          <button class="btn {reconnectAvailable ? 'btn-secondary' : 'btn-primary'}" onclick={openSamplesDir}>Open SAMPLES Folder</button>
          <label class="btn btn-secondary">
            Load Kit XML
            <input type="file" accept=".xml,.XML" hidden onchange={handleFileInput} />
          </label>
        </div>
        <p class="landing-hint">or drop a kit <code>.XML</code> here to edit</p>
      </div>
    </div>
  {:else}
    <!-- Two-pane layout -->
    <div class="toolbar">
      <div class="toolbar-left">
        <span class="toolbar-label">KIT</span>
        <span class="toolbar-title">{kit.name}</span>
        {#if loadedFileName}
          <span class="toolbar-file">{loadedFileName}</span>
        {/if}
      </div>
      <div class="toolbar-right">
        <button class="btn btn-sm btn-secondary" onclick={openSamplesDir}>
          {samplesDir ? "Change Folder" : "Open Folder"}
        </button>
        <label class="btn btn-sm btn-secondary">
          Load XML
          <input type="file" accept=".xml,.XML" hidden onchange={handleFileInput} />
        </label>
        <button class="btn btn-sm btn-primary" onclick={exportKit}>Export</button>
      </div>
    </div>

    <div class="panes">
      <!-- Left: Sample Browser -->
      <div class="pane pane-browser" class:pane--active={activePane === "browser"}>
        <div class="pane-header">
          <span class="pane-title">
            {#if samplesDir}
              {samplesDir.name}
            {:else}
              Samples
            {/if}
          </span>
          {#if mode === "search"}
            <input
              bind:this={searchInput}
              bind:value={searchQuery}
              class="search-input"
              placeholder="filter..."
            />
          {:else if searchQuery}
            <span class="search-active">/{searchQuery} <button class="search-clear" onclick={() => searchQuery = ""}>×</button></span>
          {/if}
          <span class="pane-hint">
            {#if !samplesDir}
              press <kbd>o</kbd> to open
            {:else}
              {visibleEntries.length} items
            {/if}
          </span>
        </div>
        <div class="pane-list" bind:this={browserListEl}>
          {#if !samplesDir}
            <div class="pane-empty">
              <p>No folder open.</p>
              <button class="btn btn-secondary btn-sm" onclick={openSamplesDir}>Open SAMPLES Folder</button>
            </div>
          {:else if visibleEntries.length === 0}
            <div class="pane-empty"><p>No matching files.</p></div>
          {:else}
            {#each visibleEntries as entry, i}
              <div
                class="browse-entry"
                class:browse-entry--selected={i === browseIndex && activePane === "browser"}
                class:browse-entry--dir={entry.kind === "directory"}
                style="padding-left: {entry.depth + 0.5}rem"
                role="button"
                tabindex="-1"
                onclick={() => { activePane = "browser"; browseIndex = i; }}
                ondblclick={() => { if (entry.kind === "file") addSampleToKit(entry); else expandEntry(entry); }}
              >
                <span class="browse-icon">
                  {#if entry.kind === "directory"}
                    {entry.expanded ? "▼" : "▶"}
                  {:else}
                    ♪
                  {/if}
                </span>
                <span class="browse-name">{entry.name}</span>
              </div>
            {/each}
          {/if}
        </div>
      </div>

      <!-- Right: Kit Rows -->
      <div class="pane pane-kit" class:pane--active={activePane === "kit"}>
        <div class="pane-header">
          <span class="pane-title">Kit Rows</span>
          <span class="pane-hint">{kit.rows.length} row{kit.rows.length !== 1 ? "s" : ""}</span>
        </div>
        <div
          class="pane-list"
          bind:this={kitListEl}
          ondragover={(e) => e.preventDefault()}
          ondrop={handleDrop}
        >
          {#if kit.rows.length === 0}
            <div class="pane-empty">
              <p>Empty kit.</p>
              <p class="pane-empty-hint">Select samples from the browser<br/>(<kbd>Enter</kbd> or <kbd>a</kbd> to add)</p>
            </div>
          {:else}
            {#each kit.rows as row, i}
              <div
                class="kit-row"
                class:kit-row--selected={i === kit.selectedIndex && activePane === "kit"}
                class:kit-row--playing={playingAudio?.index === i}
                class:kit-row--new={i === newRowIndex}
                role="button"
                tabindex="-1"
                onclick={() => { activePane = "kit"; kit.selectedIndex = i; }}
              >
                <div class="row-index">{i + 1}</div>
                <div class="row-name">
                  {#if mode === "rename" && i === kit.selectedIndex}
                    <input
                      bind:this={renameInput}
                      bind:value={renameValue}
                      class="rename-input"
                      onblur={confirmRename}
                    />
                  {:else}
                    {row.name}
                  {/if}
                </div>
                <div class="row-sample" title={row.samplePath}>
                  {row.samplePath ? row.samplePath.split("/").pop() : "—"}
                </div>
                <div class="row-badges">
                  <span class="badge" data-mode={row.loopMode}>{LOOP_LABELS[row.loopMode]}</span>
                  <span class="badge" data-mode={row.polyphonic}>{POLY_LABELS[row.polyphonic]}</span>
                </div>
              </div>
            {/each}
          {/if}
        </div>
      </div>
    </div>

    <!-- Status bar -->
    <div class="statusbar">
      <span class="status-pane">{activePane === "browser" ? "BROWSER" : "KIT"}</span>
      {#if pendingD}
        <span class="status-pending">d…</span>
      {/if}
      {#if playingAudio}
        <span class="status-playing">▶ playing</span>
      {/if}
      <span class="status-hint">Tab to switch · ? for help</span>
    </div>
  {/if}

  <!-- Help overlay -->
  {#if mode === "help"}
    <div class="overlay" onclick={() => mode = "normal"} role="presentation">
      <div class="help-panel" onclick={(e) => e.stopPropagation()} role="dialog">
        <h3>Keyboard Shortcuts</h3>
        <div class="help-grid">
          <div class="help-section">
            <h4>Browser Pane</h4>
            <dl>
              <dt><kbd>j</kbd>/<kbd>k</kbd></dt><dd>Navigate up/down</dd>
              <dt><kbd>l</kbd>/<kbd>→</kbd></dt><dd>Expand folder</dd>
              <dt><kbd>h</kbd>/<kbd>←</kbd></dt><dd>Collapse / go to parent</dd>
              <dt><kbd>Space</kbd></dt><dd>Audition sample</dd>
              <dt><kbd>Enter</kbd>/<kbd>a</kbd></dt><dd>Add to kit</dd>
              <dt><kbd>/</kbd></dt><dd>Search/filter</dd>
              <dt><kbd>o</kbd></dt><dd>Open folder</dd>
              <dt><kbd>g</kbd>/<kbd>G</kbd></dt><dd>Top / bottom</dd>
            </dl>
          </div>
          <div class="help-section">
            <h4>Kit Pane</h4>
            <dl>
              <dt><kbd>j</kbd>/<kbd>k</kbd></dt><dd>Navigate rows</dd>
              <dt><kbd>J</kbd>/<kbd>K</kbd></dt><dd>Move row up/down</dd>
              <dt><kbd>dd</kbd></dt><dd>Delete row</dd>
              <dt><kbd>r</kbd></dt><dd>Rename row</dd>
              <dt><kbd>Space</kbd></dt><dd>Audition</dd>
              <dt><kbd>l</kbd></dt><dd>Cycle loop mode</dd>
              <dt><kbd>p</kbd></dt><dd>Cycle polyphonic</dd>
              <dt><kbd>+</kbd>/<kbd>-</kbd></dt><dd>Volume ±5</dd>
              <dt><kbd>&lt;</kbd>/<kbd>&gt;</kbd></dt><dd>Pan ±5</dd>
              <dt><kbd>e</kbd></dt><dd>Export XML</dd>
            </dl>
          </div>
          <div class="help-section">
            <h4>Global</h4>
            <dl>
              <dt><kbd>Tab</kbd></dt><dd>Switch pane</dd>
              <dt><kbd>?</kbd></dt><dd>This help</dd>
              <dt><kbd>Esc</kbd></dt><dd>Close / clear</dd>
            </dl>
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .kit-builder { outline: none; min-height: 400px; }
  .kit-builder:focus { outline: none; }

  /* Landing */
  .landing {
    border: 2px dashed var(--border);
    border-radius: 10px;
    padding: 4rem 2rem;
    text-align: center;
  }
  .landing-icon { font-size: 2rem; color: var(--accent); margin-bottom: 1rem; }
  .landing-title {
    font-family: 'DM Mono', monospace;
    font-size: 1.2rem;
    font-weight: 500;
    margin-bottom: 0.5rem;
  }
  .landing-desc {
    font-size: 0.9rem;
    color: var(--text-secondary);
    margin-bottom: 1.5rem;
  }
  .landing-actions {
    display: flex;
    gap: 0.75rem;
    justify-content: center;
    margin-bottom: 1rem;
  }
  .landing-hint {
    font-size: 0.78rem;
    color: var(--text-secondary);
  }
  .landing-hint code {
    background: var(--surface);
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    font-size: 0.78rem;
  }

  /* Buttons */
  .btn {
    font-family: 'DM Mono', monospace;
    font-size: 0.82rem;
    border-radius: 5px;
    padding: 0.5rem 1rem;
    cursor: pointer;
    border: 1px solid var(--border);
    transition: background 0.15s, color 0.15s;
  }
  .btn-primary { background: var(--accent); color: var(--ground); border-color: var(--accent); }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-secondary { background: transparent; color: var(--text); }
  .btn-secondary:hover { background: var(--surface); }
  .btn-sm { padding: 0.3rem 0.7rem; font-size: 0.75rem; }

  /* Toolbar */
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0.75rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px 8px 0 0;
    gap: 0.5rem;
  }
  .toolbar-left { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
  .toolbar-label {
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--accent);
  }
  .toolbar-title {
    font-family: 'DM Mono', monospace;
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .toolbar-file { font-size: 0.72rem; color: var(--text-secondary); }
  .toolbar-right { display: flex; gap: 0.4rem; flex-shrink: 0; }

  /* Two-pane layout */
  .panes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr;
    border: 1px solid var(--border);
    border-top: none;
    min-height: 50vh;
    max-height: 70vh;
    overflow: hidden;
  }
  .pane {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 0;
  }
  .pane-browser { border-right: 1px solid var(--border); }
  .pane--active .pane-header { border-bottom-color: var(--accent); }
  .pane-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.4rem 0.6rem;
    background: var(--surface);
    border-bottom: 2px solid transparent;
    gap: 0.5rem;
    flex-shrink: 0;
  }
  .pane-title {
    font-family: 'DM Mono', monospace;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pane-hint {
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem;
    color: var(--text-secondary);
    flex-shrink: 0;
  }
  .pane-hint kbd {
    font-family: 'DM Mono', monospace;
    font-size: 0.65rem;
    background: var(--ground);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0 0.2rem;
  }
  .pane-list {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    scroll-behavior: smooth;
  }
  .pane-empty {
    padding: 2rem 1rem;
    text-align: center;
    color: var(--text-secondary);
    font-size: 0.82rem;
  }
  .pane-empty-hint {
    font-size: 0.75rem;
    margin-top: 0.5rem;
    color: var(--text-secondary);
  }
  .pane-empty-hint kbd {
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0 0.25rem;
  }

  /* Search */
  .search-input {
    font-family: 'DM Mono', monospace;
    font-size: 0.78rem;
    background: var(--ground);
    border: 1px solid var(--accent);
    border-radius: 3px;
    padding: 0.15rem 0.4rem;
    color: var(--text);
    outline: none;
    width: 140px;
  }
  .search-active {
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem;
    color: var(--accent);
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .search-clear {
    background: none;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0;
    line-height: 1;
  }

  /* Browse entries */
  .browse-entry {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.28rem 0.5rem;
    font-size: 0.78rem;
    cursor: pointer;
    border-bottom: 1px solid var(--border);
    transition: background 0.08s;
  }
  .browse-entry:last-child { border-bottom: none; }
  .browse-entry:hover { background: var(--surface); }
  .browse-entry--selected { background: var(--accent-dim); }
  .browse-entry--dir .browse-name { font-weight: 500; color: var(--text); }
  .browse-icon {
    font-size: 0.68rem;
    color: var(--text-secondary);
    width: 0.9rem;
    text-align: center;
    flex-shrink: 0;
  }
  .browse-name {
    font-family: 'DM Mono', monospace;
    font-size: 0.75rem;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Kit rows */
  .kit-row {
    display: grid;
    grid-template-columns: 1.5rem 1fr auto;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.6rem;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    transition: background 0.08s;
    font-size: 0.78rem;
  }
  .kit-row:last-child { border-bottom: none; }
  .kit-row:hover { background: var(--surface); }
  .kit-row--selected {
    background: var(--accent-dim);
    border-left: 2px solid var(--accent);
    padding-left: calc(0.6rem - 2px);
  }
  .kit-row--playing { background: var(--teal-dim); }
  .kit-row--new {
    animation: pulse-highlight 1.5s ease-out;
  }
  @keyframes pulse-highlight {
    0% { background: var(--accent); color: var(--ground); }
    100% { background: transparent; color: var(--text); }
  }
  .row-index {
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem;
    color: var(--text-secondary);
    text-align: center;
  }
  .row-name {
    font-family: 'DM Mono', monospace;
    font-weight: 500;
    font-size: 0.78rem;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-sample {
    font-size: 0.72rem;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 120px;
  }
  .row-badges { display: flex; gap: 0.2rem; }
  .badge {
    font-family: 'DM Mono', monospace;
    font-size: 0.6rem;
    font-weight: 500;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    border: 1px solid var(--border);
    letter-spacing: 0.03em;
  }
  .badge[data-mode="loop"] { color: var(--teal); border-color: var(--teal); }
  .badge[data-mode="cut"] { color: var(--accent); border-color: var(--accent); }
  .badge[data-mode="choke"] { color: #c47a7a; border-color: #c47a7a; }

  .rename-input {
    font-family: 'DM Mono', monospace;
    font-size: 0.78rem;
    font-weight: 500;
    background: var(--ground);
    border: 1px solid var(--accent);
    border-radius: 3px;
    padding: 0.1rem 0.25rem;
    color: var(--text);
    width: 100%;
    outline: none;
  }

  /* Status bar */
  .statusbar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.35rem 0.75rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-top: none;
    border-radius: 0 0 8px 8px;
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem;
    color: var(--text-secondary);
  }
  .status-pane { color: var(--accent); font-weight: 500; }
  .status-pending { color: var(--accent); }
  .status-playing { color: var(--teal); }
  .status-hint { margin-left: auto; }

  /* Help overlay */
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
  }
  .help-panel {
    background: var(--ground);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.5rem;
    max-width: 650px;
    width: 90vw;
    max-height: 80vh;
    overflow-y: auto;
  }
  .help-panel h3 {
    font-family: 'DM Mono', monospace;
    font-size: 0.9rem;
    font-weight: 500;
    margin-bottom: 1rem;
  }
  .help-grid {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 1.5rem;
  }
  .help-section h4 {
    font-family: 'DM Mono', monospace;
    font-size: 0.75rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--accent);
    margin-bottom: 0.5rem;
  }
  .help-section dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.2rem 0.5rem;
    align-items: baseline;
  }
  .help-section dt { text-align: right; }
  .help-section dd { font-size: 0.78rem; color: var(--text-secondary); }
  .help-section kbd {
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0.05rem 0.25rem;
    white-space: nowrap;
  }

  @media (max-width: 700px) {
    .panes { grid-template-columns: 1fr; min-height: auto; max-height: none; }
    .pane-browser { border-right: none; border-bottom: 1px solid var(--border); max-height: 40vh; }
    .pane-kit { max-height: 40vh; }
    .help-grid { grid-template-columns: 1fr; }
    .toolbar { flex-direction: column; align-items: stretch; }
    .toolbar-right { justify-content: flex-end; }
  }
</style>
