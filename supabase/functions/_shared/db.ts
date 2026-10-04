// Minimal PostgREST / Auth client over fetch, with the service role (server only). No driver dependency:
// every write is one call to public.persist(), which runs in a single transaction.

import { coded } from './http.ts';
import { fetchAllPages } from './paging.js';

const URL_ = Deno.env.get('SUPABASE_URL') ?? '';
// the legacy service-role JWT, or (projects on the new key system) the first of SUPABASE_SECRET_KEYS ({"default": "sb_secret_…"})
function secretKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (legacy) return legacy;
  try { const m = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}'); return m.default || Object.values(m)[0] || ''; } catch { return ''; }
}
const KEY = secretKey();
if (!URL_ || !KEY) console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');

// a JWT key also goes in Authorization; a new sb_secret_ key is not a JWT and is sent as apikey only
const headers = (extra: Record<string, string> = {}) => ({ apikey: KEY, ...(KEY.startsWith('ey') ? { Authorization: `Bearer ${KEY}` } : {}), 'Content-Type': 'application/json', ...extra });
/** For _shared/auth-admin.ts (the auth server's admin API). */
export const serviceHeaders = headers;
export const SUPABASE_URL = URL_;

export class DbError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

export async function rest(path: string, { method = 'GET', body, prefer }: { method?: string; body?: unknown; prefer?: string } = {}): Promise<any> {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    method, headers: headers(prefer ? { Prefer: prefer } : {}), body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new DbError(res.status, data?.code ?? String(res.status), data?.message ?? text);
  return data;
}

export const rpc = (fn: string, args: Record<string, unknown>) => rest(`rpc/${fn}`, { method: 'POST', body: args });

/**
 * Every row of a GET (PostgREST answers at most max_rows = 1000 per request, silently). `path` must carry an
 * `order=` on a unique column so pages do not overlap.
 */
export async function restAll(path: string): Promise<any[]> {
  if (!/[?&]order=/.test(path)) throw new Error(`restAll needs an order: ${path.split('?')[0]}`);
  return fetchAllPages((offset: number, limit: number) => rest(`${path}&limit=${limit}&offset=${offset}`), 1000);
}

/** Rows affected by a PATCH/DELETE (Prefer count=exact; nothing is returned, so no row cap applies). */
export async function restCount(path: string, { method, body }: { method: string; body?: unknown }): Promise<number> {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    method, headers: headers({ Prefer: 'return=minimal,count=exact' }), body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) { let d: any = null; try { d = JSON.parse(text); } catch { /* not JSON */ } throw new DbError(res.status, d?.code ?? String(res.status), d?.message ?? text); }
  const m = /\/(\d+)$/.exec(res.headers.get('content-range') || '');
  return m ? Number(m[1]) : 0;
}

/** Delete a sign-in (Auth admin API). A user already gone counts as deleted. */
export async function deleteAuthUser(userId: string): Promise<void> {
  const res = await fetch(`${URL_}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE', headers: headers() });
  await res.body?.cancel();
  if (!res.ok && res.status !== 404) throw new Error(`could not delete sign-in (${res.status})`);
}

/** The signed-in user behind a bearer token (validated by the Auth server, so a signed-out session fails). */
export async function getUser(token: string): Promise<{ id: string; email: string | null }> {
  const res = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) throw coded('UNAUTHENTICATED', 'Your sign-in has expired; please sign in again');
  if (!res.ok) throw coded('UNAUTHENTICATED', `Could not check your sign-in (${res.status})`);
  const u = await res.json();
  if (!u || !u.id) throw coded('UNAUTHENTICATED', 'Not signed in');
  return { id: u.id, email: u.email ? String(u.email).toLowerCase() : null };
}

export const inList = (ids: string[]) => `(${ids.map(x => `"${String(x).replace(/"/g, '')}"`).join(',')})`;
