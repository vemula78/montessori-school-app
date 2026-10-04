// Termly reports, frozen at generation: the progress state as of toDate (with the presentations' names copied in) and
// the SHARED observations in the term (text only; photos stay in the app). The teacher writes a narrative per area,
// submits; the principal publishes. A published report never changes under a parent: a correction is unpublish
// (principal, with a reason) → edit/regenerate → submit → publish, and every change moves `revision` (an edit made
// against an older revision fails CONFLICT). One report per child, academic year and term.
// A child who has left can have a report generated/published up to 12 months after leftOn.

import { fail, newId } from './ids.js';
import { isISODate, compareISO } from './dates.js';
import { byId, mustGet } from './people.js';
import { appendAudit } from './audit.js';
import { OBSERVATION_AREAS } from './diary.js';
import { deriveState } from './progress.js';
import { addMonths } from './retention.js';
import { learnerVisible, mustSeeLearner } from './observations.js';

export const TERMS = ['Term 1', 'Term 2', 'Term 3'];
export const NARRATIVE_KEYS = [...OBSERVATION_AREAS, 'overall'];
export const NARRATIVE_MAX = 4000;
export const LEFT_REPORT_MONTHS = 12;

/** Why reports cannot be made for this child today (null = they can). */
export function reportBlocker(s, today) {
  if (!s) return 'Student not found';
  if (s.status === 'active') return null;
  if (!isISODate(s.leftOn)) return 'This child has left and the leaving date is not recorded; set it first';
  if (compareISO(addMonths(s.leftOn, LEFT_REPORT_MONTHS), today) < 0) return `This child left more than ${LEFT_REPORT_MONTHS} months ago`;
  return null;
}

const areaOrder = a => { const i = OBSERVATION_AREAS.indexOf(a); return i < 0 ? 99 : i; };

/** The frozen content of a report (pure). */
export function reportContent(db, studentId, fromDate, toDate) {
  const state = deriveState((db.progressEvents || []).filter(e => e.studentId === studentId && compareISO(e.date, toDate) <= 0));
  const progress = state.map(x => {
    const pr = byId(db.presentations || [], x.presentationId);
    return { presentationId: x.presentationId, name: pr ? pr.name : '(removed presentation)', area: pr ? pr.area : null, status: x.status, date: x.date, seq: pr ? pr.sequence ?? 0 : 0 };
  }).sort((a, b) => areaOrder(a.area) - areaOrder(b.area) || a.seq - b.seq || a.name.localeCompare(b.name)).map(({ seq, ...r }) => r);
  const observations = (db.observations || []).filter(o => o.studentId === studentId && o.sharedAt && o.date >= fromDate && o.date <= toDate)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt < b.createdAt ? -1 : 1))
    .map(o => ({ id: o.id, date: o.date, area: o.area, text: o.text }));
  return { progress, observations };
}

/**
 * generate({studentId, academicYearId, termName, fromDate, toDate}) — creates the report, or refreshes a draft/
 * submitted one in place (narratives kept, back to draft). A published report must be unpublished first.
 */
export function generateReport(db, input = {}, ctx) {
  const { studentId, academicYearId, termName, fromDate, toDate } = input;
  const s = mustGet(db, 'students', studentId, 'Student');
  const ay = mustGet(db, 'academicYears', academicYearId, 'Academic year');
  if (!TERMS.includes(termName)) fail('VALIDATION', `Unknown term: ${termName}`);
  if (!isISODate(fromDate) || !isISODate(toDate)) fail('VALIDATION', 'Term dates must be YYYY-MM-DD');
  if (compareISO(fromDate, toDate) > 0) fail('VALIDATION', 'The term ends before it starts');
  if (compareISO(fromDate, ay.startDate) < 0 || compareISO(toDate, ay.endDate) > 0) fail('VALIDATION', `The term must lie inside ${ay.label || ay.id}`);
  const blocker = reportBlocker(s, ctx.today);
  if (blocker) fail('VALIDATION', blocker);
  const content = reportContent(db, s.id, fromDate, toDate);
  let r = db.reports.find(x => x.studentId === s.id && x.academicYearId === ay.id && x.termName === termName);
  if (r && r.status === 'published') fail('VALIDATION', 'This term\'s report is published; the principal must unpublish it before it can be regenerated');
  if (r) {
    Object.assign(r, { fromDate, toDate, ...content, status: 'draft', submittedAt: null, generatedAt: ctx.now, generatedBy: ctx.actor.id, revision: r.revision + 1 });
  } else {
    r = { id: newId('rep'), studentId: s.id, academicYearId: ay.id, termName, fromDate, toDate, status: 'draft', revision: 1, ...content,
      narratives: Object.fromEntries(NARRATIVE_KEYS.map(k => [k, ''])), generatedAt: ctx.now, generatedBy: ctx.actor.id,
      submittedAt: null, publishedAt: null, publishedBy: null, unpublishReason: null };
    db.reports.push(r);
  }
  appendAudit(db, ctx, { entity: 'report', entityId: r.id, action: 'generate', summary: `${termName} ${ay.id} for student ${s.id}: ${content.progress.length} progress line(s), ${content.observations.length} observation(s), revision ${r.revision}` });
  return r;
}

