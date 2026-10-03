// Realtime authorization test with the vendored supabase-js bundle (persistSession:false).
// Driver posts fixes → parent A (same route, bus_live consent) receives every trip_positions INSERT and the trips
// UPDATE carrying 'nearing'; parent B (other route) receives nothing within 5 s; after A withdraws bus_live
// consent, A receives nothing either. Needs: supabase start + functions serve (npm run test:supabase).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createClient } from '../vendor/supabase/supabase-js.esm.js';
import { local, signIn, command, rest } from './helpers.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
let driver, parentA, parentB, clients = [];

async function clientFor(who) {
  const sb = createClient(local().url, local().anon, { auth: { persistSession: false, autoRefreshToken: false } });
  await sb.auth.setSession({ access_token: who.token, refresh_token: who.refresh });
  clients.push(sb);
  return sb;
}
function listen(sb, tripId, tag) {
  const got = { positions: [], trips: [] };
  return new Promise((resolve, reject) => {
    const ch = sb.channel(`test-${tag}-${tripId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'trip_positions', filter: `trip_id=eq.${tripId}` }, p => got.positions.push(p.new))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'trips', filter: `id=eq.${tripId}` }, p => got.trips.push(p.new))
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') resolve({ got, ch });
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(err || new Error(status));
      });
  });
}

before(async () => {
  [driver, parentA] = await Promise.all([signIn('driver1@example.com'), signIn('parent-bus@example.com')]);
  // parent B: a fresh sign-in linked (by the service role, as a redeemed invite would) to the route-2 family, with bus_live consent
  parentB = await signIn(`route2-${randomBytes(3).toString('hex')}@example.com`);
  await rest('POST', 'app_users', { user_id: parentB.userId, role: 'parent', guardian_id: 'grd-05', status: 'active' }, 'return=minimal');
  await rest('POST', 'consents?on_conflict=id', { id: 'cns-rt-grd-05', doc: { id: 'cns-rt-grd-05', guardianId: 'grd-05', studentId: 'stu-09', purpose: 'bus_live', version: 'v1', withdrawnAt: null } }, 'resolution=merge-duplicates,return=minimal');
  // parent A must have live consent at the start
  const g = await command(parentA.token, 'consent.give', { purposes: ['app_account', 'push', 'bus_live'], version: 'v1' });
  assert.equal(g.status, 200, JSON.stringify(g.data));
});
after(async () => { for (const c of clients) await c.removeAllChannels(); });

test('parent A receives positions + nearing; parent B (other route) nothing; A after consent withdrawal nothing', async () => {
  const active = (await rest('GET', "trips?route_id=eq.route-1&status=eq.active&select=id")).data;
  for (const t of active) await command(driver.token, 'transport.endTrip', t.id);
  const start = await command(driver.token, 'transport.startTrip', { routeId: 'route-1', direction: 'pickup', simulated: true });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const tripId = start.data.result.id;
  const [A, B] = await Promise.all([clientFor(parentA), clientFor(parentB)]);
  const [la, lb] = await Promise.all([listen(A, tripId, 'a'), listen(B, tripId, 'b')]);
  await sleep(3000); // let the postgres_changes listeners register (slower right after a fresh supabase start)
  // five fixes walking towards stop 2 (Lotus Park Gate 12.8975, 77.5985), all within 400 m of it
  let ts = Date.now();
  const fixes = [[12.9000, 77.5985], [12.8995, 77.5985], [12.8990, 77.5985], [12.8986, 77.5985], [12.8983, 77.5985]];
  for (const [lat, lng] of fixes) {
    ts += 6000;
    const r = await command(driver.token, 'transport.recordPosition', tripId, { lat, lng, accuracy: 8, ts: new Date(ts).toISOString() });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  for (let i = 0; i < 50 && (la.got.positions.length < 5 || !la.got.trips.length); i++) await sleep(100);
  assert.equal(la.got.positions.length, 5, `parent A received all 5 positions (got ${la.got.positions.length}, trips ${la.got.trips.length})`);
  assert.ok(la.got.trips.some(t => (t.doc.stopEvents || []).some(e => e.type === 'nearing' && e.stopId === 'route-1-stop-2')), 'parent A received the trips UPDATE with nearing');
  assert.ok(la.got.trips.every(t => !('tracker' in t.doc)), 'hysteresis state is not published');
  await sleep(5000);
  assert.deepEqual([lb.got.positions.length, lb.got.trips.length], [0, 0], 'parent B (other route) received nothing in 5 s');

  const w = await command(parentA.token, 'consent.withdraw', 'bus_live');
  assert.equal(w.status, 200, JSON.stringify(w.data));
  const before = la.got.positions.length + la.got.trips.length;
  for (const [lat, lng] of [[12.8980, 77.5985], [12.8977, 77.5985], [12.8975, 77.5985]]) {
    ts += 6000;
    await command(driver.token, 'transport.recordPosition', tripId, { lat, lng, accuracy: 8, ts: new Date(ts).toISOString() });
  }
  await sleep(5000);
  assert.equal(la.got.positions.length + la.got.trips.length, before, 'parent A receives nothing after withdrawing bus_live consent');
  assert.equal((await rest('GET', `trip_positions?trip_id=eq.${tripId}&select=id`)).data.length, 8, 'the fixes were still recorded');

  await command(parentA.token, 'consent.give', { purposes: ['app_account', 'push', 'bus_live'], version: 'v1' });
  await command(driver.token, 'transport.endTrip', tripId);
});
