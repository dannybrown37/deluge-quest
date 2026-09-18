import { crossedMarks, percentPlayed, trackSong } from "./analytics";

interface Song {
  file: string;
  name: string;
  slug?: string;
  year?: string | number;
  genre?: string;
  duration?: string;
}

type Listener = () => void;

export class HomeAudioPlayer {
  audioCtx: AudioContext | null = null;
  mediaElement: HTMLAudioElement | null = null;
  private mediaSource: MediaElementAudioSourceNode | null = null;
  gainNode: GainNode | null = null;
  filterNode: BiquadFilterNode | null = null;
  reverbNode: ConvolverNode | null = null;
  dryGain: GainNode | null = null;
  wetGain: GainNode | null = null;
  delayNode: DelayNode | null = null;
  delayFeedback: GainNode | null = null;
  delayWet: GainNode | null = null;
  analyserNode: AnalyserNode | null = null;

  isPlaying = false;
  songLoaded = false;
  loadedSongIndex = -1;

  songs: Song[] = [];
  currentSongIndex = 0;

  onNavigate: ((song: Song) => void) | null = null;

  private listeners: Set<Listener> = new Set();
  private timerRaf = 0;

  private trackedPercent = 0;
  private listenSeconds = 0;
  private lastTickAt = 0;
  private reportedSeconds = 0;
  private playReported = false;
  private unloadFlushInstalled = false;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }

  get currentSong(): Song | undefined {
    return this.songs[this.currentSongIndex];
  }

  get elapsed(): number {
    return this.mediaElement?.currentTime ?? 0;
  }

  get playOffset(): number {
    return this.mediaElement?.currentTime ?? 0;
  }

  get duration(): number {
    const d = this.mediaElement?.duration ?? 0;
    return Number.isFinite(d) ? d : 0;
  }

  private shuffle(arr: Song[]): Song[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  async fetchSongList(): Promise<void> {
    if (this.songs.length > 0) return;
    try {
      const resp = await fetch("/audio/songs.json");
      if (resp.ok) {
        this.songs = this.shuffle(await resp.json());
        this.currentSongIndex = 0;
      }
    } catch {
      /* no songs available */
    }
  }

  createImpulse(ctx: AudioContext, duration = 2.5, decay = 3): AudioBuffer {
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

  async initAudio(): Promise<void> {
    if (this.audioCtx) {
      if (this.audioCtx.state === "suspended") await this.audioCtx.resume();
      return;
    }
    this.audioCtx = new AudioContext();

    this.filterNode = this.audioCtx.createBiquadFilter();
    this.filterNode.type = "lowpass";
    this.filterNode.frequency.value = 22050;
    this.gainNode = this.audioCtx.createGain();
    this.dryGain = this.audioCtx.createGain();
    this.wetGain = this.audioCtx.createGain();
    this.wetGain.gain.value = 0;
    this.reverbNode = this.audioCtx.createConvolver();
    this.reverbNode.buffer = this.createImpulse(this.audioCtx);
    this.delayNode = this.audioCtx.createDelay(2.0);
    this.delayNode.delayTime.value = 0.375;
    this.delayFeedback = this.audioCtx.createGain();
    this.delayFeedback.gain.value = 0.35;
    this.delayWet = this.audioCtx.createGain();
    this.delayWet.gain.value = 0;

    this.filterNode.connect(this.dryGain);
    this.filterNode.connect(this.reverbNode);
    this.filterNode.connect(this.delayNode);
    this.delayNode.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delayNode);
    this.delayNode.connect(this.delayWet);
    this.reverbNode.connect(this.wetGain);
    this.dryGain.connect(this.gainNode);
    this.wetGain.connect(this.gainNode);
    this.delayWet.connect(this.gainNode);
    this.analyserNode = this.audioCtx.createAnalyser();
    this.analyserNode.fftSize = 256;
    this.gainNode.connect(this.analyserNode);
    this.analyserNode.connect(this.audioCtx.destination);

    this.newMediaChain();
  }

  // A MediaElementAudioSourceNode stops passing audio to the graph once its
  // element's src is swapped, so each song gets a fresh element and tap.
  private newMediaChain() {
    if (!this.audioCtx || !this.filterNode) return;

    this.mediaSource?.disconnect();
    this.mediaElement?.pause();

    const el = new Audio();
    el.crossOrigin = "anonymous";
    el.preload = "auto";
    el.addEventListener("ended", () => {
      this.isPlaying = false;
      this.stepSong(1, true);
    });

    this.mediaElement = el;
    this.mediaSource = this.audioCtx.createMediaElementSource(el);
    this.mediaSource.connect(this.filterNode);
  }

  private songUrl(file: string): string {
    return `/audio/${encodeURIComponent(file).replace(/%2C/g, ",")}`;
  }

  async loadSong(idx: number): Promise<boolean> {
    if (!this.mediaElement || this.songs.length === 0) return false;
    if (this.isPlaying) {
      this.mediaElement.pause();
      this.isPlaying = false;
    }
    this.flushListenTime();
    this.newMediaChain();
    this.currentSongIndex = idx;
    this.trackedPercent = 0;
    this.listenSeconds = 0;
    this.reportedSeconds = 0;
    this.playReported = false;
    const song = this.songs[idx];

    return new Promise<boolean>((resolve) => {
      const el = this.mediaElement!;
      const onReady = () => {
        el.removeEventListener("canplaythrough", onReady);
        el.removeEventListener("error", onError);
        this.songLoaded = true;
        this.loadedSongIndex = idx;
        this.updateMediaMetadata();
        this.notify();
        resolve(true);
      };
      const onError = () => {
        el.removeEventListener("canplaythrough", onReady);
        el.removeEventListener("error", onError);
        console.error("Audio load failed:", song.file);
        resolve(false);
      };
      el.addEventListener("canplaythrough", onReady, { once: true });
      el.addEventListener("error", onError, { once: true });
      el.src = this.songUrl(song.file);
      el.load();
    });
  }

  async stepSong(delta: number, forcePlay = false): Promise<void> {
    const wasPlaying = forcePlay || this.isPlaying;
    const idx =
      (this.currentSongIndex + delta + this.songs.length) % this.songs.length;
    await this.initAudio();
    await this.loadSong(idx);
    if (wasPlaying) await this.togglePlay();
    const song = this.songs[idx];
    if (song && this.onNavigate) this.onNavigate(song);
  }

  private mediaSessionReady = false;

  reassertMediaSession() {
    this.initMediaSession();
    if (this.songLoaded) {
      this.updateMediaMetadata();
      // Chrome hides the media UI when playbackState is 'none', which happens
      // after ClientRouter transitions on some browsers. Reassert it.
      this.setMediaState(this.isPlaying ? "playing" : "paused");
    }
  }

  initMediaSession() {
    if (this.mediaSessionReady) return;
    if (!("mediaSession" in navigator)) return;
    this.mediaSessionReady = true;
    const set = (action: MediaSessionAction, handler: (() => void) | null) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        /* unsupported */
      }
    };
    set("play", () => {
      if (!this.isPlaying) this.togglePlay();
    });
    set("pause", () => {
      if (this.isPlaying) this.togglePlay();
    });
    set("stop", () => {
      if (this.isPlaying) this.togglePlay();
    });
    set("nexttrack", () => {
      if (this.songs.length > 1) this.stepSong(1);
    });
    set("previoustrack", () => {
      if (this.songs.length > 1) this.stepSong(-1);
    });
  }

  updateMediaMetadata() {
    if (!("mediaSession" in navigator)) return;
    const song = this.currentSong;
    if (!song) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.name,
      artist: "deluge.quest",
      album: "Demo Tracks",
    });
  }

  private setMediaState(state: MediaSessionPlaybackState) {
    if ("mediaSession" in navigator)
      navigator.mediaSession.playbackState = state;
  }

  async togglePlay(playbackRate = 1.0): Promise<void> {
    await this.initAudio();
    if (!this.mediaElement || !this.songLoaded || !this.gainNode) return;

    if (this.isPlaying) {
      this.mediaElement.pause();
      this.isPlaying = false;
      this.setMediaState("paused");
      cancelAnimationFrame(this.timerRaf);
      this.flushListenTime();
      // Cutting the source doesn't stop the delay feedback loop from
      // recirculating already-buffered audio — it keeps looping the tail
      // until it decays. Break the loop so pause is actually silent.
      this.delayFeedback?.disconnect();
      this.notify();
      return;
    }

    this.mediaElement.playbackRate = playbackRate;
    if (this.delayFeedback && this.delayNode)
      this.delayFeedback.connect(this.delayNode);
    await this.mediaElement.play();
    this.isPlaying = true;
    this.updateMediaMetadata();
    this.setMediaState("playing");
    this.initMediaSession();
    if (!this.playReported) {
      this.playReported = true;
      trackSong("play", this.songLabel);
    }
    this.installUnloadFlush();
    this.startTimer();
    this.notify();
  }

  private startTimer() {
    const tick = () => {
      if (!this.isPlaying) return;
      this.accrueListenTime();
      this.trackProgress();
      this.notify();
      this.timerRaf = requestAnimationFrame(tick);
    };
    this.lastTickAt = performance.now();
    this.timerRaf = requestAnimationFrame(tick);
  }

  private get songLabel(): string {
    const song = this.currentSong;
    return song?.slug ?? song?.name ?? "unknown";
  }

  private accrueListenTime() {
    // 0 means "clock stopped" (paused or backgrounded) — restart it, don't bill the gap.
    if (this.lastTickAt === 0) {
      this.lastTickAt = performance.now();
      return;
    }
    const now = performance.now();
    const delta = (now - this.lastTickAt) / 1000;
    this.lastTickAt = now;
    if (delta > 0 && delta < 5) this.listenSeconds += delta;
  }

  private trackProgress() {
    const pct = percentPlayed(this.elapsed, this.duration);
    const marks = crossedMarks(this.trackedPercent, pct);
    this.trackedPercent = Math.max(this.trackedPercent, pct);
    for (const mark of marks) {
      trackSong("progress", this.songLabel, mark);
    }
  }

  // pagehide is the only unload event mobile Safari reliably fires.
  private installUnloadFlush() {
    if (this.unloadFlushInstalled || typeof window === "undefined") return;
    this.unloadFlushInstalled = true;
    window.addEventListener("pagehide", () => this.flushListenTime());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        this.flushListenTime();
      } else if (this.isPlaying && this.audioCtx?.state === "suspended") {
        this.audioCtx.resume();
      }
    });
  }

  // Called on pause, track change, and page unload so partial listens still count.
  flushListenTime() {
    this.accrueListenTime();
    this.lastTickAt = 0;
    const unreported = Math.round(this.listenSeconds - this.reportedSeconds);
    if (unreported < 1) return;
    this.reportedSeconds = this.listenSeconds;
    trackSong("listen", this.songLabel, unreported);
  }

  updateVolume(value: number) {
    if (!this.gainNode) return;
    this.gainNode.gain.value = value / 127;
  }

  updateFilter(cutoff: number, resonance: number) {
    if (!this.filterNode) return;
    const norm = cutoff / 127;
    this.filterNode.frequency.value = 80 * Math.pow(280, norm);
    const resNorm = resonance / 127;
    this.filterNode.Q.value = 0.5 + resNorm * 24.5;
  }

  updateReverb(value: number) {
    if (!this.dryGain || !this.wetGain) return;
    const mix = value / 127;
    this.dryGain.gain.value = 1 - mix * 0.5;
    this.wetGain.gain.value = mix;
  }

  updateDelay(time: number, feedback: number) {
    if (!this.delayNode || !this.delayFeedback || !this.delayWet) return;
    this.delayNode.delayTime.value = 0.05 + (time / 127) * 0.75;
    this.delayFeedback.gain.value = (feedback / 127) * 0.85;
    const active = time > 0 || feedback > 0;
    this.delayWet.gain.value = active ? 0.4 : 0;
  }

  updatePlaybackRate(value: number) {
    const rate =
      value <= 64 ? 0.5 + (value / 64) * 0.5 : 1.0 + ((value - 64) / 63) * 1.0;
    if (this.mediaElement) this.mediaElement.playbackRate = rate;
  }

  formatTime(current: number, total: number): string {
    const fmt = (s: number) =>
      `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    return `${fmt(current)} / ${fmt(total)}`;
  }
}

export const homeAudio = new HomeAudioPlayer();
