import {
  midiToFreq,
  createSubVoice,
  createFMVoice,
  envAttackTime,
  envDecayReleaseTime,
  envSustainLevel,
  type AudioPatch,
} from './patchAudio';
import type { PreviewTrack, PreviewPatch } from './pyodide';

export interface SongPlaybackOptions {
  bpm: number;
  ticksPerQuarter: number;
  tracks: PreviewTrack[];
  durationTicks: number;
  onTick?: (currentTick: number) => void;
  onEnd?: () => void;
  sampleResolver?: (path: string, ctx: AudioContext) => Promise<AudioBuffer | null>;
}

interface ScheduledNode {
  source: AudioBufferSourceNode | OscillatorNode;
  gain: GainNode;
}

type DrumType = 'kick' | 'snare' | 'hihat' | 'clap' | 'tom' | 'cymbal' | 'perc';

function classifyDrum(drumName: string | null, midi: number): DrumType {
  if (drumName) {
    const n = drumName.toUpperCase();
    if (n.includes('KICK') || n.includes('BASS') || n.includes('BD')) return 'kick';
    if (n.includes('SNARE') || n.includes('SNR') || n.includes('SD')) return 'snare';
    if (n.includes('HAT') || n.includes('HH') || n.includes('HIHAT')) return 'hihat';
    if (n.includes('CLAP') || n.includes('CLP') || n.includes('HAND')) return 'clap';
    if (n.includes('TOM')) return 'tom';
    if (n.includes('CRASH') || n.includes('RIDE') || n.includes('CYMBAL') || n.includes('CYM')) return 'cymbal';
    if (n.includes('RIM') || n.includes('COWBELL') || n.includes('CLAVE') || n.includes('SHAKER') || n.includes('TAMB')) return 'perc';
  }
  if (midi <= 40) return 'kick';
  if (midi <= 50) return 'snare';
  if (midi >= 70) return 'hihat';
  return 'perc';
}

const WAVEFORMS: OscillatorType[] = ['sawtooth', 'square', 'triangle', 'sine'];
const LOOKAHEAD_SEC = 5;
const SCHEDULE_INTERVAL_MS = 200;

export type EQBand = 'low' | 'mid' | 'high';

const EQ_FREQ: Record<EQBand, number> = { low: 200, mid: 1000, high: 4000 };
const DEFAULT_EQ: Record<EQBand, number> = { low: -4, mid: 0, high: 0 };

export class SongPlayer {
  private opts: SongPlaybackOptions;
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private trackGains: GainNode[] = [];
  private trackBaseGain = 1;
  private trackVolumes: number[] = [];
  private trackMuted: boolean[] = [];
  private scheduled: ScheduledNode[] = [];
  private noiseBuffer: AudioBuffer | null = null;

  private eqGains: Record<EQBand, number> = { ...DEFAULT_EQ };
  private eqLow: BiquadFilterNode | null = null;
  private eqMid: BiquadFilterNode | null = null;
  private eqHigh: BiquadFilterNode | null = null;

  private startCtxTime = 0;
  private startOffsetSec = 0;
  private scheduledUpToSec = 0;
  private scheduleTimer: number | null = null;
  private rafId: number | null = null;

  private _isPlaying = false;
  private _isPaused = false;

  private flatNotes: { trackIdx: number; midi: number; isKit: boolean; drumType: DrumType; samplePath: string | null; startSec: number; durSec: number; vel: number }[] = [];
  private secPerTick: number;
  private totalDurationSec: number;
  private sampleBuffers = new Map<string, AudioBuffer>();
  private trackPatches: (PreviewPatch | null)[];

  constructor(opts: SongPlaybackOptions) {
    this.opts = opts;
    this.secPerTick = 60 / (opts.bpm * opts.ticksPerQuarter);
    this.totalDurationSec = opts.durationTicks * this.secPerTick;
    this.trackPatches = opts.tracks.map((t) => t.patch);
    this.flattenNotes();
  }

