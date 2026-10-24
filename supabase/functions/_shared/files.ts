// Private files other than child photos (schema v5): staff signatures (bucket `signatures`) and notice attachments
// (bucket `notice-files`). Server side only (service role); both buckets are private with NO storage policies for users.
// Unlike photos, the bytes come in WITH the command (base64, a few hundred KB at most): the command function checks them
// here (magic bytes, size, PNG size, JPEG without EXIF/XMP), stores them under a server-chosen path, then runs the command
// with ctx.fileInfo; if the command is refused (or was a replay), the stored object is deleted again before answering.
// Downloads: a signed path valid a few seconds, which remote.js fetches at once; paths are never logged or stored by it.

import { inspectJpeg } from './jpeg.js';
import { sniffMime, pngSize, fileProblem, EXTENSION } from './domain/files.js';
import { coded } from './http.ts';

const URL_ = Deno.env.get('SUPABASE_URL') ?? '';
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const BASE = `${URL_}/storage/v1`;
const auth = (extra: Record<string, string> = {}) => ({ apikey: KEY, Authorization: `Bearer ${KEY}`, ...extra });
const enc = (path: string) => path.split('/').map(encodeURIComponent).join('/');
const SAFE_PATH = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.(png|jpg|pdf)$/;

function checkPath(path: unknown): string {
  const p = String(path ?? '');
  if (!SAFE_PATH.test(p)) throw new Error('file path has an unexpected shape');
  return p;
}

/** Decode the base64 that came with the command, refuse it early if it is plainly too big. */
export function decodeUpload(file: any, maxBytes: number): Uint8Array {
  const b64 = file && typeof file.base64 === 'string' ? file.base64 : '';
  if (!b64) throw coded('VALIDATION', 'The file did not arrive; choose it again');
  if (b64.length > Math.ceil(maxBytes / 3) * 4 + 8) throw coded('VALIDATION', 'The file is too large');
  let bin: string;
  try { bin = atob(b64); } catch { throw coded('VALIDATION', 'The file did not arrive intact; choose it again'); }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** What the bytes are and whether this kind accepts them: {mime, bytes, width?, height?, sha256}; VALIDATION if not. */
export async function checkUpload(bytes: Uint8Array, rules: { mimes: string[]; maxBytes: number; maxEdge?: number | null }) {
  const mime = sniffMime(bytes);
  const info: any = { mime, bytes: bytes.length };
  if (mime === 'image/png') Object.assign(info, pngSize(bytes) || {});
  let problem: string | null = null;
  if (mime === 'image/jpeg') {
    const j = inspectJpeg(bytes);
    Object.assign(info, { width: j.width, height: j.height, hasExif: j.hasExif, hasXmp: j.hasXmp });
    if (j.reason && rules.mimes.includes(mime)) problem = j.reason;
  }
  problem = fileProblem(info, rules) || problem;
  if (problem) throw coded('VALIDATION', `This file cannot be used: ${problem}`);
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  info.sha256 = Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
  delete info.hasExif; delete info.hasXmp;
  return info as { mime: string; bytes: number; width?: number; height?: number; sha256: string };
}

/** A fresh server-chosen path: `${prefix}/${uuid}.${ext}`. */
export const newPath = (prefix: string, mime: string) => checkPath(`${prefix}/${crypto.randomUUID()}.${EXTENSION[mime as keyof typeof EXTENSION]}`);

export async function putObject(bucket: string, path: string, bytes: Uint8Array, mime: string) {
  const res = await fetch(`${BASE}/object/${bucket}/${enc(checkPath(path))}`, { method: 'POST', headers: auth({ 'Content-Type': mime, 'x-upsert': 'false' }), body: bytes });
  const text = await res.text();
  if (!res.ok) throw new Error(`storage upload answered ${res.status} (${text.slice(0, 80)})`);
}

/** Delete objects (one already gone counts as deleted). Returns how many existed. */
export async function removeObjects(bucket: string, paths: string[]): Promise<number> {
  const list = [...new Set(paths.map(checkPath))];
  let n = 0;
  for (let i = 0; i < list.length; i += 100) {
    const res = await fetch(`${BASE}/object/${bucket}`, { method: 'DELETE', headers: auth({ 'Content-Type': 'application/json' }), body: JSON.stringify({ prefixes: list.slice(i, i + 100) }) });
    const text = await res.text();
    if (!res.ok) throw new Error(`storage delete answered ${res.status}`);
    try { const d = JSON.parse(text); n += Array.isArray(d) ? d.length : 0; } catch { /* not JSON */ }
  }
  return n;
}

/** A download path valid ttlS seconds, relative to /storage/v1 (the browser prefixes its own Supabase URL). */
export async function signDownload(bucket: string, path: string, ttlS: number) {
  const res = await fetch(`${BASE}/object/sign/${bucket}/${enc(checkPath(path))}`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json' }), body: JSON.stringify({ expiresIn: ttlS }) });
  const d = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`storage sign answered ${res.status}`);
  const signedPath = String(d?.signedURL || d?.signedUrl || '');
  if (!signedPath.startsWith('/object/sign/')) throw new Error('storage gave no signed URL');
  return { signedPath, expiresAt: new Date(Date.now() + ttlS * 1000).toISOString() };
}

/** Objects of a bucket folder (service role), for the orphan sweep: [{name: 'prefix/file', createdAt}]. */
export async function listObjects(bucket: string, prefix = ''): Promise<{ name: string; createdAt: string | null }[]> {
  const out: { name: string; createdAt: string | null }[] = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(`${BASE}/object/list/${bucket}`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json' }), body: JSON.stringify({ prefix, limit: 1000, offset }) });
    const d = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(d)) throw new Error(`storage list answered ${res.status}`);
    out.push(...d.filter((x: any) => x && x.id).map((x: any) => ({ name: `${prefix ? `${prefix}/` : ''}${x.name}`, createdAt: x.created_at ?? null })));
    if (d.length < 1000) return out;
  }
}
