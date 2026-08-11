import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from './config.js';
import { resolvePath } from './paths.js';
import { ServiceError } from './service.js';

/**
 * File transfer over plain HTTP, not the WebSocket.
 *
 * Downloads and uploads stream straight between disk and socket, so they are
 * not subject to the 8 MB in-memory cap of `fs.read`/`fs.write`, and the
 * browser's own download UI (progress, cancel, save-as) does the client half
 * of the work for free. Auth is checked by the caller before these run.
 */

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function statusFor(err: unknown): number {
  const code =
    err instanceof ServiceError ? err.code : (err as NodeJS.ErrnoException)?.code;
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return 403;
    case 'ENOENT':
    case 'ENOTDIR':
      return 404;
    case 'EEXIST':
      return 409;
    case 'EINVAL':
      return 400;
    default:
      return 500;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** GET /api/download?path=… — streams one file as an attachment. */
export function handleDownload(url: URL, res: ServerResponse, config: Config): void {
  try {
    const target = resolvePath(url.searchParams.get('path'), config.root);
    const stats = fs.statSync(target);
    if (!stats.isFile()) throw new ServiceError('Not a regular file', 'EINVAL');

    const name = path.basename(target);
    // Plain-ASCII fallback plus the RFC 5987 form for everything else.
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(stats.size),
      'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'no-store',
    });

    const stream = fs.createReadStream(target);
    stream.pipe(res);
    // Headers are gone by now; all we can do is cut the connection so the
    // browser reports a failed download instead of saving a truncated file.
    stream.on('error', () => res.destroy());
  } catch (err) {
    sendJson(res, statusFor(err), { error: messageOf(err) });
  }
}

const INVALID_NAMES = new Set(['', '.', '..']);

/** `archive.tar.gz` → base `archive`, ext `.tar.gz`, so ` (1)` lands well. */
function splitName(name: string): { base: string; ext: string } {
  const dot = name.indexOf('.', 1);
  return dot < 0 ? { base: name, ext: '' } : { base: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * Opens a file that did not exist a moment ago. `wx` makes creation atomic,
 * so two simultaneous uploads of `report.pdf` become `report.pdf` and
 * `report (1).pdf` rather than one clobbering the other.
 */
function openUnique(dir: string, wanted: string): { fd: number; name: string } {
  const { base, ext } = splitName(wanted);
  for (let n = 0; n < 1000; n++) {
    const candidate = n === 0 ? wanted : `${base} (${n})${ext}`;
    try {
      return { fd: fs.openSync(path.join(dir, candidate), 'wx'), name: candidate };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new ServiceError('Too many files with that name already exist', 'EEXIST');
}

/** POST /api/upload?dir=…&name=… — streams the request body to a new file. */
export function handleUpload(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
): void {
  let opened: { fd: number; name: string; dir: string };
  try {
    const dir = resolvePath(url.searchParams.get('dir') ?? '~', config.root);
    // The name is the browser's, so it is untrusted: it must stay a bare
    // filename and can never navigate out of the chosen directory.
    const wanted = (url.searchParams.get('name') ?? '').replace(/[/\\]/g, '_').trim();
    if (INVALID_NAMES.has(wanted)) throw new ServiceError('A file name is required', 'EINVAL');

    fs.mkdirSync(dir, { recursive: true });
    opened = { ...openUnique(dir, wanted), dir };
  } catch (err) {
    // Drain the body first, or the client sees a reset instead of the error.
    req.resume();
    sendJson(res, statusFor(err), { error: messageOf(err) });
    return;
  }

  const full = path.join(opened.dir, opened.name);
  const out = fs.createWriteStream('', { fd: opened.fd });
  let failed = false;

  const fail = (err: unknown) => {
    if (failed) return;
    failed = true;
    out.destroy();
    // Never leave a half-written file pretending to be the upload.
    fs.unlink(full, () => {});
    if (!res.headersSent) sendJson(res, 500, { error: messageOf(err) });
    else res.destroy();
  };

  req.on('error', fail);
  req.on('aborted', () => fail(new Error('Upload aborted')));
  out.on('error', fail);

  out.on('finish', () => {
    if (failed) return;
    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch {
      // The size is informational; the file itself is already in place.
    }
    sendJson(res, 201, { name: opened.name, path: full, size });
  });

  req.pipe(out);
}
