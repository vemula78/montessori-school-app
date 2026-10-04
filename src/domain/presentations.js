// The school's curriculum (presentations) as written by the registry: starter list, manual edits, CSV import,
// retire/restore. Presentations are never deleted (progress events and reports reference them; reports also froze
// the name). The key (curriculumKey: area + normalised name) is unique; a rename keeps the id and moves the key.
// Parsing/preview of the CSV and the starter list itself live in curriculum.js / curriculum-starter.js.

import { fail, newId } from './ids.js';
import { mustGet } from './people.js';
import { appendAudit } from './audit.js';
import { OBSERVATION_AREAS } from './diary.js';
import { curriculumKey, MAX_NAME, MAX_DESCRIPTION } from './curriculum.js';
import { starterPresentations } from './curriculum-starter.js';

const MAX_AGE_MONTHS = 1200; // the CSV preview's bound (curriculum.js)
const optInt = (v, label) => {
  if (v === null || v === undefined || v === '') return null;
  if (!Number.isSafeInteger(v) || v < 0 || v > MAX_AGE_MONTHS) fail('VALIDATION', `${label} must be whole months from 0 to ${MAX_AGE_MONTHS}`);
  return v;
};

/** The editable fields of a presentation, checked. */
export function cleanPresentation(input = {}) {
  if (!OBSERVATION_AREAS.includes(input.area)) fail('VALIDATION', `Unknown area: ${input.area}`);
  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name) fail('VALIDATION', 'The presentation needs a name');
  if (name.length > MAX_NAME) fail('VALIDATION', `The name is longer than ${MAX_NAME} characters`);
  const sequence = input.sequence === null || input.sequence === undefined || input.sequence === '' ? 0 : input.sequence;
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 100000) fail('VALIDATION', 'sequence must be a whole number from 0');
  const ageFromMonths = optInt(input.ageFromMonths, 'ageFromMonths'), ageToMonths = optInt(input.ageToMonths, 'ageToMonths');
  if (ageFromMonths !== null && ageToMonths !== null && ageFromMonths > ageToMonths) fail('VALIDATION', 'The age range ends before it starts');
  const description = String(input.description ?? '').trim();
  if (description.length > MAX_DESCRIPTION) fail('VALIDATION', `The description is longer than ${MAX_DESCRIPTION} characters`);
  return { key: curriculumKey(input.area, name), area: input.area, name, sequence, ageFromMonths, ageToMonths, description };
}

const sameFields = (a, b) => ['area', 'name', 'sequence', 'ageFromMonths', 'ageToMonths', 'description'].every(k => (a[k] ?? null) === (b[k] ?? null));

/** Add the starter list; presentations already present (same key) are left as they are. Idempotent. */
export function loadStarter(db, ctx) {
  const keys = new Set(db.presentations.map(x => x.key));
  let inputRows = 0, added = 0, skippedExisting = 0;
  for (const raw of starterPresentations()) {
    inputRows++;
    const f = cleanPresentation(raw);
    if (keys.has(f.key)) { skippedExisting++; continue; }
    keys.add(f.key);
    db.presentations.push({ id: newId('prs'), ...f, active: true, source: 'starter', importBatchId: null });
    added++;
  }
  if (added + skippedExisting !== inputRows) fail('VALIDATION', 'Starter counts do not reconcile');
  appendAudit(db, ctx, { entity: 'curriculum', entityId: '-', action: 'loadStarter', summary: `starter list: ${inputRows} rows, ${added} added, ${skippedExisting} already present` });
  return { inputRows, added, skippedExisting };
}

