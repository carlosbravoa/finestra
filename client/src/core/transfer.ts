import type { UploadSummary, UploadedFile } from './types';

/**
 * Client half of file transfer. Auth rides the HttpOnly session cookie, so no
 * token appears in these URLs.
 */

export function downloadUrl(path: string): string {
  return `/api/download?path=${encodeURIComponent(path)}`;
}

/** Triggers the browser's own download UI for one server-side file. */
export function downloadFile(path: string): void {
  const a = document.createElement('a');
  a.href = downloadUrl(path);
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Uploads sequentially — kinder to the disk than a burst of parallel writes,
 * and failures stay attributable to a single file.
 */
export async function uploadTo(dir: string, files: File[]): Promise<UploadSummary> {
  const ok: UploadedFile[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  for (const file of files) {
    try {
      const res = await fetch(
        `/api/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`,
        { method: 'POST', body: file, credentials: 'same-origin' },
      );
      const data = (await res.json().catch(() => null)) as
        | (UploadedFile & { error?: string })
        | null;
      if (!res.ok || !data) {
        throw new Error(data?.error ?? `Upload failed (HTTP ${res.status})`);
      }
      ok.push(data);
    } catch (err) {
      failed.push({ name: file.name, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { dir, ok, failed };
}
