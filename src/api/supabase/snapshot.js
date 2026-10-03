// The page's only copy of school data in the real app: public.my_snapshot(), the Phase 1 Db shape built
// under the caller's RLS (it cannot hold more than this user may see). Positions are never in it.

import { personaFor } from '../../domain/commands.js';

/** @returns {{status:string, db:object|null, persona:object|null, me:object|null}} */
export async function fetchSnapshot(sb, ApiError) {
  const { data, error } = await sb.rpc('my_snapshot');
  if (error) {
    if (/JWT|jwt|401/.test(error.message || '') || error.code === 'PGRST301') throw new ApiError('UNAUTHENTICATED', 'Your sign-in has expired; please sign in again');
    throw new ApiError('OFFLINE', `Could not load the school data (${error.message || error.code || 'network'})`);
  }
  if (!data || data.status !== 'active') return { status: data ? data.status : 'unlinked', db: null, persona: null, me: null };
  const { status, me, revs, remindersSent, ...db } = data;
  db.remindersSent = remindersSent || [];
  const persona = personaFor(db, { role: me.role, staffId: me.staffId, guardianId: me.guardianId });
  return { status, db, persona, me, revs };
}
