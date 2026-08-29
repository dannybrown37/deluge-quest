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
  let animFrame: number;
  let pulsePhase = 0;
  let mounted = false;
  let draggingKnob: number | null = null;
  let dragStartY = 0;
  let dragStartAngle = 0;

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

        if (r >= 1 && r <= 3 && c >= 1 && c <= 5) {
          color = GOLD; glowIntensity = 0.7; active = true;
          link = '/score'; label = 'Score Converter'; group = 'score';
        }
        else if (r >= 1 && r <= 3 && c >= 7 && c <= 11) {
          color = TEAL; glowIntensity = 0.7; active = true;
          link = '/inspector'; label = 'Song Inspector'; group = 'inspector';
        }
        else if (r >= 1 && r <= 3 && c >= 13 && c <= 15) {
          color = WHITE; glowIntensity = 0.15;
          label = 'MIDI Import — coming soon'; group = 'midi';
        }
        else if (r === 6 && c === 15) {
          color = WHITE; glowIntensity = 0.5; active = true;
          link = '/about'; label = 'About'; group = 'about';
        }
        else if (r === 6 && c === 14) {
          color = GREEN; glowIntensity = 0.5; active = true;
          label = '100% client-side'; group = 'privacy';
        }
        else if (r === 6 && c === 0) {
          color = PURPLE; glowIntensity = 0.5; active = true;
          link = 'https://github.com/dannybrown37/deluge';
          label = 'GitHub'; group = 'github';
        }

        row.push({ row: r, col: c, color, glowIntensity, active, link, label, group });
      }
      pads.push(row);
    }
  }

  function animate() {
    pulsePhase += 0.02;

    for (let r = 5; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const pad = pads[r][c];
        if (pad.group) continue;
        const wave = Math.sin(pulsePhase + c * 0.3 + r * 0.5);
        if (wave > 0.6) { pad.color = GOLD; pad.glowIntensity = wave * 0.6; }
        else if (wave > 0.2) { pad.color = GOLD; pad.glowIntensity = 0.15; }
        else { pad.color = OFF; pad.glowIntensity = 0; }
      }
    }

    for (let c = 0; c < COLS; c++) {
      const pad = pads[0][c];
      if (pad.group) continue;
      const beat = Math.sin(pulsePhase * 0.5 + c * 0.4);
      if (beat > 0.7) { pad.color = GOLD; pad.glowIntensity = 0.4; }
      else { pad.color = OFF; pad.glowIntensity = 0; }
    }

    for (let c = 0; c < COLS; c++) {
      const pad = pads[4][c];
      if (pad.group) continue;
      const pos = ((pulsePhase * 2) % (COLS + 4)) - 2;
      const dist = Math.abs(c - pos);
      if (dist < 1) { pad.color = GOLD; pad.glowIntensity = 0.8; }
      else if (dist < 2.5) { pad.color = GOLD; pad.glowIntensity = 0.2; }
      else { pad.color = OFF; pad.glowIntensity = 0; }
    }

    pads = pads;
    animFrame = requestAnimationFrame(animate);
  }

  function handlePadHover(pad: Pad) {
    if (pad.label) {
      screenText = pad.label.toUpperCase();
      if (pad.group === 'score') screenSubtext = 'Deluge XML → MusicXML';
      else if (pad.group === 'inspector') screenSubtext = 'visual arrangement timeline';
      else if (pad.group === 'midi') screenSubtext = 'MIDI → Deluge XML';
      else if (pad.group === 'about') screenSubtext = 'open source / community';
      else if (pad.group === 'privacy') screenSubtext = 'no uploads, no server';
      else if (pad.group === 'github') screenSubtext = 'view source code';
      else screenSubtext = '';
    }
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
    animFrame = requestAnimationFrame(animate);

    window.addEventListener('mousemove', handleKnobMove);
    window.addEventListener('mouseup', handleKnobEnd);
    window.addEventListener('touchmove', handleKnobMove, { passive: false });
    window.addEventListener('touchend', handleKnobEnd);

    return () => {
      cancelAnimationFrame(animFrame);
      window.removeEventListener('mousemove', handleKnobMove);
      window.removeEventListener('mouseup', handleKnobEnd);
      window.removeEventListener('touchmove', handleKnobMove);
      window.removeEventListener('touchend', handleKnobEnd);
    };
  });
