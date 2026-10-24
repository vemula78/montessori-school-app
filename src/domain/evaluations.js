// The annual Progress Report (evaluations): one per child and academic year, on the rubric of the child's LEVEL
// (students.level: toddlers | mont1 | mont2 | mont3; rooms are mixed-age, so the form follows the child, not the room).
// The level is frozen on the evaluation when it is started. Every item is rated on its section's scale
// (Progressing/Mastered or Developing/Developed). Attendance (working days, days present) is taken from the register
// for the academic year and kept up to date on every save until a teacher overrides it with a reason.
// Workflow, as termly reports (src/domain/reports.js): the teacher saves drafts, submits (every item rated); the
// principal publishes; a published evaluation never changes under a parent: a correction is unpublish (with a reason)
// → edit → submit → publish, and every change moves `revision` (an edit made against an older revision fails CONFLICT).
// Visibility: the principal; teachers of the child's programme; parents (either guardian) only published ones of their
// own children (the real app: RLS, migration 0010). Signers are frozen at publishing: the class teachers of the child's
// programme, the principal who published ("Center Head") and the director.
// Levels are promoted once per academic year (people.promoteLevels): each child's levelAy records the year its level is
// for, so running the promotion again changes nothing.

import { fail } from './ids.js';
import { isISODate, compareISO } from './dates.js';
import { byId, mustGet, fullName, activeStudents, sortByName } from './people.js';
import { appendAudit } from './audit.js';
import { attendanceSummary } from './attendance.js';
import { reportBlocker } from './reports.js';
import { learnerVisible, mustSeeLearner } from './observations.js';
import { RUBRICS, EVALUATION_LEVELS, SCALES, LEVEL_LABEL, RATING_LABEL, CULTURAL_STUDIES_FOOTNOTE } from './evaluation-rubrics.js';

export { EVALUATION_LEVELS, LEVEL_LABEL, RATING_LABEL };
export const EVALUATION_STATUSES = ['draft', 'submitted', 'published'];
export const REMARKS_MAX = 4000;
export const ATTENDANCE_REASON_MAX = 200;
export const NEXT_LEVEL = { toddlers: 'mont1', mont1: 'mont2', mont2: 'mont3', mont3: null };

/** One evaluation per child and academic year: the id names both (the database checks it). */
export const evaluationId = (academicYearId, studentId) => `evl-${academicYearId}-${studentId}`;

export function isLevel(level) { return EVALUATION_LEVELS.includes(level); }

/** Every item of a level's rubric, in form order: [{key, label, section, group, scale, values}]. */
export function rubricItems(level) {
  const r = RUBRICS[level];
  if (!r) fail('VALIDATION', `Unknown level: ${level}`);
  return r.sections.flatMap(s => s.items.map(it => ({ key: it.key, label: it.label, section: s.title, group: s.group, scale: s.scale, values: SCALES[s.scale] })));
}
const itemMap = level => new Map(rubricItems(level).map(it => [it.key, it]));

/** The level's form as the school wrote it: {level, label, title, footnote, sections:[{title, group, scale, values, items:[{key, label}]}]}. */
export function rubric(level) {
  const r = RUBRICS[level];
  if (!r) fail('VALIDATION', `Unknown level: ${level}`);
  return { level, label: LEVEL_LABEL[level], title: r.title, footnote: CULTURAL_STUDIES_FOOTNOTE,
    sections: r.sections.map(sec => ({ title: sec.title, group: sec.group, scale: sec.scale, values: [...SCALES[sec.scale]], items: sec.items.map(it => ({ ...it })) })) };
}

/** Items of the level not rated yet: [{key, label, section}]. */
export function missingItems(e) {
  return rubricItems(e.level).filter(it => !e.ratings[it.key]).map(({ key, label, section }) => ({ key, label, section }));
}

/** "2025-26" for an academic year (the form's header). */
export function yearLabel(ay) {
  if (!ay || !isISODate(ay.startDate) || !isISODate(ay.endDate)) return ay ? (ay.label || ay.id) : '';
  return `${ay.startDate.slice(0, 4)}-${ay.endDate.slice(2, 4)}`;
}

