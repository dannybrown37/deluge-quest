export interface SequencerEngineOptions {
  bpm?: number;
  onStep?: (step: number) => void;
  onStop?: () => void;
}

export const NUM_STEPS = 16;
const SCHEDULE_INTERVAL_MS = 100;
const LOOKAHEAD_SEC = 0.15;
const DEFAULT_BPM = 120;
const MASTER_GAIN_VALUE = 0.8;

function emptyRow(): boolean[] {
  return new Array(NUM_STEPS).fill(false);
}

export class SequencerEngine {
  private _pattern: boolean[][] = [];
  private _bpm: number;
  private _isPlaying = false;
  private _currentStep = 0;

  private onStepCb?: (step: number) => void;
  private onStopCb?: () => void;

  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private rowGains: GainNode[] = [];
  private sampleBuffers: (AudioBuffer | null)[] = [];

  private scheduleTimer: number | null = null;
  private rafId: number | null = null;
  private startCtxTime = 0;
  private nextStepTime = 0;
  private nextStepIndex = 0;

  constructor(opts: SequencerEngineOptions = {}) {
    this._bpm = opts.bpm ?? DEFAULT_BPM;
    this.onStepCb = opts.onStep;
    this.onStopCb = opts.onStop;
  }

  get pattern(): boolean[][] { return this._pattern; }
  get bpm(): number { return this._bpm; }
  get isPlaying(): boolean { return this._isPlaying; }
  get currentStep(): number { return this._currentStep; }

  toggleStep(row: number, step: number): void {
    const r = this._pattern[row];
    if (!r || step < 0 || step >= NUM_STEPS) return;
    r[step] = !r[step];
  }

  clearRow(row: number): void {
    if (!this._pattern[row]) return;
    this._pattern[row] = emptyRow();
  }

  clearAll(): void {
    this._pattern = this._pattern.map(() => emptyRow());
  }

  addRow(): void {
    this._pattern.push(emptyRow());
    this.sampleBuffers.push(null);
  }

  removeRow(idx: number): void {
    if (idx < 0 || idx >= this._pattern.length) return;
    this._pattern.splice(idx, 1);
    this.sampleBuffers.splice(idx, 1);
    const gain = this.rowGains.splice(idx, 1)[0];
    if (gain) {
      try { gain.disconnect(); } catch { /* already disconnected */ }
    }
  }

  setPattern(pattern: boolean[][]): void {
    this._pattern = pattern.map((row) => [...row]);
    const buffers = new Array<AudioBuffer | null>(this._pattern.length).fill(null);
    for (let i = 0; i < Math.min(buffers.length, this.sampleBuffers.length); i++) {
      buffers[i] = this.sampleBuffers[i];
    }
    this.sampleBuffers = buffers;
  }

  getPattern(): boolean[][] {
    return this._pattern.map((row) => [...row]);
  }

  async loadSample(rowIndex: number, handle: FileSystemFileHandle): Promise<void> {
    const ctx = this.ensureContext();
    try {
      const file = await handle.getFile();
      const arrayBuf = await file.arrayBuffer();
      const buffer = await ctx.decodeAudioData(arrayBuf);
      this.sampleBuffers[rowIndex] = buffer;
    } catch {
      this.sampleBuffers[rowIndex] = null;
    }
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
    }
    return this.ctx;
  }

  private stepDurationSec(): number {
    return (60 / this._bpm) / 4;
  }

  play(): void {
    if (this._isPlaying) return;
    const ctx = this.ensureContext();

    const master = ctx.createGain();
    master.gain.value = MASTER_GAIN_VALUE;
    master.connect(ctx.destination);
    this.masterGain = master;

    this.rowGains = this._pattern.map(() => {
      const g = ctx.createGain();
      g.gain.value = 1;
      g.connect(master);
      return g;
    });

    this._isPlaying = true;
    this._currentStep = 0;
    this.nextStepIndex = 0;
    this.startCtxTime = ctx.currentTime;
    this.nextStepTime = ctx.currentTime;

    this.startScheduler();
    this.startAnimLoop();
  }

  stop(): void {
    this.stopScheduler();
    this.stopAnimLoop();
    this._isPlaying = false;
    this._currentStep = 0;
    if (this.ctx) {
      try { this.ctx.close(); } catch { /* already closed */ }
    }
    this.ctx = null;
    this.masterGain = null;
    this.rowGains = [];
    this.onStopCb?.();
  }

  setBpm(bpm: number): void {
    this._bpm = bpm;
  }

  private startScheduler(): void {
    this.stopScheduler();
    this.scheduleTimer = window.setInterval(() => this.scheduleChunk(), SCHEDULE_INTERVAL_MS);
    this.scheduleChunk();
  }

  private stopScheduler(): void {
    if (this.scheduleTimer !== null) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
  }

  private scheduleChunk(): void {
    if (!this.ctx || !this._isPlaying) return;
    const ctx = this.ctx;
    const horizon = ctx.currentTime + LOOKAHEAD_SEC;
    while (this.nextStepTime < horizon) {
      this.scheduleStep(this.nextStepIndex, this.nextStepTime);
      this.nextStepTime += this.stepDurationSec();
      this.nextStepIndex = (this.nextStepIndex + 1) % NUM_STEPS;
    }
  }

  private scheduleStep(step: number, when: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (let row = 0; row < this._pattern.length; row++) {
      if (!this._pattern[row][step]) continue;
      const buffer = this.sampleBuffers[row];
      if (!buffer) continue;
      const dest = this.rowGains[row];
      if (!dest) continue;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(dest);
      src.start(when);
    }
  }

  private startAnimLoop(): void {
    this.stopAnimLoop();
    const tick = () => {
      if (!this._isPlaying || !this.ctx) return;
      const elapsed = this.ctx.currentTime - this.startCtxTime;
      const step = Math.floor(elapsed / this.stepDurationSec()) % NUM_STEPS;
      if (step !== this._currentStep) {
        this._currentStep = step;
        this.onStepCb?.(step);
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopAnimLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  dispose(): void {
    this.stop();
    this.sampleBuffers = [];
    this._pattern = [];
  }
}
