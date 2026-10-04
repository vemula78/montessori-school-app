// Curriculum of presentations: the duplicate key and the CSV preview (the school's own list).
// Pure: nothing here changes db. The commands (curriculum.importCsv etc.) re-validate and write.
//
// Contract used by the command registry:
//   curriculumKey(area, name)        slug of area + normalised name; the unique key of a presentation
//   previewCurriculumCsv(db, text)   → {rows:[{line, presentation}], duplicates:[{line, reason}], rejected:[{line, reason}],
//                                       counts:{inputRows, imported, skippedDuplicate, rejected}}
//                                      inputRows === imported + skippedDuplicate + rejected (imported = rows.length)
// Duplicate rules (never a silent update):
//   same key twice in the file, identical details   → first wins; later rows are duplicates ("same as line N")
//   same key twice in the file, different details   → every such row is rejected, with the lines listed
//   same key as a presentation already in the app   → duplicate ("already in the app") when the details agree,
//                                                     rejected when they differ (edit the presentation instead)

import { fail } from './ids.js';
import { parseCsvObjects, normHeader } from './csv.js';
import { OBSERVATION_AREAS } from './diary.js';

export const AREAS = OBSERVATION_AREAS;
export const AREA_LABEL = { practicalLife: 'Practical life', sensorial: 'Sensorial', language: 'Language', math: 'Mathematics', culture: 'Culture' };
export const MAX_NAME = 120;
export const MAX_DESCRIPTION = 500;
export const MAX_CSV_ROWS = 1000;

const norm = s => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
const slug = s => norm(s).toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');

/** 'practicalLife', 'Pouring water between jugs' → 'practicalLife:pouring-water-between-jugs' */
export function curriculumKey(area, name) {
  return `${area}:${slug(name)}`;
}

const AREA_ALIASES = {
  practicallife: 'practicalLife', practical: 'practicalLife', pl: 'practicalLife',
  sensorial: 'sensorial', sensory: 'sensorial',
  language: 'language', literacy: 'language',
  math: 'math', maths: 'math', mathematics: 'math',
  culture: 'culture', cultural: 'culture', geography: 'culture', science: 'culture',
};
/** 'Practical life', 'practical_life', 'MATHS' → the area id, or null. */
export function parseArea(raw) {
  return AREA_ALIASES[String(raw ?? '').toLowerCase().replace(/[^a-z]/g, '')] ?? null;
}

const COLUMNS = {
  area: ['area', 'areaofthecurriculum', 'curriculumarea', 'subject', 'domain'],
  name: ['name', 'presentation', 'presentationname', 'material', 'lesson', 'title'],
  sequence: ['sequence', 'seq', 'order', 'position'],
  ageFromMonths: ['agefrommonths', 'agefrom', 'minagemonths', 'minage', 'frommonths'],
  ageToMonths: ['agetomonths', 'ageto', 'maxagemonths', 'maxage', 'tomonths'],
  description: ['description', 'notes', 'note', 'details', 'remarks'],
};

const wholeNumber = (raw, label, { min = 0, max = 1200 } = {}) => {
  const s = String(raw ?? '').trim();
  if (s === '') return { value: null };
  if (!/^\d{1,6}$/.test(s)) return { error: `${label} "${s.slice(0, 20)}" is not a whole number` };
  const n = Number(s);
  if (n < min || n > max) return { error: `${label} ${n} is outside ${min}–${max}` };
  return { value: n };
};

/** One CSV row's cells → {presentation} or {error}. Pure; the same checks the import command repeats. */
export function checkPresentationRow(cells) {
  const area = parseArea(cells.area);
  if (!norm(cells.area)) return { error: 'area is empty' };
  if (!area) return { error: `unknown area "${norm(cells.area).slice(0, 30)}" (use practicalLife, sensorial, language, math or culture)` };
  const name = norm(cells.name);
  if (!name) return { error: 'name is empty' };
  if (name.length > MAX_NAME) return { error: `name is longer than ${MAX_NAME} characters` };
  if (!slug(name)) return { error: 'name has no letters or digits' };
  const seq = wholeNumber(cells.sequence, 'sequence', { max: 100000 });
  if (seq.error) return { error: seq.error };
  const from = wholeNumber(cells.ageFromMonths, 'age from');
  if (from.error) return { error: from.error };
  const to = wholeNumber(cells.ageToMonths, 'age to');
  if (to.error) return { error: to.error };
  if (from.value !== null && to.value !== null && from.value > to.value) return { error: `age from (${from.value}) is above age to (${to.value})` };
  const description = norm(cells.description);
  if (description.length > MAX_DESCRIPTION) return { error: `description is longer than ${MAX_DESCRIPTION} characters` };
  return { presentation: { key: curriculumKey(area, name), area, name, sequence: seq.value, ageFromMonths: from.value, ageToMonths: to.value, description } };
}