/**
 * Attendance for the academic year from the register (attendanceSummary over the child's own rows): working days of
 * the child's programme from the later of the year's start and the child's first register entry that year, to the
 * earliest of today, the year's end and the leaving date; present = present + late. unmarked = working days with no
 * register entry (shown to the teacher; they may override with a reason).
 */
export function attendanceFromRegister(db, studentId, academicYearId, today) {
  const s = mustGet(db, 'students', studentId, 'Student');
  const ay = mustGet(db, 'academicYears', academicYearId, 'Academic year');
  const rows = db.attendance.filter(a => a.studentId === studentId && compareISO(a.date, ay.startDate) >= 0 && compareISO(a.date, ay.endDate) <= 0);
  const first = rows.reduce((m, a) => (!m || compareISO(a.date, m) < 0 ? a.date : m), null);
  const from = first || ay.startDate;
  let to = compareISO(ay.endDate, today) < 0 ? ay.endDate : today;
  if (s.status === 'left' && isISODate(s.leftOn) && compareISO(s.leftOn, to) < 0) to = s.leftOn;
  if (compareISO(to, from) < 0) return { workingDays: 0, present: 0, unmarked: 0, source: 'register', from, to: from, reason: null };
  const sum = attendanceSummary({ ...db, attendance: rows }, studentId, from, to);
  return { workingDays: sum.workingDays, present: sum.present + sum.late, unmarked: sum.unmarked, source: 'register', from, to, reason: null };
}

function refreshAttendance(db, e, today) {
  if (e.attendance && e.attendance.source === 'teacher') return;
  e.attendance = attendanceFromRegister(db, e.studentId, e.academicYearId, today);
}

/** Why an evaluation cannot be started or published for this child today (null = it can). */
function blocker(db, s, today) {
  return reportBlocker(s, today);
}

function newEvaluation(db, s, ay, ctx) {
  return {
    id: evaluationId(ay.id, s.id), studentId: s.id, academicYearId: ay.id, level: s.level, programId: s.programId,
    ratings: {}, attendance: attendanceFromRegister(db, s.id, ay.id, ctx.today), remarks: '', status: 'draft', revision: 1,
    createdBy: ctx.actor.id, createdAt: ctx.now, updatedBy: ctx.actor.id, updatedAt: ctx.now,
    submittedBy: null, submittedAt: null, publishedBy: null, publishedAt: null, lastPublishedAt: null, unpublishedReason: null, signers: null,
  };
}

/** start({studentId, academicYearId}) — one child; the child needs a level. Refused when this year's evaluation exists. */
export function startEvaluation(db, { studentId, academicYearId } = {}, ctx) {
  const s = mustGet(db, 'students', studentId, 'Student');
  const ay = mustGet(db, 'academicYears', academicYearId, 'Academic year');
  const why = blocker(db, s, ctx.today);
  if (why) fail('VALIDATION', why);
  if (!isLevel(s.level)) fail('VALIDATION', 'Set this child\'s level (Toddlers, Mont 1, Mont 2 or Mont 3) first');
  if (db.evaluations.some(e => e.id === evaluationId(ay.id, s.id))) fail('VALIDATION', `This child's ${yearLabel(ay)} progress report is already started`);
  const e = newEvaluation(db, s, ay, ctx);
  db.evaluations.push(e);
  appendAudit(db, ctx, { entity: 'evaluation', entityId: e.id, action: 'start', summary: `progress report ${ay.id} started for student ${s.id} (level ${s.level})` });
  return e;
}

/**
 * startClass({programId, academicYearId}) — a draft for every active child of the programme, skipping those already
 * started and those without a level. Counts add up: children = started + skippedExisting + skippedNoLevel.
 */
export function startClassEvaluations(db, { programId, academicYearId } = {}, ctx) {
  mustGet(db, 'programs', programId, 'Program');
  const ay = mustGet(db, 'academicYears', academicYearId, 'Academic year');
  const kids = activeStudents(db, programId);
  const started = [], skippedExisting = [], skippedNoLevel = [];
  for (const s of sortByName(kids)) {
    if (db.evaluations.some(e => e.id === evaluationId(ay.id, s.id))) { skippedExisting.push(s.id); continue; }
    if (!isLevel(s.level)) { skippedNoLevel.push(s.id); continue; }
    const e = newEvaluation(db, s, ay, ctx);
    db.evaluations.push(e);
    started.push(e);
  }
  const res = { children: kids.length, started: started.length, skippedExisting: skippedExisting.length, skippedNoLevel: skippedNoLevel.length,
    evaluationIds: started.map(e => e.id), skippedExistingIds: skippedExisting, skippedNoLevelIds: skippedNoLevel };
  if (res.started + res.skippedExisting + res.skippedNoLevel !== res.children) fail('VALIDATION', 'Start counts do not reconcile');
  appendAudit(db, ctx, { entity: 'evaluation', entityId: programId, action: 'startClass', summary: `progress reports ${ay.id} for programme ${programId}: ${res.children} children, ${res.started} started, ${res.skippedExisting} already started, ${res.skippedNoLevel} without a level` });
  return res;
}