  private flattenNotes() {
    const { tracks } = this.opts;
    this.flatNotes = [];
    for (let ti = 0; ti < tracks.length; ti++) {
      const track = tracks[ti];
      for (const clip of track.clips) {
        for (const row of clip.noteRows) {
          const midi = row.y ?? 60;
          const drumType = track.isKit ? classifyDrum(row.drumName, midi) : 'perc' as DrumType;
          for (const note of row.notes) {
            const absTick = clip.positionTicks + note.pos;
            this.flatNotes.push({
              trackIdx: ti,
              midi,
              isKit: track.isKit,
              drumType,
              samplePath: track.isKit ? row.samplePath : null,
              startSec: absTick * this.secPerTick,
              durSec: Math.max(note.len * this.secPerTick, 0.02),
              vel: note.vel / 127,
            });
          }
        }
      }
    }
    this.flatNotes.sort((a, b) => a.startSec - b.startSec);
  }

  get isPlaying() { return this._isPlaying; }
  get isPaused() { return this._isPaused; }

  get currentTick(): number {
    if (!this.ctx || !this._isPlaying) {
      return this.startOffsetSec / this.secPerTick;
    }
    const elapsed = this.ctx.currentTime - this.startCtxTime + this.startOffsetSec;
    return elapsed / this.secPerTick;
  }

  play() {
    if (this._isPaused && this.ctx) {
      this._isPaused = false;
      this._isPlaying = true;
      this.ctx.resume();
      this.startCtxTime = this.ctx.currentTime - this.startOffsetSec;
      this.startScheduler();
      this.startAnimLoop();
      return;
    }

    this.stopInternal();
    const ctx = new AudioContext({ sampleRate: 44100 });
    this.ctx = ctx;

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.ratio.value = 4;
    compressor.connect(ctx.destination);
    this.compressor = compressor;

    const eqLow = ctx.createBiquadFilter();
    eqLow.type = 'lowshelf';
    eqLow.frequency.value = EQ_FREQ.low;
    eqLow.gain.value = this.eqGains.low;
    this.eqLow = eqLow;

    const eqMid = ctx.createBiquadFilter();
    eqMid.type = 'peaking';
    eqMid.frequency.value = EQ_FREQ.mid;
    eqMid.Q.value = 0.7;
    eqMid.gain.value = this.eqGains.mid;
    this.eqMid = eqMid;

    const eqHigh = ctx.createBiquadFilter();
    eqHigh.type = 'highshelf';
    eqHigh.frequency.value = EQ_FREQ.high;
    eqHigh.gain.value = this.eqGains.high;
    this.eqHigh = eqHigh;

    eqLow.connect(eqMid);
    eqMid.connect(eqHigh);
    eqHigh.connect(compressor);

    const masterGain = ctx.createGain();
    masterGain.gain.value = 0.8;
    masterGain.connect(eqLow);
    this.masterGain = masterGain;

    const trackCount = this.opts.tracks.length;
    this.trackBaseGain = 0.7 / Math.sqrt(Math.max(trackCount, 1));
    if (this.trackVolumes.length !== trackCount) this.trackVolumes = this.opts.tracks.map(() => 1);
    if (this.trackMuted.length !== trackCount) this.trackMuted = this.opts.tracks.map(() => false);
    this.trackGains = this.opts.tracks.map((_, i) => {
      const g = ctx.createGain();
      g.gain.value = this.trackMuted[i] ? 0 : this.trackBaseGain * this.trackVolumes[i];
      g.connect(masterGain);
      return g;
    });

    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const noiseData = noiseBuf.getChannelData(0);
    for (let i = 0; i < noiseData.length; i++) noiseData[i] = Math.random() * 2 - 1;
    this.noiseBuffer = noiseBuf;

    this._isPlaying = true;
    this._isPaused = false;
    this.startCtxTime = ctx.currentTime;
    this.scheduledUpToSec = this.startOffsetSec;

    this.prefetchSamples().finally(() => {
      if (this._isPlaying) this.scheduleChunk();
    });
    this.startScheduler();
    this.startAnimLoop();
  }

  private async prefetchSamples() {
    const resolver = this.opts.sampleResolver;
    if (!resolver || !this.ctx) return;
    const ctx = this.ctx;
    const paths = new Set(
      this.flatNotes.map((n) => n.samplePath).filter((p): p is string => p !== null)
    );
    await Promise.all(
      [...paths].map(async (path) => {
        if (this.sampleBuffers.has(path)) return;
        const buf = await resolver(path, ctx);
        if (buf) this.sampleBuffers.set(path, buf);
      })
    );
  }

