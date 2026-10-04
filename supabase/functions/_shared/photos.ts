// Photo bytes in Storage, server side only (service role). The bucket has no policies for users: every upload and
// download URL is signed here, after the registry authorized the caller, for one server-chosen path. Signed paths are
// returned relative to /storage/v1 (the browser prefixes its own Supabase URL); they are never logged or stored.
// Shared by the command function (register → upload grant, complete → verify, remove → delete, viewUrl → 120 s
// download) and cron-daily (photosCleanup: finish deletions, reject abandoned uploads, delete orphaned objects).

import { rest, restAll, rpc, inList } from './db.ts';
import { runCommand } from './persist.ts';
import { system } from './authz.ts';
import { inspectJpeg } from './jpeg.js';
import { objectProblem, PHOTO_BUCKET, UPLOAD_TTL_S, VIEW_TTL_S, PENDING_GRACE_MS, PHOTO_MAX_BYTES } from './domain/photos.js';

const URL_ = Deno.env.get('SUPABASE_URL') ?? '';
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const BASE = `${URL_}/storage/v1`;
const auth = (extra: Record<string, string> = {}) => ({ apikey: KEY, Authorization: `Bearer ${KEY}`, ...extra });
const enc = (path: string) => path.split('/').map(encodeURIComponent).join('/');
const SAFE_PATH = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.jpg$/; // {studentId}/{photoId}.jpg, chosen by the domain

function checkPath(path: unknown): string {
  const p = String(path ?? '');
  if (!SAFE_PATH.test(p)) throw new Error('photo path has an unexpected shape');
  return p;
}
/** exp of a signed token (JWT), as ISO; falls back to now + ttl. */
function expiryOf(token: string, ttlS: number) {
  try {
    const p = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (Number.isFinite(p.exp)) return new Date(p.exp * 1000).toISOString();
  } catch { /* not a JWT: use the configured ttl */ }
  return new Date(Date.now() + ttlS * 1000).toISOString();
}
async function storageJson(method: string, path: string, body?: unknown) {
  // no Content-Type without a body: Storage refuses an empty JSON body
  const res = await fetch(`${BASE}${path}`, { method, headers: auth(body === undefined ? {} : { 'Content-Type': 'application/json' }), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new Error(`storage ${method} answered ${res.status} (${data?.error || data?.code || 'error'})`);
  return data;
}

/** A one-path upload grant (Storage fixes its life at 2 hours). */
export async function signUpload(path: string) {
  const p = checkPath(path);
  const d = await storageJson('POST', `/object/upload/sign/${PHOTO_BUCKET}/${enc(p)}`);
  const token = String(d?.token || new URL(`http://x${d.url}`).searchParams.get('token') || '');
  if (!token) throw new Error('storage gave no upload token');
  return { bucket: PHOTO_BUCKET, path: p, token, signedPath: `/object/upload/sign/${PHOTO_BUCKET}/${enc(p)}?token=${encodeURIComponent(token)}`, expiresAt: expiryOf(token, UPLOAD_TTL_S) };
}

/** A download URL for one object, valid VIEW_TTL_S seconds (remote.js fetches it at once and keeps only the bytes). */
export async function signView(path: string) {
  const p = checkPath(path);
  const d = await storageJson('POST', `/object/sign/${PHOTO_BUCKET}/${enc(p)}`, { expiresIn: VIEW_TTL_S });
  const signedPath = String(d?.signedURL || d?.signedUrl || '');
  if (!signedPath.startsWith('/object/sign/')) throw new Error('storage gave no signed URL');
  return { signedPath, expiresAt: expiryOf(new URL(`http://x${signedPath}`).searchParams.get('token') || '', VIEW_TTL_S) };
}

/** The stored bytes, or null when there is no such object. */
async function readObject(path: string): Promise<Uint8Array | null> {
  const res = await fetch(`${BASE}/object/authenticated/${PHOTO_BUCKET}/${enc(checkPath(path))}`, { headers: auth() });
  if (res.ok) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf;
  }
  const text = await res.text();
  if (res.status === 404 || (res.status === 400 && /not.?found/i.test(text))) return null;
  throw new Error(`storage download answered ${res.status}`);
}

/** Delete objects; one that is already gone counts as deleted. Returns how many existed. */
export async function deleteObjects(paths: string[]): Promise<number> {
  const list = [...new Set(paths.map(checkPath))];
  let n = 0;
  for (let i = 0; i < list.length; i += 100) {
    const d = await storageJson('DELETE', `/object/${PHOTO_BUCKET}`, { prefixes: list.slice(i, i + 100) });
    n += Array.isArray(d) ? d.length : 0;
  }
  return n;
}

/**
 * What complete() needs to know about an uploaded object: {missing:true}, or the JPEG check plus size and sha256.
 * A file that fails the check is deleted here, before the row is committed as rejected (objectDeleted:true).
 */
export async function verifyUpload(path: string) {
  const bytes = await readObject(path);
  if (!bytes) return { missing: true };
  const info: any = { ...inspectJpeg(bytes), sha256: null as string | null };
  if (bytes.length <= PHOTO_MAX_BYTES * 2) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    info.sha256 = Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
  }
  if (objectProblem(info)) { await deleteObjects([path]); info.objectDeleted = true; }
  return info;
}

