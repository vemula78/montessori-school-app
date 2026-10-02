process.env.TZ = 'Asia/Kolkata';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseDate, formatDate, formatDateTime, formatTime, todayISO, addDays, diffDays, isWeekend,
  secondsSince, compareISO, dayOfWeek, tsToMs,
} from '../src/domain/dates.js';
import { nextWorkingDay, isWorkingDay } from '../src/domain/calendar.js';
import { createEmptyDb } from '../src/store/schema.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('formatDate', () => {
  assert.equal(formatDate('2026-10-02'), '02-Oct-2026');
  assert.equal(formatDate(null), '—');
  assert.throws(() => formatDate('2026-02-30'));
});

test('parseDate accepts the four declared formats', () => {
  assert.equal(parseDate('2026-10-02'), '2026-10-02');
  assert.equal(parseDate('02-10-2026'), '2026-10-02');
  assert.equal(parseDate('02/10/2026'), '2026-10-02');
  assert.equal(parseDate('02-Oct-2026'), '2026-10-02');
  assert.equal(parseDate('2-oct-2026'), '2026-10-02');
  assert.equal(parseDate('29-02-2028'), '2028-02-29');
});

test('parseDate rejects impossible or loose input', () => {
  assert.equal(parseDate('31-02-2026'), null);
  assert.equal(parseDate('2026-13-01'), null);
  assert.equal(parseDate('2026-1-5'), null);
  assert.equal(parseDate('29-02-2027'), null);
  assert.equal(parseDate('02-10/2026'), null);
  assert.equal(parseDate('10/02/26'), null);
  assert.equal(parseDate(''), null);
  assert.equal(parseDate(undefined), null);
});

test('addDays and diffDays across month and year ends', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2027-01-01', -1), '2026-12-31');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(diffDays('2026-12-25', '2027-01-05'), 11);
  assert.equal(diffDays('2026-10-05', '2026-10-01'), -4);
});

test('weekday helpers', () => {
  assert.equal(dayOfWeek('2026-10-02'), 5); // Friday
  assert.equal(isWeekend('2026-10-03', [0, 6]), true);
  assert.equal(isWeekend('2026-10-02', [0, 6]), false);
  assert.equal(compareISO('2026-01-01', '2026-01-02'), -1);
});

test('nextWorkingDay skips weekend and holiday', () => {
  const db = createEmptyDb();
  db.academicYears.push({ id: 'AY2026-27', label: '2026-27', startDate: '2026-06-01', endDate: '2027-03-31' });
  db.calendarEvents.push({ id: 'e1', academicYearId: 'AY2026-27', type: 'holiday', title: 'Sample break', startDate: '2026-10-05', endDate: '2026-10-05', programIds: [], description: '', source: 'manual', importBatchId: null });
  // Sat 03-Oct → Sun → Mon 05-Oct holiday → Tue 06-Oct
  assert.equal(nextWorkingDay(db, '2026-10-03'), '2026-10-06');
  assert.equal(nextWorkingDay(db, '2026-10-02'), '2026-10-02');
  assert.equal(isWorkingDay(db, '2026-10-05'), false);
});

test('todayISO at 01:00 IST equals the local (IST) date, not the UTC date', () => {
  const at0100IST = new Date(Date.UTC(2026, 9, 1, 19, 30)); // 2026-10-02 01:00 IST = 2026-10-01 19:30 UTC
  assert.equal(at0100IST.toISOString().slice(0, 10), '2026-10-01');
  assert.equal(todayISO(at0100IST), '2026-10-02');
});

test('timestamps display in local time', () => {
  assert.equal(formatTime('2026-10-02T02:12:00Z'), '07:42');
  assert.equal(formatDateTime('2026-10-01T19:30:00.000Z'), '02-Oct-2026 01:00');
  assert.equal(formatTime(null), '—');
  assert.equal(secondsSince('2026-10-02T02:12:00Z', '2026-10-02T02:12:45.500Z'), 45);
  assert.equal(tsToMs('2026-10-02T07:42:00+05:30'), tsToMs('2026-10-02T02:12:00Z'));
  assert.equal(tsToMs('2026-10-02 07:42'), null);
});

test('lint: no Date.parse( or new Date(<string literal>) in src/domain', () => {
  const dir = join(root, 'src', 'domain');
  const offenders = [];
  for (const f of readdirSync(dir).filter(n => n.endsWith('.js'))) {
    const lines = readFileSync(join(dir, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/Date\.parse\(/.test(line) || /new Date\(\s*['"`]/.test(line)) offenders.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});
