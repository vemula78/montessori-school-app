// Append-only audit log. Summaries carry ids and amounts, never free-text clinical/health notes.

import { newId } from './ids.js';

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

/** Newest first, optionally filtered. */
export function listAudit(db, { entity, entityId, limit = 100 } = {}) {
  const rows = db.auditLog.filter(r => (!entity || r.entity === entity) && (!entityId || r.entityId === entityId));
  rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return rows.slice(0, limit);
}
