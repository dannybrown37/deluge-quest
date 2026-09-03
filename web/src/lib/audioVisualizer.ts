const GOLD = '#D4A847';
const TEAL = '#5AABAC';
const BAR_COUNT = 64;
const IDLE_WAVE_SPEED = 0.0008;
const IDLE_WAVE_AMPLITUDE = 0.15;

export class AudioVisualizer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private analyser: AnalyserNode | null = null;
  private freqData: Uint8Array | null = null;
  private raf = 0;
  private running = false;
  private idlePhase = 0;
  private lastTime = 0;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
  }

  connect(analyser: AnalyserNode) {
    this.analyser = analyser;
    this.freqData = new Uint8Array(analyser.frequencyBinCount);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.tick();
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
    if (!this.running) return;
    const now = performance.now();
    const dt = now - this.lastTime;
    this.lastTime = now;

    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;

    if (w === 0 || h === 0) {
      this.raf = requestAnimationFrame(this.tick);
      return;
    }

    this.ctx.clearRect(0, 0, w, h);

    let hasSignal = false;
    if (this.analyser && this.freqData) {
      this.analyser.getByteFrequencyData(this.freqData);
      let sum = 0;
      for (let i = 0; i < this.freqData.length; i++) sum += this.freqData[i];
      hasSignal = sum > 200;
    }

    if (hasSignal) {
      this.drawBars(w, h);
    } else {
      this.idlePhase += dt * IDLE_WAVE_SPEED;
      this.drawIdleWave(w, h);
    }

    this.raf = requestAnimationFrame(this.tick);
  };

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

  private hexWithAlpha(hex: string, alpha: number): string {
    const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255).toString(16).padStart(2, '0');
    return hex + a;
  }

  destroy() {
    this.stop();
    this.analyser = null;
    this.freqData = null;
  }
}
