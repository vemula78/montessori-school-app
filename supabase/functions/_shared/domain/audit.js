// Append-only audit log. Summaries carry ids and amounts, never free-text clinical/health notes.

import { newId } from './ids.js';
import { tsToLocalDate } from './dates.js';

/**
 * @param {import('../store/schema.js').Db} db
 * @param {import('../store/schema.js').Ctx} ctx
 * @param {{entity:string, entityId:string, action:string, summary:string}} row
 */
export function appendAudit(db, ctx, { entity, entityId, action, summary }) {
  const row = {
    id: newId('aud'),
    ts: ctx.now,
    actorRole: ctx.actor.role,
    actorId: ctx.actor.id,
    entity,
    entityId,
    action,
    summary,
  };
  db.auditLog.push(row);
  return row;
}

/**
 * Does an audit row pass the viewer's filters? from/to: business dates (YYYY-MM-DD) of ts, inclusive; actor: a person
 * id, or 'system'; q: text found in the summary (receipt and invoice numbers are there), any case.
 */
export function auditMatches(r, { entity, entityId, from, to, actor, q } = {}) {
  if (entity && r.entity !== entity) return false;
  if (entityId && r.entityId !== entityId) return false;
  if (from || to) { const d = tsToLocalDate(r.ts); if ((from && d < from) || (to && d > to)) return false; }
  if (actor && (actor === 'system' ? r.actorRole !== 'system' : r.actorId !== actor)) return false;
  if (q && !String(r.summary ?? '').toLowerCase().includes(String(q).toLowerCase())) return false;
  return true;
}

/** Newest first, filtered (auditMatches) before the limit is applied. */
export function listAudit(db, { entity, entityId, from, to, actor, q, limit = 100 } = {}) {
  const rows = db.auditLog.filter(r => auditMatches(r, { entity, entityId, from, to, actor, q }));
  rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return rows.slice(0, limit);
}
