// Administration module: pure rules shared by the demo, the command registry and the server.
//   twoStepRequired  the one two-step rule (SQL twin: app.two_step_ok in migration 0008)
//   whoCanSee        who can open a child's record, built from the same personas the commands authorize with
//   listDataRequests the data-rights desk (a parent: own requests; the principal: every family's)
//   announcement     the school-wide banner (plain text, at most 280 characters)
// No DOM, no I/O.

import { fail, newId } from './ids.js';
import { byId, fullName } from './people.js';
import { isISODate, compareISO } from './dates.js';
import { appendAudit } from './audit.js';
// commands.js imports this module too; these are used only inside functions, so the cycle is safe
import { buildPersonas, sees, consentScopedPersona, CONSENT_VERSION } from './commands.js';

export const PRIVILEGED_ROLES = ['admin', 'accountant'];
export const ANNOUNCEMENT_MAX = 280;
export const ANNOUNCEMENT_TONES = ['info', 'warn'];
export const DATA_REQUEST_KINDS = ['export', 'erasure', 'correction'];
export const DATA_REQUEST_STATUSES = ['open', 'in_progress', 'done', 'declined'];
export const DATA_REQUEST_OPEN = ['open', 'in_progress'];
export const DATA_REQUEST_TEXT_MAX = 1000;
export const ACCOUNT_STATUSES = ['active', 'blocked', 'revoked', 'withdrawn', 'pending'];

/**
 * Must this session complete two-step sign-in before it reaches any data or command?
 * Only the principal and the accountant are asked; an enrolled user is protected from the moment the factor is
 * verified, everyone privileged once the school's policy requires it. aal2 = the session already did the second step.
 * @param {{role:string, aal?:string|null, enrolled?:boolean, policyRequired?:boolean}} s
 */
export function twoStepRequired({ role, aal = null, enrolled = false, policyRequired = false } = {}) {
  return aal !== 'aal2' && PRIVILEGED_ROLES.includes(role) && (policyRequired === true || enrolled === true);
}

// ---------------------------------------------------------------- announcement

/** The banner if it is still current on `today` (until is the last day it shows), else null. */
export function activeAnnouncement(school, today) {
  const a = school && school.announcement;
  if (!a || typeof a.text !== 'string' || !a.text) return null;
  if (a.until && today && compareISO(a.until, today) < 0) return null;
  return a;
}

/** Plain text only: a tag-like "<x", "</", "<!" or "<?" is refused (the banner is escaped as well, never trusted). */
const HTML_LIKE = /<\s*[a-z!/?]/i;
export function setAnnouncement(db, { text, tone = 'info', until = null } = {}, ctx) {
  const t = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!t) fail('VALIDATION', 'Write the announcement');
  if (t.length > ANNOUNCEMENT_MAX) fail('VALIDATION', `The announcement is longer than ${ANNOUNCEMENT_MAX} characters`);
  if (HTML_LIKE.test(t)) fail('VALIDATION', 'The announcement must be plain text (no HTML)');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(t)) fail('VALIDATION', 'The announcement contains control characters');
  if (!ANNOUNCEMENT_TONES.includes(tone)) fail('VALIDATION', `Unknown tone: ${tone}`);
  if (until !== null && until !== undefined && until !== '') {
    if (!isISODate(until)) fail('VALIDATION', `Invalid date: ${until}`);
    if (compareISO(until, ctx.today) < 0) fail('VALIDATION', 'The last day of the announcement is in the past');
  } else until = null;
  const a = { text: t, tone, until, setBy: ctx.actor.id, setAt: ctx.now };
  db.school.announcement = a;
  appendAudit(db, ctx, { entity: 'school', entityId: 'announcement', action: 'setAnnouncement', summary: `announcement set (${tone}, ${t.length} characters, until ${until || 'cleared by hand'})` });
  return a;
}

export function clearAnnouncement(db, ctx) {
  const had = Boolean(db.school.announcement);
  db.school.announcement = null;
  appendAudit(db, ctx, { entity: 'school', entityId: 'announcement', action: 'clearAnnouncement', summary: had ? 'announcement cleared' : 'no announcement to clear' });
  return null;
}

// ---------------------------------------------------------------- data-rights desk

