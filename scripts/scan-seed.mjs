#!/usr/bin/env node
// Fake-data and leak scan. Exit 1 on any hit.
//   1. buildSeed(): every surname ∈ FAKE_SURNAMES, phones +91-90000-00NNN, emails @example.com,
//      dob 1.5–6.5 years before the current academic year starts.
//   2. Grep the published tree (index.html, README.md, app.css, src/, data/, assets/, app/, docs/) and
//      supabase/ for real-school names, Aadhaar-like 12-digit numbers and mobile-shaped 10-digit numbers
//      that are not the fake pattern; grep the published tree for network calls (fetch( / XMLHttpRequest /
//      sendBeacon) — allowed only in the real-app api: src/api/remote*.js and src/api/supabase/**.
//   3. Secrets in every file git would publish (tracked + untracked-not-ignored): JWT-shaped tokens,
//      Supabase secret keys, a Razorpay key id followed by a secret, private keys, service-role key
//      assignments; and no .env file other than the .env.example templates is tracked.
// Research/plan docs legitimately mention the forbidden names and are excluded (gitignored), as is this script.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, dirname, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildSeed } from '../src/seed/seed-data.js';
import { FAKE_SURNAMES, SCHOOL } from '../src/seed/names.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDE = new Set(['school-app-feature-list.md', 'PLAN.md', 'PLAN-REVIEW-LOG.md', 'PLAN-PHASE2.md', 'scripts/scan-seed.mjs']);
const PUBLISHED = ['index.html', 'README.md', 'app.css', 'src', 'data', 'assets', 'app', 'docs'];
const ROOTS = [...PUBLISHED, 'supabase'];
const TEXT_EXT = new Set(['.html', '.js', '.mjs', '.css', '.csv', '.svg', '.json', '.md', '.txt', '.sql', '.ts', '.toml', '.webmanifest']);
// the real-app api may call the network; nothing else that is published may
const NETWORK_ALLOWED = rel => /^src\/api\/remote[^/]*\.js$/.test(rel) || rel.startsWith('src/api/supabase/');
const PHONE_RE = /^\+91-90000-00\d{3}$/;

const hits = [];
const hit = (rule, where, detail) => hits.push({ rule, where, detail });
const mask = s => s.replace(/\d(?=\d{3})/g, '•');

// ---------------- 1. seed data ----------------
const db = buildSeed();
const people = [
  ...db.students.map(p => ['student', p]),
  ...db.guardians.map(p => ['guardian', p]),
  ...db.staff.map(p => ['staff', p]),
];
let phones = 0, emails = 0, dobs = 0;
for (const [kind, p] of people) {
  if (!FAKE_SURNAMES.includes(p.lastName)) hit('surname not in FAKE_SURNAMES', `${kind} ${p.id}`, p.lastName);
  if (p.phone !== undefined) { phones++; if (!PHONE_RE.test(p.phone)) hit('phone not fake pattern', `${kind} ${p.id}`, mask(String(p.phone))); }
  if (p.email !== undefined) { emails++; if (!String(p.email).endsWith('@example.com')) hit('email not @example.com', `${kind} ${p.id}`, String(p.email).replace(/^[^@]*/, '…')); }
}
phones++;
if (!PHONE_RE.test(db.school.phone)) hit('phone not fake pattern', 'school', mask(String(db.school.phone)));

const ay = db.academicYears.find(a => a.id === db.school.currentAcademicYearId);
if (!ay) hit('no current academic year', 'school', String(db.school.currentAcademicYearId));
else {
  const shiftMonths = (iso, months) => {
    const [y, m, d] = iso.split('-').map(Number);
    const t = y * 12 + (m - 1) + months;
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };
  const oldest = shiftMonths(ay.startDate, -78), youngest = shiftMonths(ay.startDate, -18); // 6.5 y and 1.5 y
  for (const s of db.students) {
    dobs++;
    if (!(s.dob >= oldest && s.dob <= youngest)) hit(`dob outside ${oldest}..${youngest}`, `student ${s.id}`, s.dob);
  }
}

