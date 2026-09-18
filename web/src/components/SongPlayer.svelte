<script lang="ts">
import { onDestroy, onMount } from "svelte";
import { homeAudio } from "../lib/homeAudio";

export let name: string;
export let year: string | undefined = undefined;
export let genre: string | undefined = undefined;
export let duration: string | undefined = undefined;
export let pageUrl: string;

let displayName = name;
let displayYear = year;
let displayGenre = genre;
let displayDuration = duration;
let displayUrl = pageUrl;

let playing = false;
let currentTime = 0;
let totalDuration = 0;
let loaded = false;
let copied = false;
let unsubscribe: (() => void) | null = null;
let raf = 0;

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function sync() {
  playing = homeAudio.isPlaying;
  loaded = homeAudio.songLoaded;
  currentTime = homeAudio.elapsed;
  totalDuration = homeAudio.duration;

  const song = homeAudio.currentSong;
  if (song && song.name !== displayName) {
    displayName = song.name;
    displayYear = typeof song.year === "number" ? String(song.year) : song.year;
    displayGenre = song.genre;
    displayDuration = song.duration;
    const slug = song.slug ?? slugify(song.name);
    displayUrl = `https://deluge.quest/songs/${slug}`;
  }
}

async function toggle() {
  await homeAudio.initAudio();
  const idx = homeAudio.songs.findIndex(
    (s) => s.name.toLowerCase() === name.toLowerCase(),
  );
  if (idx >= 0 && homeAudio.loadedSongIndex !== idx) {
    await homeAudio.loadSong(idx);
  }
  await homeAudio.togglePlay();
  sync();
}

function share() {
  if (navigator.share) {
    navigator.share({
      title: `${displayName} — deluge.quest`,
      url: displayUrl,
    });
  } else {
    navigator.clipboard.writeText(displayUrl);
    copied = true;
    setTimeout(() => {
      copied = false;
    }, 2000);
  }
}

function startTick() {
  const tick = () => {
    if (!playing) return;
    sync();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

onMount(async () => {
  await homeAudio.fetchSongList();
  const target = name.toLowerCase();
  const idx = homeAudio.songs.findIndex((s) => s.name.toLowerCase() === target);
  if (idx >= 0) homeAudio.currentSongIndex = idx;
  sync();

  unsubscribe = homeAudio.subscribe(() => {
    sync();
    if (playing) startTick();
  });

  if (homeAudio.isPlaying) startTick();
});

onDestroy(() => {
  unsubscribe?.();
  if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(raf);
});
</script>

<div class="player">
  <h1 class="title">{displayName}</h1>

  <div class="meta">
    {#if displayGenre}<span class="tag">{displayGenre}</span>{/if}
    {#if displayYear}<span class="tag">{displayYear}</span>{/if}
    {#if displayDuration}<span class="tag">{displayDuration}</span>{/if}
  </div>

  <button class="play-btn" on:click={toggle} aria-label={playing ? 'Pause' : 'Play'}>
    {#if playing}
      <svg viewBox="0 0 24 24" width="32" height="32">
        <rect x="5" y="3" width="5" height="18" rx="1" fill="currentColor"/>
        <rect x="14" y="3" width="5" height="18" rx="1" fill="currentColor"/>
      </svg>
    {:else}
      <svg viewBox="0 0 24 24" width="32" height="32">
        <polygon points="6,3 21,12 6,21" fill="currentColor"/>
      </svg>
    {/if}
  </button>

  <div class="seek">
    <span class="time">{fmt(currentTime)}</span>
    <div class="seekbar-track">
      <div class="seekbar-fill" style="width: {totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0}%"></div>
    </div>
    <span class="time">{fmt(totalDuration)}</span>
  </div>

  <button class="share-btn" on:click={share}>
    {copied ? 'Link copied' : 'Share'}
  </button>

  <p class="credit">Made on the <a href="https://synthstrom.com/product/deluge/" target="_blank" rel="noopener">Synthstrom Deluge</a></p>
</div>

<style>
  .player {
    width: 100%;
    max-width: 360px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.25rem;
  }

  .title {
    font-family: 'DM Mono', monospace;
    font-size: 1.3rem;
    font-weight: 500;
    text-align: center;
    color: var(--text);
    line-height: 1.3;
  }

  .meta {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    justify-content: center;
  }

  .tag {
    font-family: 'DM Mono', monospace;
    font-size: 0.75rem;
    color: var(--text-secondary);
    background: var(--surface);
    border: 1px solid var(--border);
    padding: 0.2rem 0.6rem;
    border-radius: 99px;
  }

  .play-btn {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    border: none;
    cursor: pointer;
    background: var(--accent);
    color: var(--ground);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.1s, box-shadow 0.15s;
  }
  .play-btn:hover {
    transform: scale(1.05);
    box-shadow: 0 4px 20px var(--accent-dim);
  }
  .play-btn:active {
    transform: scale(0.97);
  }

  .seek {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .time {
    font-family: 'DM Mono', monospace;
    font-size: 0.7rem;
    color: var(--text-secondary);
    min-width: 3rem;
    text-align: center;
  }

  .seekbar-track {
    flex: 1;
    height: 4px;
    border-radius: 2px;
    background: var(--border);
    overflow: hidden;
  }

  .seekbar-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
    transition: width 0.15s linear;
  }

  .share-btn {
    font-family: 'DM Mono', monospace;
    font-size: 0.8rem;
    color: var(--accent);
    background: transparent;
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 0.45rem 1.5rem;
    cursor: pointer;
    transition: background 0.1s, color 0.1s;
  }
  .share-btn:hover {
    background: var(--accent);
    color: var(--ground);
  }

  .credit {
    font-size: 0.75rem;
    color: var(--text-secondary);
    text-align: center;
  }
  .credit a {
    color: var(--teal);
  }
</style>