/** save({id?, area, name, ...}) — create (no id) or edit; a rename keeps the id. Keys stay unique. */
export function savePresentation(db, input = {}, ctx) {
  const f = cleanPresentation(input);
  const clash = db.presentations.find(x => x.key === f.key && x.id !== input.id);
  if (clash) fail('VALIDATION', `"${clash.name}" already exists in this area`);
  if (input.id) {
    const pr = mustGet(db, 'presentations', input.id, 'Presentation');
    const was = pr.name;
    Object.assign(pr, f);
    appendAudit(db, ctx, { entity: 'presentation', entityId: pr.id, action: 'edit', summary: was === pr.name ? 'presentation edited' : 'presentation renamed' });
    return pr;
  }
  const pr = { id: newId('prs'), ...f, active: true, source: 'manual', importBatchId: null };
  db.presentations.push(pr);
  appendAudit(db, ctx, { entity: 'presentation', entityId: pr.id, action: 'add', summary: `presentation added (${pr.area})` });
  return pr;
}

export function setPresentationActive(db, id, active, ctx) {
  const pr = mustGet(db, 'presentations', id, 'Presentation');
  if (pr.active !== active) {
    pr.active = active;
    appendAudit(db, ctx, { entity: 'presentation', entityId: pr.id, action: active ? 'restore' : 'retire', summary: active ? 'presentation restored' : 'presentation retired (kept for history)' });
  }
  return pr;
}

/**
 * Commit a CSV preview (curriculum.previewCurriculumCsv). Every row is re-checked against the current list (the
 * preview may be stale): same key + same fields → skippedDuplicate; same key + different fields → rejected
 * (never silently updated); invalid → rejected. inputRows = imported + skippedDuplicate + rejected, else VALIDATION.
 */
export function importCurriculum(db, preview, ctx) {
  if (!preview || !Array.isArray(preview.rows) || !Array.isArray(preview.duplicates) || !Array.isArray(preview.rejected) || !preview.counts) fail('VALIDATION', 'No preview to import');
  const inputRows = preview.counts.inputRows;
  if (preview.rows.length + preview.duplicates.length + preview.rejected.length !== inputRows) fail('VALIDATION', 'The preview counts do not add up; preview the file again');
  const importBatchId = newId('cimp');
  const byKey = new Map(db.presentations.map(x => [x.key, x]));
  let imported = 0, skippedDuplicate = preview.duplicates.length;
  const rejectedRows = preview.rejected.map(r => ({ line: r.line, reason: r.reason }));
  for (const row of preview.rows) {
    let f;
    try { f = cleanPresentation(row.presentation || {}); } catch (e) {
      if (!e || typeof e.code !== 'string') throw e;
      rejectedRows.push({ line: row.line, reason: `row failed re-validation: ${e.message}` });
      continue;
    }
    const have = byKey.get(f.key);
    if (have) {
      if (sameFields(have, f)) skippedDuplicate++;
      else rejectedRows.push({ line: row.line, reason: `conflicts with "${have.name}" already in the app (same name and area, different details); edit it there instead` });
      continue;
    }
    const pr = { id: newId('prs'), ...f, active: true, source: 'import', importBatchId };
    db.presentations.push(pr);
    byKey.set(f.key, pr);
    imported++;
  }
  rejectedRows.sort((a, b) => a.line - b.line);
  const rejected = rejectedRows.length;
  if (imported + skippedDuplicate + rejected !== inputRows) fail('VALIDATION', 'Import counts do not reconcile');
  appendAudit(db, ctx, { entity: 'curriculumImport', entityId: importBatchId, action: 'import', summary: `input ${inputRows}, imported ${imported}, duplicate ${skippedDuplicate}, rejected ${rejected}` });
  return { inputRows, imported, skippedDuplicate, rejected, rejectedRows, importBatchId };
}

/** Staff list, ordered by area then sequence then name; retired ones only when asked. */
export function listPresentations(db, p, { includeRetired = false, area } = {}) {
  if (!p || !['admin', 'teacher'].includes(p.role)) fail('NOT_ALLOWED', 'The curriculum is for staff');
  const order = a => OBSERVATION_AREAS.indexOf(a);
  return (db.presentations || []).filter(x => (includeRetired || x.active) && (!area || x.area === area))
    .sort((a, b) => order(a.area) - order(b.area) || a.sequence - b.sequence || a.name.localeCompare(b.name));
}
