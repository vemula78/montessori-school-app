#!/usr/bin/env node
// Generate supabase/seed.sql from the Phase 1 demo seed (buildSeed — fake data only), so the local stack
// starts with exactly the demo's data, written through the same public.persist() the server uses.
// Adds: staff sign-in emails, six fake auth users (OTP via the local Mailpit), parent links and consents.
//   node scripts/seed-sql.mjs            → writes supabase/seed.sql
// Every email is @example.com; no real person, phone or school appears.

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSeed } from '../src/seed/seed-data.js';
import { COLLECTIONS } from '../src/store/schema.js';
import { CONSENT_VERSION } from '../src/domain/commands.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Fixed fake users. Staff are linked by the auth trigger (staff_contacts.email); parents by app_users rows here. */
export const SEED_USERS = [
  { id: '00000000-0000-4000-8000-000000000001', email: 'principal@example.com', staffId: 'stf-principal' },
  { id: '00000000-0000-4000-8000-000000000002', email: 'teacher-pa@example.com', staffId: 'stf-teacher-pa' },
  { id: '00000000-0000-4000-8000-000000000003', email: 'accountant@example.com', staffId: 'stf-accountant' },
  { id: '00000000-0000-4000-8000-000000000004', email: 'driver1@example.com', staffId: 'stf-driver-1' },
  // grd-01: two children in two programs (one on route 1); consent: app account and photos (no live bus)
  { id: '00000000-0000-4000-8000-000000000005', email: 'parent-siblings@example.com', guardianId: 'grd-01', consents: ['app_account', 'photos'] },
  // grd-02: a route-1 bus child; consent: app account, push, live bus, photos
  { id: '00000000-0000-4000-8000-000000000006', email: 'parent-bus@example.com', guardianId: 'grd-02', consents: ['app_account', 'push', 'bus_live', 'photos'] },
];

const q = s => `'${String(s).replace(/'/g, "''")}'`;
const dollar = json => {
  const s = JSON.stringify(json);
  if (s.includes('$seed$')) throw new Error('seed JSON contains the dollar-quote tag');
  return `$seed$${s}$seed$::jsonb`;
};

export function seedChanges(db) {
  const staffEmail = new Map(SEED_USERS.filter(u => u.staffId).map(u => [u.staffId, u.email]));
  const upserts = {};
  for (const c of COLLECTIONS) {
    // auditLog goes in `audit`; consents are written by linkChanges (only the two seed families have app links);
    // demo photo rows are drawn illustrations with no stored object, so a local stack must not hold them as ready
    if (c === 'auditLog' || c === 'consents' || c === 'photos') continue;
    let rows = db[c];
    if (c === 'staff') rows = rows.map(s => ({ ...s, email: staffEmail.get(s.id) || s.email || null }));
    if (c === 'trips') rows = rows.map(({ positions, ...t }) => t);
    upserts[c] = rows;
  }
  const positions = db.trips.flatMap(t => t.positions.map(p => ({ tripId: t.id, ...p })));
  return { school: db.school, upserts, counters: db.counters, audit: db.auditLog, positions };
}

export function linkChanges(db, now) {
  const appUsers = SEED_USERS.filter(u => u.guardianId).map(u => ({ id: u.id, role: 'parent', staffId: null, guardianId: u.guardianId, status: 'active' }));
  const consents = [];
  for (const u of SEED_USERS.filter(x => x.guardianId)) {
    const g = db.guardians.find(x => x.id === u.guardianId);
    for (const studentId of g.studentIds) for (const purpose of u.consents) {
      consents.push({ id: `cns-seed-${u.guardianId}-${studentId}-${purpose}`, guardianId: u.guardianId, studentId, purpose, version: CONSENT_VERSION, textHash: null,
        givenAt: now, withdrawnAt: null, evidence: { method: 'seed (fake demo data)', inviteId: null } });
    }
  }
  return { upserts: { appUsers, consents }, audit: [{ id: 'aud-seed-links', ts: now, actorRole: 'system', actorId: 'seed', entity: 'appUser', entityId: '-', action: 'seedLinks', summary: `${appUsers.length} parent links, ${consents.length} consent records (fake demo data)` }] };
}

function authUsersSql() {
  return SEED_USERS.map(u => `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current, phone_change, phone_change_token, reauthentication_token)
values ('00000000-0000-0000-0000-000000000000', ${q(u.id)}, 'authenticated', 'authenticated', ${q(u.email)}, '', now(), '{"provider":"email","providers":["email"]}', '{}',
  now(), now(), '', '', '', '', '', '', '', '');
insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
values (gen_random_uuid(), ${q(u.id)}, ${q(u.id)}, 'email', jsonb_build_object('sub', ${q(u.id)}, 'email', ${q(u.email)}, 'email_verified', true), now(), now(), now());`).join('\n');
}

export function buildSeedSql(now = new Date()) {
  const db = buildSeed(now);
  const counts = COLLECTIONS.filter(c => !['consents', 'photos'].includes(c)).map(c => `${c} ${db[c].length}`).join(', ');
  return `-- GENERATED by scripts/seed-sql.mjs from src/seed/seed-data.js (buildSeed) — do not edit by hand.
-- Fake demo data only (surnames from FAKE_SURNAMES, phones +91-90000-00NNN, emails @example.com).
-- Generated ${now.toISOString().slice(0, 10)}; attendance, diary and the demo trip are relative to that day: regenerate to refresh.
-- Rows: ${counts}; trip positions ${db.trips.reduce((s, t) => s + t.positions.length, 0)}.

-- 1. the demo document, through the same persist() the command function uses
select public.persist('seed', 0, ${dollar(seedChanges(db))});

-- 2. fake sign-ins (staff are linked to staff_contacts by the auth trigger)
${authUsersSql()}

-- 3. parent links and their consent records
select public.persist('seed-links', 0, ${dollar(linkChanges(db, now.toISOString()))});
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const sql = buildSeedSql();
  writeFileSync(join(root, 'supabase/seed.sql'), sql);
  console.log(`supabase/seed.sql written (${sql.length} bytes, ${SEED_USERS.length} fake users)`);
}