</script>

<div class="deluge-housing">
  <div class="wood-panel wood-panel--left"></div>

  <div class="deluge-body">
    <!-- Control panel: knobs + logo + screen only -->
    <div class="control-panel">

      <!-- LEFT: 2 black + 2 gold knobs as separate diagonal columns -->
      <div class="knobs-left">
        <!-- Black column: 2 knobs, diagonal offset -->
        <div class="knob-col">
          <div class="knob-col-upper">
            <div
              class="knob-hitbox"
              role="slider" tabindex="0"
              aria-label={knobMeta[0].name}
              aria-valuenow={knobValues[0]}
              on:mousedown={(e) => handleKnobStart(0, e)}
              on:touchstart={(e) => handleKnobStart(0, e)}
              on:wheel={(e) => handleKnobWheel(0, e)}
            >
              <div class="knob-3d" style="transform: rotate({knobAngles[0]}deg)">
                <div class="knob-barrel knob-barrel--black"></div>
                <div class="knob-top knob-top--black">
                  <div class="knob-notch"></div>
                </div>
              </div>
            </div>
          </div>
          <div class="knob-col-lower">
            <div
              class="knob-hitbox"
              role="slider" tabindex="0"
              aria-label={knobMeta[1].name}
              aria-valuenow={knobValues[1]}
              on:mousedown={(e) => handleKnobStart(1, e)}
              on:touchstart={(e) => handleKnobStart(1, e)}
              on:wheel={(e) => handleKnobWheel(1, e)}
            >
              <div class="knob-3d" style="transform: rotate({knobAngles[1]}deg)">
                <div class="knob-barrel knob-barrel--black"></div>
                <div class="knob-top knob-top--black">
                  <div class="knob-notch"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <!-- Gold column: 2 knobs, same diagonal offset -->
        <div class="knob-col">
          <div class="knob-col-upper">
            <div
              class="knob-hitbox"
              role="slider" tabindex="0"
              aria-label={knobMeta[2].name}
              aria-valuenow={knobValues[2]}
              on:mousedown={(e) => handleKnobStart(2, e)}
              on:touchstart={(e) => handleKnobStart(2, e)}
              on:wheel={(e) => handleKnobWheel(2, e)}
            >
              <div class="knob-3d" style="transform: rotate({knobAngles[2]}deg)">
                <div class="knob-barrel knob-barrel--gold"></div>
                <div class="knob-top knob-top--gold">
                  <div class="knob-notch knob-notch--dark"></div>
                </div>
              </div>
            </div>
          </div>
          <div class="knob-col-lower">
            <div
              class="knob-hitbox"
              role="slider" tabindex="0"
              aria-label={knobMeta[3].name}
              aria-valuenow={knobValues[3]}
              on:mousedown={(e) => handleKnobStart(3, e)}
              on:touchstart={(e) => handleKnobStart(3, e)}
              on:wheel={(e) => handleKnobWheel(3, e)}
            >
              <div class="knob-3d" style="transform: rotate({knobAngles[3]}deg)">
                <div class="knob-barrel knob-barrel--gold"></div>
                <div class="knob-top knob-top--gold">
                  <div class="knob-notch knob-notch--dark"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Black knob left of screen -->
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
          <div class="knob-3d" style="transform: rotate({knobAngles[4]}deg)">
            <div class="knob-barrel knob-barrel--black"></div>
            <div class="knob-top knob-top--black">
              <div class="knob-notch"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- CENTER: logo + OLED screen -->
      <div class="screen-area">
        <div class="deluge-logo">✦ deluge</div>
        <div class="oled-screen">
          <div class="oled-text">{screenText}</div>
          {#if screenSubtext}
            <div class="oled-subtext">{screenSubtext}</div>
          {/if}
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
          <div class="knob-3d" style="transform: rotate({knobAngles[5]}deg)">
            <div class="knob-barrel knob-barrel--black"></div>
            <div class="knob-top knob-top--black">
              <div class="knob-notch"></div>
            </div>
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

    <!-- Pad grid -->
    {#if mounted}
      <div class="pad-grid">
        {#each pads as row}
          {#each row as pad}
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
        {/each}
      </div>
    {/if}

    <div class="grid-labels">
      <div class="grid-label grid-label--score">♫ Score</div>
      <div class="grid-label grid-label--inspector">◧ Inspector</div>
      <div class="grid-label grid-label--midi">⇄ MIDI</div>
    </div>
  </div>

  <div class="wood-panel wood-panel--right"></div>
</div>

<style>
  /* === Housing === */
  .deluge-housing {
    display: flex;
    max-width: 900px;
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
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.6rem;
    padding: 0.25rem 0;
  }

  /* --- Left knobs: black col + gold col, each with diagonal offset --- */
  .knobs-left {
    display: flex;
    gap: 10px;
    flex-shrink: 0;
  }

  .knob-col {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  /* Upper knob in each column offset right for diagonal */
  .knob-col-upper {
    margin-left: 22px;
  }

  /* --- Right knobs: gold + black, same row --- */
  .knobs-right {
    display: flex;
    gap: 10px;
    align-items: center;
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

  /* --- Black knob left of screen --- */
  .knob-screen-left {
    flex-shrink: 0;
    display: flex;
    align-items: center;
  }

  /* --- Center: logo + screen --- */
  .screen-area {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    flex: 1;
    max-width: 240px;
    min-width: 0;
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

  /* === Pad grid === */
  .pad-grid {
    display: grid;
    grid-template-columns: repeat(16, 1fr);
    gap: 3px;
  }

  .pad {
    aspect-ratio: 1;
    border: none;
    border-radius: 3px;
    cursor: default;
    padding: 0;
    transition: box-shadow 0.12s, transform 0.08s;
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

  /* Grid labels */
  .grid-labels {
    pointer-events: none;
    display: grid;
    grid-template-columns: repeat(16, 1fr);
    gap: 3px;
    margin-top: 4px;
  }
  .grid-label {
    font-family: 'DM Mono', monospace;
    font-size: 0.48rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    white-space: nowrap;
    color: rgba(255,255,255,0.3);
  }
  .grid-label--score { grid-column: 2 / 7; text-align: center; }
  .grid-label--inspector { grid-column: 8 / 13; text-align: center; }
  .grid-label--midi { grid-column: 14 / 17; text-align: center; }

  /* === Responsive === */
  @media (max-width: 700px) {
    .wood-panel { width: 18px; }
    .deluge-body { padding: 0.5rem 0.6rem 0.75rem; }
    .knob-hitbox { width: 44px; height: 44px; }
    .knob-3d { width: 38px; height: 38px; }
    .knob-top { inset: 2px; }
    .knob-notch { height: 8px; top: 3px; }
    .knob-barrel--gold { box-shadow: 0 3px 1px #7A5818, 0 4px 2px rgba(0,0,0,0.5); }
    .knob-barrel--black { box-shadow: 0 3px 1px #1A1A1E, 0 4px 2px rgba(0,0,0,0.5); }
    .knob-col-upper { margin-left: 16px; }
    .knobs-left { gap: 6px; }
    .knobs-right { gap: 6px; }
    .pad-grid { gap: 2px; }
  }

  @media (max-width: 500px) {
    .wood-panel { width: 10px; }
    .deluge-body { padding: 0.3rem 0.4rem 0.5rem; }
    .knob-hitbox { width: 36px; height: 36px; }
    .knob-3d { width: 30px; height: 30px; }
    .knob-notch { height: 6px; top: 2px; width: 2px; }
    .knob-barrel--gold { box-shadow: 0 2px 1px #7A5818, 0 3px 2px rgba(0,0,0,0.5); }
    .knob-barrel--black { box-shadow: 0 2px 1px #1A1A1E, 0 3px 2px rgba(0,0,0,0.5); }
    .knob-col-upper { margin-left: 10px; }
    .knobs-left { gap: 4px; }
    .knobs-right { gap: 4px; }
    .oled-screen { padding: 0.25rem 0.4rem; }
    .oled-text { font-size: 0.6rem; }
    .deluge-logo { font-size: 0.85rem; }
    .pad-grid { gap: 1.5px; }
    .grid-labels { display: none; }
  }
</style>