  pause() {
    if (!this._isPlaying || !this.ctx) return;
    this.startOffsetSec = this.ctx.currentTime - this.startCtxTime + this.startOffsetSec;
    // Clamp to avoid negative values from timing jitter
    if (this.startOffsetSec < 0) this.startOffsetSec = 0;
    this.ctx.suspend();
    this._isPlaying = false;
    this._isPaused = true;
    this.stopScheduler();
    this.stopAnimLoop();
  }

  stop() {
    this.startOffsetSec = 0;
    this.stopInternal();
    this.opts.onTick?.(0);
  }

  seek(tick: number) {
    const wasPaused = this._isPaused;
    this.stopInternal();
    this.startOffsetSec = Math.max(0, tick * this.secPerTick);
    this.opts.onTick?.(tick);
    if (!wasPaused) {
      this.play();
    }
  }

  dispose() {
    this.stopInternal();
    this.startOffsetSec = 0;
  }

  private stopInternal() {
    this.stopScheduler();
    this.stopAnimLoop();
    this._isPlaying = false;
    this._isPaused = false;
    for (const s of this.scheduled) {
      try { s.source.stop(); } catch {}
      try { s.source.disconnect(); } catch {}
      try { s.gain.disconnect(); } catch {}
    }
    this.scheduled = [];
    if (this.ctx) {
      try { this.ctx.close(); } catch {}
      this.ctx = null;
    }
    this.masterGain = null;
    this.compressor = null;
    this.trackGains = [];
    this.noiseBuffer = null;
    this.eqLow = null;
    this.eqMid = null;
    this.eqHigh = null;
  }

  getTrackVolume(trackIdx: number): number {
    return this.trackVolumes[trackIdx] ?? 1;
  }

  setTrackVolume(trackIdx: number, volume: number) {
    this.trackVolumes[trackIdx] = volume;
    this.applyTrackGain(trackIdx);
  }

  isTrackMuted(trackIdx: number): boolean {
    return this.trackMuted[trackIdx] ?? false;
  }

  setTrackMuted(trackIdx: number, muted: boolean) {
    this.trackMuted[trackIdx] = muted;
    this.applyTrackGain(trackIdx);
  }

  private applyTrackGain(trackIdx: number) {
    const node = this.trackGains[trackIdx];
    if (!node || !this.ctx) return;
    const value = this.trackMuted[trackIdx] ? 0 : this.trackBaseGain * this.trackVolumes[trackIdx];
    node.gain.setTargetAtTime(value, this.ctx.currentTime, 0.01);
  }

  getEQ(band: EQBand): number {
    return this.eqGains[band];
  }

  setEQ(band: EQBand, gainDb: number) {
    this.eqGains[band] = gainDb;
    const node = band === 'low' ? this.eqLow : band === 'mid' ? this.eqMid : this.eqHigh;
    if (node && this.ctx) {
      node.gain.setTargetAtTime(gainDb, this.ctx.currentTime, 0.01);
    }
  }

  private startScheduler() {
    this.stopScheduler();
    this.scheduleTimer = window.setInterval(() => this.scheduleChunk(), SCHEDULE_INTERVAL_MS);
  }

  private stopScheduler() {
    if (this.scheduleTimer !== null) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
  }

  private scheduleChunk() {
    if (!this.ctx || !this._isPlaying) return;

    const now = this.ctx.currentTime;
    const elapsed = now - this.startCtxTime + this.startOffsetSec;
    const horizonSec = elapsed + LOOKAHEAD_SEC;

    if (this.scheduledUpToSec >= this.totalDurationSec) {
      if (elapsed >= this.totalDurationSec) {
        this.stop();
        this.opts.onEnd?.();
      }
      return;
    }

    for (const note of this.flatNotes) {
      if (note.startSec < this.scheduledUpToSec) continue;
      if (note.startSec >= horizonSec) break;

      const when = this.startCtxTime + note.startSec - this.startOffsetSec;
      if (when < now - 0.1) continue;

      this.scheduleNote(note, Math.max(when, now));
    }

    this.scheduledUpToSec = horizonSec;
  }

