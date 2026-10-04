// Curriculum: the duplicate key, the starter list and the pure CSV preview (counts that add up, quarantine with line and
// reason, no silent update). The commands that write (curriculum.importCsv etc.) are exercised in phase3-domain.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { curriculumKey, previewCurriculumCsv, parseArea, checkPresentationRow, AREAS, MAX_CSV_ROWS } from '../src/domain/curriculum.js';
import { starterPresentations } from '../src/domain/curriculum-starter.js';
import { importCurriculum } from '../src/domain/presentations.js';
import { buildSeed } from '../src/seed/seed-data.js';
import { validateDb } from '../src/domain/validate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const ctx = { actor: { role: 'admin', id: 'stf-principal' }, now: '2026-10-02T05:00:00.000Z', today: '2026-10-02' };
const pres = (area, name, extra = {}) => ({ id: `p-${name}`, key: curriculumKey(area, name), area, name, sequence: 10, ageFromMonths: null, ageToMonths: null, description: '', active: true, source: 'manual', ...extra });
const emptyDb = () => ({ presentations: [], auditLog: [] });

test('curriculumKey: area + a slug of the normalised name; case, spacing and punctuation do not make a new key', () => {
  assert.equal(curriculumKey('practicalLife', 'Pouring water between jugs'), 'practicalLife:pouring-water-between-jugs');
  assert.equal(curriculumKey('practicalLife', '  pouring   WATER between jugs! '), curriculumKey('practicalLife', 'Pouring water between jugs'));
  assert.notEqual(curriculumKey('sensorial', 'Pink tower'), curriculumKey('math', 'Pink tower'), 'the same name in another area is another presentation');
  assert.equal(curriculumKey('language', 'Sandpaper letters: group 1'), 'language:sandpaper-letters-group-1');
  assert.equal(curriculumKey('language', 'ಅಕ್ಷರ ಮಾಲೆ'), 'language:ಅಕ್ಷರ-ಮಾಲೆ', 'letters of any script survive');
});

test('area names: ids and everyday spellings map to the five areas; anything else is null', () => {
  for (const [raw, want] of [['practicalLife', 'practicalLife'], ['Practical life', 'practicalLife'], ['practical_life', 'practicalLife'], ['SENSORIAL', 'sensorial'], ['Maths', 'math'], ['mathematics', 'math'], ['Cultural', 'culture'], ['language', 'language']]) assert.equal(parseArea(raw), want, raw);
  for (const raw of ['', 'astrology', null, undefined, 'art']) assert.equal(parseArea(raw), null, String(raw));
});

test('starter list: five areas, at least 150 rows, unique keys, sane ages and a contiguous order', () => {
  const list = starterPresentations();
  assert.ok(list.length >= 150, `${list.length} rows`);
  assert.deepEqual([...new Set(list.map(p => p.area))].sort(), [...AREAS].sort());
  assert.equal(new Set(list.map(p => p.key)).size, list.length, 'keys are unique');
  for (const a of AREAS) assert.ok(list.filter(p => p.area === a).length >= 20, `${a} has a real list`);
  for (const p of list) {
    assert.equal(p.key, curriculumKey(p.area, p.name), p.name);
    assert.ok(!('id' in p), 'the command assigns ids');
    assert.equal(p.active, true);
    assert.equal(p.source, 'starter');
    assert.ok(Number.isInteger(p.ageFromMonths) && Number.isInteger(p.ageToMonths) && p.ageFromMonths >= 18 && p.ageToMonths <= 84 && p.ageFromMonths < p.ageToMonths, `${p.name} ages`);
    assert.ok(p.name.length <= 120 && p.description.length > 0 && p.description.length <= 500, p.name);
    assert.equal(checkPresentationRow({ area: p.area, name: p.name, sequence: String(p.sequence), ageFromMonths: String(p.ageFromMonths), ageToMonths: String(p.ageToMonths), description: p.description }).error, undefined, `${p.name} passes the same row check as an import`);
  }
  for (const a of AREAS) assert.deepEqual(list.filter(p => p.area === a).map(p => p.sequence), list.filter(p => p.area === a).map((_, i) => (i + 1) * 10), `${a} order 10, 20, ...`);
  assert.deepEqual(starterPresentations(), list, 'the same list every call');
});

test('starter list holds material and presentation names only: no digit runs that look like phone or ID numbers', () => {
  for (const p of starterPresentations()) assert.ok(!/\d{4,}/.test(`${p.name} ${p.description}`), p.name);
});

