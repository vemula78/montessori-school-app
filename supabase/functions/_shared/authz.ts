// Who is calling: the user behind the bearer token, and their app_users link (role is read from the database
// on every request, never from JWT claims, so a revocation or role change is effective immediately).

import { coded } from './http.ts';
import { getUser, rest } from './db.ts';

export type Link = { role: string; staffId: string | null; guardianId: string | null; status: string };
export type Caller =
  | { kind: 'user'; user: { id: string; email: string | null }; link: Link | null }
  | { kind: 'system'; label: string };

export async function caller(req: Request): Promise<Caller> {
  const h = req.headers.get('Authorization') || '';
  const token = h.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw coded('UNAUTHENTICATED', 'Sign in first');
  const user = await getUser(token);
  const rows = await rest(`app_users?user_id=eq.${encodeURIComponent(user.id)}&select=role,staff_id,guardian_id,status`);
  const r = rows && rows[0];
  return { kind: 'user', user, link: r ? { role: r.role, staffId: r.staff_id, guardianId: r.guardian_id, status: r.status } : null };
}

export const system = (label: string): Caller => ({ kind: 'system', label });