const editable = e => { if (e.status === 'published') fail('VALIDATION', 'A published progress report cannot be changed; the principal can unpublish it'); };
const sameRevision = (e, revision) => {
  if (revision === undefined || revision === null) return;
  if (revision !== e.revision) fail('CONFLICT', 'Someone else changed this progress report meanwhile; reload it and make your change again');
};

function cleanAttendance(a) {
  if (a === 'register') return 'register';
  if (!a || typeof a !== 'object') fail('VALIDATION', 'attendance must be "register" or {workingDays, present, reason}');
  const { workingDays, present, reason } = a;
  if (!Number.isSafeInteger(workingDays) || workingDays < 0 || workingDays > 366) fail('VALIDATION', 'Working days must be a whole number from 0 to 366');
  if (!Number.isSafeInteger(present) || present < 0) fail('VALIDATION', 'Days present must be a whole number, 0 or more');
  if (present > workingDays) fail('VALIDATION', 'Days present cannot be more than the working days');
  const why = String(reason ?? '').trim();
  if (!why) fail('VALIDATION', 'Give the reason for changing the register\'s figures');
  if (why.length > ATTENDANCE_REASON_MAX) fail('VALIDATION', `The reason must be at most ${ATTENDANCE_REASON_MAX} characters`);
  return { workingDays, present, reason: why };
}

/**
 * save(id, {ratings?, remarks?, attendance?, revision}) — ratings is a patch {itemKey: value | null} (null clears one);
 * each value must be on its section's scale. attendance: 'register' (back to the register's figures) or
 * {workingDays, present, reason} (a teacher's figures, with the reason). Register figures are refreshed on every save.
 */
export function saveEvaluation(db, id, { ratings, remarks, attendance, revision } = {}, ctx) {
  const e = mustGet(db, 'evaluations', id, 'Progress report');
  editable(e);
  if (revision === undefined || revision === null) fail('VALIDATION', 'Send the revision you started editing from');
  sameRevision(e, revision);
  const items = itemMap(e.level);
  const changes = [];
  if (ratings !== undefined) {
    if (!ratings || typeof ratings !== 'object' || Array.isArray(ratings)) fail('VALIDATION', 'ratings must be {itemKey: value}');
    const next = { ...e.ratings };
    for (const [k, v] of Object.entries(ratings)) {
      const it = items.get(k);
      if (!it) fail('VALIDATION', `Unknown item for ${LEVEL_LABEL[e.level]}: ${k}`);
      if (v === null || v === '') { delete next[k]; continue; }
      if (!it.values.includes(v)) fail('VALIDATION', `"${it.label}" is rated ${it.values.map(x => RATING_LABEL[x]).join(' or ')}`);
      next[k] = v;
    }
    const n = Object.keys(ratings).length;
    if (n) changes.push(`${n} rating(s)`);
    e.ratings = next;
  }
  if (remarks !== undefined) {
    const t = String(remarks ?? '').trim();
    if (t.length > REMARKS_MAX) fail('VALIDATION', `General remarks must be at most ${REMARKS_MAX} characters`);
    if (t !== e.remarks) changes.push('remarks');
    e.remarks = t;
  }
  if (attendance !== undefined) {
    const a = cleanAttendance(attendance);
    if (a === 'register') {
      e.attendance = attendanceFromRegister(db, e.studentId, e.academicYearId, ctx.today);
      changes.push('attendance from the register');
    } else {
      const reg = attendanceFromRegister(db, e.studentId, e.academicYearId, ctx.today);
      e.attendance = { workingDays: a.workingDays, present: a.present, unmarked: null, source: 'teacher', from: reg.from, to: reg.to, reason: a.reason,
        register: { workingDays: reg.workingDays, present: reg.present, unmarked: reg.unmarked } };
      changes.push('attendance set by the teacher');
    }
  } else refreshAttendance(db, e, ctx.today);
  Object.assign(e, { revision: e.revision + 1, updatedBy: ctx.actor.id, updatedAt: ctx.now });
  appendAudit(db, ctx, { entity: 'evaluation', entityId: e.id, action: 'save', summary: `${changes.join(', ') || 'saved'} (revision ${e.revision})` });
  return e;
}

