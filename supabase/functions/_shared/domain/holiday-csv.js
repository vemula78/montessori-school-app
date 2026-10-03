// Holiday-list CSV: parse → preview (nothing written) → import (counts reconcile).
// inputRows === ok + duplicate + outsideYear + rejected (preview)
// inputRows === imported + skippedDuplicate + rejected (import; excluded outside-year rows count as rejected)

import { fail, newId } from './ids.js';
import { parseDate, compareISO, formatDate, isISODate } from './dates.js';
import { mustGet, byId } from './people.js';
import { EVENT_TYPES, academicYearFor } from './calendar.js';
import { appendAudit } from './audit.js';
import { parseCsv } from './csv.js';

export { parseCsv }; // the RFC-4180 parser now lives in csv.js (shared with data import and settlements)

const ALIASES = {
  title: ['title', 'name', 'holiday', 'holidayname', 'occasion', 'eventname', 'event'],
  startDate: ['date', 'start', 'startdate', 'from', 'fromdate'],
  endDate: ['end', 'enddate', 'to', 'todate', 'till', 'until'],
  type: ['type', 'category', 'kind'],
  programs: ['program', 'programs', 'programme', 'programmes', 'class', 'classes'],
  description: ['description', 'notes', 'note', 'remarks', 'details'],
};
/** Column order assumed when the file has no recognisable header row. */
export const POSITIONAL = ['startDate', 'title', 'endDate', 'type', 'programs'];

const norm = h => String(h).toLowerCase().replace(/[^a-z]/g, '');

function detectHeader(fields) {
  if (fields.some(f => parseDate(f) !== null)) return null;
  const map = {};
  fields.forEach((f, i) => {
    const n = norm(f);
    for (const [key, list] of Object.entries(ALIASES)) if (list.includes(n) && map[key] === undefined) map[key] = i;
  });
  return map.title !== undefined && map.startDate !== undefined ? map : null;
}

const TYPE_ALIASES = { holiday: 'holiday', event: 'event', ptm: 'ptm', halfday: 'halfDay', workingsaturday: 'workingSaturday' };

/** Duplicate key: normalised title (any script) + dates + type + programs. */
export function eventKey(title, startDate, endDate, type, programIds) {
  const t = String(title).normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
  return `${t}|${startDate}|${endDate}|${type}|${[...(programIds || [])].sort().join(',')}`;
}
const keyOf = e => eventKey(e.title, e.startDate, e.endDate, e.type, e.programIds);

function resolvePrograms(db, cell) {
  const raw = String(cell || '').trim();
  if (!raw || /^all$/i.test(raw)) return { ids: [] };
  const ids = [];
  for (const part of raw.split(/[;|]/).map(x => x.trim()).filter(Boolean)) {
    const p = db.programs.find(pr => pr.id === part || pr.name.toLowerCase() === part.toLowerCase());
    if (!p) return { error: `unknown program "${part}"` };
    if (!ids.includes(p.id)) ids.push(p.id);
  }
  return { ids };
}

/**
 * Validate a holiday CSV against an academic year. Pure: does not modify db.
 * @returns {{academicYearId, columns, rows:Array, counts:{inputRows, ok, duplicate, outsideYear, rejected}}}
 */
