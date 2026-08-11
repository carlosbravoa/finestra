import { h } from '../../core/dom';
import type { MenuItem } from '../../core/types';
import {
  DataTable,
  button,
  describeError,
  formatDate,
  formatUntil,
  placeholder,
  toolbar,
  type Column,
  type Section,
  type SectionContext,
  type SectionDef,
} from './common';

/**
 * Where a server's *own* certificates usually live. Editable, and remembered
 * per browser.
 *
 * `/etc/ssl/certs` is deliberately absent: it is the OS trust store, so adding
 * it buries the handful of certificates that can actually expire on you under
 * a couple of hundred CA roots that cannot.
 */
const DEFAULT_PATHS = [
  '/etc/letsencrypt/live',
  '/etc/nginx',
  '/etc/apache2',
  '/etc/pki/tls/certs',
];
const PATHS_KEY = 'sysman.certPaths';

const WARN_DAYS = 30;

interface CertInfo {
  path: string;
  subject: string;
  issuer: string;
  altNames: string;
  notBefore: number;
  notAfter: number;
  selfSigned: boolean;
}

function daysLeft(cert: CertInfo): number {
  return Math.round((cert.notAfter - Date.now()) / 86_400_000);
}

function createCertificates(ctx: SectionContext): Section {
  const { desktop } = ctx;

  let certs: CertInfo[] = [];
  let paths: string[] = desktop.settings.get<string[]>(PATHS_KEY, DEFAULT_PATHS);
  let loading = false;
  let loaded = false;

  const columns: Array<Column<CertInfo>> = [
    {
      key: 'expiry',
      label: 'Expires',
      width: 'minmax(0, 0.7fr)',
      render: (cert) => {
        const days = daysLeft(cert);
        const tone = days < 0 ? 'danger' : days <= WARN_DAYS ? 'warn' : 'ok';
        return h(
          'span',
          { class: `sysman-badge tone-${tone}`, title: formatDate(cert.notAfter) },
          days < 0 ? 'expired' : formatUntil(cert.notAfter),
        );
      },
      sort: (cert) => cert.notAfter,
    },
    {
      key: 'subject',
      label: 'Subject',
      width: 'minmax(140px, 1.2fr)',
      render: (cert) => h('span', { class: 'sysman-ellipsis', text: cert.subject, title: cert.subject }),
      sort: (cert) => cert.subject,
    },
    {
      key: 'altNames',
      label: 'Also valid for',
      width: 'minmax(130px, 1.2fr)',
      showAbove: 860,
      render: (cert) =>
        h('span', { class: 'sysman-ellipsis', text: cert.altNames || '—', title: cert.altNames }),
      sort: (cert) => cert.altNames,
    },
    {
      key: 'issuer',
      label: 'Issuer',
      width: 'minmax(120px, 1fr)',
      showAbove: 700,
      render: (cert) =>
        h(
          'span',
          { class: 'sysman-ellipsis', title: cert.issuer },
          h('span', { text: cert.issuer }),
          cert.selfSigned ? h('span', { class: 'sysman-tag', text: 'self-signed' }) : null,
        ),
      sort: (cert) => cert.issuer,
    },
    {
      key: 'path',
      label: 'File',
      cls: 'is-mono',
      width: 'minmax(140px, 1.4fr)',
      showAbove: 560,
      render: (cert) => h('span', { class: 'sysman-ellipsis', text: cert.path, title: cert.path }),
      sort: (cert) => cert.path,
    },
  ];

  const table = new DataTable<CertInfo>({
    columns,
    key: (cert) => `${cert.path}:${cert.subject}:${cert.notAfter}`,
    onContext: (row, at) => desktop.contextMenu(rowMenu(row), at),
  });
  table.sortBy('expiry', false);

  const pathChips = h('div', { class: 'sysman-chips' });
  const status = h('span', { class: 'sysman-toolbar-note' });
  const banner = h('div', { class: 'sysman-banner' });
  banner.hidden = true;
  const body = h('div', { class: 'sysman-du-body' }, table.element);

  const element = h(
    'div',
    { class: 'sysman-section' },
    toolbar(
      button('Rescan', () => void load()),
      button('Add path…', () => void addPath()),
      status,
    ),
    pathChips,
    banner,
    body,
  );

  function renderPaths(): void {
    pathChips.replaceChildren(
      ...paths.map((p) =>
        h(
          'div',
          { class: 'sysman-chip' },
          h('span', { class: 'sysman-chip-label', text: p }),
          h('button', {
            class: 'sysman-chip-remove',
            text: '✕',
            title: `Stop scanning ${p}`,
            on: {
              click: () => {
                paths = paths.filter((other) => other !== p);
                desktop.settings.set(PATHS_KEY, paths);
                renderPaths();
                void load();
              },
            },
          }),
        ),
      ),
    );
  }

  async function addPath(): Promise<void> {
    const value = await desktop.prompt({
      title: 'Add a certificate path',
      message: 'A directory to search, or a single certificate file.',
      placeholder: '/etc/letsencrypt/live',
    });
    if (!value || ctx.isDisposed()) return;
    if (!paths.includes(value)) {
      paths = [...paths, value];
      desktop.settings.set(PATHS_KEY, paths);
      renderPaths();
    }
    await load();
  }

  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    status.textContent = 'Scanning…';
    try {
      const result = await desktop.rpc.call<{
        certs: CertInfo[];
        missing: string[];
        truncated: boolean;
      }>('certs', 'scan', { paths });
      if (ctx.isDisposed()) return;

      loaded = true;
      certs = result.certs;
      banner.hidden = result.missing.length === 0 && !result.truncated;
      if (!banner.hidden) {
        const parts: string[] = [];
        if (result.missing.length > 0) {
          parts.push(`Not found: ${result.missing.join(', ')}`);
        }
        if (result.truncated) parts.push('Too many files to scan; narrow the paths.');
        banner.textContent = parts.join(' · ');
        // A path that simply is not there on this host is information, not an
        // error — most machines have only one of these directories.
        banner.classList.toggle('is-info', !result.truncated);
      }
      render();
    } catch (err) {
      if (ctx.isDisposed()) return;
      banner.hidden = false;
      banner.textContent = describeError(err);
      body.replaceChildren(placeholder('Could not scan for certificates', describeError(err)));
      status.textContent = '';
    } finally {
      loading = false;
    }
  }

  function render(): void {
    if (certs.length === 0) {
      body.replaceChildren(
        placeholder(
          'No certificates found',
          'Add a path with the button above — for example /etc/letsencrypt/live.',
        ),
      );
      status.textContent = '';
      ctx.setStatus('No certificates found');
      return;
    }

    if (body.firstChild !== table.element) body.replaceChildren(table.element);
    table.setRows(certs);

    const expired = certs.filter((c) => daysLeft(c) < 0).length;
    const soon = certs.filter((c) => {
      const days = daysLeft(c);
      return days >= 0 && days <= WARN_DAYS;
    }).length;
    status.textContent = `${certs.length} certificates`;
    ctx.setStatus(
      expired > 0 || soon > 0
        ? `${expired} expired · ${soon} expiring within ${WARN_DAYS} days`
        : `${certs.length} certificates, none expiring within ${WARN_DAYS} days`,
    );
  }

  function rowMenu(cert: CertInfo): MenuItem[] {
    return [
      { type: 'header', label: cert.subject },
      {
        label: 'Show details',
        onSelect: () => {
          void desktop.confirm({
            title: cert.subject,
            message: [
              `Issuer: ${cert.issuer}`,
              `Valid from: ${formatDate(cert.notBefore)}`,
              `Valid to: ${formatDate(cert.notAfter)} (${formatUntil(cert.notAfter)})`,
              cert.altNames ? `Also valid for: ${cert.altNames}` : '',
              `File: ${cert.path}`,
            ]
              .filter(Boolean)
              .join('\n'),
            cancelLabel: null,
            confirmLabel: 'Close',
          });
        },
      },
      {
        label: 'Open file location',
        onSelect: () => {
          const dir = cert.path.slice(0, cert.path.lastIndexOf('/')) || '/';
          void desktop.launch('files', { params: { path: dir } });
        },
      },
    ];
  }

  renderPaths();

  return {
    element,

    activate() {
      // Scanning touches the disk; do it on first visit and on request.
      if (!loaded && !loading) void load();
    },

    menu: () => [
      { label: 'Rescan', accelerator: 'F5', onSelect: () => void load() },
      { label: 'Add path…', onSelect: () => void addPath() },
      { type: 'separator' },
      {
        label: 'Reset paths to defaults',
        onSelect: () => {
          paths = [...DEFAULT_PATHS];
          desktop.settings.set(PATHS_KEY, paths);
          renderPaths();
          void load();
        },
      },
    ],

    destroy() {
      table.destroy();
    },
  };
}

export const certificatesSection: SectionDef = {
  id: 'certificates',
  title: 'Certificates',
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="9" r="6"/><path d="m8.5 14-1 7 4.5-2.5L16.5 21l-1-7"/>
  </svg>`,
  requires: ['certs'],
  create: createCertificates,
};
