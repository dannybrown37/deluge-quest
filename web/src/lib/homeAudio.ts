interface Song {
  file: string;
  name: string;
  year?: string | number;
  genre?: string;
  duration?: string;
}

type Listener = () => void;

class HomeAudioPlayer {
  audioCtx: AudioContext | null = null;
  audioBuffer: AudioBuffer | null = null;
  sourceNode: AudioBufferSourceNode | null = null;
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
  playStartTime = 0;
  playOffset = 0;
  songLoaded = false;
  loadedSongIndex = -1;

  songs: Song[] = [];
  currentSongIndex = 0;

  keeper: HTMLAudioElement | null = null;
  private keeperUrl = '';
  private listeners: Set<Listener> = new Set();
  private timerRaf = 0;

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
    if (!this.isPlaying || !this.audioCtx || !this.sourceNode) return this.playOffset;
    return this.playOffset + (this.audioCtx.currentTime - this.playStartTime) * this.sourceNode.playbackRate.value;
  }

  get duration(): number {
    return this.audioBuffer?.duration ?? 0;
  }

  async fetchSongList(): Promise<void> {
    if (this.songs.length > 0) return;
    try {
      const resp = await fetch('/audio/songs.json');
      if (resp.ok) {
        this.songs = await resp.json();
        if (this.songs.length > 0) {
          this.currentSongIndex = Math.floor(Math.random() * this.songs.length);
        }
      }
    } catch { /* no songs available */ }
  }

  private silentWavUrl(): string {
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

  private initKeeper() {
    if (this.keeper) return;
    this.keeperUrl = this.silentWavUrl();
    this.keeper = new Audio(this.keeperUrl);
    this.keeper.loop = true;
    this.keeper.volume = 0;
  }

  updateMediaMetadata() {
    if (!('mediaSession' in navigator)) return;
    const song = this.currentSong;
    if (!song) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.name,
      artist: 'DelugeKit',
      album: 'Demo Tracks',
    });
  }

  private setMediaState(state: MediaSessionPlaybackState) {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state;
  }

  initMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const set = (action: MediaSessionAction, handler: (() => void) | null) => {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported */ }
    };
    set('play', () => { if (!this.isPlaying) this.togglePlay(); });
    set('pause', () => { if (this.isPlaying) this.togglePlay(); });
    set('stop', () => { if (this.isPlaying) this.togglePlay(); });
    set('nexttrack', () => { if (this.songs.length > 1) this.stepSong(1); });
    set('previoustrack', () => { if (this.songs.length > 1) this.stepSong(-1); });
  }

  reassertMediaSession() {
    if (!this.isPlaying) return;
    this.initKeeper();
    this.keeper?.play().catch(() => {});
    this.updateMediaMetadata();
    this.setMediaState('playing');
    this.initMediaSession();
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
      if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
      return;
    }
    this.audioCtx = new AudioContext();
    this.filterNode = this.audioCtx.createBiquadFilter();
    this.filterNode.type = 'lowpass';
    this.gainNode = this.audioCtx.createGain();
    this.dryGain = this.audioCtx.createGain();
    this.wetGain = this.audioCtx.createGain();
    this.reverbNode = this.audioCtx.createConvolver();
    this.reverbNode.buffer = this.createImpulse(this.audioCtx);
    this.delayNode = this.audioCtx.createDelay(2.0);
    this.delayNode.delayTime.value = 0.375;
    this.delayFeedback = this.audioCtx.createGain();
    this.delayFeedback.gain.value = 0.35;
    this.delayWet = this.audioCtx.createGain();
    this.delayWet.gain.value = 0.4;
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
  }

  private songUrl(file: string): string {
    return `/audio/${encodeURIComponent(file).replace(/%2C/g, ',')}`;
  }

  async loadSong(idx: number): Promise<boolean> {
    if (!this.audioCtx || this.songs.length === 0) return false;
    if (this.isPlaying && this.sourceNode) {
      this.sourceNode.onended = null;
      this.sourceNode.stop();
      this.sourceNode = null;
      this.isPlaying = false;
    }
    this.playOffset = 0;
    this.currentSongIndex = idx;
    const song = this.songs[idx];
    try {
      const resp = await fetch(this.songUrl(song.file));
      if (!resp.ok) return false;
      const buf = await resp.arrayBuffer();
      this.audioBuffer = await this.audioCtx.decodeAudioData(buf);
      this.songLoaded = true;
      this.loadedSongIndex = idx;
      this.updateMediaMetadata();
      this.notify();
      return true;
    } catch (e) {
      console.error('Audio load failed:', e);
      return false;
    }
  }

  async stepSong(delta: number): Promise<void> {
    const wasPlaying = this.isPlaying;
    const idx = (this.currentSongIndex + delta + this.songs.length) % this.songs.length;
    await this.initAudio();
    await this.loadSong(idx);
    if (wasPlaying) await this.togglePlay();
  }

  async togglePlay(playbackRate = 1.0): Promise<void> {
    await this.initAudio();
    if (!this.audioCtx || !this.audioBuffer || !this.gainNode) return;

    if (this.isPlaying && this.sourceNode) {
      this.playOffset += (this.audioCtx.currentTime - this.playStartTime) * this.sourceNode.playbackRate.value;
      this.sourceNode.stop();
      this.sourceNode = null;
      this.isPlaying = false;
      this.keeper?.pause();
      this.setMediaState('paused');
      cancelAnimationFrame(this.timerRaf);
      this.notify();
      return;
    }

    if (this.playOffset >= this.audioBuffer.duration) this.playOffset = 0;

    this.sourceNode = this.audioCtx.createBufferSource();
    this.sourceNode.buffer = this.audioBuffer;
    this.sourceNode.playbackRate.value = playbackRate;
    this.sourceNode.connect(this.filterNode!);
    this.sourceNode.onended = () => {
      if (this.isPlaying) {
        this.isPlaying = false;
        this.playOffset = 0;
        this.sourceNode = null;
        this.keeper?.pause();
        this.setMediaState('none');
        cancelAnimationFrame(this.timerRaf);
        this.notify();
      }
    };
    this.sourceNode.start(0, this.playOffset);
    this.playStartTime = this.audioCtx.currentTime;
    this.isPlaying = true;
    this.initKeeper();
    this.keeper?.play().catch(() => {});
    this.updateMediaMetadata();
    this.setMediaState('playing');
    this.startTimer();
    this.notify();
  }

  private startTimer() {
    const tick = () => {
      if (!this.isPlaying) return;
      this.notify();
      this.timerRaf = requestAnimationFrame(tick);
    };
    this.timerRaf = requestAnimationFrame(tick);
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
    if (!this.delayNode || !this.delayFeedback) return;
    this.delayNode.delayTime.value = 0.05 + (time / 127) * 0.75;
    this.delayFeedback.gain.value = (feedback / 127) * 0.85;
  }

  updatePlaybackRate(value: number) {
    const rate = value <= 64 ? 0.5 + (value / 64) * 0.5 : 1.0 + ((value - 64) / 63) * 1.0;
    if (this.sourceNode) this.sourceNode.playbackRate.value = rate;
  }

  formatTime(current: number, total: number): string {
    const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    return `${fmt(current)} / ${fmt(total)}`;
  }
}

export const homeAudio = new HomeAudioPlayer();
