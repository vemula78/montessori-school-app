// Who is calling: the user behind the bearer token, and their app_users link (role is read from the database
// on every request, never from JWT claims, so a revocation or role change is effective immediately). The token's
// `aal` (aal2 = two-step done this session) is read from the claims after the auth server has accepted the token.

import { coded } from './http.ts';
import { getUser, rest } from './db.ts';

export type Link = { role: string; staffId: string | null; guardianId: string | null; status: string };
export type Caller =
  | { kind: 'user'; user: { id: string; email: string | null; aal: string; sessionId: string | null }; link: Link | null }
  | { kind: 'system'; label: string };

export async function caller(req: Request): Promise<Caller> {
  const h = req.headers.get('Authorization') || '';
  const token = h.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw coded('UNAUTHENTICATED', 'Sign in first');
  // the auth server validated the token (signature, expiry, live session) in getUser; only then are its claims read
  const u = await getUser(token);
  const claims = jwtClaims(token);
  const user = { ...u, aal: typeof claims.aal === 'string' ? claims.aal : 'aal1', sessionId: typeof claims.session_id === 'string' ? claims.session_id : null };
  const rows = await rest(`app_users?user_id=eq.${encodeURIComponent(user.id)}&select=role,staff_id,guardian_id,status`);
  const r = rows && rows[0];
  return { kind: 'user', user, link: r ? { role: r.role, staffId: r.staff_id, guardianId: r.guardian_id, status: r.status } : null };
}

export const system = (label: string): Caller => ({ kind: 'system', label });

/** The payload of a JWT the auth server has already accepted (never used to decide who the caller is: getUser does). */
export function jwtClaims(token: string): Record<string, unknown> {
  try {
    const part = token.split('.')[1] || '';
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const v = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0))));
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}
