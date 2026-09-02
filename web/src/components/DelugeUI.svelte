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
  const DEFAULT_KNOB_VALUES = [0, 0, 127, 0, 0, 64, 100];
  let knobValues = [...DEFAULT_KNOB_VALUES];
  let knobAngles = knobValues.map(v => (v / 127) * 270 - 135);
  const knobMeta = [
    { name: 'delay time',     style: 'black', hint: 'Delay Time' },
    { name: 'delay fdbk',     style: 'black', hint: 'Delay Feedback' },
    { name: 'filter',         style: 'gold',  hint: 'Cutoff' },
    { name: 'resonance',      style: 'gold',  hint: 'Resonance' },
    { name: 'reverb',         style: 'black', hint: 'Reverb' },
    { name: 'tempo',          style: 'black', hint: 'Speed' },
    { name: 'output',         style: 'gold',  hint: 'Volume' },
  ];

  function knobTip(i: number): string {
    return knobMeta[i].hint;
  }

  let screenText = 'DELUGE TOOLS';
  let screenSubtext = 'drop a song to begin';
  let pads: Pad[][] = [];
  let sidebarPads: Pad[][] = [];
  let mounted = false;
  let draggingKnob: number | null = null;
  let dragStartY = 0;
  let dragStartAngle = 0;

  interface Song { file: string; name: string; year?: string | number; genre?: string; duration?: string; }
  let songs: Song[] = [];
  let currentSongIndex = 0;
  let songLoaded = false;
  let browsing = false;
  let browseIndex = 0;

  function marquee(node: HTMLElement, _text: string) {
    const inner = node.firstElementChild as HTMLElement;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function measure() {
      if (reduceMotion) return;
      node.classList.remove('is-scrolling');
      node.style.removeProperty('--marquee-shift');
      node.style.removeProperty('--marquee-duration');
      inner.style.animation = '';
      const overflow = inner.scrollWidth - node.clientWidth;
      if (overflow > 2) {
        node.style.setProperty('--marquee-shift', `-${overflow + 12}px`);
        const seconds = (overflow + 12) / 45 + 2;
        inner.style.animation = `oled-marquee ${seconds}s ease-in-out infinite alternate`;
        node.classList.add('is-scrolling');
      }
    }
    requestAnimationFrame(measure);
    return {
      update() { requestAnimationFrame(measure); },
    };
  }

  function idleText(): string {
    return songs[currentSongIndex]?.name.toUpperCase() ?? 'DELUGE TOOLS';
  }

  function idleSubtext(): string {
    if (!songs[currentSongIndex]) return 'drop a song to begin';
    return songLoaded ? 'press play' : 'press load';
  }

  async function fetchSongList() {
    try {
      const resp = await fetch('/audio/songs.json');
      if (resp.ok) {
        songs = await resp.json();
        if (songs.length > 0) {
          currentSongIndex = Math.floor(Math.random() * songs.length);
          screenText = idleText();
          screenSubtext = idleSubtext();
        }
      }
    } catch { /* no songs available */ }
  }

  // Audio player state
  let audioCtx: AudioContext | null = null;
  let audioBuffer: AudioBuffer | null = null;
  let sourceNode: AudioBufferSourceNode | null = null;
  let gainNode: GainNode | null = null;
  let filterNode: BiquadFilterNode | null = null;
  let reverbNode: ConvolverNode | null = null;
  let dryGain: GainNode | null = null;
  let wetGain: GainNode | null = null;
  let delayNode: DelayNode | null = null;
  let delayFeedback: GainNode | null = null;
  let delayWet: GainNode | null = null;
  let isPlaying = false;
  let playStartTime = 0;
  let playOffset = 0;

  // The Media Session API only binds to a real media element, so a silent looping
  // <audio> stands in for the Web Audio graph to expose OS play/pause keys.
  let keeper: HTMLAudioElement | null = null;
  let keeperUrl = '';

  function silentWavUrl(): string {
    const sampleRate = 8000;
    const frames = sampleRate;
    const size = 44 + frames * 2;
    const buf = new ArrayBuffer(size);
    const view = new DataView(buf);
    const ascii = (offset: number, text: string) => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };
    ascii(0, 'RIFF');
    view.setUint32(4, size - 8, true);
    ascii(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, 'data');
    view.setUint32(40, frames * 2, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  function initKeeper() {
    if (keeper) return;
    keeperUrl = silentWavUrl();
    keeper = new Audio(keeperUrl);
    keeper.loop = true;
    keeper.volume = 0;
  }

  function updateMediaMetadata() {
    if (!('mediaSession' in navigator)) return;
    const song = songs[currentSongIndex];
    if (!song) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.name,
      artist: 'Deluge Tools',
      album: 'Demo Tracks',
    });
  }

  function setMediaState(state: MediaSessionPlaybackState) {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state;
  }

  function initMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const set = (action: MediaSessionAction, handler: (() => void) | null) => {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported action */ }
    };
    set('play', () => { if (!isPlaying) togglePlay(); });
    set('pause', () => { if (isPlaying) togglePlay(); });
    set('stop', () => { if (isPlaying) togglePlay(); });
    set('nexttrack', () => { if (songs.length > 1) stepSong(1); });
    set('previoustrack', () => { if (songs.length > 1) stepSong(-1); });
  }

  async function stepSong(delta: number) {
    const wasPlaying = isPlaying;
    const idx = (currentSongIndex + delta + songs.length) % songs.length;
    await initAudio();
    await loadSong(idx);
    if (wasPlaying) await togglePlay();
  }

  const DESIGN_WIDTH = 900;
  let wrapperWidth = DESIGN_WIDTH;
  let housingHeight = 0;
  $: scale = Math.min(1, wrapperWidth / DESIGN_WIDTH);

  const AUDITION_PALETTE = ['#4488DD','#DD55AA','#DDBB33','#5AABAC','#CC3030','#AACC30','#3355CC','#FF6622'];

  const TOOLS: { group: string; label: string; link: string; color: string; subtext: string }[] = [
    { group: 'stats',     label: 'Song Stats',      link: '/stats',     color: AUDITION_PALETTE[0], subtext: 'library analysis & stats' },
    { group: 'preview',   label: 'Song Preview',     link: '/preview',   color: AUDITION_PALETTE[1], subtext: 'arrangement preview & playback' },
    { group: 'score',     label: 'Score Converter',  link: '/score',     color: AUDITION_PALETTE[2], subtext: 'Deluge XML → MusicXML' },
    { group: 'midi',      label: 'MIDI Import',      link: '/import',    color: AUDITION_PALETTE[3], subtext: 'MIDI → Deluge XML' },
    { group: 'manage',    label: 'Card Management',  link: '/manage',    color: AUDITION_PALETTE[4], subtext: 'organize samples & songs' },
    { group: 'patch',     label: 'Patch Generator',  link: '/patch',     color: AUDITION_PALETTE[5], subtext: 'random synth presets' },
    { group: 'kits',      label: 'Kit Builder',      link: '/kits',      color: AUDITION_PALETTE[6], subtext: 'build & edit drum kits' },
  ];

  const FUTURE_TOOLS: { group: string; label: string; subtext: string; color: string }[] = [
    { group: 'future-1', label: 'Coming Soon', subtext: '', color: AUDITION_PALETTE[7] },
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
    if (idx < 0 || idx >= FUTURE_TOOLS.length) return undefined;
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
          const localR = r % 4, localC = c % 4;
          color = tool.color; glowIntensity = 0.9 - (localR * 4 + localC) * 0.05; active = true;
          link = tool.link; label = tool.label; group = tool.group;
        } else {
          const future = futureAt(r, c);
          if (future) {
            const fLocalR = r % 4, fLocalC = c % 4;
            color = future.color; glowIntensity = 0.15 - (fLocalR * 4 + fLocalC) * 0.008;
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

        const MUTE_COLORS = ['#40A060','#CC3030','#CC3030','#CC3030','#CC3030','#CC3030','#CC3030','#CC3030'];
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
    screenText = idleText();
    screenSubtext = idleSubtext();
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

  function createImpulse(ctx: AudioContext, duration = 2.5, decay = 3): AudioBuffer {
    const rate = ctx.sampleRate;
    const len = rate * duration;
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  async function initAudio() {
    if (audioCtx) {
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      return;
    }
    audioCtx = new AudioContext();
    filterNode = audioCtx.createBiquadFilter();
    filterNode.type = 'lowpass';
    gainNode = audioCtx.createGain();
    dryGain = audioCtx.createGain();
    wetGain = audioCtx.createGain();
    reverbNode = audioCtx.createConvolver();
    reverbNode.buffer = createImpulse(audioCtx);
    delayNode = audioCtx.createDelay(2.0);
    delayNode.delayTime.value = 0.375;
    delayFeedback = audioCtx.createGain();
    delayFeedback.gain.value = 0.35;
    delayWet = audioCtx.createGain();
    delayWet.gain.value = 0.4;
    filterNode.connect(dryGain);
    filterNode.connect(reverbNode);
    filterNode.connect(delayNode);
    delayNode.connect(delayFeedback);
    delayFeedback.connect(delayNode);
    delayNode.connect(delayWet);
    reverbNode.connect(wetGain);
    dryGain.connect(gainNode);
    wetGain.connect(gainNode);
    delayWet.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    updateVolume();
    updateFilter();
    updateReverb();
    updateDelay();
    if (songs.length > 0) await loadSong(currentSongIndex);
  }

  // Commas are legal in a path segment; some static hosts 404 on the %2C form.
  function songUrl(file: string): string {
    return `/audio/${encodeURIComponent(file).replace(/%2C/g, ',')}`;
  }

  async function loadSong(idx: number) {
    if (!audioCtx || songs.length === 0) return;
    if (isPlaying && sourceNode) {
      sourceNode.onended = null;
      sourceNode.stop();
      sourceNode = null;
      isPlaying = false;
    }
    playOffset = 0;
    currentSongIndex = idx;
    const song = songs[idx];
    screenText = 'LOADING';
    screenSubtext = song.name;
    try {
      const resp = await fetch(songUrl(song.file));
      if (!resp.ok) { screenText = 'ERROR'; screenSubtext = 'file not found'; return; }
      const buf = await resp.arrayBuffer();
      audioBuffer = await audioCtx.decodeAudioData(buf);
      songLoaded = true;
      updateMediaMetadata();
      screenText = song.name.toUpperCase();
      screenSubtext = 'press play';
    } catch (e) {
      console.error('Audio load failed:', e);
      screenText = 'ERROR';
      screenSubtext = 'load failed';
    }
  }

  function resetKnobs() {
    knobValues = [...DEFAULT_KNOB_VALUES];
    knobAngles = knobValues.map(v => (v / 127) * 270 - 135);
    updateVolume();
    updateFilter();
    updateReverb();
    updateDelay();
    updatePlaybackRate();
  }

  function handleLoad() {
    if (songs.length === 0) return;
    browsing = !browsing;
    if (browsing) {
      browseIndex = currentSongIndex;
      screenText = 'LOAD SONG';
      screenSubtext = `${songs.length} songs`;
    } else {
      screenText = idleText();
      screenSubtext = idleSubtext();
    }
  }

  function handleReset() {
    resetKnobs();
    screenText = idleText();
    screenSubtext = 'knobs reset';
  }

  async function chooseSong(idx: number) {
    browsing = false;
    await initAudio();
    resetKnobs();
    await loadSong(idx);
  }

  function handleOutsideClick(e: MouseEvent) {
    if (!browsing) return;
    const t = e.target as HTMLElement;
    if (t.closest('.song-browser') || t.closest('.load-btn')) return;
    browsing = false;
    screenSubtext = idleSubtext();
  }

  function handleBrowseKeys(e: KeyboardEvent) {
    if (!browsing) return;
    if (e.key === 'Escape') { browsing = false; screenSubtext = idleSubtext(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); browseIndex = (browseIndex + 1) % songs.length; }
    if (e.key === 'ArrowUp') { e.preventDefault(); browseIndex = (browseIndex - 1 + songs.length) % songs.length; }
    if (e.key === 'Enter') { e.preventDefault(); chooseSong(browseIndex); }
  }

  function updateVolume() {
    if (!gainNode) return;
    gainNode.gain.value = knobValues[6] / 127;
  }

  function updateReverb() {
    if (!dryGain || !wetGain) return;
    const mix = knobValues[4] / 127;
    dryGain.gain.value = 1 - mix * 0.5;
    wetGain.gain.value = mix;
  }

  function updateDelay() {
    if (!delayNode || !delayFeedback) return;
    delayNode.delayTime.value = 0.05 + (knobValues[0] / 127) * 0.75; // 0.05s – 0.8s
    delayFeedback.gain.value = (knobValues[1] / 127) * 0.85; // 0 – 0.85, avoids runaway feedback
  }

  function updateFilter() {
    if (!filterNode) return;
    const norm = knobValues[2] / 127;
    filterNode.frequency.value = 80 * Math.pow(280, norm); // 80 Hz – 22400 Hz exponential
    const resNorm = knobValues[3] / 127;
    filterNode.Q.value = 0.5 + resNorm * 24.5; // 0.5 – 25
  }

  function getPlaybackRate(): number {
    const v = knobValues[5];
    if (v <= 64) return 0.5 + (v / 64) * 0.5;
    return 1.0 + ((v - 64) / 63) * 1.0;
  }

  function updatePlaybackRate() {
    if (sourceNode) sourceNode.playbackRate.value = getPlaybackRate();
  }

  async function togglePlay() {
    await initAudio();
    if (!audioCtx || !audioBuffer || !gainNode) return;

    if (isPlaying && sourceNode) {
      playOffset += (audioCtx.currentTime - playStartTime) * sourceNode.playbackRate.value;
      sourceNode.stop();
      sourceNode = null;
      isPlaying = false;
      keeper?.pause();
      setMediaState('paused');
      screenText = idleText();
      screenSubtext = `paused · ${formatTime(playOffset, audioBuffer.duration)}`;
      return;
    }

    if (playOffset >= audioBuffer.duration) playOffset = 0;

    sourceNode = audioCtx.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.playbackRate.value = getPlaybackRate();
    sourceNode.connect(filterNode!);
    sourceNode.onended = () => {
      if (isPlaying) {
        isPlaying = false;
        playOffset = 0;
        sourceNode = null;
        keeper?.pause();
        setMediaState('none');
        screenText = idleText();
        screenSubtext = idleSubtext();
      }
    };
    sourceNode.start(0, playOffset);
    playStartTime = audioCtx.currentTime;
    isPlaying = true;
    initKeeper();
    keeper?.play().catch(() => { /* autoplay blocked until a gesture */ });
    updateMediaMetadata();
    setMediaState('playing');
    screenText = idleText();
    screenSubtext = formatTime(playOffset, audioBuffer.duration);
    updateScreenTimer();
  }

  function formatTime(current: number, total: number): string {
    const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    return `${fmt(current)} / ${fmt(total)}`;
  }

  function updateScreenTimer() {
    if (!isPlaying || !audioCtx || !audioBuffer || !sourceNode) return;
    const elapsed = playOffset + (audioCtx.currentTime - playStartTime) * sourceNode.playbackRate.value;
    screenSubtext = formatTime(elapsed, audioBuffer.duration);
    requestAnimationFrame(updateScreenTimer);
  }

  function handleKnobMove(e: MouseEvent | TouchEvent) {
    if (draggingKnob === null) return;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const delta = (dragStartY - clientY) * 1.5;
    knobAngles[draggingKnob] = Math.max(-135, Math.min(135, dragStartAngle + delta));
    knobValues[draggingKnob] = Math.round(((knobAngles[draggingKnob] + 135) / 270) * 127);
    screenText = knobMeta[draggingKnob].name.toUpperCase();
    screenSubtext = `${knobValues[draggingKnob]}`;
    if (draggingKnob === 0 || draggingKnob === 1) updateDelay();
    if (draggingKnob === 4) updateReverb();
    if (draggingKnob === 6) updateVolume();
    if (draggingKnob === 5) updatePlaybackRate();
    if (draggingKnob === 2 || draggingKnob === 3) updateFilter();
  }

  function handleKnobEnd() {
    if (draggingKnob !== null) {
      draggingKnob = null;
      if (isPlaying) {
        screenText = idleText();
        updateScreenTimer();
      } else {
        screenText = idleText();
        screenSubtext = idleSubtext();
      }
    }
  }

  function handleKnobWheel(idx: number, e: WheelEvent) {
    const delta = e.deltaY > 0 ? -5 : 5;
    knobAngles[idx] = Math.max(-135, Math.min(135, knobAngles[idx] + delta));
    knobValues[idx] = Math.round(((knobAngles[idx] + 135) / 270) * 127);
    screenText = knobMeta[idx].name.toUpperCase();
    screenSubtext = `${knobValues[idx]}`;
    if (idx === 0 || idx === 1) updateDelay();
    if (idx === 4) updateReverb();
    if (idx === 6) updateVolume();
    if (idx === 5) updatePlaybackRate();
    if (idx === 2 || idx === 3) updateFilter();
  }

  onMount(() => {
    mounted = true;
    initPads();
    fetchSongList();
    initMediaSession();

    window.addEventListener('keydown', handleBrowseKeys);
    window.addEventListener('mousedown', handleOutsideClick);
    window.addEventListener('mousemove', handleKnobMove);
    window.addEventListener('mouseup', handleKnobEnd);
    window.addEventListener('touchmove', handleKnobMove, { passive: false });
    window.addEventListener('touchend', handleKnobEnd);

    return () => {
      window.removeEventListener('keydown', handleBrowseKeys);
      window.removeEventListener('mousedown', handleOutsideClick);
      window.removeEventListener('mousemove', handleKnobMove);
      window.removeEventListener('mouseup', handleKnobEnd);
      window.removeEventListener('touchmove', handleKnobMove);
      window.removeEventListener('touchend', handleKnobEnd);
      keeper?.pause();
      if (keeperUrl) URL.revokeObjectURL(keeperUrl);
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
          title={knobTip(0)}
          on:mousedown={(e) => handleKnobStart(0, e)}
          on:touchstart={(e) => handleKnobStart(0, e)}
          on:wheel|preventDefault={(e) => handleKnobWheel(0, e)}
        >
          <div class="knob-3d" style="transform: rotate({knobAngles[0]}deg)">
            <div class="knob-barrel knob-barrel--black"></div>
            <div class="knob-top knob-top--black">
              <div class="knob-notch"></div>
            </div>
          </div>
        </div>
        <!-- Knob 1: lower black — bottom row, far left (anchor) -->
        <div
          class="knob-hitbox"
          style="position:absolute; bottom:0; left:0;"
          role="slider" tabindex="0"
          aria-label={knobMeta[1].name}
          aria-valuenow={knobValues[1]}
          title={knobTip(1)}
          on:mousedown={(e) => handleKnobStart(1, e)}
          on:touchstart={(e) => handleKnobStart(1, e)}
          on:wheel|preventDefault={(e) => handleKnobWheel(1, e)}
        >
          <div class="knob-3d" style="transform: rotate({knobAngles[1]}deg)">
            <div class="knob-barrel knob-barrel--black"></div>
            <div class="knob-top knob-top--black">
              <div class="knob-notch"></div>
            </div>
          </div>
        </div>
        <!-- Knob 2: upper gold — top row, right -->
        <div
          class="knob-hitbox"
          style="position:absolute; top:0; left:209px;"
          role="slider" tabindex="0"
          aria-label={knobMeta[2].name}
          aria-valuenow={knobValues[2]}
          title={knobTip(2)}
          on:mousedown={(e) => handleKnobStart(2, e)}
          on:touchstart={(e) => handleKnobStart(2, e)}
          on:wheel|preventDefault={(e) => handleKnobWheel(2, e)}
        >
          <div class="knob-3d" style="transform: rotate({knobAngles[2]}deg)">
            <div class="knob-barrel knob-barrel--gold"></div>
            <div class="knob-top knob-top--gold">
              <div class="knob-notch knob-notch--dark"></div>
            </div>
          </div>
        </div>
        <!-- Knob 3: lower gold — bottom row, middle -->
        <div
          class="knob-hitbox"
          style="position:absolute; bottom:0; left:128px;"
          role="slider" tabindex="0"
          aria-label={knobMeta[3].name}
          aria-valuenow={knobValues[3]}
          title={knobTip(3)}
          on:mousedown={(e) => handleKnobStart(3, e)}
          on:touchstart={(e) => handleKnobStart(3, e)}
          on:wheel|preventDefault={(e) => handleKnobWheel(3, e)}
        >
          <div class="knob-3d" style="transform: rotate({knobAngles[3]}deg)">
            <div class="knob-barrel knob-barrel--gold"></div>
            <div class="knob-top knob-top--gold">
              <div class="knob-notch knob-notch--dark"></div>
            </div>
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
            title={knobTip(4)}
            on:mousedown={(e) => handleKnobStart(4, e)}
            on:touchstart={(e) => handleKnobStart(4, e)}
            on:wheel|preventDefault={(e) => handleKnobWheel(4, e)}
          >
            <div class="knob-3d" style="transform: rotate({knobAngles[4]}deg)">
              <div class="knob-barrel knob-barrel--black"></div>
              <div class="knob-top knob-top--black">
                <div class="knob-notch"></div>
              </div>
            </div>
          </div>
        </div>

        <div class="screen-area">
          <div class="deluge-logo">✦ deluge</div>
          <div class="oled-row">
            <div class="oled-screen">
              <div class="oled-text" use:marquee={screenText}><span>{screenText}</span></div>
              <div class="oled-subtext">{screenSubtext || ' '}</div>
              {#if browsing}
                <div class="song-browser" role="listbox" aria-label="Song list" tabindex="-1">
                  {#each songs as song, i}
                    <button
                      class="song-option"
                      class:is-current={i === currentSongIndex}
                      class:is-cursor={i === browseIndex}
                      role="option"
                      aria-selected={i === currentSongIndex}
                      on:click={() => chooseSong(i)}
                      on:mouseenter={() => browseIndex = i}
                    >
                      <span class="song-name">{song.name}</span>
                      <span class="song-meta">
                        {#if song.duration}<span class="song-duration">{song.duration}</span>{/if}
                        {#if song.genre}<span class="song-genre">{song.genre}</span>{/if}
                        {#if song.year}<span class="song-year">{song.year}</span>{/if}
                      </span>
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
            <button
              class="load-btn"
              class:load-btn--open={browsing}
              on:click={handleLoad}
              aria-expanded={browsing}
              aria-label="Load song"
              title="Load"
            >
              <div class="load-btn-surface">LOAD</div>
            </button>
          </div>
        </div>
      </div>

      <div class="knobs-right">
        <!-- Black (tempo) -->
        <div class="knob-col">
          <div
            class="knob-hitbox"
            role="slider" tabindex="0"
            aria-label={knobMeta[5].name}
            aria-valuenow={knobValues[5]}
            title={knobTip(5)}
            on:mousedown={(e) => handleKnobStart(5, e)}
            on:touchstart={(e) => handleKnobStart(5, e)}
            on:wheel|preventDefault={(e) => handleKnobWheel(5, e)}
          >
            <div class="knob-3d" style="transform: rotate({knobAngles[5]}deg)">
              <div class="knob-barrel knob-barrel--black"></div>
              <div class="knob-top knob-top--black">
                <div class="knob-notch"></div>
              </div>
            </div>
          </div>
          <button
            class="play-btn reset-btn"
            on:click={handleReset}
            title="Reset"
            aria-label="Reset knobs to default"
          >
            <div class="play-btn-surface">
              <svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
                <path d="M10 6a4 4 0 1 1-1.2-2.85"/>
                <path d="M10.4 1.2v2.6H7.8"/>
              </svg>
            </div>
          </button>
        </div>
        <!-- Gold (output level) + play button below -->
        <div class="knob-col">
          <div
            class="knob-hitbox"
            role="slider" tabindex="0"
            aria-label={knobMeta[6].name}
            aria-valuenow={knobValues[6]}
            title={knobTip(6)}
            on:mousedown={(e) => handleKnobStart(6, e)}
            on:touchstart={(e) => handleKnobStart(6, e)}
            on:wheel|preventDefault={(e) => handleKnobWheel(6, e)}
          >
            <div class="knob-3d" style="transform: rotate({knobAngles[6]}deg)">
              <div class="knob-barrel knob-barrel--gold"></div>
              <div class="knob-top knob-top--gold">
                <div class="knob-notch knob-notch--dark"></div>
              </div>
            </div>
          </div>
          <button
            class="play-btn"
            class:play-btn--active={isPlaying}
            on:click={togglePlay}
            aria-label={isPlaying ? 'Pause' : 'Play'}
            title={isPlaying ? 'Pause' : 'Play'}
          >
            <div class="play-btn-surface">
              {#if isPlaying}
                <svg viewBox="0 0 12 12" width="8" height="8"><rect x="1" y="1" width="3.5" height="10" fill="currentColor"/><rect x="7.5" y="1" width="3.5" height="10" fill="currentColor"/></svg>
              {:else}
                <svg viewBox="0 0 12 12" width="8" height="8"><polygon points="2,0 12,6 2,12" fill="currentColor"/></svg>
              {/if}
            </div>
          </button>
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
              title={pad.label}
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
              title={pad.label}
            ></button>
          {/each}
        {/each}
      </div>
    {/if}

    <div class="grid-labels">
      <div class="grid-label-group grid-label-group--stats-up"><span class="grid-label-arrow">↑</span><span class="grid-label-text">Songs</span></div>
      <div class="grid-label-group grid-label-group--stats-down"><span class="grid-label-arrow">↓</span><span class="grid-label-text">Card</span></div>
      <div class="grid-label-group grid-label-group--preview-up"><span class="grid-label-arrow">↑</span><span class="grid-label-text">Preview</span></div>
      <div class="grid-label-group grid-label-group--preview-down"><span class="grid-label-arrow">↓</span><span class="grid-label-text">Patch</span></div>
      <div class="grid-label-group grid-label-group--score-up"><span class="grid-label-arrow">↑</span><span class="grid-label-text">Score</span></div>
      <div class="grid-label-group grid-label-group--score-down"><span class="grid-label-arrow">↓</span><span class="grid-label-text">Kits</span></div>
      <div class="grid-label-group grid-label-group--midi-up"><span class="grid-label-arrow">↑</span><span class="grid-label-text">Import</span></div>
      <div class="grid-labels-gap"></div>
      <div class="grid-label-group grid-label-group--github"><span class="grid-label-text">GitHub</span></div>
      <div class="grid-label-group grid-label-group--about"><span class="grid-label-text">About</span></div>
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
    padding: 0.6rem 1rem 0.3rem;
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
  .knob-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }

  /* --- Play button --- */
  .play-btn {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: none;
    padding: 0;
    cursor: pointer;
    background: linear-gradient(180deg, #3A3A40 0%, #252528 40%, #1A1A1E 100%);
    box-shadow:
      0 2px 1px rgba(0,0,0,0.4),
      inset 0 1px 0 rgba(255,255,255,0.06);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: box-shadow 0.1s;
  }
  .play-btn:hover {
    box-shadow:
      0 2px 1px rgba(0,0,0,0.4),
      inset 0 1px 0 rgba(255,255,255,0.06),
      0 0 8px rgba(212,168,71,0.3);
  }
  .play-btn:active {
    transform: scale(0.95);
  }
  .play-btn-surface {
    color: #888;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .play-btn--active .play-btn-surface {
    color: #D4A847;
  }

  .load-btn {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: none;
    padding: 0;
    cursor: pointer;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(180deg, #3A3A40 0%, #252528 40%, #1A1A1E 100%);
    box-shadow:
      0 2px 1px rgba(0,0,0,0.4),
      inset 0 1px 0 rgba(255,255,255,0.06);
    transition: box-shadow 0.1s;
  }
  .load-btn:hover {
    box-shadow:
      0 2px 1px rgba(0,0,0,0.4),
      inset 0 1px 0 rgba(255,255,255,0.06),
      0 0 8px rgba(212,168,71,0.3);
  }
  .load-btn:active {
    transform: scale(0.95);
  }
  .load-btn-surface {
    font-family: 'DM Mono', monospace;
    font-size: 0.4rem;
    font-weight: 500;
    letter-spacing: 0.02em;
    color: #888;
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
  .oled-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
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
    position: relative;
    background: #020204;
    border: 1px solid #1A1A1E;
    border-radius: 3px;
    padding: 0.35rem 0.7rem;
    flex: 1 1 auto;
    min-width: 0;
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
  }
  .oled-text > span {
    display: inline-block;
    will-change: transform;
  }
  @keyframes -global-oled-marquee {
    0%, 18%   { transform: translateX(0); }
    82%, 100% { transform: translateX(var(--marquee-shift, 0)); }
  }
  @media (prefers-reduced-motion: reduce) {
    .oled-text { text-overflow: ellipsis; }
  }
  .oled-subtext {
    font-family: 'DM Mono', monospace;
    font-size: 0.55rem;
    color: #777;
    margin-top: 0.1rem;
    letter-spacing: 0.04em;
  }

  .song-browser {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    top: calc(100% + 5px);
    z-index: 30;
    width: 620px;
    max-width: 88vw;
    max-height: 320px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1px;
    background: #08080B;
    border: 1px solid #3A3A42;
    border-radius: 4px;
    box-shadow: 0 10px 28px rgba(0,0,0,0.85);
    padding: 4px;
  }
  .song-option {
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.3rem 0.45rem;
    font-family: 'DM Mono', monospace;
    font-size: 0.78rem;
    line-height: 1.2;
    letter-spacing: 0.02em;
    color: #C9C5BC;
    border-radius: 3px;
  }
  .song-option.is-cursor {
    background: #2A2A33;
    color: #FFFFFF;
  }
  .song-option.is-current {
    color: #D4A847;
  }
  .song-name {
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .song-meta {
    flex: 0 0 auto;
    display: flex;
    gap: 0.6rem;
    font-size: 0.66rem;
    color: #6E6A63;
    letter-spacing: 0.06em;
  }
  .song-option.is-cursor .song-meta { color: #9A968E; }

  .song-browser::-webkit-scrollbar { width: 8px; }
  .song-browser::-webkit-scrollbar-thumb { background: #3A3A42; border-radius: 4px; }

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

  .grid-labels {
    pointer-events: none;
    display: grid;
    grid-template-columns: repeat(16, 1fr) 8px repeat(2, 1fr);
    gap: 3px;
    margin-top: 1px;
    line-height: 1;
    height: 18px;
  }
  .grid-labels-gap {
    grid-column: 17;
    width: 8px;
  }
  .grid-label-group {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 2px;
    font-family: 'DM Mono', monospace;
    font-size: 0.42rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: rgba(255,255,255,0.3);
  }
  .grid-label-arrow {
    font-size: 0.35rem;
    line-height: 1;
  }
  .grid-label-text {
    line-height: 1;
  }
  .grid-label-group--stats-up { grid-column: 1 / 3; }
  .grid-label-group--stats-down { grid-column: 3 / 5; }
  .grid-label-group--preview-up { grid-column: 5 / 7; }
  .grid-label-group--preview-down { grid-column: 7 / 9; }
  .grid-label-group--score-up { grid-column: 9 / 11; }
  .grid-label-group--score-down { grid-column: 11 / 13; }
  .grid-label-group--midi-up { grid-column: 13 / 15; }
  .grid-label-group--github,
  .grid-label-group--about {
    font-size: 0.36rem;
    letter-spacing: 0.04em;
    color: rgba(255,255,255,0.25);
  }
  .grid-label-group--github { grid-column: 18; }
  .grid-label-group--about { grid-column: 19; }

</style>
