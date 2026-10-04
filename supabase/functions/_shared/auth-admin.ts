// The auth server's admin API (service key, server only): what only GoTrue can do — list sign-ins, ban/unban, change a
// sign-in email, send a staff invite, remove authenticator factors. Every call answers {status, ok, body}; callers decide.

import { SUPABASE_URL, serviceHeaders } from './db.ts';

export type AuthAnswer = { status: number; ok: boolean; body: any };

async function call(method: string, path: string, body?: unknown): Promise<AuthAnswer> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1${path}`, { method, headers: serviceHeaders(), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: res.status, ok: res.ok, body: data };
}

/** Every sign-in, page by page (the admin API answers at most per_page users per request). */
export async function listAuthUsers(): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page < 1000; page++) {
    const r = await call('GET', `/admin/users?page=${page}&per_page=500`);
    if (!r.ok) throw new Error(`could not list sign-ins (${r.status})`);
    const users = Array.isArray(r.body?.users) ? r.body.users : [];
    out.push(...users);
    if (users.length < 500) return out;
  }
  throw new Error('too many sign-ins to list');
}

export const getAuthUser = (id: string) => call('GET', `/admin/users/${encodeURIComponent(id)}`);
export const updateAuthUser = (id: string, patch: Record<string, unknown>) => call('PUT', `/admin/users/${encodeURIComponent(id)}`, patch);
export const inviteAuthUser = (email: string) => call('POST', '/invite', { email });
export const deleteAuthFactor = (userId: string, factorId: string) => call('DELETE', `/admin/users/${encodeURIComponent(userId)}/factors/${encodeURIComponent(factorId)}`);

/** ~100 years: the admin API has no "forever". */
export const BAN_FOR = '876000h';
export const verifiedTotp = (u: any) => (Array.isArray(u?.factors) ? u.factors : []).filter((f: any) => f.factor_type === 'totp' && f.status === 'verified');
