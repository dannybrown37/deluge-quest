<script lang="ts">
  import { loadPyodide, convertToMusicXML } from "../lib/pyodide";

  type State = "idle" | "loading" | "processing" | "done" | "error";

  let state: State = $state("idle");
  let progress = $state("");
  let progressPct = $state(0);
  let errorMsg = $state("");
  let fileName = $state("");
  let resultXml = $state("");
  let dragOver = $state(false);

  async function convert(name: string, xmlContent: string) {
    fileName = name;
    state = "loading";

    try {
      const pyodide = await loadPyodide((stage, pct) => {
        progress = stage;
        progressPct = pct;
      });

      state = "processing";
      progress = "Converting";
      progressPct = 85;

      resultXml = await convertToMusicXML(xmlContent, pyodide);

      state = "done";
      progress = "Done";
      progressPct = 100;
    } catch (e: any) {
      state = "error";
      errorMsg = e.message || "Conversion failed";
    }
  }

  async function handleFile(file: File) {
    if (!file.name.toLowerCase().endsWith(".xml")) {
      state = "error";
      errorMsg = "Please drop a Deluge .XML song file";
      return;
    }
    convert(file.name, await file.text());
  }

  $effect(() => {
    try {
      const stored = sessionStorage.getItem("deluge-score-file");
      if (stored) {
        sessionStorage.removeItem("deluge-score-file");
        const { name, content } = JSON.parse(stored);
        if (name && content) convert(name, content);
      }
    } catch {}
  });

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    const file = e.dataTransfer?.files[0];
    if (file) handleFile(file);
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
    const file = input.files?.[0];
    if (file) handleFile(file);
  }

  function download() {
    const blob = new Blob([resultXml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName.replace(/\.XML$/i, ".musicxml");
    a.click();
    URL.revokeObjectURL(url);
  }

  function reset() {
    state = "idle";
    resultXml = "";
    fileName = "";
    errorMsg = "";
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
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') document.getElementById('file-input')?.click(); }}
  >
    <div class="dropzone-content">
      <span class="dropzone-icon">♫</span>
      <p class="dropzone-title">Drop a Deluge song file</p>
      <p class="dropzone-sub">or <label class="dropzone-browse">browse<input id="file-input" type="file" accept=".xml,.XML" onchange={handleInputChange} hidden /></label></p>
      <p class="dropzone-hint">.XML files from your Deluge SD card</p>
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
        <span>Converting</span>
      </div>
      <div class="pipeline-step" class:pipeline-step--active={progressPct >= 100}>
        <span class="pipeline-dot"></span>
        <span>Done</span>
      </div>
    </div>
    <div class="progress-bar">
      <div class="progress-fill" style="width: {progressPct}%"></div>
    </div>
    <p class="status-file">{fileName}</p>
  </div>

{:else if state === "done"}
  <div class="result-card">
    <div class="result-header">
      <span class="result-icon">✓</span>
      <span class="result-title">Conversion complete</span>
    </div>
    <p class="result-file">{fileName} → {fileName.replace(/\.XML$/i, '.musicxml')}</p>
    <div class="result-actions">
      <button class="btn btn-primary" onclick={download}>Download MusicXML</button>
      <button class="btn btn-secondary" onclick={reset}>Convert another</button>
    </div>
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

  .status-card, .result-card, .error-card {
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
    margin-bottom: 1rem;
  }
  .progress-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
    transition: width 0.4s ease;
  }

  .status-file {
    font-family: 'DM Mono', monospace;
    font-size: 0.82rem;
    color: var(--text-secondary);
  }

  .result-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .result-icon {
    color: var(--teal);
    font-size: 1.2rem;
    font-weight: 700;
  }
  .result-title {
    font-family: 'DM Mono', monospace;
    font-size: 1rem;
    font-weight: 500;
  }
  .result-file {
    font-family: 'DM Mono', monospace;
    font-size: 0.82rem;
    color: var(--text-secondary);
    margin-bottom: 1.25rem;
  }
  .result-actions {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
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
  .btn-primary {
    background: var(--accent);
    color: var(--ground);
  }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-secondary {
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
  }
  .btn-secondary:hover { background: var(--surface); }
</style>
