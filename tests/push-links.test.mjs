// Every link a push notification opens must be a route the app knows (review 2026-10-19 #1: they all opened "Page not found").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const routes = [...readFileSync('src/ui/app.js', 'utf8').matchAll(/pattern: '([^']+)'/g)].map((m) => new RegExp(`^${m[1].replace(/:[a-zA-Z]+/g, '[^/]+')}$`));
const links = (file) => [...readFileSync(file, 'utf8').matchAll(/url: [`']#([^`']*)[`']/g)].map((m) => m[1].replace(/\$\{[^}]+\}/g, 'x'));

test('push notification links point at real routes', () => {
  const all = [...links('supabase/functions/_shared/notify.js'), ...links('supabase/functions/cron-daily/index.ts')];
  assert.ok(all.length >= 6, `found ${all.length} links`);
  for (const path of all) assert.ok(routes.some((r) => r.test(path)), `no route for #${path}`);
});
