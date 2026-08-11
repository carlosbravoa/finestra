import { h } from '../../core/dom';

/**
 * A small canvas time-series chart: one or two series, a live headline value
 * per series, and a crosshair with a tooltip.
 *
 * It measures itself with a ResizeObserver rather than the window's `onResize`,
 * which also covers the case where the element starts at zero size (a minimized
 * window) and only later gets a real one.
 */

/** Samples kept per series: four minutes at the two-second poll. */
const DEFAULT_CAPACITY = 120;

interface Sample {
  /** Client clock at the time of the sample. */
  t: number;
  /** One value per series. NaN marks a gap in the recording. */
  v: number[];
}

export interface TimeChartOptions {
  title: string;
  /** One or two series. A second series gets the second palette colour. */
  series: string[];
  /** Formats a value for the headline, axis and tooltip. */
  format(value: number): string;
  /** Fixed upper bound. Omitted means scale to the tallest visible sample. */
  max?: number;
  /** Floor for the auto-scaled bound, so an idle chart is not all noise. */
  minScale?: number;
  capacity?: number;
}

export class TimeChart {
  readonly element: HTMLElement;

  private readonly canvas = h('canvas', { class: 'sysman-chart-canvas' });
  private readonly tip = h('div', { class: 'sysman-chart-tip' });
  private readonly plot: HTMLElement;
  private readonly values: HTMLElement[] = [];
  private readonly capacity: number;

  private samples: Sample[] = [];
  private hover: number | null = null;
  private width = 0;
  private height = 0;
  private frame = 0;
  private observer: ResizeObserver | null = null;

  constructor(private readonly options: TimeChartOptions) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;

    const legend = h('div', { class: 'sysman-chart-legend' });
    for (let i = 0; i < options.series.length; i++) {
      const value = h('span', { class: 'sysman-chart-value', text: '—' });
      this.values.push(value);
      legend.appendChild(
        h(
          'span',
          { class: 'sysman-chart-key' },
          // A legend is present whenever there are two series; identity is
          // never carried by the line colour alone.
          options.series.length > 1
            ? h('span', { class: `sysman-chart-dot slot-${i}` })
            : null,
          options.series.length > 1
            ? h('span', { class: 'sysman-chart-keylabel', text: options.series[i] })
            : null,
          value,
        ),
      );
    }

    this.tip.hidden = true;
    this.plot = h('div', { class: 'sysman-chart-plot' }, this.canvas, this.tip);

    this.element = h(
      'div',
      { class: 'sysman-chart' },
      h(
        'div',
        { class: 'sysman-chart-head' },
        h('span', { class: 'sysman-chart-title', text: options.title }),
        legend,
      ),
      this.plot,
    );

    this.canvas.addEventListener('mousemove', (ev) => this.onMove(ev));
    this.canvas.addEventListener('mouseleave', () => {
      this.hover = null;
      this.tip.hidden = true;
      this.schedule();
    });

