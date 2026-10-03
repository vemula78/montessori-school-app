// Minimal PostgREST / Auth client over fetch, with the service role (server only). No driver dependency:
// every write is one call to public.persist(), which runs in a single transaction.

import { coded } from './http.ts';

const URL_ = Deno.env.get('SUPABASE_URL') ?? '';
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
if (!URL_ || !KEY) console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');

const headers = (extra: Record<string, string> = {}) => ({ apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...extra });

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
