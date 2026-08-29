<script lang="ts">
  import { onMount } from 'svelte';

  interface Pad {
    row: number;
    col: number;
    color: string;
    glowIntensity: number;
    active: boolean;
    link?: string;
    label?: string;
    group?: string;
  }

  const ROWS = 8;
  const COLS = 16;
  const SIDEBAR_COLS = 2;

  const GOLD = '#D4A847';
  const TEAL = '#5AABAC';
  const GREEN = '#40A060';
  const PURPLE = '#8050B0';
  const WHITE = '#E0DDD6';
  const OFF = 'transparent';

  // 7 knobs matching real Deluge layout
  // Left: 2 black diagonal + 2 gold diagonal to their right
  // Center-left: 1 black knob next to screen
  // Right: 1 gold + 1 black, horizontally parallel
  let knobValues = [64, 64, 64, 64, 64, 120, 100];
  let knobAngles = knobValues.map(v => (v / 127) * 270 - 135);
  const knobMeta = [
    { name: 'upper',    style: 'black' },  // 0: left upper black
    { name: 'select',   style: 'black' },  // 1: left lower black
    { name: 'scroll',   style: 'gold'  },  // 2: left upper gold
    { name: 'encoder',  style: 'gold'  },  // 3: left lower gold
    { name: 'navigate', style: 'black' },  // 4: black knob left of screen
    { name: 'tempo',    style: 'black' },  // 5: right black (left position)
    { name: 'output',   style: 'gold'  },  // 6: right gold (rightmost)
  ];

  let screenText = 'DELUGE TOOLS';
  let screenSubtext = 'drop a song to begin';
  let pads: Pad[][] = [];
  let sidebarPads: Pad[][] = [];
  let mounted = false;
  let draggingKnob: number | null = null;
  let dragStartY = 0;
  let dragStartAngle = 0;

  const DESIGN_WIDTH = 900;
  let wrapperWidth = DESIGN_WIDTH;
  let housingHeight = 0;
  $: scale = Math.min(1, wrapperWidth / DESIGN_WIDTH);

  const TOOLS: { group: string; label: string; link: string; color: string; subtext: string }[] = [
    { group: 'stats',     label: 'Song Stats',      link: '/stats',     color: PURPLE, subtext: 'library analysis & stats' },
    { group: 'clean',     label: 'Card Clean',      link: '/clean',     color: WHITE,  subtext: 'find unused samples' },
    { group: 'score',     label: 'Score Converter',  link: '/score',     color: GOLD,   subtext: 'Deluge XML → MusicXML' },
    { group: 'midi',      label: 'MIDI Import',      link: '/import',    color: GREEN,  subtext: 'MIDI → Deluge XML' },
    { group: 'inspector', label: 'Song Inspector',   link: '/inspector', color: TEAL,   subtext: 'visual arrangement timeline' },
  ];

  const FUTURE_TOOLS: { group: string; label: string; subtext: string }[] = [
    { group: 'future-1', label: 'Coming Soon', subtext: '' },
    { group: 'future-2', label: 'Coming Soon', subtext: '' },
    { group: 'future-3', label: 'Coming Soon', subtext: '' },
  ];

  function toolAt(r: number, c: number): typeof TOOLS[number] | undefined {
    const blockRow = Math.floor(r / 4);
    const blockCol = Math.floor(c / 4);
    const idx = blockRow * 4 + blockCol;
    return TOOLS[idx];
  }

  function futureAt(r: number, c: number): typeof FUTURE_TOOLS[number] | undefined {
    const blockRow = Math.floor(r / 4);
    if (blockRow !== 1) return undefined;
    const blockCol = Math.floor(c / 4);
    const toolsOnRow1 = TOOLS.length - 4;
    const idx = blockCol - toolsOnRow1;
    if (idx < 0) return undefined;
    return FUTURE_TOOLS[idx];
  }

  function initPads() {
    pads = [];
    for (let r = 0; r < ROWS; r++) {
      const row: Pad[] = [];
      for (let c = 0; c < COLS; c++) {
        let color = OFF;
        let glowIntensity = 0;
        let active = false;
        let link: string | undefined;
        let label: string | undefined;
        let group: string | undefined;

        const tool = toolAt(r, c);
        if (tool) {
          color = tool.color; glowIntensity = 0.7; active = true;
          link = tool.link; label = tool.label; group = tool.group;
        } else {
          const future = futureAt(r, c);
          if (future) {
            color = WHITE; glowIntensity = 0.08;
            group = future.group; label = future.label;
          }
        }

        row.push({ row: r, col: c, color, glowIntensity, active, link, label, group });
      }
      pads.push(row);
    }

    sidebarPads = [];
    for (let r = 0; r < ROWS; r++) {
      const row: Pad[] = [];
      for (let c = 0; c < SIDEBAR_COLS; c++) {
        let color = OFF;
        let glowIntensity = 0;
        let active = false;
        let link: string | undefined;
        let label: string | undefined;
        let group: string | undefined;

        const MUTE_COLORS = ['#40A060','#CC3030','#40A060','#CC3030','#40A060','#CC3030','#40A060','#CC3030'];
        const AUDITION_COLORS = ['#4488DD','#DD55AA','#DDBB33','#5AABAC','#CC3030','#AACC30','#3355CC','#FF6622'];

        if (c === 0) {
          color = MUTE_COLORS[r]; glowIntensity = 0.5; active = true;
          link = 'https://github.com/dannybrown37/deluge';
          label = 'GitHub'; group = 'github';
        } else {
          color = AUDITION_COLORS[r]; glowIntensity = 0.5; active = true;
          link = '/about'; label = 'About'; group = 'about';
        }

        row.push({ row: r, col: c, color, glowIntensity, active, link, label, group });
      }
      sidebarPads.push(row);
    }
  }

  function handlePadHover(pad: Pad) {
    if (!pad.label) return;
    screenText = pad.label.toUpperCase();
    const allTools = [...TOOLS, ...FUTURE_TOOLS];
    const match = allTools.find(t => t.group === pad.group);
    if (match) { screenSubtext = match.subtext; }
    else if (pad.group === 'about') screenSubtext = 'open source / community';
    else if (pad.group === 'github') screenSubtext = 'view source code';
    else screenSubtext = '';
  }

  function handlePadLeave() {
    screenText = 'DELUGE TOOLS';
    screenSubtext = 'drop a song to begin';
  }

  function handlePadClick(pad: Pad) {
    if (pad.link) {
      if (pad.link.startsWith('http')) window.open(pad.link, '_blank', 'noopener');
      else window.location.href = pad.link;
    }
  }

  function handleKnobStart(idx: number, e: MouseEvent | TouchEvent) {
    draggingKnob = idx;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    dragStartY = clientY;
    dragStartAngle = knobAngles[idx];
    e.preventDefault();
  }

  function handleKnobMove(e: MouseEvent | TouchEvent) {
    if (draggingKnob === null) return;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const delta = (dragStartY - clientY) * 1.5;
    knobAngles[draggingKnob] = Math.max(-135, Math.min(135, dragStartAngle + delta));
    knobValues[draggingKnob] = Math.round(((knobAngles[draggingKnob] + 135) / 270) * 127);
    screenText = knobMeta[draggingKnob].name.toUpperCase();
    screenSubtext = `${knobValues[draggingKnob]}`;
  }

  function handleKnobEnd() {
    if (draggingKnob !== null) {
      draggingKnob = null;
      screenText = 'DELUGE TOOLS';
      screenSubtext = 'drop a song to begin';
    }
  }

  function handleKnobWheel(idx: number, e: WheelEvent) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -5 : 5;
    knobAngles[idx] = Math.max(-135, Math.min(135, knobAngles[idx] + delta));
    knobValues[idx] = Math.round(((knobAngles[idx] + 135) / 270) * 127);
    screenText = knobMeta[idx].name.toUpperCase();
    screenSubtext = `${knobValues[idx]}`;
  }

  onMount(() => {
    mounted = true;
    initPads();

    window.addEventListener('mousemove', handleKnobMove);
    window.addEventListener('mouseup', handleKnobEnd);
    window.addEventListener('touchmove', handleKnobMove, { passive: false });
    window.addEventListener('touchend', handleKnobEnd);

    return () => {
      window.removeEventListener('mousemove', handleKnobMove);
      window.removeEventListener('mouseup', handleKnobEnd);
      window.removeEventListener('touchmove', handleKnobMove);
      window.removeEventListener('touchend', handleKnobEnd);
    };
  });