test('preview on the dirty fixture: every row lands in exactly one bucket, with line and reason, and the counts add up', () => {
  const csv = read('tests/fixtures/curriculum-dirty.csv');
  assert.ok(csv.charCodeAt(0) === 0xFEFF, 'the fixture starts with a BOM');
  const db = { presentations: [
    pres('math', 'Hundred board', { sequence: 30, ageFromMonths: 48, ageToMonths: 72, description: 'Placing tiles to build the numbers, 1 to 100' }),
    pres('culture', 'Magnetic and non-magnetic', { sequence: 20, ageFromMonths: 30, ageToMonths: 72, description: 'Testing objects with a magnet' }),
  ] };
  const before = JSON.stringify(db);
  const r = previewCurriculumCsv(db, csv);
  assert.equal(JSON.stringify(db), before, 'pure: db is untouched');
  assert.deepEqual(r.counts, { inputRows: 17, imported: 4, skippedDuplicate: 3, rejected: 10 });
  assert.equal(r.counts.inputRows, r.counts.imported + r.counts.skippedDuplicate + r.counts.rejected);
  assert.deepEqual(r.rows.map(x => x.line), [2, 3, 5, 16]);
  assert.deepEqual(r.rows.map(x => x.presentation.name), ['Carrying a tray', 'Pouring water between jugs', 'Pink tower', 'Parts of a leaf']);
  assert.ok(r.rows.every(x => x.presentation.source === 'import' && x.presentation.active === true && Number.isInteger(x.presentation.sequence)));
  assert.deepEqual(r.duplicates, [{ line: 4, reason: 'same as line 3' }, { line: 6, reason: 'same as line 5' }, { line: 14, reason: 'already in the app' }]);
  const lines = r.rejected.map(x => x.line);
  assert.deepEqual(lines, [7, 8, 9, 10, 11, 12, 13, 15, 17, 19]);
  const why = l => r.rejected.find(x => x.line === l).reason;
  for (const l of [7, 8, 9]) assert.match(why(l), /repeated with different details \(lines 7, 8, 9\)/, 'a conflicting repeat quarantines every copy and names the lines');
  assert.match(why(10), /name is empty/);
  assert.match(why(11), /unknown area "astrology"/);
  assert.match(why(12), /sequence "abc" is not a whole number/);
  assert.match(why(13), /age from \(60\) is above age to \(36\)/);
  assert.match(why(15), /fields but .* headers/, 'an unquoted comma shifts the columns, so the row is quarantined');
  assert.match(why(17), /same area and name as a presentation already in the app, but with different details/, 'never a silent update');
  assert.match(why(19), /unterminated quoted field/);
  const all = [...r.rows.map(x => x.line), ...r.duplicates.map(x => x.line), ...r.rejected.map(x => x.line)].sort((a, b) => a - b);
  assert.deepEqual(all, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19], 'no row is lost or counted twice');
});