const cleanText = (v, what, required) => {
  const t = String(v ?? '').trim();
  if (required && !t) fail('VALIDATION', `${what} is required`);
  if (t.length > DATA_REQUEST_TEXT_MAX) fail('VALIDATION', `${what} is longer than ${DATA_REQUEST_TEXT_MAX} characters`);
  return t;
};

export const dataRequestView = (db, r) => ({ ...r, guardianName: fullName(byId(db.guardians, r.guardianId)) });

/** A parent files a request about their own data: export, erasure or correction. One open request per kind. */
export function fileDataRequest(db, guardianId, { kind, details = '' } = {}, ctx) {
  if (!DATA_REQUEST_KINDS.includes(kind)) fail('VALIDATION', `Unknown request kind: ${kind}`);
  if (!byId(db.guardians, guardianId)) fail('NOT_FOUND', 'Guardian not found');
  const d = cleanText(details, 'What should be corrected', kind === 'correction');
  if ((db.dataRequests || []).some(r => r.guardianId === guardianId && r.kind === kind && DATA_REQUEST_OPEN.includes(r.status))) {
    fail('VALIDATION', `You already have an open ${kind} request; the school will answer it first`);
  }
  const r = { id: newId('drq'), guardianId, kind, details: d, status: 'open', filedAt: ctx.now, filedBy: ctx.actor.id, updatedAt: ctx.now,
    resolution: null, decidedBy: null, decidedAt: null };
  db.dataRequests.push(r);
  appendAudit(db, ctx, { entity: 'dataRequest', entityId: r.id, action: 'file', summary: `${kind} request filed for guardian ${guardianId}` });
  return dataRequestView(db, r);
}

/**
 * The principal moves a request on: open → in_progress → done | declined (or straight to done/declined).
 * Closing needs a resolution (what was done, or why not) and is final.
 */
export function updateDataRequest(db, id, { status, resolution } = {}, ctx) {
  const r = byId(db.dataRequests || [], id);
  if (!r) fail('NOT_FOUND', 'Request not found');
  if (!DATA_REQUEST_STATUSES.includes(status)) fail('VALIDATION', `Unknown status: ${status}`);
  if (!DATA_REQUEST_OPEN.includes(r.status)) fail('VALIDATION', `This request is already ${r.status}; a closed request is final`);
  const closing = !DATA_REQUEST_OPEN.includes(status);
  const res = cleanText(resolution, 'The resolution', closing);
  if (status === r.status && !res) fail('VALIDATION', `The request is already ${status}`);
  const before = r.status;
  Object.assign(r, { status, updatedAt: ctx.now, resolution: res || r.resolution || null });
  if (closing) Object.assign(r, { decidedBy: ctx.actor.id, decidedAt: ctx.now });
  appendAudit(db, ctx, { entity: 'dataRequest', entityId: r.id, action: 'update', summary: `${r.kind} request ${before} → ${status}` });
  return dataRequestView(db, r);
}

/** Erasure carried out (people.anonymiseGuardian): the guardian's open erasure requests are done. */
export function closeErasureRequests(db, guardianId, ctx) {
  let n = 0;
  for (const r of db.dataRequests || []) {
    if (r.guardianId !== guardianId || r.kind !== 'erasure' || !DATA_REQUEST_OPEN.includes(r.status)) continue;
    Object.assign(r, { status: 'done', updatedAt: ctx.now, decidedBy: ctx.actor.id, decidedAt: ctx.now,
      resolution: 'Erased by the principal; fee records, consent records and audit entries are kept as the law requires.' });
    n++;
  }
  return n;
}

/** A parent: their own requests; the principal: every family's. Newest first. */
export function listDataRequests(db, p) {
  if (!p || !['admin', 'parent'].includes(p.role)) fail('NOT_ALLOWED', 'Not available to you');
  const rows = (db.dataRequests || []).filter(r => p.role === 'admin' || r.guardianId === p.guardianId);
  return rows.map(r => dataRequestView(db, r)).sort((a, b) => (a.filedAt < b.filedAt ? 1 : a.filedAt > b.filedAt ? -1 : 0));
}

// ---------------------------------------------------------------- guardian corrections (the data-rights "correction" desk)

