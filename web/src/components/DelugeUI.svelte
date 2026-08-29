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

  interface Knob {
    label: string;
    value: number;
    gold: boolean;
    large: boolean;
  }

  const ROWS = 8;
  const COLS = 16;

  const GOLD = '#D4A847';
  const TEAL = '#5AABAC';
  const GREEN = '#40A060';
  const PURPLE = '#8050B0';
  const WHITE = '#E0DDD6';
  const BLUE = '#4070C0';
  const RED = '#C04040';
  const OFF = 'transparent';

  let knobs: Knob[] = [
    { label: 'upper', value: 64, gold: true, large: true },
    { label: 'select', value: 64, gold: true, large: true },
    { label: 'scroll', value: 64, gold: true, large: true },
    { label: 'tempo', value: 120, gold: false, large: true },
    { label: 'level', value: 100, gold: false, large: true },
    { label: 'hp vol', value: 80, gold: false, large: true },
    { label: 'line in', value: 0, gold: false, large: true },
  ];

  const buttonGroups = [
    { buttons: [
      { label: 'song', lit: false },
      { label: 'clip', lit: false },
    ]},
    { buttons: [
      { label: 'synth', lit: false },
      { label: 'kit', lit: false },
      { label: 'midi', lit: false },
      { label: 'cv', lit: false },
    ]},
    { buttons: [
      { label: 'scale', lit: false },
      { label: 'cross\nscreen', lit: false },
    ]},
    { buttons: [
      { label: 'back/\nundo', lit: false },
      { label: 'load', lit: false },
    ]},
    { buttons: [
      { label: 'tap\ntempo', lit: false },
      { label: 'sync-\nscaling', lit: false },
    ]},
    { buttons: [
      { label: 'learn/\ninput', lit: false },
      { label: 'triplet\nview', lit: false },
    ]},
    { buttons: [
      { label: 'play', lit: true, color: '#40A060' },
      { label: 'record', lit: true, color: '#C04040' },
    ]},
    { buttons: [
      { label: '◁', lit: false },
      { label: '▷', lit: false },
      { label: 'shift', lit: false },
    ]},
  ];

  let knobAngles: number[] = knobs.map(k => (k.value / 127) * 270 - 135);

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
    knobs[draggingKnob].value = Math.round(((knobAngles[draggingKnob] + 135) / 270) * 127);
    screenText = knobs[draggingKnob].label.toUpperCase();
    screenSubtext = `${knobs[draggingKnob].value}`;
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
    knobs[idx].value = Math.round(((knobAngles[idx] + 135) / 270) * 127);
    screenText = knobs[idx].label.toUpperCase();
    screenSubtext = `${knobs[idx].value}`;
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
    <!-- Control panel — matches real Deluge knob layout -->
    <div class="control-panel">
      <!-- Left: 3 gold knobs in offset arrangement -->
      <div class="knobs-left">
        <!-- Upper gold knob, offset right -->
        <div class="knob-row knob-row--upper-left">
          <div class="knob-wrapper">
            <div
              class="knob-hitbox"
              role="slider"
              tabindex="0"
              aria-label={knobs[0].label}
              aria-valuenow={knobs[0].value}
              aria-valuemin={0}
              aria-valuemax={127}
              on:mousedown={(e) => handleKnobStart(0, e)}
              on:touchstart={(e) => handleKnobStart(0, e)}
              on:wheel={(e) => handleKnobWheel(0, e)}
            >
              <div class="knob-3d knob-3d--gold" style="transform: rotate({knobAngles[0]}deg)">
                <div class="knob-barrel knob-barrel--gold"></div>
                <div class="knob-top knob-top--gold">
                  <div class="knob-notch knob-notch--dark"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <!-- Select + Scroll, side by side below -->
        <div class="knob-row">
          {#each [1, 2] as idx}
            <div class="knob-wrapper">
              <div
                class="knob-hitbox"
                role="slider"
                tabindex="0"
                aria-label={knobs[idx].label}
                aria-valuenow={knobs[idx].value}
                aria-valuemin={0}
                aria-valuemax={127}
                on:mousedown={(e) => handleKnobStart(idx, e)}
                on:touchstart={(e) => handleKnobStart(idx, e)}
                on:wheel={(e) => handleKnobWheel(idx, e)}
              >
                <div class="knob-3d knob-3d--gold" style="transform: rotate({knobAngles[idx]}deg)">
                  <div class="knob-barrel knob-barrel--gold"></div>
                  <div class="knob-top knob-top--gold">
                    <div class="knob-notch knob-notch--dark"></div>
                  </div>
                </div>
              </div>
              <span class="knob-label">{knobs[idx].label}</span>
            </div>
          {/each}
        </div>
      </div>

      <!-- Center: logo + OLED screen -->
      <div class="screen-area">
        <div class="deluge-logo">✦ deluge</div>
        <div class="oled-screen">
          <div class="oled-text">{screenText}</div>
          {#if screenSubtext}
            <div class="oled-subtext">{screenSubtext}</div>
          {/if}
        </div>
      </div>

      <!-- Right: 4 black knobs -->
      <div class="knobs-right">
        <!-- Top row: hp vol + line in -->
        <div class="knob-row">
          {#each [5, 6] as idx}
            <div class="knob-wrapper">
              <div
                class="knob-hitbox"
                role="slider"
                tabindex="0"
                aria-label={knobs[idx].label}
                aria-valuenow={knobs[idx].value}
                aria-valuemin={0}
                aria-valuemax={127}
                on:mousedown={(e) => handleKnobStart(idx, e)}
                on:touchstart={(e) => handleKnobStart(idx, e)}
                on:wheel={(e) => handleKnobWheel(idx, e)}
              >
                <div class="knob-3d knob-3d--black" style="transform: rotate({knobAngles[idx]}deg)">
                  <div class="knob-barrel knob-barrel--black"></div>
                  <div class="knob-top knob-top--black">
                    <div class="knob-notch"></div>
                  </div>
                </div>
              </div>
            </div>
          {/each}
        </div>
        <!-- Bottom row: tempo + level -->
        <div class="knob-row">
          {#each [3, 4] as idx}
            <div class="knob-wrapper">
              <div
                class="knob-hitbox"
                role="slider"
                tabindex="0"
                aria-label={knobs[idx].label}
                aria-valuenow={knobs[idx].value}
                aria-valuemin={0}
                aria-valuemax={127}
                on:mousedown={(e) => handleKnobStart(idx, e)}
                on:touchstart={(e) => handleKnobStart(idx, e)}
                on:wheel={(e) => handleKnobWheel(idx, e)}
              >
                <div class="knob-3d knob-3d--black" style="transform: rotate({knobAngles[idx]}deg)">
                  <div class="knob-barrel knob-barrel--black"></div>
                  <div class="knob-top knob-top--black">
                    <div class="knob-notch"></div>
                  </div>
                </div>
              </div>
              <span class="knob-label">{knobs[idx].label}</span>
            </div>
          {/each}
        </div>
      </div>
    </div>

    <!-- Button strip -->
    <div class="button-strip">
      {#each buttonGroups as group}
        <div class="button-group">
          {#each group.buttons as btn}
            <div class="hw-button-col">
              <span class="hw-button-label">{btn.label}</span>
              <div class="hw-button" class:hw-button--lit={btn.lit} style={btn.color ? `--btn-color: ${btn.color}` : ''}></div>
            </div>
          {/each}
        </div>
      {/each}
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
  .deluge-housing {
    display: flex;
    max-width: 820px;
    margin: 0 auto;
    user-select: none;
    filter: drop-shadow(0 12px 40px rgba(0,0,0,0.5));
  }

  /* Walnut side panels with grain */
  .wood-panel {
    width: 28px;
    flex-shrink: 0;
    background:
      repeating-linear-gradient(
        180deg,
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

  /* Control panel */
  .control-panel {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
    padding: 0 0.25rem;
  }
  .knobs-left, .knobs-right {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .knob-row {
    display: flex;
    gap: 0.3rem;
    align-items: center;
  }
  .knob-row--upper-left {
    padding-left: 1.8rem;
  }
  .knob-wrapper {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.2rem;
  }

  /* Knob hit area */
  .knob-hitbox {
    width: 56px;
    height: 56px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: grab;
  }
  .knob-hitbox:active { cursor: grabbing; }

  /* 3D Knob — barrel + top face, like a cylinder viewed from above-front */
  .knob-3d {
    position: relative;
    width: 48px;
    height: 48px;
  }

  /* Barrel — the side of the cylinder, rendered as a ring shadow */
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

  /* Top face of the knob */
  .knob-top {
    position: absolute;
    inset: 3px;
    border-radius: 50%;
    z-index: 1;
    /* Knurling via SVG-like repeating border */
    background-size: 100% 100%;
  }
  .knob-top--gold {
    background:
      repeating-conic-gradient(
        from 0deg,
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
      repeating-conic-gradient(
        from 0deg,
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

  /* Position notch */
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

  .knob-label {
    font-family: 'DM Mono', monospace;
    font-size: 0.5rem;
    color: #555;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  /* Logo + OLED */
  .screen-area {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    flex: 1;
    max-width: 220px;
  }
  .deluge-logo {
    font-family: 'DM Mono', monospace;
    font-size: 0.85rem;
    font-weight: 500;
    color: #777;
    letter-spacing: 0.14em;
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

  /* Button strip */
  .button-strip {
    display: flex;
    justify-content: center;
    gap: 10px;
    margin-bottom: 0.6rem;
    padding: 0 0.5rem;
    flex-wrap: wrap;
    align-items: flex-end;
  }
  .button-group {
    display: flex;
    gap: 4px;
    align-items: flex-end;
  }
  .hw-button-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }
  .hw-button-label {
    font-family: 'DM Mono', monospace;
    font-size: 0.38rem;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    white-space: pre;
    text-align: center;
    line-height: 1.2;
  }
  .hw-button {
    width: 16px;
    height: 10px;
    background: linear-gradient(180deg, #2A2A2E 0%, #1A1A1E 100%);
    border: 1px solid #3A3A40;
    border-radius: 2px;
    box-shadow:
      0 2px 1px rgba(0,0,0,0.5),
      inset 0 1px 0 rgba(255,255,255,0.06);
  }
  .hw-button--lit {
    box-shadow:
      0 2px 1px rgba(0,0,0,0.5),
      inset 0 1px 0 rgba(255,255,255,0.06),
      0 0 4px var(--btn-color, #fff);
  }

  /* Pad Grid — raised silicone pads with LED glow */
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

    /* Translucent white silicone — visible even when unlit */
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

  /* Responsive */
  @media (max-width: 768px) {
    .wood-panel { width: 18px; }
    .deluge-body { padding: 0.5rem 0.6rem 0.75rem; }
    .knob-hitbox { width: 44px; height: 44px; }
    .knob-3d { width: 38px; height: 38px; }
    .knob-top { inset: 2px; }
    .knob-notch { height: 8px; top: 3px; }
    .knob-barrel--gold { box-shadow: 0 3px 1px #7A5818, 0 4px 2px rgba(0,0,0,0.5); }
    .knob-barrel--black { box-shadow: 0 3px 1px #1A1A1E, 0 4px 2px rgba(0,0,0,0.5); }
    .knob-row--upper-left { padding-left: 1.2rem; }
    .pad-grid { gap: 2px; }
    .button-strip { gap: 6px; }
    .hw-button { width: 14px; height: 8px; }
    .hw-button-label { font-size: 0.34rem; }
  }

  @media (max-width: 520px) {
    .wood-panel { width: 10px; }
    .deluge-body { padding: 0.3rem 0.4rem 0.5rem; }
    .knob-hitbox { width: 36px; height: 36px; }
    .knob-3d { width: 30px; height: 30px; }
    .knob-notch { height: 6px; top: 2px; width: 2px; }
    .knob-barrel--gold { box-shadow: 0 2px 1px #7A5818, 0 3px 2px rgba(0,0,0,0.5); }
    .knob-barrel--black { box-shadow: 0 2px 1px #1A1A1E, 0 3px 2px rgba(0,0,0,0.5); }
    .knob-label { display: none; }
    .knob-row--upper-left { padding-left: 0.8rem; }
    .oled-screen { padding: 0.25rem 0.4rem; }
    .oled-text { font-size: 0.6rem; }
    .deluge-logo { font-size: 0.65rem; }
    .pad-grid { gap: 1.5px; }
    .grid-labels { display: none; }
    .button-strip { display: none; }
  }
</style>