/** submit(id, {revision?}) — a draft with every item rated goes to the principal. */
export function submitEvaluation(db, id, { revision } = {}, ctx) {
  const e = mustGet(db, 'evaluations', id, 'Progress report');
  if (e.status !== 'draft') fail('VALIDATION', `Only a draft can be submitted (this one is ${e.status})`);
  sameRevision(e, revision);
  const missing = missingItems(e);
  if (missing.length) fail('VALIDATION', `${missing.length} item(s) are not rated yet`, { missing });
  refreshAttendance(db, e, ctx.today);
  Object.assign(e, { status: 'submitted', submittedBy: ctx.actor.id, submittedAt: ctx.now, revision: e.revision + 1, updatedBy: ctx.actor.id, updatedAt: ctx.now });
  appendAudit(db, ctx, { entity: 'evaluation', entityId: e.id, action: 'submit', summary: `submitted for publishing (revision ${e.revision})` });
  return e;
}

/** The class teachers who sign: active teachers of the child's programme (staff.programIds is what RLS reads). */
export function classTeacherIds(db, programId) {
  return db.staff.filter(s => s.role === 'teacher' && s.active !== false && (s.programIds || []).includes(programId)).map(s => s.id).sort();
}

/** publish(id, {revision?}) — the principal; the signers are frozen with it. */
export function publishEvaluation(db, id, { revision } = {}, ctx) {
  const e = mustGet(db, 'evaluations', id, 'Progress report');
  if (e.status !== 'submitted') fail('VALIDATION', `Only a submitted progress report can be published (this one is ${e.status})`);
  sameRevision(e, revision);
  const s = byId(db.students, e.studentId);
  const why = blocker(db, s, ctx.today);
  if (why) fail('VALIDATION', why);
  if (missingItems(e).length) fail('VALIDATION', 'Every item must be rated before publishing');
  Object.assign(e, { status: 'published', publishedBy: ctx.actor.id, publishedAt: ctx.now, unpublishedReason: null, revision: e.revision + 1,
    signers: { teacherIds: classTeacherIds(db, s.programId), centerHeadId: ctx.actor.id }, updatedBy: ctx.actor.id, updatedAt: ctx.now });
  appendAudit(db, ctx, { entity: 'evaluation', entityId: e.id, action: 'publish', summary: `progress report ${e.academicYearId} published for student ${e.studentId} (revision ${e.revision})` });
  return e;
}

/** unpublish(id, reason) — the principal, for a correction; back to draft, the reason kept. */
export function unpublishEvaluation(db, id, reason, ctx) {
  const e = mustGet(db, 'evaluations', id, 'Progress report');
  if (e.status !== 'published') fail('VALIDATION', 'This progress report is not published');
  const why = String(reason ?? '').trim();
  if (!why) fail('VALIDATION', 'Give the reason for unpublishing');
  if (why.length > ATTENDANCE_REASON_MAX) fail('VALIDATION', `The reason must be at most ${ATTENDANCE_REASON_MAX} characters`);
  Object.assign(e, { status: 'draft', submittedAt: null, submittedBy: null, unpublishedReason: why, lastPublishedAt: e.publishedAt, publishedAt: null, publishedBy: null,
    signers: null, revision: e.revision + 1, updatedBy: ctx.actor.id, updatedAt: ctx.now });
  appendAudit(db, ctx, { entity: 'evaluation', entityId: e.id, action: 'unpublish', summary: `unpublished for correction (revision ${e.revision})` });
  return e;
}

// ---------------------------------------------------------------- reads (both modes; RLS mirrors them in the real app)

const visible = (p, e) => learnerVisible(p, e.studentId) && (p.role !== 'parent' || e.status === 'published');