const GUARDIAN_FIELDS = ['firstName', 'lastName', 'phone', 'relation'];
/** Correct a guardian's name, phone or relation (principal). The sign-in email changes only through the account desk. */
export function updateGuardian(db, { guardianId, ...patch } = {}, ctx) {
  const g = byId(db.guardians, guardianId);
  if (!g) fail('NOT_FOUND', 'Guardian not found');
  if (/^Erased-\d+$/.test(g.firstName)) fail('VALIDATION', 'This guardian was erased; the record cannot be filled in again');
  const keys = Object.keys(patch);
  if (!keys.length) fail('VALIDATION', 'Nothing to change');
  for (const k of keys) if (!GUARDIAN_FIELDS.includes(k)) fail('VALIDATION', `Unknown field: ${k}`);
  const next = {};
  for (const k of keys) {
    const v = String(patch[k] ?? '').trim();
    if (k === 'firstName' && !v) fail('VALIDATION', 'The first name is required');
    if (v.length > 80) fail('VALIDATION', `${k} is longer than 80 characters`);
    if (k === 'phone' && v && !/^\+?[0-9][0-9 -]{5,19}$/.test(v)) fail('VALIDATION', 'Enter the phone number with digits, spaces or dashes only');
    next[k] = v;
  }
  const changed = keys.filter(k => next[k] !== (g[k] ?? ''));
  Object.assign(g, next);
  // field names only: the audit log carries ids, never the personal values
  appendAudit(db, ctx, { entity: 'guardian', entityId: g.id, action: 'correct', summary: changed.length ? `corrected: ${changed.join(', ')}` : 'no change' });
  return { ...g, name: fullName(g) };
}

// ---------------------------------------------------------------- accounts (sign-in links)

const ROLE_ORDER = { admin: 0, accountant: 1, teacher: 2, driver: 3, parent: 4 };

function linkOf(db, userId) {
  const u = (db.appUsers || []).find(x => x.id === userId);
  if (!u) fail('NOT_FOUND', 'Account not found');
  return u;
}

/** Block a sign-in (status blocked: RLS and the command function refuse it at once). Never yourself or the last principal. */
export function blockUser(db, userId, ctx, p) {
  const u = linkOf(db, userId);
  if ((u.staffId && u.staffId === p.staffId)) fail('VALIDATION', 'You cannot block your own account');
  if (u.status === 'blocked') return { userId, status: u.status };
  if (u.status !== 'active') fail('VALIDATION', `This account is ${u.status}; only an active account can be blocked`);
  if (u.role === 'admin' && !(db.appUsers || []).some(x => x.id !== u.id && x.role === 'admin' && x.status === 'active')) {
    fail('VALIDATION', 'This is the last active principal account; it cannot be blocked');
  }
  u.status = 'blocked';
  appendAudit(db, ctx, { entity: 'appUser', entityId: userId, action: 'block', summary: `${u.role} sign-in blocked` });
  return { userId, status: u.status };
}