  private scheduleKick(ctx: AudioContext, dest: AudioNode, vol: number, when: number) {
    const dur = 0.25;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + dur);
    g.connect(dest);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, when);
    osc.frequency.exponentialRampToValueAtTime(30, when + 0.08);
    osc.connect(g);
    osc.start(when);
    osc.stop(when + dur + 0.01);
    this.scheduled.push({ source: osc, gain: g });
  }

  private scheduleSnare(ctx: AudioContext, dest: AudioNode, vol: number, when: number) {
    const dur = 0.15;

    const toneG = ctx.createGain();
    toneG.gain.setValueAtTime(vol * 0.6, when);
    toneG.gain.exponentialRampToValueAtTime(0.001, when + 0.08);
    toneG.connect(dest);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 200;
    osc.connect(toneG);
    osc.start(when);
    osc.stop(when + 0.08 + 0.01);
    this.scheduled.push({ source: osc, gain: toneG });

    const noiseG = ctx.createGain();
    noiseG.gain.setValueAtTime(vol, when);
    noiseG.gain.exponentialRampToValueAtTime(0.001, when + dur);
    noiseG.connect(dest);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const hpf = ctx.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.value = 2000;
    src.connect(hpf);
    hpf.connect(noiseG);
    src.start(when);
    src.stop(when + dur + 0.01);
    this.scheduled.push({ source: src, gain: noiseG });
  }

  private scheduleHihat(ctx: AudioContext, dest: AudioNode, vol: number, when: number) {
    const dur = 0.05;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol * 0.5, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + dur);
    g.connect(dest);

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const hpf = ctx.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.value = 7000;
    const bpf = ctx.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.frequency.value = 10000;
    bpf.Q.value = 1;
    src.connect(hpf);
    hpf.connect(bpf);
    bpf.connect(g);
    src.start(when);
    src.stop(when + dur + 0.01);
    this.scheduled.push({ source: src, gain: g });
  }

  private scheduleClap(ctx: AudioContext, dest: AudioNode, vol: number, when: number) {
    const dur = 0.12;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol * 0.7, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + dur);
    g.connect(dest);

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bpf = ctx.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.frequency.value = 1500;
    bpf.Q.value = 2;
    src.connect(bpf);
    bpf.connect(g);
    src.start(when);
    src.stop(when + dur + 0.01);
    this.scheduled.push({ source: src, gain: g });
  }

  private scheduleTom(ctx: AudioContext, dest: AudioNode, vol: number, when: number, midi: number) {
    const dur = 0.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + dur);
    g.connect(dest);

    const freq = midiToFreq(Math.max(midi, 40));
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, when);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.5, when + dur);
    osc.connect(g);
    osc.start(when);
    osc.stop(when + dur + 0.01);
    this.scheduled.push({ source: osc, gain: g });
  }

  private scheduleCymbal(ctx: AudioContext, dest: AudioNode, vol: number, when: number) {
    const dur = 0.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol * 0.4, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + dur);
    g.connect(dest);

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const hpf = ctx.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.value = 5000;
    src.connect(hpf);
    hpf.connect(g);
    src.start(when);
    src.stop(when + dur + 0.01);
    this.scheduled.push({ source: src, gain: g });
  }

  private schedulePerc(ctx: AudioContext, dest: AudioNode, vol: number, when: number, midi: number) {
    const dur = 0.08;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol * 0.6, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + dur);
    g.connect(dest);

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bpf = ctx.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.frequency.value = midiToFreq(midi);
    bpf.Q.value = 3;
    src.connect(bpf);
    bpf.connect(g);
    src.start(when);
    src.stop(when + dur + 0.01);
    this.scheduled.push({ source: src, gain: g });
  }

  private scheduleSample(ctx: AudioContext, dest: AudioNode, vol: number, when: number, buffer: AudioBuffer) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, when);
    g.connect(dest);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(g);
    src.start(when);
    this.scheduled.push({ source: src, gain: g });
  }

  private schedulePatchVoice(
    ctx: AudioContext, dest: AudioNode, patch: PreviewPatch,
    midi: number, vel: number, when: number, durSec: number
  ) {
    const freq = midiToFreq(midi);
    const a1 = envAttackTime(patch.envelope1.attack);
    const d1 = envDecayReleaseTime(patch.envelope1.decay);
    const s1 = envSustainLevel(patch.envelope1.sustain);
    const r1 = envDecayReleaseTime(patch.envelope1.release);

    const noteGain = ctx.createGain();
    noteGain.gain.setValueAtTime(0, when);
    noteGain.gain.linearRampToValueAtTime(vel, when + a1);
    noteGain.gain.linearRampToValueAtTime(vel * s1, when + a1 + d1);
    noteGain.gain.setValueAtTime(vel * s1, when + durSec);
    noteGain.gain.linearRampToValueAtTime(0, when + durSec + r1);
    noteGain.connect(dest);

    const audioPatch = patch as unknown as AudioPatch;
    const unisonCount = Math.max(1, patch.unisonNum);
    const voiceDur = durSec + r1 + 0.1;
    for (let u = 0; u < unisonCount; u++) {
      const detuneOffset = unisonCount === 1 ? 0 : ((u / (unisonCount - 1)) - 0.5) * patch.unisonDetune;
      if (patch.mode === 'fm') {
        createFMVoice(ctx, freq, detuneOffset, audioPatch, noteGain, when, voiceDur, null, undefined);
      } else {
        createSubVoice(ctx, freq, detuneOffset, audioPatch, noteGain, when, voiceDur, null, undefined);
      }
    }
  }

  private scheduleNote(
    note: { trackIdx: number; midi: number; isKit: boolean; drumType: DrumType; samplePath: string | null; startSec: number; durSec: number; vel: number },
    when: number
  ) {
    const ctx = this.ctx!;
    const dest = this.trackGains[note.trackIdx];
    if (!dest) return;

    const vol = note.vel * note.vel;

    const buffer = note.samplePath ? this.sampleBuffers.get(note.samplePath) : undefined;
    if (buffer) {
      this.scheduleSample(ctx, dest, vol, when, buffer);
    } else if (note.isKit) {
      switch (note.drumType) {
        case 'kick': this.scheduleKick(ctx, dest, vol, when); break;
        case 'snare': this.scheduleSnare(ctx, dest, vol, when); break;
        case 'hihat': this.scheduleHihat(ctx, dest, vol, when); break;
        case 'clap': this.scheduleClap(ctx, dest, vol, when); break;
        case 'tom': this.scheduleTom(ctx, dest, vol, when, note.midi); break;
        case 'cymbal': this.scheduleCymbal(ctx, dest, vol, when); break;
        case 'perc': this.schedulePerc(ctx, dest, vol, when, note.midi); break;
      }
    } else {
      const patch = this.trackPatches[note.trackIdx];
      if (patch) {
        this.schedulePatchVoice(ctx, dest, patch, note.midi, vol, when, note.durSec);
        return;
      }

      const noteGain = ctx.createGain();
      noteGain.gain.setValueAtTime(0, when);
      noteGain.gain.linearRampToValueAtTime(vol, when + 0.002);
      const release = Math.min(0.05, note.durSec * 0.3);
      noteGain.gain.setValueAtTime(vol, when + note.durSec - release);
      noteGain.gain.linearRampToValueAtTime(0, when + note.durSec);
      noteGain.connect(dest);

      const osc = ctx.createOscillator();
      osc.type = WAVEFORMS[note.trackIdx % WAVEFORMS.length];
      osc.frequency.value = midiToFreq(note.midi);
      osc.connect(noteGain);
      osc.start(when);
      osc.stop(when + note.durSec + 0.01);
      this.scheduled.push({ source: osc, gain: noteGain });
    }
  }

  private startAnimLoop() {
    this.stopAnimLoop();
    const tick = () => {
      if (!this._isPlaying) return;
      const current = this.currentTick;
      this.opts.onTick?.(current);
      if (current * this.secPerTick >= this.totalDurationSec) {
        this.stop();
        this.opts.onEnd?.();
        return;
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopAnimLoop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}
