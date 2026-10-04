import { test } from 'node:test';
import assert from 'node:assert/strict';

// The real app's entry defines window.__APP_CONFIG__ before src/api/index.js loads. The exported api must then be
// the Supabase-mode api object itself (not a Promise), with the same surface as the demo. No network is touched:
// creating the client and the api makes no request.
test('remote mode: index.js exports a ready-to-use api object (mode supabase) when __APP_CONFIG__ is set', async () => {
  globalThis.__APP_CONFIG__ = { supabaseUrl: 'http://127.0.0.1:9', supabaseAnonKey: 'test-anon-key', vapidPublicKey: '', gatewayMode: 'test', persistSession: false };
  try {
    const { api } = await import('../src/api/index.js?remote-mode-test');
    assert.equal(typeof api.then, 'undefined', 'not a Promise');
    assert.equal(api.mode, 'supabase');
    for (const k of ['ready', 'subscribe', 'getDb']) assert.equal(typeof api[k], 'function', k);
    for (const ns of ['session', 'people', 'notices', 'threads', 'calendar', 'transport', 'fees', 'attendance', 'diary', 'audit', 'admin', 'auth', 'consent', 'push', 'import', 'reminders', 'rights', 'oversight']) assert.equal(typeof api[ns], 'object', ns);
    for (const f of ['createGatewayOrder', 'verifyGatewayPayment', 'gatewayOrderStatus', 'importSettlementCsv', 'settlementReport', 'applyLateFees', 'recordPayment']) assert.equal(typeof api.fees[f], 'function', `fees.${f}`);
    assert.equal(typeof api.transport.subscribeTrip, 'function');
    for (const ns of [api.admin.accounts, api.admin.announcement, api.auth.twoStep]) assert.equal(typeof ns, 'object', 'administration namespaces');
    assert.deepEqual(api.session.personas(), [], 'nobody signed in');
    assert.throws(() => api.session.set('persona-x'), { code: 'NOT_ALLOWED' });
    await assert.rejects(api.people.students(), { code: 'NOT_ALLOWED' });
  } finally {
    delete globalThis.__APP_CONFIG__;
  }
});