export function unblockUser(db, userId, ctx) {
  const u = linkOf(db, userId);
  if (u.status === 'active') return { userId, status: u.status };
  if (u.status !== 'blocked') fail('VALIDATION', `This account is ${u.status}, not blocked`);
  u.status = 'active';
  appendAudit(db, ctx, { entity: 'appUser', entityId: userId, action: 'unblock', summary: `${u.role} sign-in unblocked` });
  return { userId, status: u.status };
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/**
 * The person's sign-in email (the staff record or the guardian record of the link) after the auth server changed it.
 * Refused when another staff member or guardian already uses the address (a new sign-in with it would link to them).
 */
export function changeSignInEmail(db, { userId, email } = {}, ctx) {
  const u = linkOf(db, userId);
  const e = String(email ?? '').trim().toLowerCase();
  if (!EMAIL.test(e) || e.length > 254) fail('VALIDATION', 'Enter a valid email address');
  const person = u.staffId ? byId(db.staff, u.staffId) : byId(db.guardians, u.guardianId);
  if (!person) fail('NOT_FOUND', 'The person of this account was not found');
  const clash = [...db.staff, ...db.guardians].some(x => x !== person && String(x.email || '').toLowerCase() === e);
  if (clash) fail('VALIDATION', 'Another person in the school already uses this email');
  if (String(person.email || '').toLowerCase() === e) return { userId, email: e };
  person.email = e;
  appendAudit(db, ctx, { entity: 'appUser', entityId: userId, action: 'changeEmail', summary: `${u.role} sign-in email changed (${u.staffId ? `staff ${u.staffId}` : `guardian ${u.guardianId}`})` });
  return { userId, email: e };
}

export const ACCOUNT_ACTIONS = ['signOutEverywhere', 'resendInvite', 'resetTwoStep', 'twoStepPolicy', 'block', 'unblock', 'changeEmail'];
/** Audit-only row for an action done on the auth server (no data row changes). detail: codes only, never personal data. */
export function noteAccountAction(db, { userId = null, action, outcome, detail = null, by } = {}, ctx) {
  if (!ACCOUNT_ACTIONS.includes(action)) fail('VALIDATION', `Unknown account action: ${action}`);
  if (!['ok', 'failed'].includes(outcome)) fail('VALIDATION', 'outcome must be ok or failed');
  if (typeof by !== 'string' || !by) fail('VALIDATION', 'by (the staff id of the principal) is required');
  const d = detail === null || detail === undefined ? '' : String(detail).replace(/[^\w .,:;=/()+-]/g, '').slice(0, 200);
  const row = appendAudit(db, { ...ctx, actor: { role: 'admin', id: by } },
    { entity: 'appUser', entityId: userId || '-', action, summary: `${action} ${outcome}${d ? `: ${d}` : ''}` });
  return { id: row.id, action, outcome };
}

// ---------------------------------------------------------------- who can see a child

/**
 * Everyone who can open this child's record, with why, from the personas the commands authorize with (buildPersonas,
 * the server's consentScopedPersona, sees): the checker cannot disagree with authorization.
 * @param {{appUsers?:{id:string, staffId?:string|null, guardianId?:string|null, status:string}[]|null, requireConsent?:boolean}} [opts]
 *   requireConsent true (real app): a parent sees a child only with live app_account consent for that child; the demo
 *   does not ask for consent. appUsers (real app: from the account directory; demo: the demo account store) gives each
 *   person's sign-in status; without it every status is 'none'.
 * @returns {{student:{id:string, name:string}, viewers:object[]}}  every viewer has sees:true except a guardian of the
 *   child who has not accepted the privacy notice (real app: name only, sees:false, consent:false).
 */
export function whoCanSee(db, studentId, { appUsers = null, requireConsent = false } = {}) {
  const s = byId(db.students, studentId);
  const personas = buildPersonas(db);
  if (!s) fail('NOT_FOUND', 'Student not found');
  const signIn = (key, id) => {
    const links = (appUsers || []).filter(u => u[key] === id);
    if (!links.length) return 'none';
    return (links.find(u => u.status === 'active') || links[0]).status;
  };
  const liveConsent = gid => (db.consents || []).some(c => c.guardianId === gid && c.studentId === studentId && c.purpose === 'app_account' && c.version === CONSENT_VERSION && !c.withdrawnAt);
  const viewers = [];
  for (const p0 of personas) {
    if (p0.role === 'parent') {
      if (!(s.guardianIds || []).includes(p0.guardianId)) continue;
      const g = byId(db.guardians, p0.guardianId);
      const consent = liveConsent(p0.guardianId);
      const p = requireConsent ? consentScopedPersona(db, p0, db.consents || []) : p0;
      const yes = sees(p, studentId);
      viewers.push({ kind: 'guardian', id: g.id, name: fullName(g), role: 'parent', sees: yes, consent,
        via: yes ? `Guardian (${g.relation || 'family'})` : `Guardian (${g.relation || 'family'}); has not accepted the privacy notice, sees the name only`,
        signIn: signIn('guardianId', g.id) });
      continue;
    }
    if (!sees(p0, studentId)) continue;
    const st = byId(db.staff, p0.staffId);
    const via = p0.role === 'admin' ? 'Principal: every child'
      : p0.role === 'accountant' ? 'Accountant: every child (fees; no health notes or learning records)'
        : p0.role === 'teacher' ? `Teacher of ${byId(db.programs, s.programId)?.name ?? s.programId}`
          : p0.role === 'driver' ? `Bus: ${byId(db.routes, s.routeId)?.name ?? s.routeId}` : p0.role;
    viewers.push({ kind: 'staff', id: st.id, name: fullName(st), role: p0.role, sees: true, via, signIn: signIn('staffId', st.id) });
  }
  viewers.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name));
  return { student: { id: s.id, name: fullName(s) }, viewers };
}