/** The evaluation with its rubric filled in: sections [{title, group, scale, values, items:[{key, label, rating}]}]. */
export function evaluationView(db, e) {
  const s = byId(db.students, e.studentId);
  const sections = RUBRICS[e.level].sections.map(sec => ({ title: sec.title, group: sec.group, scale: sec.scale, values: SCALES[sec.scale],
    items: sec.items.map(it => ({ key: it.key, label: it.label, rating: e.ratings[it.key] || null })) }));
  const total = sections.reduce((n, x) => n + x.items.length, 0);
  const rated = sections.reduce((n, x) => n + x.items.filter(i => i.rating).length, 0);
  return { ...e, studentName: s ? fullName(s) : '—', levelLabel: LEVEL_LABEL[e.level], levelTitle: RUBRICS[e.level].title, sections, total, rated, missing: total - rated };
}

/** list({programId?, studentId?, academicYearId?}) → evaluations this persona may see (parents: published, own children). */
export function listEvaluations(db, p, { programId, studentId, academicYearId } = {}) {
  if (!p || !['admin', 'teacher', 'parent'].includes(p.role)) fail('NOT_ALLOWED', 'Not available to you');
  if (studentId) mustSeeLearner(p, db, studentId);
  const inProg = programId ? new Set(db.students.filter(s => s.programId === programId).map(s => s.id)) : null;
  return (db.evaluations || []).filter(e => visible(p, e) && (!studentId || e.studentId === studentId) && (!inProg || inProg.has(e.studentId))
    && (!academicYearId || e.academicYearId === academicYearId))
    .map(e => evaluationView(db, e))
    .sort((a, b) => (a.academicYearId < b.academicYearId ? 1 : a.academicYearId > b.academicYearId ? -1 : a.studentName.localeCompare(b.studentName)));
}

export function getEvaluation(db, p, id) {
  const e = byId(db.evaluations || [], id);
  if (!e) fail('NOT_FOUND', 'Progress report not found');
  if (!p || !['admin', 'teacher', 'parent'].includes(p.role) || !visible(p, e)) fail('NOT_ALLOWED', 'Not your progress report');
  return evaluationView(db, e);
}

/**
 * The teacher's class list: classStatus({programId, academicYearId}) → [{studentId, name, level, levelLabel, evaluationId,
 * status:'not_started'|'draft'|'submitted'|'published', missing, revision}] for every active child of the programme.
 */
export function classStatus(db, p, { programId, academicYearId } = {}) {
  if (!p || !['admin', 'teacher'].includes(p.role)) fail('NOT_ALLOWED', 'Not available to you');
  mustGet(db, 'programs', programId, 'Program');
  if (p.role === 'teacher' && !(p.programIds || []).includes(programId)) fail('NOT_ALLOWED', 'Not your program');
  mustGet(db, 'academicYears', academicYearId, 'Academic year');
  return sortByName(activeStudents(db, programId)).map(s => {
    const e = byId(db.evaluations || [], evaluationId(academicYearId, s.id));
    return { studentId: s.id, name: fullName(s), level: s.level || null, levelLabel: s.level ? LEVEL_LABEL[s.level] : null, evaluationId: e ? e.id : null,
      status: e ? e.status : 'not_started', missing: e ? missingItems(e).length : null, revision: e ? e.revision : null };
  });
}

/**
 * Who signs this report: [{role:'teacher'|'centerHead'|'director', staffId|null, name}]. Published: the frozen signers;
 * otherwise (a staff preview) the programme's class teachers and the first active principal.
 */
export function evaluationSigners(db, e) {
  const s = byId(db.students, e.studentId);
  const teacherIds = e.signers ? e.signers.teacherIds : classTeacherIds(db, s ? s.programId : e.programId);
  const head = e.signers ? e.signers.centerHeadId : (db.staff.filter(x => x.role === 'admin' && x.active !== false).map(x => x.id).sort()[0] || null);
  const out = teacherIds.map(id => ({ role: 'teacher', staffId: id, name: fullName(byId(db.staff, id)) }));
  if (head) out.push({ role: 'centerHead', staffId: head, name: fullName(byId(db.staff, head)) });
  out.push({ role: 'director', staffId: null, name: (db.school && db.school.directorName) || '' });
  return out;
}