const editable = r => { if (r.status === 'published') fail('VALIDATION', 'A published report cannot be changed; the principal can unpublish it'); };
const sameRevision = (r, revision) => { if (revision !== r.revision) fail('CONFLICT', 'Someone else changed this report meanwhile; reload it and make your change again'); };

/** saveNarratives(reportId, {narratives:{area:text}, revision}) — revision = the one the editor started from. */
export function saveNarratives(db, reportId, { narratives, revision } = {}, ctx) {
  const r = mustGet(db, 'reports', reportId, 'Report');
  editable(r);
  sameRevision(r, revision);
  if (!narratives || typeof narratives !== 'object') fail('VALIDATION', 'narratives must be an object');
  const next = { ...r.narratives };
  for (const [k, v] of Object.entries(narratives)) {
    if (!NARRATIVE_KEYS.includes(k)) fail('VALIDATION', `Unknown narrative: ${k}`);
    const t = String(v ?? '').trim();
    if (t.length > NARRATIVE_MAX) fail('VALIDATION', `The ${k} narrative is longer than ${NARRATIVE_MAX} characters`);
    next[k] = t;
  }
  Object.assign(r, { narratives: next, revision: r.revision + 1 });
  appendAudit(db, ctx, { entity: 'report', entityId: r.id, action: 'saveNarratives', summary: `narratives saved (revision ${r.revision})` });
  return r;
}

export function submitReport(db, reportId, ctx) {
  const r = mustGet(db, 'reports', reportId, 'Report');
  if (r.status !== 'draft') fail('VALIDATION', `Only a draft can be submitted (this one is ${r.status})`);
  Object.assign(r, { status: 'submitted', submittedAt: ctx.now, revision: r.revision + 1 });
  appendAudit(db, ctx, { entity: 'report', entityId: r.id, action: 'submit', summary: `submitted for publishing (revision ${r.revision})` });
  return r;
}

export function publishReport(db, reportId, ctx) {
  const r = mustGet(db, 'reports', reportId, 'Report');
  if (r.status !== 'submitted') fail('VALIDATION', `Only a submitted report can be published (this one is ${r.status})`);
  const blocker = reportBlocker(byId(db.students, r.studentId), ctx.today);
  if (blocker) fail('VALIDATION', blocker);
  Object.assign(r, { status: 'published', publishedAt: ctx.now, publishedBy: ctx.actor.id, unpublishReason: null, revision: r.revision + 1 });
  appendAudit(db, ctx, { entity: 'report', entityId: r.id, action: 'publish', summary: `${r.termName} ${r.academicYearId} published for student ${r.studentId} (revision ${r.revision})` });
  return r;
}

export function unpublishReport(db, reportId, reason, ctx) {
  const r = mustGet(db, 'reports', reportId, 'Report');
  if (r.status !== 'published') fail('VALIDATION', 'This report is not published');
  const why = String(reason ?? '').trim();
  if (!why) fail('VALIDATION', 'Give the reason for unpublishing');
  Object.assign(r, { status: 'draft', submittedAt: null, unpublishReason: why, lastPublishedAt: r.publishedAt, publishedAt: null, publishedBy: null, revision: r.revision + 1 });
  appendAudit(db, ctx, { entity: 'report', entityId: r.id, action: 'unpublish', summary: `unpublished for correction (revision ${r.revision})` });
  return r;
}

/** Reports a persona may see: parents only published ones of their own children. */
export function listReports(db, p, { studentId, academicYearId } = {}) {
  if (!p || !['admin', 'teacher', 'parent'].includes(p.role)) fail('NOT_ALLOWED', 'Not available to you');
  if (studentId) mustSeeLearner(p, db, studentId);
  return (db.reports || []).filter(r => learnerVisible(p, r.studentId) && (p.role !== 'parent' || r.status === 'published')
    && (!studentId || r.studentId === studentId) && (!academicYearId || r.academicYearId === academicYearId))
    .sort((a, b) => (a.academicYearId < b.academicYearId ? 1 : a.academicYearId > b.academicYearId ? -1 : TERMS.indexOf(b.termName) - TERMS.indexOf(a.termName)));
}

export function getReport(db, p, id) {
  const r = byId(db.reports || [], id);
  if (!r) fail('NOT_FOUND', 'Report not found');
  if (!learnerVisible(p, r.studentId) || (p.role === 'parent' && r.status !== 'published') || !['admin', 'teacher', 'parent'].includes(p.role)) fail('NOT_ALLOWED', 'Not your report');
  return r;
}
