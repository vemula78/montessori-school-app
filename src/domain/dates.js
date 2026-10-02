// Dates are 'YYYY-MM-DD' strings internally; display is DD-MMM-YYYY.
// Strings are parsed by regex only. Never Date-parse a string here: an ISO date string is
// UTC midnight and shows as the previous day in IST.

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad2 = n => String(n).padStart(2, '0');

function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }

export function daysInMonth(y, m) {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

function build(y, m, d) {
  if (!(y >= 1900 && y <= 2999) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= daysInMonth(y, m))) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Split a strict 'YYYY-MM-DD' into numbers, or null. */
function parts(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  return build(y, mo, d) ? { y, m: mo, d } : null;
}

function mustParts(iso) {
  const p = parts(iso);
  if (!p) throw new TypeError(`Not a valid ISO date: ${iso}`);
  return p;
}

/** True if str is a real calendar date in strict 'YYYY-MM-DD' form. */
export function isISODate(str) { return parts(str) !== null; }

/**
 * Strict parse. Accepts YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY (day first, never guessed) and DD-MMM-YYYY.
 * Day/month may be 1–2 digits in the day-first forms; ISO form requires 2 digits.
 * Returns ISO 'YYYY-MM-DD' or null (invalid shape or impossible date such as 31-02).
 */
export function parseDate(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim();
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return build(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s))) {
    if (s.includes('-') && s.includes('/')) return null;
    return build(+m[3], +m[2], +m[1]);
  }
  if ((m = /^(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{4})$/.exec(s))) {
    const mi = MONTHS.findIndex(x => x.toLowerCase() === m[2].toLowerCase());
    return mi < 0 ? null : build(+m[3], mi + 1, +m[1]);
  }
  return null;
}

/** '2026-10-02' → '02-Oct-2026'. null/undefined/'' → '—' (missing). Throws on malformed input. */
export function formatDate(iso) {
  if (iso === null || iso === undefined || iso === '') return '—';
  const p = mustParts(iso);
  return `${pad2(p.d)}-${MONTHS[p.m - 1]}-${p.y}`;
}

/** Local calendar date of `now` (local getters, not toISOString). */
export function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** Current instant as ISO-8601 UTC. */
export function nowISO(now = new Date()) {
  return now.toISOString();
}

/** Parse an ISO-8601 timestamp ('…T07:42:00Z', with optional ms or ±HH:MM offset) to epoch ms, or null. */
export function tsToMs(ts) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(ts || '');
  if (!m || !build(+m[1], +m[2], +m[3])) return null;
  if (+m[4] > 23 || +m[5] > 59 || +(m[6] || 0) > 59) return null;
  if (m[8] !== 'Z' && (+m[10] > 14 || +m[11] > 59 || (+m[10] === 14 && +m[11] > 0))) return null;
  let ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), +((m[7] || '0').padEnd(3, '0')));
  if (m[8] !== 'Z') ms -= (m[9] === '-' ? -1 : 1) * (+m[10] * 60 + +m[11]) * 60000;
  return ms;
}

/** Any accepted timestamp → canonical UTC 'YYYY-MM-DDTHH:MM:SS.sssZ', or null. */
export function normalizeTs(ts) {
  const ms = tsToMs(ts);
  return ms === null ? null : new Date(ms).toISOString();
}

function mustMs(ts) {
  const ms = tsToMs(ts);
  if (ms === null) throw new TypeError(`Not a valid ISO timestamp: ${ts}`);
  return ms;
}

/** Timestamp → local 'DD-MMM-YYYY HH:MM'. null → '—'. */
export function formatDateTime(tsIso) {
  if (tsIso === null || tsIso === undefined || tsIso === '') return '—';
  const d = new Date(mustMs(tsIso));
  return `${pad2(d.getDate())}-${MONTHS[d.getMonth()]}-${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Timestamp → local 'HH:MM'. null → '—'. */
export function formatTime(tsIso) {
  if (tsIso === null || tsIso === undefined || tsIso === '') return '—';
  const d = new Date(mustMs(tsIso));
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Local calendar date of a timestamp. */
export function tsToLocalDate(tsIso) {
  return todayISO(new Date(mustMs(tsIso)));
}

function toDayNumber(iso) {
  const p = mustParts(iso);
  return Date.UTC(p.y, p.m - 1, p.d) / 86400000;
}

function fromDayNumber(n) {
  const d = new Date(n * 86400000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function addDays(iso, n) {
  return fromDayNumber(toDayNumber(iso) + n);
}

/** Whole days from a to b (b − a). diffDays('2026-10-01','2026-10-03') === 2. */
export function diffDays(a, b) {
  return toDayNumber(b) - toDayNumber(a);
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(iso) {
  return new Date(toDayNumber(iso) * 86400000).getUTCDay();
}

export function isWeekend(iso, weeklyOffs = [0, 6]) {
  return weeklyOffs.includes(dayOfWeek(iso));
}

/** Whole seconds elapsed from tsIso to nowIso. */
export function secondsSince(tsIso, nowIso) {
  return Math.floor((mustMs(nowIso) - mustMs(tsIso)) / 1000);
}

/** Lexical compare; valid for same-format ISO dates or same-format UTC timestamps. Returns -1/0/1. */
export function compareISO(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Inclusive list of dates from start to end. */
export function dateRange(start, end) {
  const out = [];
  for (let d = start; compareISO(d, end) <= 0; d = addDays(d, 1)) out.push(d);
  return out;
}

/** 'HH:MM' 24-hour check. */
export function isHHMM(s) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');
}