</script>

<div class="deluge-scaler" bind:clientWidth={wrapperWidth} style="height: {housingHeight * scale}px;">
<div class="deluge-housing" bind:clientHeight={housingHeight} style="transform: scale({scale}); transform-origin: top center;">
  <div class="wood-panel wood-panel--left"></div>

  <div class="deluge-body">
    <!-- Control panel: knobs + logo + screen only -->
    <div class="control-panel">

      <!-- LEFT: 2 black + 2 gold knobs as separate diagonal columns -->
      <div class="knobs-left" style="position:relative; width:265px; height:114px;">
        <!-- 4 knobs positioned absolutely: bottom-left black is anchor -->
        <!-- Knob 0: upper black — top row, left -->
        <div
          class="knob-hitbox"
          style="position:absolute; top:0; left:79px;"
          role="slider" tabindex="0"
          aria-label={knobMeta[0].name}
          aria-valuenow={knobValues[0]}
          on:mousedown={(e) => handleKnobStart(0, e)}
          on:touchstart={(e) => handleKnobStart(0, e)}
          on:wheel={(e) => handleKnobWheel(0, e)}
        >
          <div class="knob-3d">
            <div class="knob-barrel knob-barrel--black"></div>
            <div class="knob-top knob-top--black"></div>
          </div>
        </div>
        <!-- Knob 1: lower black — bottom row, far left (anchor) -->
        <div
          class="knob-hitbox"
          style="position:absolute; bottom:0; left:0;"
          role="slider" tabindex="0"
          aria-label={knobMeta[1].name}
          aria-valuenow={knobValues[1]}
          on:mousedown={(e) => handleKnobStart(1, e)}
          on:touchstart={(e) => handleKnobStart(1, e)}
          on:wheel={(e) => handleKnobWheel(1, e)}
        >
          <div class="knob-3d">
            <div class="knob-barrel knob-barrel--black"></div>
            <div class="knob-top knob-top--black"></div>
          </div>
        </div>
        <!-- Knob 2: upper gold — top row, right -->
        <div
          class="knob-hitbox"
          style="position:absolute; top:0; left:209px;"
          role="slider" tabindex="0"
          aria-label={knobMeta[2].name}
          aria-valuenow={knobValues[2]}
          on:mousedown={(e) => handleKnobStart(2, e)}
          on:touchstart={(e) => handleKnobStart(2, e)}
          on:wheel={(e) => handleKnobWheel(2, e)}
        >
          <div class="knob-3d">
            <div class="knob-barrel knob-barrel--gold"></div>
            <div class="knob-top knob-top--gold"></div>
          </div>
        </div>
        <!-- Knob 3: lower gold — bottom row, middle -->
        <div
          class="knob-hitbox"
          style="position:absolute; bottom:0; left:128px;"
          role="slider" tabindex="0"
          aria-label={knobMeta[3].name}
          aria-valuenow={knobValues[3]}
          on:mousedown={(e) => handleKnobStart(3, e)}
          on:touchstart={(e) => handleKnobStart(3, e)}
          on:wheel={(e) => handleKnobWheel(3, e)}
        >
          <div class="knob-3d">
            <div class="knob-barrel knob-barrel--gold"></div>
            <div class="knob-top knob-top--gold"></div>
          </div>
        </div>
      </div>

      <!-- Center group: black knob + logo/screen -->
      <div class="center-group">
        <div class="knob-screen-left">
          <div
            class="knob-hitbox"
            role="slider" tabindex="0"
            aria-label={knobMeta[4].name}
            aria-valuenow={knobValues[4]}
            on:mousedown={(e) => handleKnobStart(4, e)}
            on:touchstart={(e) => handleKnobStart(4, e)}
            on:wheel={(e) => handleKnobWheel(4, e)}
          >
            <div class="knob-3d">
              <div class="knob-barrel knob-barrel--black"></div>
              <div class="knob-top knob-top--black"></div>
            </div>
          </div>
        </div>

        <div class="screen-area">
          <div class="deluge-logo">✦ deluge</div>
          <div class="oled-screen">
            <div class="oled-text">{screenText}</div>
            <div class="oled-subtext">{screenSubtext || ' '}</div>
          </div>
        </div>
      </div>

      <!-- RIGHT: black + gold knobs, horizontally parallel (gold on right) -->
      <div class="knobs-right">
        <!-- Black (tempo) -->
        <div
          class="knob-hitbox"
          role="slider" tabindex="0"
          aria-label={knobMeta[5].name}
          aria-valuenow={knobValues[5]}
          on:mousedown={(e) => handleKnobStart(5, e)}
          on:touchstart={(e) => handleKnobStart(5, e)}
          on:wheel={(e) => handleKnobWheel(5, e)}
        >
          <div class="knob-3d">
            <div class="knob-barrel knob-barrel--black"></div>
            <div class="knob-top knob-top--black"></div>
          </div>
        </div>
        <!-- Gold (output level) -->
        <div
          class="knob-hitbox"
          role="slider" tabindex="0"
          aria-label={knobMeta[6].name}
          aria-valuenow={knobValues[6]}
          on:mousedown={(e) => handleKnobStart(6, e)}
          on:touchstart={(e) => handleKnobStart(6, e)}
          on:wheel={(e) => handleKnobWheel(6, e)}
        >
          <div class="knob-3d" style="transform: rotate({knobAngles[6]}deg)">
            <div class="knob-barrel knob-barrel--gold"></div>
            <div class="knob-top knob-top--gold">
              <div class="knob-notch knob-notch--dark"></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Pad grid: 18 columns (16 main + gap + 2 sidebar) -->
    {#if mounted}
      <div class="pad-grid">
        {#each { length: ROWS } as _, r}
          {#each pads[r] as pad}
            <button
              class="pad"
              class:pad--lit={pad.glowIntensity > 0}
              class:pad--clickable={!!pad.link}
              style="--glow-color: {pad.color}; --glow-intensity: {pad.glowIntensity}"
              on:mouseenter={() => handlePadHover(pad)}
              on:mouseleave={handlePadLeave}
              on:click={() => handlePadClick(pad)}
              aria-label={pad.label || `Pad ${pad.row + 1}-${pad.col + 1}`}
            ></button>
          {/each}
          <div class="grid-gap"></div>
          {#each sidebarPads[r] as pad}
            <button
              class="pad"
              class:pad--lit={pad.glowIntensity > 0}
              class:pad--clickable={!!pad.link}
              style="--glow-color: {pad.color}; --glow-intensity: {pad.glowIntensity}"
              on:mouseenter={() => handlePadHover(pad)}
              on:mouseleave={handlePadLeave}
              on:click={() => handlePadClick(pad)}
              aria-label={pad.label || `Sidebar ${pad.row + 1}-${pad.col + 1}`}
            ></button>
          {/each}
        {/each}
      </div>
    {/if}

    <div class="grid-labels">
      <div class="grid-label grid-label--stats"># Stats</div>
      <div class="grid-label grid-label--score">&#9835; Score</div>
      <div class="grid-label grid-label--midi">&#9834; Import</div>
      <div class="grid-label grid-label--inspector">&#9703; Inspector</div>
      <div class="grid-labels-gap"></div>
      <div class="grid-label grid-label--sidebar">MUTE<br/>LAUNCH</div>
      <div class="grid-label grid-label--sidebar">AUDITION<br/>SECTION</div>
    </div>
  </div>

  <div class="wood-panel wood-panel--right"></div>
</div>
</div>

<style>
  /* === Scaler wrapper === */
  .deluge-scaler {
    width: 100%;
    position: relative;
  }

  /* === Housing === */
  .deluge-housing {
    display: flex;
    width: 900px;
    margin: 0 auto;
    user-select: none;
    filter: drop-shadow(0 12px 40px rgba(0,0,0,0.5));
  }

  .wood-panel {
    width: 28px;
    flex-shrink: 0;
    background:
      repeating-linear-gradient(180deg,
        transparent 0px, transparent 3px,
        rgba(0,0,0,0.06) 3px, rgba(0,0,0,0.06) 4px
      ),
      linear-gradient(90deg,
        rgba(0,0,0,0.15) 0%, transparent 30%, transparent 70%, rgba(0,0,0,0.15) 100%
      ),
      linear-gradient(180deg,
        #7A4A30 0%, #8B5838 10%, #6B3E28 20%, #8B5838 30%,
        #7A4A30 40%, #6B3E28 50%, #8B5838 60%, #7A4A30 70%,
        #6B3E28 80%, #8B5838 90%, #7A4A30 100%
      );
  }
  .wood-panel--left {
    border-radius: 14px 0 0 14px;
    border-right: 1px solid #3A2218;
  }
  .wood-panel--right {
    border-radius: 0 14px 14px 0;
    border-left: 1px solid #3A2218;
  }

  .deluge-body {
    flex: 1;
    background: #111114;
    padding: 0.6rem 1rem 1rem;
    position: relative;
    min-width: 0;
  }

  /* === Control panel === */
  .control-panel {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 0.6rem;
    padding: 0.25rem 0;
  }

  /* --- Left knobs: black col + gold col, each with diagonal offset --- */
  .knobs-left {
    position: relative;
    width: 156px;
    height: 114px;
    flex-shrink: 0;
  }

  /* --- Right knobs: gold + black, same row --- */
  .knobs-right {
    display: flex;
    gap: 10px;
    align-self: flex-start;
    flex-shrink: 0;
  }

  /* --- Knob rendering --- */
  .knob-hitbox {
    width: 56px;
    height: 56px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: grab;
    flex-shrink: 0;
  }
  .knob-hitbox:active { cursor: grabbing; }

  .knob-3d {
    position: relative;
    width: 48px;
    height: 48px;
  }

  .knob-barrel {
    position: absolute;
    inset: 0;
    border-radius: 50%;
  }
  .knob-barrel--gold {
    box-shadow:
      0 4px 1px #7A5818,
      0 5px 1px #6A4810,
      0 6px 2px rgba(0,0,0,0.5);
    background: linear-gradient(180deg,
      #C4942A 0%, #9A7420 40%, #7A5818 100%
    );
  }
  .knob-barrel--black {
    box-shadow:
      0 4px 1px #1A1A1E,
      0 5px 1px #111,
      0 6px 2px rgba(0,0,0,0.5);
    background: linear-gradient(180deg,
      #3A3A40 0%, #252528 40%, #1A1A1E 100%
    );
  }

  .knob-top {
    position: absolute;
    inset: 3px;
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
    top: 4px;
    left: 50%;
    transform: translateX(-50%);
    width: 3px;
    height: 10px;
    background: #CCC;
    border-radius: 1.5px;
    box-shadow: 0 0 2px rgba(0,0,0,0.4);
  }
  .knob-notch--dark {
    background: #2A1A0A;
    box-shadow: 0 0 2px rgba(0,0,0,0.2);
  }

  /* --- Center group: knob + logo/screen together --- */
  .center-group {
    display: flex;
    align-items: center;
    align-self: center;
    gap: 6px;
    margin-left: auto;
    margin-right: auto;
    transform: translateX(-56px);
  }

  .knob-screen-left {
    flex-shrink: 0;
    display: flex;
    align-items: flex-end;
    align-self: flex-end;
  }

  .screen-area {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    width: 240px;
    flex-shrink: 0;
  }
  .deluge-logo {
    font-family: 'DM Mono', monospace;
    font-size: 1.2rem;
    font-weight: 500;
    color: #888;
    letter-spacing: 0.16em;
    text-transform: lowercase;
  }
  .oled-screen {
    background: #020204;
    border: 1px solid #1A1A1E;
    border-radius: 3px;
    padding: 0.35rem 0.7rem;
    width: 100%;
    text-align: center;
    box-shadow: inset 0 1px 6px rgba(0,0,0,0.9);
  }
  .oled-text {
    font-family: 'DM Mono', monospace;
    font-size: 0.75rem;
    font-weight: 500;
    color: #E0DDD6;
    letter-spacing: 0.08em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .oled-subtext {
    font-family: 'DM Mono', monospace;
    font-size: 0.55rem;
    color: #777;
    margin-top: 0.1rem;
    letter-spacing: 0.04em;
  }

  /* === Pad grid: 16 main + gap + 2 sidebar === */
  .pad-grid {
    display: grid;
    grid-template-columns: repeat(16, 1fr) 8px repeat(2, 1fr);
    gap: 3px;
    min-width: 0;
  }

  .grid-gap {
    grid-column: 17;
    width: 8px;
  }

  .pad {
    aspect-ratio: 1;
    border: none;
    border-radius: 3px;
    cursor: default;
    padding: 0;
    transition: box-shadow 0.05s, transform 0.05s;
    background: rgba(220, 215, 205, 0.12);
    border: 1px solid rgba(255,255,255,0.06);
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.08),
      inset 0 -1px 0 rgba(0,0,0,0.2),
      0 1px 2px rgba(0,0,0,0.25);
  }

  .pad--lit {
    background:
      radial-gradient(circle at 50% 55%,
        color-mix(in srgb, var(--glow-color) calc(var(--glow-intensity) * 100%), transparent) 0%,
        rgba(220, 215, 205, 0.1) 65%
      );
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.1),
      inset 0 -1px 0 rgba(0,0,0,0.15),
      0 0 calc(var(--glow-intensity) * 8px) color-mix(in srgb, var(--glow-color) calc(var(--glow-intensity) * 50%), transparent),
      0 1px 2px rgba(0,0,0,0.2);
  }

  .pad--clickable { cursor: pointer; }
  .pad--clickable:hover {
    transform: scale(1.08);
    box-shadow:
      0 0 12px color-mix(in srgb, var(--glow-color) 50%, transparent),
      inset 0 1px 0 rgba(255,255,255,0.15),
      0 2px 4px rgba(0,0,0,0.3);
  }

  /* Grid labels — same grid as pads so sidebar labels align */
  .grid-labels {
    pointer-events: none;
    display: grid;
    grid-template-columns: repeat(16, 1fr) 8px repeat(2, 1fr);
    gap: 3px;
    margin-top: 4px;
  }
  .grid-labels-gap {
    grid-column: 17;
    width: 8px;
  }
  .grid-label {
    font-family: 'DM Mono', monospace;
    font-size: 0.48rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    white-space: nowrap;
    color: rgba(255,255,255,0.3);
    text-align: center;
  }
  .grid-label--stats { grid-column: 1 / 5; }
  .grid-label--score { grid-column: 5 / 9; }
  .grid-label--midi { grid-column: 9 / 13; }
  .grid-label--inspector { grid-column: 13 / 17; }
  .grid-label--sidebar {
    font-size: 0.36rem;
    letter-spacing: 0.04em;
    color: rgba(255,255,255,0.25);
    line-height: 1.3;
  }

</style>
