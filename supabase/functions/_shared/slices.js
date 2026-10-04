// Pure helpers for the command executor (node-testable): what changed between the loaded slice and the
// state after the domain command ran, in the shape public.persist() expects.

import { COLLECTIONS } from './store/schema.js';

const KEY = {
  noticeReceipts: r => `${r.noticeId}|${r.guardianId}`,
  attendance: r => `${r.date}|${r.studentId}`,
};
const keyOf = (c, r) => (KEY[c] ? KEY[c](r) : r.id);
// Phase 3: retention.purge (slice 'retention', system only) deletes learning, diary, attendance and message rows
const DELETABLE = new Set(['calendarEvents', 'importRows', 'observations', 'progressEvents', 'photos', 'diaryEntries', 'reports', 'attendance', 'messages']);
const stable = x => JSON.stringify(x);

/**
 * @param {object} before  the loaded slice (deep copy taken before the command ran)
 * @param {object} after   the same object after the command mutated it
 * @param {string[]} writes collections the command's slice may write ('school', 'counters' included by name)
 * @returns {{school?:object, upserts:Object<string,object[]>, deletes:Object<string,string[]>, counters?:object,
 *   audit:object[], positions:object[]}}
 * Throws when a collection outside `writes` changed (a programming error: it would bypass the slice's rev guard),
 * or when a non-deletable row disappeared (ledger and people rows are never deleted).
 */
export function diffChanges(before, after, writes) {
  const out = { upserts: {}, deletes: {}, audit: [], positions: [] };
  const w = new Set(writes);
  const arrays = new Set([...COLLECTIONS, ...Object.keys(after).filter(k => Array.isArray(after[k]))]);
  arrays.delete('auditLog');
  for (const c of arrays) {
    const a = before[c] || [], b = after[c] || [];
    if (!w.has(c)) {
      if (stable(a) !== stable(b)) throw new Error(`command changed "${c}", which its slice may not write`);
      continue;
    }
    const prev = new Map(a.map(r => [keyOf(c, r), r]));
    const ups = [];
    const seen = new Set();
    for (const r of b) {
      const k = keyOf(c, r);
      if (seen.has(k)) throw new Error(`duplicate key ${k} in "${c}"`);
      seen.add(k);
      const old = prev.get(k);
      if (c === 'trips') {
        const oldTs = new Set((old?.positions || []).map(p => p.ts));
        for (const p of r.positions || []) if (!oldTs.has(p.ts)) out.positions.push({ tripId: r.id, ts: p.ts, lat: p.lat, lng: p.lng, accuracy: p.accuracy });
        const strip = t => { const { positions, ...rest } = t || {}; return rest; };
        if (!old || stable(strip(old)) !== stable(strip(r))) ups.push(strip(r));
        continue;
      }
      if (!old || stable(old) !== stable(r)) ups.push(r);
    }
    if (ups.length) out.upserts[c] = ups;
    const gone = [...prev.keys()].filter(k => !seen.has(k));
    if (gone.length) {
      if (!DELETABLE.has(c)) throw new Error(`command removed rows from "${c}", which are never deleted`);
      out.deletes[c] = gone;
    }
  }
  if (stable(before.school) !== stable(after.school)) {
    if (!w.has('school')) throw new Error('command changed "school", which its slice may not write');
    out.school = after.school;
  }
  if (stable(before.counters) !== stable(after.counters)) {
    if (!w.has('counters')) throw new Error('command changed "counters", which its slice may not write');
    out.counters = after.counters;
  }
  const oldAudit = new Set((before.auditLog || []).map(r => r.id));
  out.audit = (after.auditLog || []).filter(r => !oldAudit.has(r.id));
  return out;
}

export const isEmptyChange = c => !c.school && !c.counters && !c.audit.length && !c.positions.length
  && !Object.keys(c.upserts).length && !Object.keys(c.deletes).length;
