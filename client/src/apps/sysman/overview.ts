import { h } from '../../core/dom';
import { TimeChart } from './chart';
import {
  describeError,
  formatBytes,
  formatDuration,
  formatPercent,
  formatRate,
  meter,
  placeholder,
  type Section,
  type SectionContext,
  type SectionDef,
} from './common';

const POLL_MS = 2000;
/** Filesystems and their sizes change far more slowly than the counters. */
const MOUNTS_EVERY = 15;
/** A pause longer than this leaves a visible break rather than a fake line. */
const GAP_MS = POLL_MS * 3;

interface NetTotals {
  name: string;
  rx: number;
  tx: number;
}

interface Stats {
  cpu: number;
  cores: number;
  loadAvg: number[];
  memTotal: number;
  memUsed: number;
  uptime: number;
  time: number;
  net: NetTotals[];
  disk: { read: number; written: number };
  temps: Array<{ label: string; c: number }>;
}

interface MountUsage {
  mount: string;
  device: string;
  fstype: string;
  total: number;
  used: number;
  avail: number;
}

function createOverview(ctx: SectionContext): Section {
  const { desktop } = ctx;

  let timer: number | null = null;
  let running = false;
  let previous: Stats | null = null;
  let ticks = 0;
  let memTotal = 0;

  const cpuChart = new TimeChart({
    title: 'CPU',
    series: ['CPU'],
    format: formatPercent,
    max: 1,
  });
  const memChart = new TimeChart({
    title: 'Memory',
    series: ['Used'],
    format: (v) => formatBytes(v),
    max: 1,
  });
  const loadChart = new TimeChart({
    title: 'Load average (1 min)',
    series: ['Load'],
    format: (v) => v.toFixed(2),
    minScale: 1,
  });
  const netChart = new TimeChart({
    title: 'Network',
    series: ['Received', 'Sent'],
    format: formatRate,
    minScale: 64 * 1024,
  });
  const diskChart = new TimeChart({
    title: 'Disk I/O',
    series: ['Read', 'Written'],
    format: formatRate,
    minScale: 1024 * 1024,
  });
  const charts = [cpuChart, memChart, loadChart, netChart, diskChart];

  const summary = h('div', { class: 'sysman-summary' });
  const banner = h('div', { class: 'sysman-banner' });
  banner.hidden = true;
  const mountsBox = h('div', { class: 'sysman-cards' });
  const tempsBox = h('div', { class: 'sysman-chips' });

  const mountsPanel = h(
    'section',
    { class: 'sysman-panel' },
    h('h2', { class: 'sysman-panel-title', text: 'Filesystems' }),
    mountsBox,
  );
  const tempsPanel = h(
    'section',
    { class: 'sysman-panel' },
    h('h2', { class: 'sysman-panel-title', text: 'Temperatures' }),
    tempsBox,
  );
  tempsPanel.hidden = true;

  const element = h(
    'div',
    { class: 'sysman-scroll' },
    banner,
    summary,
    h('div', { class: 'sysman-charts' }, ...charts.map((c) => c.element)),
    mountsPanel,
    tempsPanel,
  );

  function renderSummary(stats: Stats): void {
    const host = desktop.host;
    const fields: Array<[string, string]> = [
      ['Host', host?.hostname ?? '—'],
      ['Uptime', formatDuration(stats.uptime)],
      ['CPU', `${formatPercent(stats.cpu)} of ${stats.cores} cores`],
      ['Memory', `${formatBytes(stats.memUsed)} of ${formatBytes(stats.memTotal)}`],
      [
        'Load',
        stats.loadAvg.map((n) => n.toFixed(2)).join('  ·  '),
      ],
    ];
    summary.replaceChildren(
      ...fields.map(([label, value]) =>
        h(
          'div',
          { class: 'sysman-stat' },
          h('div', { class: 'sysman-stat-label', text: label }),
          h('div', { class: 'sysman-stat-value', text: value }),
        ),
      ),
    );
  }

  function renderTemps(temps: Stats['temps']): void {
    tempsPanel.hidden = temps.length === 0;
    tempsBox.replaceChildren(
      ...temps.map((t) =>
        h(
          'div',
          { class: `sysman-chip${t.c >= 85 ? ' is-hot' : ''}` },
          h('span', { class: 'sysman-chip-label', text: t.label }),
          h('span', { class: 'sysman-chip-value', text: `${t.c.toFixed(1)} °C` }),
        ),
      ),
    );
  }

  function renderMounts(mounts: MountUsage[]): void {
    if (mounts.length === 0) {
      mountsBox.replaceChildren(placeholder('No device-backed filesystems found.'));
      return;
    }
    mountsBox.replaceChildren(
      ...mounts.map((m) => {
        const fraction = m.total > 0 ? m.used / m.total : 0;
        return h(
          'div',
          { class: 'sysman-card' },
          h(
            'div',
            { class: 'sysman-card-head' },
            h('span', { class: 'sysman-card-title', text: m.mount, title: m.device }),
            h('span', { class: 'sysman-card-sub', text: m.fstype }),
          ),
          meter(fraction),
          h('div', {
            class: 'sysman-card-foot',
            text: `${formatBytes(m.used)} used · ${formatBytes(m.avail)} free · ${formatPercent(fraction)}`,
          }),
        );
      }),
    );
  }

  function showBanner(message: string | null): void {
    banner.hidden = message === null;
    if (message !== null) banner.textContent = message;
  }

  async function poll(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const stats = await desktop.rpc.call<Stats>('sys', 'stats');
      if (ctx.isDisposed()) return;

      showBanner(null);

      if (memTotal !== stats.memTotal) {
        memTotal = stats.memTotal;
        // The memory chart's ceiling is the machine's RAM, so the line's
        // height stays comparable over time instead of auto-rescaling.
        memChart.setMax(stats.memTotal);
      }

      renderSummary(stats);
      renderTemps(stats.temps);

      cpuChart.push([stats.cpu]);
      memChart.push([stats.memUsed]);
      loadChart.push([stats.loadAvg[0] ?? 0]);

      if (previous) {
        const seconds = (stats.time - previous.time) / 1000;
        if (seconds > 0) {
          const before = new Map(previous.net.map((n) => [n.name, n]));
          let rx = 0;
          let tx = 0;
          for (const iface of stats.net) {
            const was = before.get(iface.name);
            if (!was) continue;
            // Counters are 64-bit but can still reset when an interface is
            // recreated; a negative delta means "no useful reading".
            if (iface.rx >= was.rx) rx += (iface.rx - was.rx) / seconds;
            if (iface.tx >= was.tx) tx += (iface.tx - was.tx) / seconds;
          }
          netChart.push([rx, tx]);

          const read = Math.max(0, stats.disk.read - previous.disk.read) / seconds;
          const written = Math.max(0, stats.disk.written - previous.disk.written) / seconds;
          diskChart.push([read, written]);
        }
      }
      previous = stats;

      if (ticks % MOUNTS_EVERY === 0) {
        try {
          const mounts = await desktop.rpc.call<MountUsage[]>('sys', 'filesystems');
          if (!ctx.isDisposed()) renderMounts(mounts);
        } catch (err) {
          if (!ctx.isDisposed()) {
            mountsBox.replaceChildren(placeholder('Could not read filesystems', describeError(err)));
          }
        }
      }
      ticks++;
      ctx.setStatus(`Updated ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      if (ctx.isDisposed()) return;
      // Stale numbers on screen would be worse than saying nothing.
      showBanner(`${describeError(err)} — retrying.`);
      ctx.setStatus('Disconnected');
      for (const chart of charts) chart.break();
      previous = null;
    } finally {
      running = false;
    }
  }

  function schedule(): void {
    if (timer !== null) return;
    timer = window.setInterval(() => void poll(), POLL_MS);
  }

  return {
    element,

    activate() {
      // A pause leaves a gap in the record; do not join across it.
      if (previous && Date.now() - previous.time > GAP_MS) {
        for (const chart of charts) chart.break();
        previous = null;
      }
      for (const chart of charts) chart.measure();
      void poll();
      schedule();
    },

    deactivate() {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    },

    resize() {
      for (const chart of charts) chart.measure();
    },

    destroy() {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      for (const chart of charts) chart.destroy();
    },
  };
}

export const overviewSection: SectionDef = {
  id: 'overview',
  title: 'Overview',
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>
  </svg>`,
  requires: ['sys'],
  create: createOverview,
};