    this.observer = new ResizeObserver(() => this.measure());
    this.observer.observe(this.plot);
  }

  /** Append one reading per series. */
  push(values: number[]): void {
    this.samples.push({ t: Date.now(), v: values });
    if (this.samples.length > this.capacity) this.samples.shift();
    for (let i = 0; i < this.values.length; i++) {
      const v = values[i];
      this.values[i].textContent = Number.isFinite(v) ? this.options.format(v) : '—';
    }
    this.schedule();
  }

  /** Set the fixed upper bound, e.g. once the machine's total RAM is known. */
  setMax(max: number): void {
    this.options.max = max;
    this.schedule();
  }

  /**
   * Record a discontinuity. Polling stops while the window is hidden, and
   * joining across that gap would draw a line through data we never sampled.
   */
  break(): void {
    const last = this.samples[this.samples.length - 1];
    if (!last || last.v.every((v) => Number.isNaN(v))) return;
    this.samples.push({ t: Date.now(), v: this.options.series.map(() => NaN) });
    for (const el of this.values) el.textContent = '—';
  }

  clear(): void {
    this.samples = [];
    for (const el of this.values) el.textContent = '—';
    this.schedule();
  }

  /** Re-measure after the element may have changed size. */
  measure(): void {
    const rect = this.plot.getBoundingClientRect();
    // A minimized or hidden window measures as zero; the observer fires again
    // with a real size when it comes back.
    if (rect.width < 1 || rect.height < 1) return;
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.schedule();
  }

  destroy(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private onMove(ev: MouseEvent): void {
    if (this.samples.length === 0 || this.width === 0) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const index = Math.round((x / this.width) * (this.capacity - 1));
    const offset = index - (this.capacity - this.samples.length);
    this.hover = offset >= 0 && offset < this.samples.length ? offset : null;
    this.schedule();
  }

  private scale(): number {
    if (this.options.max !== undefined) return this.options.max;
    let peak = this.options.minScale ?? 1;
    for (const s of this.samples) {
      for (const v of s.v) if (Number.isFinite(v) && v > peak) peak = v;
    }
    return niceCeil(peak);
  }

  private draw(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx || this.width === 0) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    const style = getComputedStyle(this.element);
    const colors = [
      style.getPropertyValue('--chart-1').trim() || '#5288f0',
      style.getPropertyValue('--chart-2').trim() || '#bd8530',
    ];
    const grid = style.getPropertyValue('--border').trim() || '#2a3240';
    const faint = style.getPropertyValue('--text-faint').trim() || '#6b7686';

    const max = this.scale();
    const pad = 10;
    const plotTop = pad;
    const plotHeight = Math.max(1, this.height - pad * 2);
    const stepX = this.width / (this.capacity - 1);

    // Grid, kept recessive: quarters of the scale, no labels but the top one.
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    for (let i = 0; i <= 4; i++) {
      const y = Math.round(plotTop + (plotHeight * i) / 4) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(this.width, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    const yOf = (v: number): number =>
      plotTop + plotHeight - Math.min(1, Math.max(0, v / max)) * plotHeight;
    const xOf = (index: number): number =>
      (index + (this.capacity - this.samples.length)) * stepX;

    for (let s = this.options.series.length - 1; s >= 0; s--) {
      const color = colors[s] || colors[0];

      // A single series gets a soft fill; two would only muddy each other.
      if (this.options.series.length === 1) {
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.14;
        ctx.beginPath();
        let open = false;
        for (let i = 0; i < this.samples.length; i++) {
          const v = this.samples[i].v[s];
          if (!Number.isFinite(v)) {
            if (open) {
              ctx.lineTo(xOf(i - 1), plotTop + plotHeight);
              ctx.closePath();
              open = false;
            }
            continue;
          }
          if (!open) {
            ctx.moveTo(xOf(i), plotTop + plotHeight);
            open = true;
          }
          ctx.lineTo(xOf(i), yOf(v));
        }
        if (open) {
          ctx.lineTo(xOf(this.samples.length - 1), plotTop + plotHeight);
          ctx.closePath();
        }
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      let drawing = false;
      for (let i = 0; i < this.samples.length; i++) {
        const v = this.samples[i].v[s];
        if (!Number.isFinite(v)) {
          drawing = false;
          continue;
        }
        const x = xOf(i);
        const y = yOf(v);
        if (drawing) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        drawing = true;
      }
      ctx.stroke();
    }

    // Scale label, so the shape of the line means something.
    ctx.fillStyle = faint;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(this.options.format(max), 2, 1);

    // How much time the line covers. The window fills from the right over
    // several minutes, and without this a half-empty chart reads as broken
    // rather than as one that has not been watching for long.
    if (this.samples.length > 1) {
      const seconds = (this.samples[this.samples.length - 1].t - this.samples[0].t) / 1000;
      ctx.textBaseline = 'bottom';
      ctx.fillText(`last ${shortDuration(seconds)}`, 2, this.height - 1);
    }

    if (this.hover !== null && this.hover < this.samples.length) {
      const sample = this.samples[this.hover];
      const x = xOf(this.hover);

      ctx.strokeStyle = faint;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, plotTop);
      ctx.lineTo(Math.round(x) + 0.5, plotTop + plotHeight);
      ctx.stroke();

      for (let s = 0; s < this.options.series.length; s++) {
        const v = sample.v[s];
        if (!Number.isFinite(v)) continue;
        // A 2px surface ring keeps the marker legible over the line.
        ctx.beginPath();
        ctx.arc(x, yOf(v), 4, 0, Math.PI * 2);
        ctx.fillStyle = colors[s] || colors[0];
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = style.getPropertyValue('--surface-2').trim() || '#171c25';
        ctx.stroke();
      }

      this.showTip(sample, x);
    } else {
      this.tip.hidden = true;
    }
  }

  private showTip(sample: Sample, x: number): void {
    const age = Math.max(0, Math.round((Date.now() - sample.t) / 1000));
    const lines: Node[] = [
      h('div', { class: 'sysman-tip-time', text: age === 0 ? 'now' : `${age}s ago` }),
    ];
    for (let s = 0; s < this.options.series.length; s++) {
      const v = sample.v[s];
      lines.push(
        h(
          'div',
          { class: 'sysman-tip-row' },
          h('span', { class: `sysman-chart-dot slot-${s}` }),
          h('span', { text: this.options.series[s] }),
          h('span', {
            class: 'sysman-tip-value',
            text: Number.isFinite(v) ? this.options.format(v) : 'no data',
          }),
        ),
      );
    }
    this.tip.replaceChildren(...lines);
    this.tip.hidden = false;
    // Keep the tooltip inside the plot rather than letting it clip.
    const half = this.tip.offsetWidth / 2;
    const left = Math.min(Math.max(x, half + 2), this.width - half - 2);
    this.tip.style.left = `${left}px`;
  }
}

function shortDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  return `${Math.round(seconds / 60)} min`;
}

/** Rounds up to 1, 2 or 5 times a power of ten, so the scale stays stable. */
function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const pow = 10 ** exp;
  const norm = value / pow;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * pow;
}