export function previewHolidayCsv(db, text, academicYearId) {
  const ay = mustGet(db, 'academicYears', academicYearId, 'Academic year');
  const records = parseCsv(text);
  let map = null;
  if (records.length && !records[0].unterminated) map = detectHeader(records[0].fields.map(f => f.trim()));
  const dataRecords = map ? records.slice(1) : records;
  if (!map) { map = {}; POSITIONAL.forEach((k, i) => { map[k] = i; }); }

  const existing = new Set(db.calendarEvents.map(keyOf));
  const seen = new Set();
  const rows = [];
  for (const rec of dataRecords) {
    const get = k => (map[k] === undefined ? '' : String(rec.fields[map[k]] ?? '').trim());
    const row = { line: rec.line, raw: rec.fields, title: get('title'), startDate: null, endDate: null, type: 'holiday', programIds: [], description: get('description'), status: 'ok' };
    const reject = reason => { row.status = 'rejected'; row.reason = reason; rows.push(row); };
    if (rec.unterminated) { reject('unterminated quoted field'); continue; }
    if (!row.title) { reject('title is empty'); continue; }
    const sRaw = get('startDate'), eRaw = get('endDate');
    row.startDate = parseDate(sRaw);
    if (!row.startDate) { reject(sRaw ? `invalid date "${sRaw}" (use YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY or DD-MMM-YYYY)` : 'date is empty'); continue; }
    row.endDate = eRaw ? parseDate(eRaw) : row.startDate;
    if (!row.endDate) { reject(`invalid end date "${eRaw}"`); continue; }
    if (compareISO(row.endDate, row.startDate) < 0) { reject(`end date ${formatDate(row.endDate)} is before start date ${formatDate(row.startDate)}`); continue; }
    const tRaw = get('type');
    if (tRaw) {
      const t = TYPE_ALIASES[norm(tRaw)];
      if (!t || !EVENT_TYPES.includes(t)) { reject(`unknown type "${tRaw}"`); continue; }
      row.type = t;
    }
    const progs = resolvePrograms(db, get('programs'));
    if (progs.error) { reject(progs.error); continue; }
    row.programIds = progs.ids;
    const key = keyOf(row);
    if (existing.has(key)) { row.status = 'duplicate'; row.reason = 'already in the calendar'; rows.push(row); continue; }
    if (seen.has(key)) { row.status = 'duplicate'; row.reason = 'repeated in this file'; rows.push(row); continue; }
    seen.add(key);
    if (compareISO(row.startDate, ay.startDate) < 0 || compareISO(row.endDate, ay.endDate) > 0) {
      row.status = 'outsideYear';
      row.reason = `outside ${ay.label || ay.id} (${formatDate(ay.startDate)} – ${formatDate(ay.endDate)})`;
    }
    rows.push(row);
  }
  const counts = { inputRows: rows.length, ok: 0, duplicate: 0, outsideYear: 0, rejected: 0 };
  for (const r of rows) counts[r.status]++;
  return { academicYearId, columns: Object.keys(map), rows, counts };
}

/**
 * Commit a preview. Duplicates are re-checked against the current db (the preview may be stale),
 * so importing the same preview twice imports nothing the second time.
 */
export function importHolidays(db, preview, { includeOutsideYear = false } = {}, ctx) {
  if (!preview || !Array.isArray(preview.rows)) fail('VALIDATION', 'No preview to import');
  const ayId = preview.academicYearId;
  const ay = mustGet(db, 'academicYears', ayId, 'Academic year');
  const importBatchId = newId('imp');
  const keys = new Set(db.calendarEvents.map(keyOf));
  let imported = 0, skippedDuplicate = 0, rejected = 0;
  const rejectedRows = [];
  const reject = (r, reason) => { rejected++; rejectedRows.push({ line: r.line, reason }); };
  for (const r of preview.rows) {
    if (r.status === 'rejected') { reject(r, r.reason); continue; }
    // Re-validate everything: the preview may be stale or edited. Duplicates are re-checked against the current db.
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    const programIds = Array.isArray(r.programIds) ? r.programIds : null;
    let problem = null;
    if (!title) problem = 'title is empty';
    else if (!isISODate(r.startDate) || !isISODate(r.endDate)) problem = 'dates must be YYYY-MM-DD';
    else if (compareISO(r.endDate, r.startDate) < 0) problem = 'end date is before start date';
    else if (!EVENT_TYPES.includes(r.type)) problem = `unknown type "${r.type}"`;
    else if (!programIds) problem = 'programs missing';
    else { const bad = programIds.find(p => !byId(db.programs, p)); if (bad !== undefined) problem = `unknown program "${bad}"`; }
    if (problem) { reject(r, `row failed re-validation: ${problem}`); continue; }
    const row = { title, startDate: r.startDate, endDate: r.endDate, type: r.type, programIds: [...programIds] };
    const key = keyOf(row);
    if (keys.has(key)) { skippedDuplicate++; continue; }
    const outside = compareISO(row.startDate, ay.startDate) < 0 || compareISO(row.endDate, ay.endDate) > 0;
    if (outside && !includeOutsideYear) { reject(r, `outside ${ay.label || ay.id}; not included`); continue; }
    keys.add(key);
    db.calendarEvents.push({
      id: newId('evt'), academicYearId: outside ? (academicYearFor(db, row.startDate)?.id ?? ayId) : ayId,
      ...row, description: typeof r.description === 'string' ? r.description : '', source: 'import', importBatchId,
    });
    imported++;
  }
  const inputRows = preview.rows.length;
  if (imported + skippedDuplicate + rejected !== inputRows) fail('VALIDATION', 'Import counts do not reconcile');
  appendAudit(db, ctx, {
    entity: 'calendarImport', entityId: importBatchId, action: 'import',
    summary: `AY ${ayId}: input ${inputRows}, imported ${imported}, duplicate ${skippedDuplicate}, rejected ${rejected}`,
  });
  return { inputRows, imported, skippedDuplicate, rejected, importBatchId, rejectedRows };
}
