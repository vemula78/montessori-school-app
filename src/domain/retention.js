// Retention after a child leaves (closes deferred blocker #10). school.retention holds one period per category in
// whole months after students.leftOn; null = the school has not decided, and nothing of that category is touched.
//   photos        live photos of the child → deleting (reason 'retention'); the server deletes the objects → expired
//   observations  observations and progress events are deleted; their photos go too (live → deleting/expired,
//                 rows already without an object are deleted)
//   diary         diary entries and termly reports are deleted
//   attendance    attendance rows are deleted
//   messages      the messages of the child's conversations are deleted (the conversation row stays)
// Never touched: fee records (the law requires them), people, consent records, the audit log.
// A child who left without a leaving date (import, Phase 2 data) is never due: listed as leftWithoutDate.

import { fail } from './ids.js';
import { isISODate, compareISO, daysInMonth } from './dates.js';
import { appendAudit } from './audit.js';
import { RETENTION_KEYS } from '../store/schema.js';
import { LIVE_STATUSES, TERMINAL_STATUSES, RETENTION_REASON } from './photos.js';

export const RETENTION_MAX_MONTHS = 240;
export const CATEGORIES = { photos: 'photosMonthsAfterLeaving', observations: 'observationsMonthsAfterLeaving', diary: 'diaryMonthsAfterLeaving',
  attendance: 'attendanceMonthsAfterLeaving', messages: 'messagesMonthsAfterLeaving' };
/** Collections whose rows a retention purge may delete (the server's persist allow-list matches). */
export const PURGEABLE = ['observations', 'progressEvents', 'photos', 'diaryEntries', 'reports', 'attendance', 'messages'];

/** 'YYYY-MM-DD' + n months, the day clamped to the month's end (31-Jan + 1 → 28/29-Feb). */
export function addMonths(iso, n) {
  if (!isISODate(iso)) fail('VALIDATION', `Invalid date: ${iso}`);
  const [y, m, d] = iso.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  const yy = Math.floor(t / 12), mm = (t % 12) + 1;
  return `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(d, daysInMonth(yy, mm))).padStart(2, '0')}`;
}

/** {key: months|null} for every RETENTION_KEYS entry; whole months 1..240 or null. */
export function cleanRetention(input = {}) {
  const out = {};
  for (const k of RETENTION_KEYS) {
    const v = input[k];
    if (v === null || v === undefined || v === '') { out[k] = null; continue; }
    if (!Number.isSafeInteger(v) || v < 1 || v > RETENTION_MAX_MONTHS) fail('VALIDATION', `${k} must be whole months from 1 to ${RETENTION_MAX_MONTHS}, or not decided`);
    out[k] = v;
  }
  for (const k of Object.keys(input)) if (!RETENTION_KEYS.includes(k)) fail('VALIDATION', `Unknown retention setting: ${k}`);
  return out;
}

export function setRetention(db, input, ctx) {
  const before = db.school.retention || {};
  db.school.retention = cleanRetention(input);
  const changed = RETENTION_KEYS.filter(k => (before[k] ?? null) !== db.school.retention[k]).map(k => `${k} ${before[k] ?? 'unset'} → ${db.school.retention[k] ?? 'unset'}`);
  appendAudit(db, ctx, { entity: 'school', entityId: 'school', action: 'setRetention', summary: changed.length ? changed.join('; ') : 'no change' });
  return { ...db.school.retention };
}

/**
 * What is due today, per category (pure). Undecided categories list nothing.
 * @returns {{asOf:string, leftWithoutDate:string[], categories:Object<string,{months:number|null, students:string[],
 *   expire:string[], deletes:Object<string,string[]>, due:number}>}}
 *   expire: photo ids to mark deleting (→ expired); deletes: row keys per collection (attendance: 'date|studentId').
 */
