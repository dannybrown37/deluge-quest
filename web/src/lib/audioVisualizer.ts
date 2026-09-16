const GOLD = '#D4A847';
const TEAL = '#5AABAC';
const BAR_COUNT = 64;
const IDLE_WAVE_SPEED = 0.0008;
const IDLE_WAVE_AMPLITUDE = 0.15;

const CIRCUIT_COLS = 16;
const CIRCUIT_ROWS = 8;
const NODE_RADIUS = 3;
const CONNECTION_DECAY = 0.92;

const STORAGE_KEY = 'deluge-viz-paused';

export type VisualizerMode = 'bars' | 'circuit';

export class AudioVisualizer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private analyser: AnalyserNode | null = null;
  private freqData: Uint8Array<ArrayBuffer> | null = null;
  private raf = 0;
  private running = false;
  private idlePhase = 0;
  private lastTime = 0;
  private lastSignal = false;
  private dpr = 1;
  private _mode: VisualizerMode = 'bars';
  private _paused = false;
  private _visible = true;
  private observer: IntersectionObserver | null = null;
  private motionQuery: MediaQueryList | null = null;
  private motionHandler: ((e: MediaQueryListEvent) => void) | null = null;

  private nodeEnergy: Float32Array = new Float32Array(CIRCUIT_COLS * CIRCUIT_ROWS);
  private connectionStrength: Float32Array = new Float32Array(CIRCUIT_COLS * CIRCUIT_ROWS);

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    try { this._paused = localStorage.getItem(STORAGE_KEY) === '1'; } catch { /* localStorage may be unavailable */ }

    this.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (this.motionQuery.matches) this._paused = true;
    this.motionHandler = (e: MediaQueryListEvent) => {
      if (e.matches) this.paused = true;
    };
    this.motionQuery.addEventListener('change', this.motionHandler);

    this.observer = new IntersectionObserver(([entry]) => {
      this._visible = entry.isIntersecting;
      if (this._visible && this.running && !this._paused) this.tick();
    });
    this.observer.observe(canvas);
  }

  get mode(): VisualizerMode {
    return this._mode;
  }

  set mode(m: VisualizerMode) {
    this._mode = m;
    this.nodeEnergy.fill(0);
    this.connectionStrength.fill(0);
  }

  get connected(): boolean {
    return this.analyser !== null;
  }

  get paused(): boolean {
    return this._paused;
  }

  set paused(p: boolean) {
    this._paused = p;
    try { localStorage.setItem(STORAGE_KEY, p ? '1' : '0'); } catch { /* localStorage may be unavailable */ }
    if (p) {
      cancelAnimationFrame(this.raf);
      this.drawStatic();
    } else if (this.running && this._visible) {
      this.lastTime = performance.now();
      this.tick();
    }
  }

  connect(analyser: AnalyserNode) {
    this.analyser = analyser;
    this.freqData = new Uint8Array(analyser.frequencyBinCount);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    if (this._paused) {
      this.drawStatic();
    } else {
      this.tick();
    }
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * this.dpr;
    this.canvas.height = rect.height * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  private tick = () => {
    if (!this.running || this._paused || !this._visible) return;
    try {
      this.draw();
    } catch (err) {
      console.error('[visualizer] draw failed', err);
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private draw() {
    const now = performance.now();
    const dt = now - this.lastTime;
    this.lastTime = now;

    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;

    if (w === 0 || h === 0) return;

    this.ctx.clearRect(0, 0, w, h);

    let hasSignal = false;
    if (this.analyser && this.freqData) {
      this.analyser.getByteFrequencyData(this.freqData);
      let sum = 0;
      for (let i = 0; i < this.freqData.length; i++) sum += this.freqData[i];
      hasSignal = sum > 200;
    }

    if (hasSignal !== this.lastSignal) {
      this.lastSignal = hasSignal;

    }

    if (this._mode === 'bars') {
      if (hasSignal) {
        this.drawBars(w, h);
      } else {
        this.idlePhase += dt * IDLE_WAVE_SPEED;
        this.drawIdleWave(w, h);
      }
    } else {
      if (hasSignal) {
        this.drawCircuit(w, h, dt);
      } else {
        this.idlePhase += dt * IDLE_WAVE_SPEED;
        this.drawCircuitIdle(w, h, dt);
      }
    }
  }

  private drawBars(w: number, h: number) {
    if (!this.freqData) return;
    const binCount = this.freqData.length;
    const barW = w / BAR_COUNT;
    const gap = Math.max(1, barW * 0.15);

    for (let i = 0; i < BAR_COUNT; i++) {
      const freqIndex = Math.floor((i / BAR_COUNT) * binCount * 0.75);
      const value = this.freqData[freqIndex] / 255;
      const barH = value * h * 0.9;

      const t = i / BAR_COUNT;
      const color = t < 0.5 ? GOLD : TEAL;
      const alpha = 0.4 + value * 0.6;

      this.ctx.fillStyle = this.hexWithAlpha(color, alpha);

      const x = i * barW + gap / 2;
      this.ctx.fillRect(x, h - barH, barW - gap, barH);

      if (value > 0.6) {
        this.ctx.fillStyle = this.hexWithAlpha(color, value * 0.3);
        this.ctx.fillRect(x, h - barH - 2, barW - gap, 2);
      }
    }
  }

  private drawIdleWave(w: number, h: number) {
    const midY = h * 0.5;
    const amp = h * IDLE_WAVE_AMPLITUDE;
    const ctx = this.ctx;

    for (let layer = 0; layer < 3; layer++) {
      const color = layer < 2 ? GOLD : TEAL;
      const alpha = 0.08 + layer * 0.04;
      const speed = 1 + layer * 0.5;
      const freq = 2 + layer * 0.7;

      ctx.beginPath();
      ctx.moveTo(0, h);

      for (let x = 0; x <= w; x += 2) {
        const t = x / w;
        const y = midY + Math.sin(t * Math.PI * freq + this.idlePhase * speed) * amp
                       + Math.sin(t * Math.PI * (freq * 1.7) + this.idlePhase * speed * 0.6) * amp * 0.3;
        ctx.lineTo(x, y);
      }

      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fillStyle = this.hexWithAlpha(color, alpha);
      ctx.fill();
    }
  }

  private drawCircuit(w: number, h: number, _dt: number) {
    if (!this.freqData) return;
    const ctx = this.ctx;
    const binCount = this.freqData.length;

    const padX = Math.max(20, w * 0.04);
    const padY = Math.max(16, h * 0.12);
    const spacingX = (w - padX * 2) / (CIRCUIT_COLS - 1);
    const spacingY = (h - padY * 2) / (CIRCUIT_ROWS - 1);
    const centerCol = (CIRCUIT_COLS - 1) / 2;
    const centerRow = (CIRCUIT_ROWS - 1) / 2;
    const maxDist = Math.sqrt(centerCol * centerCol + centerRow * centerRow);

    for (let row = 0; row < CIRCUIT_ROWS; row++) {
      for (let col = 0; col < CIRCUIT_COLS; col++) {
        const idx = row * CIRCUIT_COLS + col;
        const dx = col - centerCol;
        const dy = row - centerRow;
        const dist = Math.sqrt(dx * dx + dy * dy) / maxDist;

        const freqBin = Math.floor(dist * binCount * 0.6);
        const rawValue = this.freqData[Math.min(freqBin, binCount - 1)] / 255;

        const proximity = 1 - dist * 0.3;
        const target = rawValue * rawValue * proximity;
        this.nodeEnergy[idx] += (target - this.nodeEnergy[idx]) * 0.15;
        this.connectionStrength[idx] = this.connectionStrength[idx] * CONNECTION_DECAY +
          this.nodeEnergy[idx] * (1 - CONNECTION_DECAY);
      }
    }

    ctx.lineWidth = 1;
    for (let row = 0; row < CIRCUIT_ROWS; row++) {
      for (let col = 0; col < CIRCUIT_COLS; col++) {
        const idx = row * CIRCUIT_COLS + col;
        const energy = this.connectionStrength[idx];
        if (energy < 0.05) continue;

        const x = padX + col * spacingX;
        const y = padY + row * spacingY;
        const dist = Math.sqrt((col - centerCol) ** 2 + (row - centerRow) ** 2) / maxDist;
        const color = dist < 0.5 ? GOLD : TEAL;

        if (col < CIRCUIT_COLS - 1) {
          const rightEnergy = this.connectionStrength[idx + 1];
          const linkStrength = Math.min(energy, rightEnergy);
          if (linkStrength > 0.05) {
            ctx.strokeStyle = this.hexWithAlpha(color, linkStrength * 0.5);
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(padX + (col + 1) * spacingX, y);
            ctx.stroke();
          }
        }

        if (row < CIRCUIT_ROWS - 1) {
          const belowEnergy = this.connectionStrength[idx + CIRCUIT_COLS];
          const linkStrength = Math.min(energy, belowEnergy);
          if (linkStrength > 0.05) {
            ctx.strokeStyle = this.hexWithAlpha(color, linkStrength * 0.4);
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x, padY + (row + 1) * spacingY);
            ctx.stroke();
          }
        }
      }
    }

    for (let row = 0; row < CIRCUIT_ROWS; row++) {
      for (let col = 0; col < CIRCUIT_COLS; col++) {
        const idx = row * CIRCUIT_COLS + col;
        const energy = this.nodeEnergy[idx];
        const x = padX + col * spacingX;
        const y = padY + row * spacingY;
        const dist = Math.sqrt((col - centerCol) ** 2 + (row - centerRow) ** 2) / maxDist;
        const color = dist < 0.5 ? GOLD : TEAL;

        const baseRadius = NODE_RADIUS + energy * 4;

        if (energy > 0.15) {
          const glowRadius = baseRadius + energy * 8;
          const gradient = ctx.createRadialGradient(x, y, 0, x, y, glowRadius);
          gradient.addColorStop(0, this.hexWithAlpha(color, energy * 0.4));
          gradient.addColorStop(1, this.hexWithAlpha(color, 0));
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(x, y, glowRadius, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.fillStyle = this.hexWithAlpha(color, 0.2 + energy * 0.8);
        ctx.beginPath();
        ctx.arc(x, y, baseRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawCircuitIdle(w: number, h: number, _dt: number) {
    const ctx = this.ctx;
    const padX = Math.max(20, w * 0.04);
    const padY = Math.max(16, h * 0.12);
    const spacingX = (w - padX * 2) / (CIRCUIT_COLS - 1);
    const spacingY = (h - padY * 2) / (CIRCUIT_ROWS - 1);
    const centerCol = (CIRCUIT_COLS - 1) / 2;
    const centerRow = (CIRCUIT_ROWS - 1) / 2;
    const maxDist = Math.sqrt(centerCol * centerCol + centerRow * centerRow);

    for (let row = 0; row < CIRCUIT_ROWS; row++) {
      for (let col = 0; col < CIRCUIT_COLS; col++) {
        const x = padX + col * spacingX;
        const y = padY + row * spacingY;
        const dist = Math.sqrt((col - centerCol) ** 2 + (row - centerRow) ** 2) / maxDist;

        const wave = Math.sin(this.idlePhase * 1.5 - dist * 4) * 0.5 + 0.5;
        const dimAlpha = 0.06 + wave * 0.08;
        const color = dist < 0.5 ? GOLD : TEAL;

        ctx.fillStyle = this.hexWithAlpha(color, dimAlpha);
        ctx.beginPath();
        ctx.arc(x, y, NODE_RADIUS, 0, Math.PI * 2);
        ctx.fill();

        if (col < CIRCUIT_COLS - 1 && wave > 0.6) {
          const rx = padX + (col + 1) * spacingX;
          ctx.strokeStyle = this.hexWithAlpha(color, 0.04);
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(rx, y);
          ctx.stroke();
        }
      }
    }
  }

  private hexWithAlpha(hex: string, alpha: number): string {
    const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255).toString(16).padStart(2, '0');
    return hex + a;
  }

  private drawStatic() {
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    if (w === 0 || h === 0) return;
    this.ctx.clearRect(0, 0, w, h);

    if (this._mode === 'bars') {
      const midY = h * 0.5;
      const amp = h * IDLE_WAVE_AMPLITUDE;
      for (let layer = 0; layer < 3; layer++) {
        const color = layer < 2 ? GOLD : TEAL;
        const alpha = 0.08 + layer * 0.04;
        const freq = 2 + layer * 0.7;
        this.ctx.beginPath();
        this.ctx.moveTo(0, h);
        for (let x = 0; x <= w; x += 2) {
          const t = x / w;
          const y = midY + Math.sin(t * Math.PI * freq) * amp
                         + Math.sin(t * Math.PI * (freq * 1.7)) * amp * 0.3;
          this.ctx.lineTo(x, y);
        }
        this.ctx.lineTo(w, h);
        this.ctx.closePath();
        this.ctx.fillStyle = this.hexWithAlpha(color, alpha);
        this.ctx.fill();
      }
    } else {
      const padX = Math.max(20, w * 0.04);
      const padY = Math.max(16, h * 0.12);
      const spacingX = (w - padX * 2) / (CIRCUIT_COLS - 1);
      const spacingY = (h - padY * 2) / (CIRCUIT_ROWS - 1);
      const centerCol = (CIRCUIT_COLS - 1) / 2;
      const centerRow = (CIRCUIT_ROWS - 1) / 2;
      const maxDist = Math.sqrt(centerCol * centerCol + centerRow * centerRow);
      for (let row = 0; row < CIRCUIT_ROWS; row++) {
        for (let col = 0; col < CIRCUIT_COLS; col++) {
          const x = padX + col * spacingX;
          const y = padY + row * spacingY;
          const dist = Math.sqrt((col - centerCol) ** 2 + (row - centerRow) ** 2) / maxDist;
          const color = dist < 0.5 ? GOLD : TEAL;
          this.ctx.fillStyle = this.hexWithAlpha(color, 0.1);
          this.ctx.beginPath();
          this.ctx.arc(x, y, NODE_RADIUS, 0, Math.PI * 2);
          this.ctx.fill();
        }
      }
    }
  }

  destroy() {
    this.stop();
    this.observer?.disconnect();
    this.observer = null;
    if (this.motionQuery && this.motionHandler) {
      this.motionQuery.removeEventListener('change', this.motionHandler);
    }
    this.motionQuery = null;
    this.motionHandler = null;
    this.analyser = null;
    this.freqData = null;
  }
}
