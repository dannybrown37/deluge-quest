<script lang="ts">
  import { loadPyodide, analyzeStats, type SongStats } from "../lib/pyodide";

  type State = "idle" | "loading" | "processing" | "done" | "error";

  let state: State = $state("idle");
  let progress = $state("");
  let progressPct = $state(0);
  let errorMsg = $state("");
  let results: SongStats[] = $state([]);
  let sortBy = $state("name");
  let dragOver = $state(false);
  let fileCount = $state(0);

  const sortFns: Record<string, (a: SongStats, b: SongStats) => number> = {
    name: (a, b) => a.filename.localeCompare(b.filename),
    bpm: (a, b) => a.bpm - b.bpm,
    key: (a, b) => a.key.localeCompare(b.key),
    duration: (a, b) => a.durationStr.localeCompare(b.durationStr),
    notes: (a, b) => a.totalNotes - b.totalNotes,
    instruments: (a, b) => a.instrumentCount - b.instrumentCount,
  };

  let sorted = $derived([...results].sort(sortFns[sortBy] ?? sortFns.name));

  let summary = $derived.by(() => {
    if (results.length === 0) return null;
    const total = results.length;
    const arrCount = results.filter(s => s.hasArrangement).length;
    const bpms = results.map(s => s.bpm).filter(b => b > 0);
    const totalNotes = results.reduce((sum, s) => sum + s.totalNotes, 0);
    const keyCounts: Record<string, number> = {};
    for (const s of results) {
      if (!s.key.startsWith("Error")) {
        keyCounts[s.key] = (keyCounts[s.key] || 0) + 1;
      }
    }
    const topKeys = Object.entries(keyCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    return {
      total,
      arrCount,
      bpmMin: bpms.length ? Math.min(...bpms) : 0,
      bpmMax: bpms.length ? Math.max(...bpms) : 0,
      bpmAvg: bpms.length ? bpms.reduce((a, b) => a + b, 0) / bpms.length : 0,
      totalNotes,
      topKeys,
    };
  });

  async function readEntryRecursive(entry: FileSystemEntry): Promise<File[]> {
    if (entry.isFile) {
      return new Promise((resolve) => {
        (entry as FileSystemFileEntry).file(
          (f) => resolve(f.name.toLowerCase().endsWith(".xml") ? [f] : []),
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

  async function processFiles(files: File[]) {
    const xmlFiles = files.filter(f => f.name.toLowerCase().endsWith(".xml"));
    if (xmlFiles.length === 0) {
      state = "error";
      errorMsg = "No .XML files found. Drop Deluge song files from your SD card.";
      return;
    }

    fileCount = xmlFiles.length;
    state = "loading";

    try {
      const pyodide = await loadPyodide((stage, pct) => {
        progress = stage;
        progressPct = pct;
      });

      state = "processing";
      progress = `Analyzing ${xmlFiles.length} file${xmlFiles.length > 1 ? "s" : ""}`;
      progressPct = 85;

      const fileData = await Promise.all(
        xmlFiles.map(async f => ({ name: f.name, content: await f.text() }))
      );

      results = await analyzeStats(fileData, pyodide);
      state = "done";
      progressPct = 100;
    } catch (e: any) {
      state = "error";
      errorMsg = e.message || "Analysis failed";
    }
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
        await processFiles(allFiles);
        return;
      }
    }

    const files = e.dataTransfer?.files;
    if (files?.length) await processFiles(Array.from(files));
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
    if (files?.length) processFiles(Array.from(files));
  }

  function setSort(col: string) {
    if (sortBy === col) {
      results = [...results].reverse();
    } else {
      sortBy = col;
    }
  }

  function reset() {
    state = "idle";
    results = [];
    errorMsg = "";
    fileCount = 0;
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
      <p class="dropzone-title">Drop your SONGS folder</p>
      <p class="dropzone-sub">or browse for a <label class="dropzone-browse">folder<input id="stats-folder-input" type="file" webkitdirectory onchange={handleInputChange} hidden /></label> or <label class="dropzone-browse">files<input id="stats-file-input" type="file" accept=".xml,.XML" multiple onchange={handleInputChange} hidden /></label></p>
      <p class="dropzone-hint">Recursively scans for .XML song files</p>
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
    <div class="results-header">
      <span class="results-count">{results.length} song{results.length !== 1 ? 's' : ''} analyzed</span>
      <button class="btn btn-secondary btn-sm" onclick={reset}>Analyze more</button>
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th><button class="sort-btn" class:sort-btn--active={sortBy === 'name'} onclick={() => setSort('name')}>Song</button></th>
            <th><button class="sort-btn" class:sort-btn--active={sortBy === 'bpm'} onclick={() => setSort('bpm')}>BPM</button></th>
            <th><button class="sort-btn" class:sort-btn--active={sortBy === 'key'} onclick={() => setSort('key')}>Key</button></th>
            <th>Arr?</th>
            <th><button class="sort-btn" class:sort-btn--active={sortBy === 'duration'} onclick={() => setSort('duration')}>Duration</button></th>
            <th><button class="sort-btn" class:sort-btn--active={sortBy === 'instruments'} onclick={() => setSort('instruments')}>Inst</button></th>
            <th>Clips</th>
            <th><button class="sort-btn" class:sort-btn--active={sortBy === 'notes'} onclick={() => setSort('notes')}>Notes</button></th>
          </tr>
        </thead>
        <tbody>
          {#each sorted as s}
            <tr class:row--error={s.key.startsWith('Error')}>
              <td class="cell-name">{s.filename.replace(/\.XML$/i, '')}</td>
              <td class="cell-num">{s.bpm > 0 ? s.bpm.toFixed(0) : '-'}</td>
              <td>{s.key}</td>
              <td class="cell-center">{s.hasArrangement ? 'Y' : ''}</td>
              <td class="cell-num">{s.durationStr}</td>
              <td class="cell-num">{s.instrumentCount || '-'}</td>
              <td class="cell-num">{s.clipCount || '-'}</td>
              <td class="cell-num">{s.totalNotes > 0 ? s.totalNotes.toLocaleString() : '-'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    {#if summary}
      <div class="summary">
        <h3 class="summary-title">Summary</h3>
        <div class="summary-grid">
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
          {#if summary.topKeys.length > 0}
            <div class="stat stat--wide">
              <span class="stat-value">{summary.topKeys.map(([k, n]) => `${k} (${n})`).join(', ')}</span>
              <span class="stat-label">top keys</span>
            </div>
          {/if}
        </div>
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
    transition: border-color 0.2s, background 0.2s;
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
    transition: color 0.2s;
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
    transition: background 0.2s;
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

  .results-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1rem;
  }
  .results-count {
    font-family: 'DM Mono', monospace;
    font-size: 0.85rem;
    color: var(--text-secondary);
  }

  .table-wrap {
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.82rem;
    white-space: nowrap;
  }
  thead {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  th {
    font-family: 'DM Mono', monospace;
    font-weight: 500;
    font-size: 0.78rem;
    text-align: left;
    padding: 0.6rem 0.75rem;
    color: var(--text-secondary);
  }
  td {
    padding: 0.5rem 0.75rem;
    border-top: 1px solid var(--border);
    color: var(--text);
  }
  tbody tr:hover {
    background: var(--surface);
  }

  .cell-name {
    font-family: 'DM Mono', monospace;
    font-weight: 500;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cell-num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .cell-center {
    text-align: center;
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
  }
  .sort-btn:hover {
    color: var(--text);
  }
  .sort-btn--active {
    color: var(--accent);
  }

  .summary {
    margin-top: 1.5rem;
    padding: 1.25rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .summary-title {
    font-family: 'DM Mono', monospace;
    font-size: 0.82rem;
    font-weight: 500;
    margin-bottom: 0.75rem;
  }
  .summary-grid {
    display: flex;
    gap: 2rem;
    flex-wrap: wrap;
  }
  .stat {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .stat--wide {
    flex-basis: 100%;
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
    transition: background 0.15s;
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
</style>