/**
 * Everything the print page lays out except the signature images (the api adds those as Blobs): the school's footer,
 * the header (level title, YEAR, name, date of birth, admission number), the rated sections, attendance, remarks and
 * the signers. The footer comes from school settings (principal-entered); nothing is hard-coded.
 */
export function evaluationPrintView(db, p, id) {
  const e = getEvaluation(db, p, id);
  const s = mustGet(db, 'students', e.studentId, 'Student');
  const ay = byId(db.academicYears, e.academicYearId);
  const school = db.school || {};
  const f = school.reportFooter || null;
  return {
    evaluation: e,
    school: { name: school.name || '', directorName: school.directorName || '',
      footer: { address: f ? f.address : school.address || '', phones: f ? [...f.phones] : (school.phone ? [school.phone] : []), email: f ? f.email : '', website: f ? f.website : '' } },
    header: { levelTitle: e.levelTitle, title: 'PROGRESS REPORT', year: yearLabel(ay), name: fullName(s), dob: s.dob, admissionNo: s.admissionNo },
    sections: e.sections, footnote: CULTURAL_STUDIES_FOOTNOTE, attendance: { workingDays: e.attendance.workingDays, present: e.attendance.present },
    remarks: e.remarks, signers: evaluationSigners(db, e), draft: e.status !== 'published',
  };
}

// ---------------------------------------------------------------- level promotion (academic-year rollover)

/**
 * What promoting to academic year `toAcademicYearId` would do, for every active child: promote (level → next),
 * final (Mont 3 stays), noLevel (no level set), already (level already for that year). Counts add up to children.
 */
export function promotionPlan(db, toAcademicYearId) {
  mustGet(db, 'academicYears', toAcademicYearId, 'Academic year');
  const rows = sortByName(activeStudents(db)).map(s => {
    const base = { studentId: s.id, name: fullName(s), programId: s.programId, from: s.level || null, to: null };
    if (!isLevel(s.level)) return { ...base, outcome: 'noLevel' };
    if (s.levelAy === toAcademicYearId) return { ...base, outcome: 'already' };
    if (!NEXT_LEVEL[s.level]) return { ...base, outcome: 'final' };
    return { ...base, to: NEXT_LEVEL[s.level], outcome: 'promote' };
  });
  const count = k => rows.filter(r => r.outcome === k).length;
  return { toAcademicYearId, children: rows.length, promote: count('promote'), final: count('final'), noLevel: count('noLevel'), already: count('already'), rows };
}

/**
 * promoteLevels({toAcademicYearId, skip:[studentId]}) — the principal, after the preview. A skipped child (only one who
 * would be promoted) keeps their level and is marked as decided for that year. Running it again changes nothing.
 * Counts: children = promoted + skipped + final + noLevel + already.
 */
export function promoteLevels(db, { toAcademicYearId, skip = [] } = {}, ctx) {
  if (!Array.isArray(skip)) fail('VALIDATION', 'skip must be a list of children');
  const plan = promotionPlan(db, toAcademicYearId);
  const skipSet = new Set(skip.map(String));
  for (const id of skipSet) if (!plan.rows.some(r => r.studentId === id)) fail('VALIDATION', `Not an active child: ${id}`);
  let promoted = 0, skipped = 0;
  for (const r of plan.rows) {
    const s = byId(db.students, r.studentId);
    if (r.outcome === 'promote') {
      if (skipSet.has(s.id)) skipped++; else { s.level = r.to; promoted++; }
      s.levelAy = toAcademicYearId;
    } else if (r.outcome === 'final') s.levelAy = toAcademicYearId; // Mont 3 stays Mont 3
  }
  const res = { toAcademicYearId, children: plan.children, promoted, skipped, final: plan.final, noLevel: plan.noLevel, already: plan.already };
  if (res.promoted + res.skipped + res.final + res.noLevel + res.already !== res.children) fail('VALIDATION', 'Promotion counts do not reconcile');
  appendAudit(db, ctx, { entity: 'student', entityId: '-', action: 'promoteLevels', summary: `levels for ${toAcademicYearId}: ${res.children} children, ${res.promoted} promoted, ${res.skipped} kept back, ${res.final} at the last level, ${res.noLevel} without a level, ${res.already} already done` });
  return res;
}