export function retentionPlan(db, today) {
  const r = (db.school && db.school.retention) || {};
  const left = db.students.filter(s => s.status === 'left');
  const leftWithoutDate = left.filter(s => !isISODate(s.leftOn)).map(s => s.id).sort();
  const categories = {};
  for (const [cat, key] of Object.entries(CATEGORIES)) {
    const months = Number.isSafeInteger(r[key]) ? r[key] : null;
    const students = months === null ? [] : left.filter(s => isISODate(s.leftOn) && compareISO(addMonths(s.leftOn, months), today) <= 0).map(s => s.id).sort();
    const ids = new Set(students);
    const of = c => (db[c] || []).filter(x => ids.has(x.studentId));
    const expire = [], deletes = {};
    const put = (c, list) => { if (list.length) deletes[c] = list; };
    if (cat === 'photos') expire.push(...of('photos').filter(x => LIVE_STATUSES.includes(x.status)).map(x => x.id));
    if (cat === 'observations') {
      put('observations', of('observations').map(x => x.id));
      put('progressEvents', of('progressEvents').map(x => x.id));
      expire.push(...of('photos').filter(x => LIVE_STATUSES.includes(x.status)).map(x => x.id));
      put('photos', of('photos').filter(x => TERMINAL_STATUSES.includes(x.status)).map(x => x.id));
    }
    if (cat === 'diary') { put('diaryEntries', of('diaryEntries').map(x => x.id)); put('reports', of('reports').map(x => x.id)); }
    if (cat === 'attendance') put('attendance', of('attendance').map(x => `${x.date}|${x.studentId}`));
    if (cat === 'messages') {
      const threads = new Set((db.threads || []).filter(t => ids.has(t.studentId)).map(t => t.id));
      put('messages', (db.messages || []).filter(m => threads.has(m.threadId)).map(m => m.id));
    }
    categories[cat] = { months, students, expire, deletes, due: expire.length + Object.values(deletes).reduce((s, l) => s + l.length, 0) };
  }
  return { asOf: today, leftWithoutDate, categories };
}

const rowKey = (c, x) => (c === 'attendance' ? `${x.date}|${x.studentId}` : x.id);

/**
 * Apply the rows the cron step listed ({expire:[photoId], deletes:{collection:[key]}}), each re-checked against
 * today's plan: anything no longer due is skipped. requested = expired + deleted + skipped (else VALIDATION).
 */
export function purgeRetention(db, request = {}, ctx) {
  const plan = retentionPlan(db, ctx.today);
  const dueExpire = new Set(Object.values(plan.categories).flatMap(c => c.expire));
  const dueDelete = {};
  for (const c of Object.values(plan.categories)) for (const [col, keys] of Object.entries(c.deletes)) for (const k of keys) (dueDelete[col] ||= new Set()).add(k);
  const reqExpire = [...new Set(Array.isArray(request.expire) ? request.expire : [])];
  const reqDeletes = request.deletes && typeof request.deletes === 'object' ? request.deletes : {};
  for (const col of Object.keys(reqDeletes)) if (!PURGEABLE.includes(col)) fail('NOT_ALLOWED', `Retention never deletes ${col}`);
  let requested = 0, expired = 0, skipped = 0;
  const deleted = {};
  for (const id of reqExpire) {
    requested++;
    const ph = db.photos.find(x => x.id === id);
    if (!ph || !dueExpire.has(id) || !LIVE_STATUSES.includes(ph.status)) { skipped++; continue; }
    Object.assign(ph, { status: 'deleting', deleteReason: RETENTION_REASON });
    expired++;
  }
  for (const [col, list] of Object.entries(reqDeletes)) {
    const keys = new Set(Array.isArray(list) ? list : []);
    requested += keys.size;
    const ok = new Set([...keys].filter(k => dueDelete[col] && dueDelete[col].has(k)));
    const before = db[col].length;
    db[col] = db[col].filter(x => !ok.has(rowKey(col, x)));
    deleted[col] = before - db[col].length;
    skipped += keys.size - deleted[col];
  }
  const nDeleted = Object.values(deleted).reduce((s, n) => s + n, 0);
  if (expired + nDeleted + skipped !== requested) fail('VALIDATION', 'Retention counts do not reconcile');
  appendAudit(db, ctx, { entity: 'retention', entityId: '-', action: 'purge',
    summary: `requested ${requested}: photos to expire ${expired}, deleted ${Object.entries(deleted).map(([c, n]) => `${c} ${n}`).join(', ') || 'none'}, skipped ${skipped}` });
  return { asOf: ctx.today, requested, expired, deleted, skipped };
}
