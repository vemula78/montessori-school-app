#!/usr/bin/env node
// The Edge Functions run the SAME domain code as the browser and the tests. `supabase functions serve/deploy`
// only sees supabase/functions/, so the pure modules are copied there (committed, byte-identical):
//   src/domain/*.js      → supabase/functions/_shared/domain/*.js
//   src/store/schema.js  → supabase/functions/_shared/store/schema.js   (validate.js imports it)
// node scripts/sync-domain.mjs          copy (and delete copies whose source is gone)
// node scripts/sync-domain.mjs --check  exit 1 if any copy is missing, extra or different (CI / acceptance)

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAIRS = [
  { from: 'src/domain', to: 'supabase/functions/_shared/domain', files: null },
  { from: 'src/store', to: 'supabase/functions/_shared/store', files: ['schema.js'] },
];
const check = process.argv.includes('--check');
const problems = [];
let copied = 0, same = 0, removed = 0;

for (const { from, to, files } of PAIRS) {
  const src = join(root, from), dst = join(root, to);
  const list = files || readdirSync(src).filter(f => f.endsWith('.js')).sort();
  if (!check) mkdirSync(dst, { recursive: true });
  for (const f of list) {
    const a = readFileSync(join(src, f));
    const target = join(dst, f);
    const b = existsSync(target) ? readFileSync(target) : null;
    if (b && a.equals(b)) { same++; continue; }
    if (check) problems.push(`${to}/${f} ${b ? 'differs from' : 'is missing for'} ${from}/${f}`);
    else { writeFileSync(target, a); copied++; }
  }
  if (existsSync(dst)) {
    for (const f of readdirSync(dst).filter(x => x.endsWith('.js'))) {
      if (list.includes(f)) continue;
      if (check) problems.push(`${to}/${f} has no source in ${from}/`);
      else { unlinkSync(join(dst, f)); removed++; }
    }
  }
}

if (check) {
  if (problems.length) { console.log(`sync-domain --check FAIL (${problems.length}):\n  ${problems.join('\n  ')}\nRun: node scripts/sync-domain.mjs`); process.exit(1); }
  console.log(`sync-domain --check OK: ${same} files identical`);
} else {
  console.log(`sync-domain: ${copied} copied, ${same} unchanged, ${removed} removed`);
}
