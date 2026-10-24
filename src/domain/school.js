// School settings the principal enters in the app (schema v5), never hard-coded: the details printed in the Progress
// Report's footer, the director's name, the contact for privacy questions (rendered into the privacy notice), office
// hours for parents' messages, and the school's UPI ID for fees paid straight to the school. Each is null until set.
//   reportFooter   {address, phones:[≤3], email, website}
//   directorName   string
//   privacyContact {name, role, email}   — never invented: unset → the notice says "the school office"
//   officeHours    {start:'HH:MM', end:'HH:MM', days:[0..6]} (0 = Sunday), school time (IST)
//   upi            {vpa, payeeName}
// Audit rows name the fields changed, never their values.

import { fail } from './ids.js';
import { isHHMM, dateInZone, IST_OFFSET_MIN, dayOfWeek, tsToMs } from './dates.js';
import { appendAudit } from './audit.js';

export const SCHOOL_DETAIL_KEYS = ['reportFooter', 'directorName', 'privacyContact', 'officeHours', 'upi'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^\+?[0-9][0-9 -]{5,19}$/;
const VPA_RE = /^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.-]{1,63}$/;
const WEBSITE_RE = /^(https?:\/\/)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(\/[^\s]*)?$/;

function str(v, label, max, required = false) {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (required && !s) fail('VALIDATION', `${label} is required`);
  if (s.length > max) fail('VALIDATION', `${label} must be at most ${max} characters`);
  return s;
}
function obj(v, keys, label) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail('VALIDATION', `${label} must be an object`);
  for (const k of Object.keys(v)) if (!keys.includes(k)) fail('VALIDATION', `Unknown field in ${label}: ${k}`);
  return v;
}
const email = (v, label, required = false) => {
  const e = str(v, label, 120, required).toLowerCase();
  if (e && !EMAIL_RE.test(e)) fail('VALIDATION', `${label}: enter a valid email address`);
  return e;
};

const CLEAN = {
  reportFooter(v) {
    obj(v, ['address', 'phones', 'email', 'website'], 'The report footer');
    const phones = v.phones === undefined ? [] : v.phones;
    if (!Array.isArray(phones) || phones.length > 3) fail('VALIDATION', 'Give at most three phone numbers');
    const list = phones.map(p => str(p, 'A phone number', 20)).filter(Boolean);
    for (const p of list) if (!PHONE_RE.test(p)) fail('VALIDATION', 'Enter phone numbers with digits, spaces or dashes only');
    const website = str(v.website, 'The website', 100);
    if (website && !WEBSITE_RE.test(website)) fail('VALIDATION', 'Enter the website like www.example.com');
    return { address: str(v.address, 'The address', 200, true), phones: list, email: email(v.email, 'The email'), website };
  },
  directorName(v) { return str(v, "The director's name", 80, true); },
  privacyContact(v) {
    obj(v, ['name', 'role', 'email'], 'The privacy contact');
    return { name: str(v.name, "The contact's name", 80, true), role: str(v.role, "The contact's role", 80, true), email: email(v.email, "The contact's email", true) };
  },
  officeHours(v) {
    obj(v, ['start', 'end', 'days'], 'Office hours');
    if (!isHHMM(v.start) || !isHHMM(v.end) || v.end <= v.start) fail('VALIDATION', 'Office hours need a start and an end (HH:MM, the end after the start)');
    if (!Array.isArray(v.days) || !v.days.length || v.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) fail('VALIDATION', 'Choose the days the office is open');
    return { start: v.start, end: v.end, days: [...new Set(v.days)].sort() };
  },
  upi(v) {
    obj(v, ['vpa', 'payeeName'], 'UPI details');
    const vpa = str(v.vpa, 'The UPI ID', 120, true);
    if (!VPA_RE.test(vpa)) fail('VALIDATION', 'Enter the UPI ID like schoolname@bank');
    return { vpa, payeeName: str(v.payeeName, 'The payee name', 80, true) };
  },
};

/** setSchoolDetails({reportFooter?, directorName?, privacyContact?, officeHours?, upi?}) — each value, or null to clear it. */
export function setSchoolDetails(db, patch, ctx) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('VALIDATION', 'Send the details as an object');
  const keys = Object.keys(patch);
  if (!keys.length) fail('VALIDATION', 'Nothing to change');
  for (const k of keys) if (!SCHOOL_DETAIL_KEYS.includes(k)) fail('VALIDATION', `Unknown setting: ${k}`);
  const next = {};
  for (const k of keys) next[k] = patch[k] === null ? null : CLEAN[k](patch[k]);
  const changed = keys.filter(k => JSON.stringify(db.school[k] ?? null) !== JSON.stringify(next[k]));
  Object.assign(db.school, next);
  appendAudit(db, ctx, { entity: 'school', entityId: 'school', action: 'setDetails', summary: changed.length ? `changed: ${changed.join(', ')}` : 'no change' });
  return schoolDetails(db);
}

/** The settings as stored (null where unset). */
export function schoolDetails(db) {
  const s = db.school || {};
  return Object.fromEntries(SCHOOL_DETAIL_KEYS.map(k => [k, s[k] ?? null]));
}

/**
 * Is the office open at `nowIso` (school time)? {set:false} when no hours are set (then nothing is said to parents).
 * nextOpen = 'HH:MM' and day (0..6) of the next opening when closed.
 */
export function officeHoursStatus(school, nowIso) {
  const h = school && school.officeHours;
  if (!h) return { set: false, open: true, hours: null, nextOpen: null };
  const ms = tsToMs(nowIso);
  const local = new Date(ms + IST_OFFSET_MIN * 60000);
  const hhmm = `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
  const today = dateInZone(ms, IST_OFFSET_MIN);
  const dow = dayOfWeek(today);
  const open = h.days.includes(dow) && hhmm >= h.start && hhmm < h.end;
  let nextOpen = null;
  if (!open) {
    for (let i = 0; i <= 7; i++) {
      const d = (dow + i) % 7;
      if (h.days.includes(d) && (i > 0 || hhmm < h.start)) { nextOpen = { day: d, time: h.start, inDays: i }; break; }
    }
  }
  return { set: true, open, hours: { ...h }, nextOpen };
}