test('import then preview again: nothing new, and the counts still add up (importing is idempotent)', () => {
  const csv = read('tests/fixtures/curriculum-dirty.csv');
  const db = emptyDb();
  const first = previewCurriculumCsv(db, csv);
  const res = importCurriculum(db, first, ctx);
  assert.equal(res.imported + res.skippedDuplicate + res.rejected, res.inputRows);
  assert.equal(db.presentations.length, res.imported);
  const again = previewCurriculumCsv(db, csv);
  assert.equal(again.counts.imported, 0);
  assert.equal(again.counts.inputRows, again.counts.skippedDuplicate + again.counts.rejected);
  const keys = db.presentations.map(p => p.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('a blank sequence continues after the highest in that area; a stated one is kept', () => {
  const db = { presentations: [pres('math', 'Number rods', { sequence: 70 })] };
  const r = previewCurriculumCsv(db, 'area,name,sequence\nmath,Alpha,\nmath,Beta,\nlanguage,Gamma,\nmath,Delta,5\nmath,Epsilon,\n');
  const seq = Object.fromEntries(r.rows.map(x => [x.presentation.name, x.presentation.sequence]));
  assert.deepEqual(seq, { Alpha: 80, Beta: 90, Gamma: 10, Delta: 5, Epsilon: 100 });
});

test('a repeat that differs only in what the first row left blank is a conflict, not a silent merge', () => {
  const r = previewCurriculumCsv(emptyDb(), 'area,name,age_from_months\nmath,Alpha,\nmath,Alpha,36\n');
  assert.equal(r.counts.imported, 0);
  assert.equal(r.counts.rejected, 2);
});

test('headers: any column order, aliases, extra columns ignored; no area or name column is refused outright', () => {
  const r = previewCurriculumCsv(emptyDb(), 'Notes,Presentation,Area of the curriculum,Colour\nsome note,Pink tower,Sensorial,pink\n');
  assert.equal(r.counts.imported, 1);
  assert.equal(r.rows[0].presentation.description, 'some note');
  assert.equal(r.rows[0].presentation.area, 'sensorial');
  assert.throws(() => previewCurriculumCsv(emptyDb(), 'name,age\nPink tower,3\n'), { code: 'VALIDATION' });
  assert.throws(() => previewCurriculumCsv(emptyDb(), 'Pink tower,sensorial\n'), { code: 'VALIDATION' }, 'a file with no header row');
  assert.deepEqual(previewCurriculumCsv(emptyDb(), '').counts, { inputRows: 0, imported: 0, skippedDuplicate: 0, rejected: 0 });
  assert.deepEqual(previewCurriculumCsv(emptyDb(), 'area,name\n').counts, { inputRows: 0, imported: 0, skippedDuplicate: 0, rejected: 0 });
});

test('row limits: name length, description length, age bounds and the file size cap', () => {
  const long = 'x'.repeat(121);
  const r = previewCurriculumCsv(emptyDb(), `area,name,age_from_months,description\nmath,${long},,\nmath,Ok,5000,\nmath,Fine,,${'d'.repeat(501)}\n`);
  assert.equal(r.counts.rejected, 3);
  assert.match(r.rejected[0].reason, /name is longer than 120/);
  assert.match(r.rejected[1].reason, /outside 0–1200/);
  assert.match(r.rejected[2].reason, /description is longer than 500/);
  const many = `area,name\n${Array.from({ length: MAX_CSV_ROWS + 1 }, (_, i) => `math,Row ${i}`).join('\n')}\n`;
  assert.throws(() => previewCurriculumCsv(emptyDb(), many), { code: 'VALIDATION' });
});

test('formula-looking or markup-looking cells are kept as text (the UI escapes them); nothing is evaluated', () => {
  const r = previewCurriculumCsv(emptyDb(), 'area,name,description\nmath,=1+1,<img src=x onerror=alert(1)>\n');
  assert.equal(r.counts.imported, 1);
  assert.equal(r.rows[0].presentation.name, '=1+1');
  assert.equal(r.rows[0].presentation.description, '<img src=x onerror=alert(1)>');
});

test('the shipped sample CSV previews cleanly against the seed: school-own rows import, repeats of the starter list are duplicates', () => {
  const db = buildSeed(new Date(2026, 9, 2, 10, 0, 0));
  const r = previewCurriculumCsv(db, read('data/curriculum-sample.csv'));
  assert.equal(r.counts.inputRows, 16);
  assert.equal(r.counts.rejected, 0);
  assert.equal(r.counts.skippedDuplicate, 2, 'Pink tower and Hundred board are already in the starter list');
  assert.equal(r.counts.imported, 14);
  assert.equal(r.counts.inputRows, r.counts.imported + r.counts.skippedDuplicate + r.counts.rejected);
  const res = importCurriculum(db, r, ctx);
  assert.deepEqual([res.imported, res.skippedDuplicate, res.rejected], [14, 2, 0]);
  assert.deepEqual(validateDb(db), [], 'the document stays valid after the import');
});

test('the seed carries the starter list as the load command would, with unique ids and keys', () => {
  const db = buildSeed(new Date(2026, 9, 2, 10, 0, 0));
  const starter = starterPresentations();
  assert.equal(db.presentations.length, starter.length);
  assert.deepEqual(db.presentations.map(p => p.key), starter.map(p => p.key));
  assert.equal(new Set(db.presentations.map(p => p.id)).size, starter.length);
});

test('R7 the preview refuses a file over 512 KB, the same limit the import uses, so Confirm is never offered for it', () => {
  const big = 'area,name\n' + Array.from({ length: 900 }, (_, i) => `sensorial,${'x'.repeat(600)}${i}`).join('\n');
  assert.ok(new TextEncoder().encode(big).length > 512 * 1024);
  assert.throws(() => previewCurriculumCsv(emptyDb(), big), /512 KB/);
});

test('R8 text that was not valid UTF-8 (decoded with replacement characters) is refused, not silently imported', () => {
  assert.throws(() => previewCurriculumCsv(emptyDb(), 'area,name\nsensorial,Pink tower �\n'), /UTF-8/);
});