/** The fields a row actually states (blank sequence/ages mean "not stated"), for comparing with another row or a stored presentation. */
const stated = p => ({ sequence: p.sequence, ageFromMonths: p.ageFromMonths, ageToMonths: p.ageToMonths, description: p.description });
const sameDetails = (a, b) => Object.keys(a).every(k => a[k] === b[k]);
/** Row details agree with a stored presentation on every field the row states. */
const agreesWith = (row, stored) => {
  const s = stated(row);
  return (s.sequence === null || s.sequence === stored.sequence) && (s.ageFromMonths === null || s.ageFromMonths === stored.ageFromMonths)
    && (s.ageToMonths === null || s.ageToMonths === stored.ageToMonths) && (s.description === '' || s.description === (stored.description || ''));
};

export const CSV_MAX_BYTES = 512 * 1024;

/**
 * Validate a curriculum CSV against the presentations already in db. Pure.
 * The first row must be a header with at least an area and a name column (any order; extra columns are ignored).
 * Ages are in months. A blank sequence continues after the highest sequence in that area.
 */
export function previewCurriculumCsv(db, text) {
  // the same limit curriculum.importCsv applies, so a preview the import would refuse is never offered
  if (new TextEncoder().encode(String(text)).length > CSV_MAX_BYTES) fail('VALIDATION', 'The file is larger than 512 KB');
  // the browser decodes a file that is not UTF-8 with replacement characters; refuse it rather than import altered names
  if (String(text).includes('\uFFFD')) fail('VALIDATION', 'The file is not UTF-8 text. Save it as "CSV UTF-8" and try again');
  const parsed = parseCsvObjects(text);
  const col = {};
  for (const h of parsed.headers) for (const [k, list] of Object.entries(COLUMNS)) if (col[k] === undefined && list.includes(normHeader(h))) col[k] = h;
  if (parsed.headers.length && (col.area === undefined || col.name === undefined)) {
    fail('VALIDATION', 'The first row must be a header with at least "area" and "name" columns');
  }
  if (parsed.rows.length > MAX_CSV_ROWS) fail('VALIDATION', `The file has ${parsed.rows.length} rows; the limit is ${MAX_CSV_ROWS}`);

  const existing = new Map(db.presentations.map(p => [p.key, p]));
  const maxSeq = {};
  for (const p of db.presentations) maxSeq[p.area] = Math.max(maxSeq[p.area] ?? 0, p.sequence || 0);

  const candidates = []; // {line, p}
  const rejected = [];
  for (const r of parsed.rows) {
    if (r.problem) { rejected.push({ line: r.line, reason: r.problem }); continue; }
    const cells = Object.fromEntries(Object.entries(COLUMNS).map(([k]) => [k, col[k] === undefined ? '' : r.values[col[k]]]));
    const c = checkPresentationRow(cells);
    if (c.error) rejected.push({ line: r.line, reason: c.error }); else candidates.push({ line: r.line, p: c.presentation });
  }

  const groups = new Map();
  for (const c of candidates) { if (!groups.has(c.p.key)) groups.set(c.p.key, []); groups.get(c.p.key).push(c); }

  const rows = [], duplicates = [];
  for (const [key, list] of groups) {
    const stored = existing.get(key);
    if (stored) {
      for (const c of list) {
        if (agreesWith(c.p, stored)) duplicates.push({ line: c.line, reason: 'already in the app' });
        else rejected.push({ line: c.line, reason: 'same area and name as a presentation already in the app, but with different details; edit that presentation instead' });
      }
      continue;
    }
    const [first, ...rest] = list;
    if (rest.every(c => sameDetails(stated(c.p), stated(first.p)))) {
      rows.push(first);
      for (const c of rest) duplicates.push({ line: c.line, reason: `same as line ${first.line}` });
    } else {
      const lines = list.map(c => c.line).join(', ');
      for (const c of list) rejected.push({ line: c.line, reason: `repeated with different details (lines ${lines}); fix the file so the row appears once` });
    }
  }

  rows.sort((a, b) => a.line - b.line);
  const out = rows.map(({ line, p }) => {
    let sequence = p.sequence;
    if (sequence === null) { maxSeq[p.area] = (maxSeq[p.area] ?? 0) + 10; sequence = maxSeq[p.area]; } else maxSeq[p.area] = Math.max(maxSeq[p.area] ?? 0, sequence);
    return { line, presentation: { ...p, sequence, active: true, source: 'import' } };
  });
  duplicates.sort((a, b) => a.line - b.line);
  rejected.sort((a, b) => a.line - b.line);
  const counts = { inputRows: parsed.rows.length, imported: out.length, skippedDuplicate: duplicates.length, rejected: rejected.length };
  if (counts.imported + counts.skippedDuplicate + counts.rejected !== counts.inputRows) fail('VALIDATION', 'Curriculum import counts do not reconcile');
  return { rows: out, duplicates, rejected, counts };
}