/** Rows in 'deleting' (all, or these ids): delete their objects, then record them deleted/expired. */
export async function cleanupDeleting(photoIds: string[] | null = null) {
  const filter = photoIds ? `&id=in.${inList(photoIds)}` : '';
  const rows = await restAll(`photos?status=eq.deleting${filter}&select=id,path:doc->>path&order=id`);
  const out = { deleting: rows.length, objectsDeleted: 0, finished: 0, errors: [] as string[] };
  if (!rows.length) return out;
  const withPath = rows.filter((r: any) => r.path && SAFE_PATH.test(r.path));
  try { out.objectsDeleted = withPath.length ? await deleteObjects(withPath.map((r: any) => r.path)) : 0; } catch (e: any) { out.errors.push(String(e?.message || e)); return out; }
  const r = await runCommand('photos.finishDelete', [{ photoIds: rows.map((x: any) => x.id) }], system('photos'));
  out.finished = r.result.finished;
  return out;
}

/**
 * Both directions of the orphan sweep. Pending rows older than the grace are rejected (abandoned). Objects whose row is
 * terminal (rejected/deleted/expired) are deleted at once, whatever their age: Storage cannot revoke a signed upload
 * token, so an old grant can put an object back after its row was closed (audit C5). Objects with no row, or whose row
 * is still pending, are deleted only after the grace, so an upload in flight is never touched.
 */
export async function sweepPhotos(nowMs: number) {
  const cutoff = nowMs - PENDING_GRACE_MS;
  const pending = (await restAll('photos?status=eq.pending&select=id,createdAt:doc->>createdAt&order=id')).filter((r: any) => Date.parse(r.createdAt) < cutoff);
  let abandoned = 0;
  if (pending.length) abandoned = (await runCommand('photos.markRejected', [{ photoIds: pending.map((r: any) => r.id), reason: 'abandoned: not uploaded within 2 hours' }], system('photos'))).result.rejected;
  const objects: { name: string; created_at: string }[] = await rpc('photo_objects', {});
  const idOf = (name: string) => (/^[^/]+\/([^/]+)\.jpg$/.exec(name) || [])[1];
  const ids = objects.map(o => idOf(o.name)).filter(Boolean) as string[];
  const status = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    for (const r of await rest(`photos?id=in.${inList(ids.slice(i, i + 200))}&select=id,status`)) status.set(r.id, r.status);
  }
  const orphans = objects.filter(o => {
    const st = status.get(idOf(o.name) || '');
    if (st === 'ready' || st === 'deleting') return false;           // kept / handled by cleanupDeleting
    if (st && ['rejected', 'deleted', 'expired'].includes(st)) return true; // terminal row: no grace
    return Date.parse(o.created_at) < cutoff;                         // pending or no row: after the grace
  }).map(o => o.name);
  const strange = orphans.filter(n => !SAFE_PATH.test(n));
  const orphanObjectsDeleted = orphans.length - strange.length ? await deleteObjects(orphans.filter(n => SAFE_PATH.test(n))) : 0;
  if (strange.length) {
    // names the app never makes: removed through the API one by one
    for (const n of strange) await storageJson('DELETE', `/object/${PHOTO_BUCKET}`, { prefixes: [n] });
  }
  return { objects: objects.length, pendingAbandoned: abandoned, orphanObjectsDeleted: orphanObjectsDeleted + strange.length };
}
