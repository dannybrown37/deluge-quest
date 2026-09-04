<script lang="ts">
  import { loadPyodide, inspectSong, type PreviewData, type PreviewTrack } from "../lib/pyodide";
  import { SongPlayer, type EQBand } from "../lib/songAudio";
  import { cardStore } from "../lib/cardStore";
  import { trackToolAction } from "../lib/analytics";

  type State = "idle" | "loading" | "processing" | "done" | "error";

  let state: State = $state("idle");
  let progress = $state("");
  let progressPct = $state(0);
  let errorMsg = $state("");
  let fileName = $state("");
  let data: PreviewData | null = $state(null);
  let dragOver = $state(false);
  let statsCount = $state(0);
  let hoveredClip: { track: number; clip: number } | null = $state(null);
  let tooltip = $state({ visible: false, x: 0, y: 0, text: "" });
  let cardSongs: { path: string; xml: string }[] = $state([]);
  let cardName = $state("");
  let cardSavedAt = $state(0);
  let cardFromCache = $state(false);

  async function tryLoadCardSongs() {
    try {
      if (cardStore.isLoaded && cardStore.songXmls.size > 0) {
        cardSongs = cardStore.eligibleSongs(false);
        cardName = cardStore.rootHandle?.name ?? "";
        return;
      }
      const cached = await cardStore.loadCachedSongs();
      if (cached?.songs.length) {
        cardSongs = cached.songs;
        cardName = cached.cardName;
        cardSavedAt = cached.savedAt;
        cardFromCache = true;
      }
    } catch {}
  }

  tryLoadCardSongs();

  let player: SongPlayer | null = $state(null);
  let playState: 'stopped' | 'playing' | 'paused' = $state('stopped');
  let playheadTick = $state(0);
  let scrollEl: HTMLDivElement | undefined = $state();

  const EQ_BANDS: { key: EQBand; label: string }[] = [
    { key: 'low', label: 'Low' },
    { key: 'mid', label: 'Mid' },
    { key: 'high', label: 'High' },
  ];
  const EQ_FREQ_LABEL: Record<EQBand, string> = { low: '200 Hz shelf', mid: '1 kHz', high: '4 kHz shelf' };
  let eq: Record<EQBand, number> = $state({ low: -4, mid: 0, high: 0 });

  function setEQ(band: EQBand, gainDb: number) {
    eq = { ...eq, [band]: gainDb };
    player?.setEQ(band, gainDb);
  }

  let filterCutoff = $state(20000);
  let filterRes = $state(0.5);

  function setFilterCutoff(hz: number) {
    filterCutoff = hz;
    player?.setFilterCutoff(hz);
  }

  function setFilterRes(q: number) {
    filterRes = q;
    player?.setFilterRes(q);
  }

  // Knob helpers — value 0..1 maps to angle -135..135
  function valToAngle(v: number): number { return v * 270 - 135; }
  function angleToVal(a: number): number { return (Math.max(-135, Math.min(135, a)) + 135) / 270; }

  // EQ knob: -12..12 dB → 0..1
  function eqToNorm(db: number): number { return (db + 12) / 24; }
  function normToEq(n: number): number { return Math.round(n * 24 - 12); }

  // Filter cutoff: exponential 80 Hz..20 kHz → 0..1
  function cutoffToNorm(hz: number): number { return Math.log(hz / 80) / Math.log(20000 / 80); }
  function normToCutoff(n: number): number { return Math.round(80 * Math.pow(20000 / 80, n)); }

  // Resonance: 0.5..20 → 0..1
  function resToNorm(q: number): number { return (q - 0.5) / 19.5; }
  function normToRes(n: number): number { return +(0.5 + n * 19.5).toFixed(1); }

  interface KnobDef {
    id: string;
    label: string;
    color: 'gold' | 'black';
    getNorm: () => number;
    setFromNorm: (n: number) => void;
    display: () => string;
  }

  const knobDefs: KnobDef[] = [
    { id: 'cutoff', label: 'Cutoff', color: 'gold',
      getNorm: () => cutoffToNorm(filterCutoff),
      setFromNorm: (n) => setFilterCutoff(normToCutoff(n)),
      display: () => filterCutoff >= 1000 ? `${(filterCutoff / 1000).toFixed(1)}k` : `${filterCutoff}` },
    { id: 'res', label: 'Res', color: 'gold',
      getNorm: () => resToNorm(filterRes),
      setFromNorm: (n) => setFilterRes(normToRes(n)),
      display: () => `${filterRes}` },
    { id: 'eqLow', label: 'Low', color: 'black',
      getNorm: () => eqToNorm(eq.low),
      setFromNorm: (n) => setEQ('low', normToEq(n)),
      display: () => `${eq.low > 0 ? '+' : ''}${eq.low}` },
    { id: 'eqMid', label: 'Mid', color: 'black',
      getNorm: () => eqToNorm(eq.mid),
      setFromNorm: (n) => setEQ('mid', normToEq(n)),
      display: () => `${eq.mid > 0 ? '+' : ''}${eq.mid}` },
    { id: 'eqHigh', label: 'High', color: 'black',
      getNorm: () => eqToNorm(eq.high),
      setFromNorm: (n) => setEQ('high', normToEq(n)),
      display: () => `${eq.high > 0 ? '+' : ''}${eq.high}` },
  ];

  let draggingKnob: number | null = $state(null);
  let dragStartY = 0;
  let dragStartNorm = 0;

  function handleKnobStart(idx: number, e: MouseEvent) {
    e.preventDefault();
    draggingKnob = idx;
    dragStartY = e.clientY;
    dragStartNorm = knobDefs[idx].getNorm();
    document.addEventListener('mousemove', handleKnobMove);
    document.addEventListener('mouseup', handleKnobEnd);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';
  }

  function handleKnobMove(e: MouseEvent) {
    if (draggingKnob === null) return;
    e.preventDefault();
    const delta = (dragStartY - e.clientY) / 150;
    const n = Math.max(0, Math.min(1, dragStartNorm + delta));
    knobDefs[draggingKnob].setFromNorm(n);
  }

  function handleKnobEnd() {
    draggingKnob = null;
    document.removeEventListener('mousemove', handleKnobMove);
    document.removeEventListener('mouseup', handleKnobEnd);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  }

  let trackVolumes: number[] = $state([]);
  let trackMuted: boolean[] = $state([]);

  function setTrackVolume(ti: number, volume: number) {
    trackVolumes[ti] = volume;
    player?.setTrackVolume(ti, volume);
  }

  function toggleTrackMuted(ti: number) {
    trackMuted[ti] = !trackMuted[ti];
    player?.setTrackMuted(ti, trackMuted[ti]);
  }

  const TRACK_COLORS = [
    "#D4A847", "#5AABAC", "#C47A7A", "#7A9EC4", "#A87AD4",
    "#7AC48A", "#D4977A", "#7ACAC4", "#C4B07A", "#AD7AC4",
    "#7AC4A8", "#C47AAD",
  ];

  const TYPE_COLORS: Record<string, string> = {
    synth: "#D4A847",
    kit: "#5AABAC",
    midi: "#7A9EC4",
    cv: "#A87AD4",
    audio: "#C47A7A",
  };

  const TYPE_LABELS: Record<string, string> = {
    synth: "Synth",
    kit: "Kit",
    midi: "MIDI",
    cv: "CV",
    audio: "Audio",
  };

  let typeCounts = $derived.by(() => {
    if (!data) return [];
    const counts: Record<string, number> = {};
    for (const t of data.tracks) {
      const type = t.instrumentType ?? (t.isKit ? "kit" : "synth");
      counts[type] = (counts[type] ?? 0) + 1;
    }
    return Object.entries(counts).map(([type, count]) => ({
      type,
      count,
      label: TYPE_LABELS[type] ?? type,
      color: TYPE_COLORS[type] ?? "#888",
    }));
  });

  const TRACK_HEIGHT = 32;
  const HEADER_HEIGHT = 28;
  const LABEL_WIDTH = 140;
  const RULER_HEIGHT = 24;
  const MIN_TIMELINE_WIDTH = 600;
  const PADDING = 16;

  let containerEl: HTMLDivElement | undefined = $state();
  let containerWidth = $state(800);

  $effect(() => {
    if (!containerEl) return;
    const ro = new ResizeObserver(entries => {
      containerWidth = entries[0].contentRect.width;
    });
    ro.observe(containerEl);
    return () => ro.disconnect();
  });

  let layout = $derived.by(() => {
    if (!data || data.tracks.length === 0) return null;

    const ticksPerMeasure = data.ticksPerQuarter * 4;
    const totalMeasures = Math.ceil(data.durationTicks / ticksPerMeasure);
    const trackCount = data.tracks.length;

    const availableWidth = Math.max(containerWidth - LABEL_WIDTH - PADDING * 2, MIN_TIMELINE_WIDTH);
    const pxPerMeasure = Math.max(availableWidth / totalMeasures, 20);
    const timelineWidth = pxPerMeasure * totalMeasures;
    const svgWidth = LABEL_WIDTH + timelineWidth;
    const svgHeight = RULER_HEIGHT + trackCount * TRACK_HEIGHT + PADDING;

    const rulerMarks: { x: number; label: string }[] = [];
    let step = 1;
    if (totalMeasures > 200) step = 16;
    else if (totalMeasures > 100) step = 8;
    else if (totalMeasures > 50) step = 4;
    else if (totalMeasures > 20) step = 2;
    for (let m = 0; m <= totalMeasures; m += step) {
      rulerMarks.push({
        x: LABEL_WIDTH + m * pxPerMeasure,
        label: String(m + 1),
      });
    }

    const isSession = !data.hasArrangement;
    const tracks = data.tracks.map((t, i) => {
      const y = RULER_HEIGHT + i * TRACK_HEIGHT;
      const type = t.instrumentType ?? (t.isKit ? "kit" : "synth");
      const color = TYPE_COLORS[type] ?? TRACK_COLORS[i % TRACK_COLORS.length];
      const clips = t.clips.map((c, ci) => {
        const x = LABEL_WIDTH + (c.positionTicks / ticksPerMeasure) * pxPerMeasure;
        const w = Math.max((c.lengthTicks / ticksPerMeasure) * pxPerMeasure, 2);
        const patternW = isSession
          ? Math.max((c.clipLengthTicks / ticksPerMeasure) * pxPerMeasure, 2)
          : w;
        const loops = isSession && c.clipLengthTicks > 0
          ? Math.ceil(c.lengthTicks / c.clipLengthTicks)
          : 1;
        return { ...c, x, w, patternW, loops, trackIdx: i, clipIdx: ci };
      });
      return { ...t, y, color, clips, isSession };
    });

    return { svgWidth, svgHeight, rulerMarks, tracks, totalMeasures, pxPerMeasure, ticksPerMeasure };
  });

  async function inspect(name: string, xmlContent: string) {
    fileName = name;
    state = "loading";

    try {
      const pyodide = await loadPyodide((stage, pct) => {
        progress = stage;
        progressPct = pct;
      });

      state = "processing";
      progress = "Parsing song";
      progressPct = 85;

      const result = await inspectSong(xmlContent, pyodide);

      if (result.tracks.length === 0) {
        state = "error";
        errorMsg = "No tracks found. This song has no clips or arrangement data.";
        return;
      }

      data = result;
      trackVolumes = result.tracks.map(() => 1);
      trackMuted = result.tracks.map(() => false);
      state = "done";
      progressPct = 100;
      trackToolAction("preview", "inspect");
    } catch (e: any) {
      state = "error";
      errorMsg = e.message || "Failed to parse song";
      trackToolAction("preview", "inspect_error");
    }
  }

  async function handleFile(file: File) {
    if (!file.name.toLowerCase().endsWith(".xml")) {
      state = "error";
      errorMsg = "Please drop a Deluge .XML song file";
      return;
    }
    inspect(file.name, await file.text());
  }

  $effect(() => {
    try {
      const stored = sessionStorage.getItem("deluge-preview-file");
      if (stored) {
        sessionStorage.removeItem("deluge-preview-file");
        const { name, content } = JSON.parse(stored);
        if (name && content) inspect(name, content);
      }
    } catch {}
    try {
      const cached = JSON.parse(sessionStorage.getItem("deluge-stats-results") ?? "null");
      statsCount = Array.isArray(cached) ? cached.length : 0;
    } catch {
      statsCount = 0;
    }
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

  function formatMeasure(ticks: number, ticksPerMeasure: number): string {
    const measure = Math.floor(ticks / ticksPerMeasure) + 1;
    const beat = Math.floor((ticks % ticksPerMeasure) / (ticksPerMeasure / 4)) + 1;
    return `m${measure} beat ${beat}`;
  }

  function formatLength(ticks: number, ticksPerMeasure: number): string {
    const measures = ticks / ticksPerMeasure;
    if (measures === Math.floor(measures)) return `${measures} bar${measures !== 1 ? "s" : ""}`;
    return `${measures.toFixed(1)} bars`;
  }

  function showTooltip(e: MouseEvent, trackIdx: number, clipIdx: number) {
    if (!data || !layout) return;
    const track = data.tracks[trackIdx];
    const clip = track.clips[clipIdx];
    const ticksPerMeasure = layout.ticksPerMeasure;
    const lines = [track.name];
    if (data.hasArrangement) {
      lines.push(formatMeasure(clip.positionTicks, ticksPerMeasure));
    }
    lines.push(formatLength(clip.clipLengthTicks, ticksPerMeasure));
    if (!data.hasArrangement && clip.clipLengthTicks < clip.lengthTicks) {
      const loops = Math.ceil(clip.lengthTicks / clip.clipLengthTicks);
      lines.push(`loops ${loops}x`);
    }
    lines.push(`${clip.noteCount} notes, ${clip.rowCount} rows`);
    hoveredClip = { track: trackIdx, clip: clipIdx };
    tooltip = {
      visible: true,
      x: e.clientX,
      y: e.clientY,
      text: lines.join("\n"),
    };
  }

  function hideTooltip() {
    hoveredClip = null;
    tooltip = { ...tooltip, visible: false };
  }

  function createPlayer() {
    if (!data) return null;
    const p = new SongPlayer({
      bpm: data.bpm,
      ticksPerQuarter: data.ticksPerQuarter,
      tracks: data.tracks,
      durationTicks: data.durationTicks,
      onTick: (tick) => {
        playheadTick = tick;
        autoScrollToPlayhead();
      },
      onEnd: () => { playState = 'stopped'; },
      sampleResolver: cardStore.isLoaded
        ? (path, ctx) => cardStore.getSampleBuffer(path, ctx)
        : undefined,
    });
    for (const { key } of EQ_BANDS) p.setEQ(key, eq[key]);
    p.setFilterCutoff(filterCutoff);
    p.setFilterRes(filterRes);
    for (let i = 0; i < data.tracks.length; i++) {
      p.setTrackVolume(i, trackVolumes[i] ?? 1);
      p.setTrackMuted(i, trackMuted[i] ?? false);
    }
    return p;
  }

  function togglePlay() {
    if (playState === 'playing') {
      player?.pause();
      playState = 'paused';
    } else {
      if (!player || playState === 'stopped') {
        player?.dispose();
        player = createPlayer();
      }
      player?.play();
      playState = 'playing';
      trackToolAction("preview", "play");
    }
  }

  function stopPlayback() {
    player?.stop();
    playState = 'stopped';
    playheadTick = 0;
  }

  function handleTimelineClick(e: MouseEvent) {
    if (!layout || !data) return;
    const svg = e.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const scrollLeft = scrollEl?.scrollLeft ?? 0;
    const x = e.clientX - rect.left + scrollLeft;
    const timelineX = x - LABEL_WIDTH;
    if (timelineX < 0) return;
    const tick = (timelineX / layout.pxPerMeasure) * layout.ticksPerMeasure;
    const clampedTick = Math.max(0, Math.min(tick, data.durationTicks));
    if (!player || playState === 'stopped') {
      player?.dispose();
      player = createPlayer();
    }
    player?.seek(clampedTick);
    playState = 'playing';
  }

  function autoScrollToPlayhead() {
    if (!scrollEl || !layout) return;
    const px = LABEL_WIDTH + (playheadTick / layout.ticksPerMeasure) * layout.pxPerMeasure;
    const viewLeft = scrollEl.scrollLeft;
    const viewRight = viewLeft + scrollEl.clientWidth;
    if (px < viewLeft + 60 || px > viewRight - 60) {
      scrollEl.scrollLeft = px - scrollEl.clientWidth / 3;
    }
  }

  function reset() {
    player?.dispose();
    player = null;
    playState = 'stopped';
    playheadTick = 0;
    state = "idle";
    data = null;
    fileName = "";
    errorMsg = "";
  }
</script>

{#if state === "idle"}
  {#if statsCount > 0}
    <a class="resume-banner" href="/stats">
      <span>{statsCount} song{statsCount === 1 ? "" : "s"} loaded in Song Stats</span>
      <span class="resume-banner-arrow">Back to Song Stats →</span>
    </a>
  {/if}
  {#if cardSongs.length > 0}
    <div class="card-picker">
      <p class="card-picker-title">
        {cardSongs.length} song{cardSongs.length === 1 ? "" : "s"} with arrangement data{cardName ? ` on ${cardName}` : ""}
      </p>
      {#if cardFromCache}
        <p class="card-picker-sub">From your last card scan{cardSavedAt ? ` (${new Date(cardSavedAt).toLocaleString()})` : ""}. Rescan on <a href="/manage">Card Management</a> to refresh.</p>
      {/if}
      <ul class="card-picker-list">
        {#each cardSongs as song}
          <li>
            <button type="button" class="card-picker-item" onclick={() => inspect(song.path, song.xml)}>
              {song.path}
            </button>
          </li>
        {/each}
      </ul>
      <p class="card-picker-hint">or drop a file below</p>
    </div>
  {:else}
    <p class="card-hint">No songs cached yet. <a href="/manage">Scan your card on Card Management</a> to pick a song from a list here instead of dropping a file.</p>
  {/if}
  <div
    class="dropzone"
    class:dropzone--over={dragOver}
    role="button"
    tabindex="0"
    ondrop={handleDrop}
    ondragover={handleDragOver}
    ondragleave={handleDragLeave}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') document.getElementById('preview-file-input')?.click(); }}
  >
    <div class="dropzone-content">
      <span class="dropzone-icon">&#9703;</span>
      <p class="dropzone-title">Drop a Deluge song file</p>
      <p class="dropzone-sub">or <label class="dropzone-browse">browse<input id="preview-file-input" type="file" accept=".xml,.XML" onchange={handleInputChange} hidden /></label></p>
      <p class="dropzone-hint">Visualize your arrangement as a timeline</p>
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
        <span>Parsing</span>
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

{:else if state === "done" && data && layout}
  <div class="preview-panel">
    <div class="preview-panel-header">
      <div class="meta">
        <h2 class="song-name">{fileName.replace(/\.XML$/i, '')}</h2>
        <div class="meta-chips">
          {#if !data.hasArrangement}
            <span class="chip chip--session">Session</span>
          {/if}
          <span class="chip">{data.bpm.toFixed(0)} BPM</span>
          <span class="chip">{data.key}</span>
          <span class="chip">{data.durationStr}</span>
          <span class="chip">{data.trackCount} tracks</span>
          <span class="chip">{data.totalNotes.toLocaleString()} notes</span>
        </div>
      </div>
      <button class="btn btn-secondary" onclick={reset}>Inspect another</button>
    </div>

    {#if typeCounts.length > 0}
      <div class="type-breakdown">
        <h3 class="type-breakdown-title">Instruments</h3>
        <div class="type-grid">
          {#each typeCounts as tc}
            <div class="type-card">
              <span class="type-dot" style="background: {tc.color}"></span>
              <span class="type-label">{tc.label}</span>
              <span class="type-count">{tc.count}</span>
            </div>
          {/each}
        </div>
        <div class="track-list">
          {#each data!.tracks as track, ti}
            {@const type = track.instrumentType ?? (track.isKit ? "kit" : "synth")}
            {@const totalNotes = track.clips.reduce((s, c) => s + c.noteCount, 0)}
            <div class="track-row">
              <span class="track-row-dot" style="background: {TYPE_COLORS[type] ?? '#888'}"></span>
              <span class="track-row-name">{track.name}</span>
              <span class="track-row-type">{TYPE_LABELS[type] ?? type}</span>
              {#if track.midiChannel != null}
                <span class="track-row-detail">Ch {track.midiChannel + 1}</span>
              {/if}
              {#if track.cvChannel != null}
                <span class="track-row-detail">Ch {track.cvChannel + 1}</span>
              {/if}
              <span class="track-row-notes">{totalNotes} notes</span>
              <button
                class="track-mute-btn"
                class:track-mute-btn--active={trackMuted[ti]}
                onclick={() => toggleTrackMuted(ti)}
                title={trackMuted[ti] ? 'Unmute' : 'Mute'}
              >M</button>
              <input
                class="track-volume-slider"
                type="range"
                min="0"
                max="1.5"
                step="0.05"
                value={trackVolumes[ti] ?? 1}
                oninput={(e) => setTrackVolume(ti, Number((e.target as HTMLInputElement).value))}
                title="{track.name} volume"
              />
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <div class="transport">
      <button class="transport-btn" onclick={togglePlay} title={playState === 'playing' ? 'Pause' : 'Play'}>
        {#if playState === 'playing'}
          <svg width="16" height="16" viewBox="0 0 16 16"><rect x="3" y="2" width="4" height="12" fill="currentColor"/><rect x="9" y="2" width="4" height="12" fill="currentColor"/></svg>
        {:else}
          <svg width="16" height="16" viewBox="0 0 16 16"><polygon points="3,1 14,8 3,15" fill="currentColor"/></svg>
        {/if}
      </button>
      <button class="transport-btn" onclick={stopPlayback} title="Stop" disabled={playState === 'stopped'}>
        <svg width="16" height="16" viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" fill="currentColor"/></svg>
      </button>
      {#if layout}
        <span class="transport-time">
          {Math.floor(playheadTick / layout.ticksPerMeasure) + 1}:{Math.floor((playheadTick % layout.ticksPerMeasure) / (layout.ticksPerMeasure / 4)) + 1}
        </span>
      {/if}

      <div class="knob-strip">
        {#each knobDefs as def, ki}
          {@const angle = valToAngle(def.getNorm())}
          {#if ki === 2}
            <div class="knob-divider"></div>
          {/if}
          <div class="knob-group">
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="knob-hitbox"
              onmousedown={(e) => handleKnobStart(ki, e)}
              title="{def.label}"
            >
              <div class="knob-3d" style="transform: rotate({angle}deg)">
                <div class="knob-barrel knob-barrel--{def.color}"></div>
                <div class="knob-top knob-top--{def.color}">
                  <div class="knob-notch {def.color === 'gold' ? 'knob-notch--dark' : ''}"></div>
                </div>
              </div>
            </div>
            <span class="knob-label">{def.label}</span>
            <span class="knob-value">{def.display()}</span>
          </div>
        {/each}
      </div>
    </div>

    <div class="timeline-container" bind:this={containerEl}>
      <div class="timeline-scroll" bind:this={scrollEl}>
        <svg
          width={layout.svgWidth}
          height={layout.svgHeight}
          viewBox="0 0 {layout.svgWidth} {layout.svgHeight}"
          class="timeline-svg"
          onclick={handleTimelineClick}
          role="none"
        >
          <!-- Ruler -->
          {#each layout.rulerMarks as mark}
            <line
              x1={mark.x}
              y1={RULER_HEIGHT - 4}
              x2={mark.x}
              y2={layout.svgHeight}
              stroke="var(--border)"
              stroke-width="0.5"
            />
            <text
              x={mark.x + 3}
              y={RULER_HEIGHT - 8}
              class="ruler-text"
              fill="var(--text-secondary)"
            >{mark.label}</text>
          {/each}

          <!-- Ruler baseline -->
          <line
            x1={LABEL_WIDTH}
            y1={RULER_HEIGHT}
            x2={layout.svgWidth}
            y2={RULER_HEIGHT}
            stroke="var(--border)"
            stroke-width="1"
          />

          <!-- Tracks -->
          {#each layout.tracks as track, ti}
            <!-- Track background -->
            {#if ti % 2 === 0}
              <rect
                x="0"
                y={track.y}
                width={layout.svgWidth}
                height={TRACK_HEIGHT}
                fill="var(--surface)"
                opacity="0.5"
              />
            {/if}

            <!-- Track separator -->
            <line
              x1="0"
              y1={track.y + TRACK_HEIGHT}
              x2={layout.svgWidth}
              y2={track.y + TRACK_HEIGHT}
              stroke="var(--border)"
              stroke-width="0.5"
            />

            <!-- Track label -->
            <text
              x={LABEL_WIDTH - 8}
              y={track.y + TRACK_HEIGHT / 2 + 4}
              text-anchor="end"
              class="track-label"
              fill="var(--text)"
            >{track.name}</text>

            <!-- Clip instances -->
            {#each track.clips as clip, ci}
              {@const isHovered = hoveredClip?.track === ti && hoveredClip?.clip === ci}
              {#if track.isSession && clip.loops > 1}
                <!-- Session mode: show pattern repeats as faded blocks -->
                {#each Array(clip.loops) as _, li}
                  {@const loopX = clip.x + li * clip.patternW}
                  {@const loopW = Math.min(clip.patternW, clip.w - li * clip.patternW)}
                  {#if loopW > 0}
                    <rect
                      x={loopX}
                      y={track.y + 3}
                      width={loopW}
                      height={TRACK_HEIGHT - 6}
                      rx={li === 0 ? 3 : 0}
                      fill={track.color}
                      opacity={li === 0 ? (isHovered ? 1 : 0.75) : (isHovered ? 0.55 : 0.35)}
                      stroke={li === 0 && isHovered ? "var(--text)" : "none"}
                      stroke-width="1.5"
                      style="cursor: pointer"
                      onmouseenter={(e) => showTooltip(e, ti, ci)}
                      onmousemove={(e) => { if (tooltip.visible) tooltip = { ...tooltip, x: e.clientX, y: e.clientY }; }}
                      onmouseleave={hideTooltip}
                    />
                    {#if li > 0}
                      <line
                        x1={loopX} y1={track.y + 5}
                        x2={loopX} y2={track.y + TRACK_HEIGHT - 5}
                        stroke="var(--ground)"
                        stroke-width="0.5"
                        opacity="0.5"
                        style="pointer-events: none"
                      />
                    {/if}
                  {/if}
                {/each}
              {:else}
                <rect
                  x={clip.x}
                  y={track.y + 3}
                  width={clip.w}
                  height={TRACK_HEIGHT - 6}
                  rx="3"
                  fill={track.color}
                  opacity={isHovered ? 1 : 0.75}
                  stroke={isHovered ? "var(--text)" : "none"}
                  stroke-width="1.5"
                  style="cursor: pointer"
                  onmouseenter={(e) => showTooltip(e, ti, ci)}
                  onmousemove={(e) => { if (tooltip.visible) tooltip = { ...tooltip, x: e.clientX, y: e.clientY }; }}
                  onmouseleave={hideTooltip}
                />
              {/if}
              <!-- Clip label (only if wide enough) -->
              {#if clip.w > 40}
                <text
                  x={clip.x + 5}
                  y={track.y + TRACK_HEIGHT / 2 + 3}
                  class="clip-label"
                  fill="var(--ground)"
                  style="pointer-events: none"
                >{clip.noteCount}n</text>
              {/if}
            {/each}
          {/each}

          <!-- Playhead -->
          {#if playState !== 'stopped' && playheadTick > 0}
            {@const px = LABEL_WIDTH + (playheadTick / layout.ticksPerMeasure) * layout.pxPerMeasure}
            <line
              x1={px} y1={RULER_HEIGHT}
              x2={px} y2={layout.svgHeight}
              stroke="var(--accent)"
              stroke-width="2"
              opacity="0.9"
              style="pointer-events: none"
            />
            <circle
              cx={px} cy={RULER_HEIGHT}
              r="4"
              fill="var(--accent)"
              style="pointer-events: none"
            />
          {/if}
        </svg>
      </div>
    </div>

    <!-- Legend -->
    <div class="legend">
      {#each layout.tracks as track}
        <div class="legend-item">
          <span class="legend-swatch" style="background: {track.color}"></span>
          <span class="legend-name">{track.name}</span>
        </div>
      {/each}
    </div>
  </div>

  <!-- Tooltip (portal to body) -->
  {#if tooltip.visible}
    <div
      class="tooltip"
      style="left: {tooltip.x + 12}px; top: {tooltip.y - 8}px"
    >
      {#each tooltip.text.split('\n') as line, i}
        <span class:tooltip-title={i === 0} class:tooltip-detail={i > 0}>{line}</span>
      {/each}
    </div>
  {/if}

{:else if state === "error"}
  <div class="error-card">
    <p class="error-msg">{errorMsg}</p>
    <button class="btn btn-secondary" onclick={reset}>Try again</button>
  </div>
{/if}

<style>
  .resume-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
    text-decoration: none;
    font-size: 0.85rem;
    transition: border-color 0.05s, background 0.05s;
  }
  .resume-banner:hover {
    border-color: var(--accent);
    background: var(--accent-dim);
  }
  .resume-banner-arrow {
    font-family: 'DM Mono', monospace;
    color: var(--accent);
    flex-shrink: 0;
  }
  .card-hint {
    font-size: 0.82rem;
    color: var(--text-secondary);
    margin-bottom: 1rem;
  }
  .card-hint a {
    color: var(--accent);
  }
  .card-picker {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1rem 1.25rem;
    margin-bottom: 1rem;
    background: var(--surface);
  }
  .card-picker-title {
    font-family: 'DM Mono', monospace;
    font-size: 0.82rem;
    font-weight: 500;
    margin-bottom: 0.3rem;
  }
  .card-picker-sub {
    font-size: 0.78rem;
    color: var(--text-secondary);
    margin-bottom: 0.6rem;
  }
  .card-picker-sub a {
    color: var(--accent);
  }
  .card-picker-list {
    list-style: none;
    margin: 0 0 0.5rem;
    padding: 0;
    max-height: 220px;
    overflow-y: auto;
  }
  .card-picker-item {
    display: block;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    color: var(--text);
    font-family: 'DM Mono', monospace;
    font-size: 0.8rem;
    padding: 0.4rem 0.5rem;
    border-radius: 5px;
    cursor: pointer;
    transition: background 0.05s;
  }
  .card-picker-item:hover {
    background: var(--accent-dim);
    color: var(--accent);
  }
  .card-picker-hint {
    font-size: 0.78rem;
    color: var(--text-secondary);
    opacity: 0.7;
  }
  .card-reconnect {
    width: 100%;
    border: none;
    font-family: inherit;
    cursor: pointer;
  }

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
    border-color: var(--teal);
    background: var(--teal-dim);
  }
  .dropzone:focus-visible {
    outline: 2px solid var(--teal);
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
    color: var(--teal);
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
    transition: color 0.05s;
  }
  .pipeline-step--active {
    color: var(--teal);
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
    background: var(--teal);
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
    background: var(--teal);
    border-radius: 2px;
    transition: width 0.4s ease;
  }

  .status-file {
    font-family: 'DM Mono', monospace;
    font-size: 0.82rem;
    color: var(--text-secondary);
  }

  /* Preview result */
  .preview-panel {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .preview-panel-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .song-name {
    font-family: 'DM Mono', monospace;
    font-size: 1.1rem;
    font-weight: 500;
    margin-bottom: 0.4rem;
  }

  .meta-chips {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .chip {
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem;
    padding: 0.2rem 0.5rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-secondary);
  }
  .chip--session {
    background: var(--teal);
    border-color: var(--teal);
    color: var(--ground);
    font-weight: 600;
  }

  .transport {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .transport-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    transition: background 0.05s, border-color 0.05s;
  }
  .transport-btn:hover:not(:disabled) {
    border-color: var(--teal);
    color: var(--teal);
  }
  .transport-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .transport-time {
    font-family: 'DM Mono', monospace;
    font-size: 0.82rem;
    color: var(--text-secondary);
    min-width: 4ch;
  }

  .knob-strip {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-left: auto;
    padding-left: 0.75rem;
    border-left: 1px solid var(--border);
  }

  .knob-divider {
    width: 1px;
    height: 48px;
    background: var(--border);
    margin: 0 0.3rem;
  }

  .knob-group {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0;
  }

  .knob-hitbox {
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: grab;
    flex-shrink: 0;
    user-select: none;
    -webkit-user-select: none;
    touch-action: none;
  }
  .knob-hitbox:active { cursor: grabbing; }

  .knob-3d {
    position: relative;
    width: 32px;
    height: 32px;
  }

  .knob-barrel {
    position: absolute;
    inset: 0;
    border-radius: 50%;
  }
  .knob-barrel--gold {
    box-shadow:
      0 3px 1px #7A5818,
      0 4px 1px #6A4810,
      0 5px 2px rgba(0,0,0,0.5);
    background: linear-gradient(180deg,
      #C4942A 0%, #9A7420 40%, #7A5818 100%
    );
  }
  .knob-barrel--black {
    box-shadow:
      0 3px 1px #1A1A1E,
      0 4px 1px #111,
      0 5px 2px rgba(0,0,0,0.5);
    background: linear-gradient(180deg,
      #3A3A40 0%, #252528 40%, #1A1A1E 100%
    );
  }

  .knob-top {
    position: absolute;
    inset: 2px;
    border-radius: 50%;
    z-index: 1;
  }
  .knob-top--gold {
    background:
      repeating-conic-gradient(from 0deg,
        #C4942A 0deg 2.5deg,
        #D4A847 2.5deg 3.5deg,
        #B08828 3.5deg 5deg,
        #C4942A 5deg 7.5deg
      );
    border: 1px solid #A07828;
    box-shadow:
      inset 0 2px 4px rgba(255,255,200,0.2),
      inset 0 -2px 4px rgba(0,0,0,0.2);
  }
  .knob-top--gold:hover {
    box-shadow:
      inset 0 2px 4px rgba(255,255,200,0.3),
      inset 0 -2px 4px rgba(0,0,0,0.15),
      0 0 8px rgba(212,168,71,0.3);
  }
  .knob-top--black {
    background:
      repeating-conic-gradient(from 0deg,
        #252528 0deg 2.5deg,
        #3A3A40 2.5deg 3.5deg,
        #1E1E22 3.5deg 5deg,
        #2A2A2E 5deg 7.5deg
      );
    border: 1px solid #444;
    box-shadow:
      inset 0 2px 4px rgba(255,255,255,0.06),
      inset 0 -2px 4px rgba(0,0,0,0.3);
  }
  .knob-top--black:hover {
    box-shadow:
      inset 0 2px 4px rgba(255,255,255,0.1),
      inset 0 -2px 4px rgba(0,0,0,0.2),
      0 0 6px rgba(255,255,255,0.08);
  }

  .knob-notch {
    position: absolute;
    top: 3px;
    left: 50%;
    transform: translateX(-50%);
    width: 2px;
    height: 7px;
    background: #CCC;
    border-radius: 1px;
    box-shadow: 0 0 2px rgba(0,0,0,0.4);
  }
  .knob-notch--dark {
    background: #2A1A0A;
    box-shadow: 0 0 2px rgba(0,0,0,0.2);
  }

  .knob-label {
    font-family: 'DM Mono', monospace;
    font-size: 0.62rem;
    color: var(--text-secondary);
    line-height: 1;
  }

  .knob-value {
    font-family: 'DM Mono', monospace;
    font-size: 0.58rem;
    color: var(--text-secondary);
    opacity: 0.7;
    line-height: 1;
  }

  .timeline-container {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--ground);
    overflow: hidden;
  }

  .timeline-scroll {
    overflow-x: auto;
    overflow-y: hidden;
  }

  .timeline-svg {
    display: block;
  }

  .ruler-text {
    font-family: 'DM Mono', monospace;
    font-size: 9px;
  }

  .track-label {
    font-family: 'DM Mono', monospace;
    font-size: 11px;
  }

  .clip-label {
    font-family: 'DM Mono', monospace;
    font-size: 9px;
    font-weight: 500;
  }

  .legend {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
    padding: 0.5rem 0;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .legend-swatch {
    width: 12px;
    height: 12px;
    border-radius: 3px;
  }

  .legend-name {
    font-family: 'DM Mono', monospace;
    font-size: 0.75rem;
    color: var(--text-secondary);
  }

  /* Tooltip */
  .tooltip {
    position: fixed;
    z-index: 1000;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.5rem 0.7rem;
    pointer-events: none;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }

  .tooltip-title {
    font-family: 'DM Mono', monospace;
    font-size: 0.78rem;
    font-weight: 500;
    color: var(--text);
  }

  .tooltip-detail {
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem;
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
    transition: background 0.05s;
  }
  .btn-secondary {
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
  }
  .btn-secondary:hover { background: var(--surface); }

  .type-breakdown {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1rem 1.25rem;
  }
  .type-breakdown-title {
    font-family: 'DM Mono', monospace;
    font-size: 0.78rem;
    font-weight: 500;
    color: var(--text-secondary);
    margin-bottom: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .type-grid {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
    margin-bottom: 0.75rem;
  }
  .type-card {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-family: 'DM Mono', monospace;
    font-size: 0.82rem;
  }
  .type-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .type-label {
    color: var(--text-secondary);
  }
  .type-count {
    font-weight: 600;
    color: var(--text);
  }

  .track-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    border-top: 1px solid var(--border);
    padding-top: 0.75rem;
  }
  .track-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-family: 'DM Mono', monospace;
    font-size: 0.78rem;
    padding: 0.2rem 0;
  }
  .track-row-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .track-row-name {
    color: var(--text);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .track-row-type {
    color: var(--text-secondary);
    font-size: 0.72rem;
  }
  .track-row-detail {
    color: var(--text-secondary);
    font-size: 0.72rem;
    opacity: 0.7;
  }
  .track-row-notes {
    color: var(--text-secondary);
    font-size: 0.72rem;
    white-space: nowrap;
  }
  .track-mute-btn {
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-secondary);
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.05s, border-color 0.05s, color 0.05s;
  }
  .track-mute-btn:hover {
    border-color: var(--teal);
    color: var(--teal);
  }
  .track-mute-btn--active {
    background: #c47a7a;
    border-color: #c47a7a;
    color: var(--ground);
  }
  .track-volume-slider {
    flex-shrink: 0;
    width: 70px;
    accent-color: var(--teal);
  }
</style>