// ---------------- 2. published tree grep ----------------
// Real names are stored only as SHA-256 of the lowercase word, so this public script doesn't name them.
const FORBIDDEN_WORD_HASHES = new Map([
  ['4f6d6bb749acd85c1e90243e0e83f0c4920e9b0e7aa04d840d3ea6b13ab0fe8a', 'vendor domain'],
  ['0e38d696338a0dc70f865c8cfc82a89fa2eb278d4608b14117f84dca175c655b', 'hospital name'],
]);
const forbiddenWord = text => {
  for (const w of String(text).toLowerCase().match(/[a-z0-9]+/g) || []) {
    const rule = FORBIDDEN_WORD_HASHES.get(createHash('sha256').update(w).digest('hex'));
    if (rule) return rule;
  }
  return null;
};
const RULES = [
  ['Aadhaar-like 12-digit number', /(?<![\d.])[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}(?![\d])/],
  ['mobile-shaped number (not +91-90000-00NNN)', /(?<![\d.])(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?![\d])/],
  ['network call', /\bfetch\s*\(|XMLHttpRequest|sendBeacon/],
];
const SECRET_RULES = [
  ['JWT-shaped token (Supabase anon/service key?)', /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['Supabase secret key', /\bsb_secret_[A-Za-z0-9_-]{10,}/],
  ['Razorpay key id followed by a secret', /rzp_(?:live|test)_[A-Za-z0-9]{14}[\s"':=,]+[A-Za-z0-9]{20,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['service_role key assignment', /service_role[_ ]?key['"]?\s*[:=]\s*['"]?[A-Za-z0-9._-]{20,}/i],
];
const files = [];
function walk(rel) {
  if (EXCLUDE.has(rel)) return;
  const abs = join(root, rel);
  if (!existsSync(abs)) return;
  const st = statSync(abs);
  if (st.isDirectory()) { for (const n of readdirSync(abs)) walk(rel ? `${rel}/${n}` : n); return; }
  if (TEXT_EXT.has(extname(rel).toLowerCase())) files.push(rel);
}
for (const r of ROOTS) walk(r);
let lines = 0;
const published = rel => PUBLISHED.some(r => rel === r || rel.startsWith(`${r}/`));
for (const rel of files) {
  const text = readFileSync(join(root, rel), 'utf8');
  text.split(/\r?\n/).forEach((line, i) => {
    lines++;
    const clean = line.replace(/\+91-90000-00\d{3}/g, ''); // the sanctioned fake pattern
    const named = forbiddenWord(line);
    if (named) hit(named, `${rel}:${i + 1}`, '(redacted)');
    for (const [rule, re] of RULES) {
      if (rule === 'network call' && (!published(rel) || NETWORK_ALLOWED(rel))) continue;
      const m = re.exec(rule.startsWith('mobile') || rule.startsWith('Aadhaar') ? clean : line);
      if (m) hit(rule, `${rel}:${i + 1}`, rule.includes('number') ? mask(m[0]) : m[0]);
    }
  });
}

// ---------------- 3. secrets in everything git would publish ----------------
let gitFiles = [];
try {
  gitFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
} catch (e) { hit('git ls-files failed', '.', e.message); }
let secretFiles = 0;
for (const rel of gitFiles) {
  if (EXCLUDE.has(rel)) continue;
  if (/(^|\/)\.env/.test(rel) && !/(^|\/)\.env\.example$/.test(rel)) hit('.env file would be published', rel, 'add it to .gitignore');
  const abs = join(root, rel);
  if (!existsSync(abs) || statSync(abs).size > 5 * 1024 * 1024) continue;
  const buf = readFileSync(abs);
  if (buf.includes(0)) continue; // binary
  secretFiles++;
  const text = buf.toString('utf8');
  const named = forbiddenWord(text);
  if (named && !files.includes(rel)) {
    text.split(/\r?\n/).forEach((line, i) => { const n = forbiddenWord(line); if (n) hit(n, `${rel}:${i + 1}`, '(redacted)'); });
  }
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [rule, re] of SECRET_RULES) {
      const m = re.exec(line);
      if (m) hit(rule, `${rel}:${i + 1}`, `${m[0].slice(0, 12)}…`);
    }
  });
}
if (forbiddenWord(`${SCHOOL.name} ${SCHOOL.address}`)) hit('real name in SCHOOL', 'names.js', '(redacted)');

// ---------------- report ----------------
console.log('Seed scan');
console.log(`  people checked      ${people.length} (students ${db.students.length}, guardians ${db.guardians.length}, staff ${db.staff.length})`);
console.log(`  surnames checked    ${people.length} against ${FAKE_SURNAMES.length} allowed`);
console.log(`  phones checked      ${phones}`);
console.log(`  emails checked      ${emails}`);
console.log(`  dobs checked        ${dobs}`);
console.log(`  files grepped       ${files.length} (${lines} lines) in ${ROOTS.join(', ')}`);
console.log(`  secrets/names       ${secretFiles} files git would publish (${gitFiles.length} paths)`);
console.log(`  network calls       allowed only in src/api/remote*.js, src/api/supabase/**`);
console.log(`  excluded            ${[...EXCLUDE].join(', ')}`);
if (hits.length) {
  console.log(`\nFAIL — ${hits.length} hit(s):`);
  for (const h of hits) console.log(`  [${h.rule}] ${h.where} → ${h.detail}`);
  process.exit(1);
}
console.log('\nPASS — 0 hits');
