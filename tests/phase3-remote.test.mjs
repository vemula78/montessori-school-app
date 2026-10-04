// Real-app api (remote.js) for Phase 3, against a fake Supabase client and function caller (no network):
// the photo bytes travel through the signed path only, the URL never comes back to the caller; uploads go to the
// grant's one path; progress history reads progress_events; the new namespaces exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeed } from '../src/seed/seed-data.js';
import { createRemoteApi } from '../src/api/remote.js';
import { createSurface, ApiError, toApiError, op } from '../src/api/index.js';

const NOW = new Date(Date.UTC(2026, 9, 2, 5, 0, 0));
const TEACHER = { userId: 'u-t', role: 'teacher', staffId: 'stf-teacher-pa', guardianId: null };
const snapshotOf = me => ({ status: 'active', me, revs: {}, remindersSent: [], ...buildSeed(NOW), auditLog: [] });

function fakeSb({ uploadError = null } = {}) {
  const queries = [], uploads = [];
  let snapshots = 0;
  const sb = {
    queries, uploads, get snapshots() { return snapshots; },
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'u-t', email: 't@example.com' }, access_token: 't' } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({}),
    },
    rpc: async () => { snapshots++; return { data: snapshotOf(TEACHER), error: null }; },
    from(table) {
      const q = { table, filters: [] };
      const b = {
        select(c) { q.select = c; return b; }, eq(c, v) { q.filters.push([c, v]); return b; }, order(c, o) { q.order = [c, o]; return b; },
        then(res, rej) { queries.push(q); return Promise.resolve({ data: [{ doc: { seq: 1 } }, { doc: { seq: 2 } }], error: null }).then(res, rej); },
      };
      return b;
    },
    storage: { from: bucket => ({ uploadToSignedUrl: async (path, token, blob, opts) => { uploads.push({ bucket, path, token, blob, opts }); return { data: uploadError ? null : { path }, error: uploadError }; } }) },
    channel() { const ch = { on() { return ch; }, subscribe() { return ch; } }; return ch; },
    removeChannel() {},
  };
  return sb;
}
async function make(sb, results = {}) {
  const calls = [];
  const call = async (fnName, body) => { calls.push({ fnName, body }); const r = results[body.name]; if (r instanceof Error) throw r; return { result: typeof r === 'function' ? r(body) : r ?? null }; };
  const api = await createRemoteApi({ supabaseUrl: 'http://127.0.0.1:9/', supabaseAnonKey: 'x' }, { createSurface, ApiError, toApiError, op, sb, call });
  await api.ready();
  return { api, calls };
}

test('photos.blob: the signed path is fetched inside remote.js and only the Blob comes back; nothing is refetched or stored', async () => {
  const sb = fakeSb();
  const signedPath = '/object/sign/child-photos/stu-04/pho-1.jpg?token=fake.token.value';
  const { api, calls } = await make(sb, { 'photos.viewUrl': { photoId: 'pho-1', signedPath, expiresAt: '2026-10-02T05:02:00.000Z' } });
  const before = sb.snapshots;
  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { fetched.push({ url: String(url), init }); return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } }); };
  try {
    const blob = await api.photos.blob('pho-1');
    assert.ok(blob instanceof Blob);
    assert.equal(blob.size, 4);
    assert.deepEqual(fetched.map(f => f.url), [`http://127.0.0.1:9/storage/v1${signedPath}`]);
    assert.equal(fetched[0].init.referrerPolicy, 'no-referrer');
    assert.deepEqual(calls.map(c => c.body.name), ['photos.viewUrl']);
    assert.ok(calls[0].body.requestId, 'every call names its request (readOnly: the server never stores it)');
    assert.equal(sb.snapshots, before, 'a read does not refetch the snapshot');
    globalThis.fetch = async () => new Response('{"statusCode":"404"}', { status: 400 });
    await assert.rejects(api.photos.blob('pho-1'), { code: 'NOT_FOUND' });
  } finally { globalThis.fetch = realFetch; }
});

test('photos.upload: to the grant\'s bucket, path and token as a JPEG; a lost answer (409) is success; size/type/expiry refusals are VALIDATION', async () => {
  const grant = { photo: { id: 'pho-1' }, upload: { bucket: 'child-photos', path: 'stu-04/pho-1.jpg', token: 'tok', signedPath: '/x', expiresAt: '2026-10-02T07:00:00.000Z' } };
  const jpeg = new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' });
  const sb = fakeSb();
  const { api } = await make(sb);
  assert.deepEqual(await api.photos.upload(jpeg, grant), { uploaded: true });
  assert.deepEqual(sb.uploads.map(u => [u.bucket, u.path, u.token, u.opts.contentType]), [['child-photos', 'stu-04/pho-1.jpg', 'tok', 'image/jpeg']]);
  await assert.rejects(api.photos.upload(new Blob(['x'], { type: 'image/png' }), grant), { code: 'VALIDATION' });
  await assert.rejects(api.photos.upload(jpeg, { photo: { id: 'pho-1' }, upload: null, uploadError: 'The upload could not be prepared; add the photo again.' }), /could not be prepared/);
  for (const [error, expect] of [[{ statusCode: '409', message: 'The resource already exists' }, null], [{ statusCode: '413', message: 'Payload too large' }, /400 KiB/],
    [{ statusCode: '415', message: 'mime type image/png is not supported' }, /JPEG/], [{ statusCode: '400', message: 'jwt expired' }, /expired/]]) {
    const { api: a } = await make(fakeSb({ uploadError: error }));
    if (expect) await assert.rejects(a.photos.upload(jpeg, grant), e => e.code === 'VALIDATION' && expect.test(e.message));
    else assert.equal((await a.photos.upload(jpeg, grant)).already, true);
  }
});

test('register/complete/remove are commands (with a refetch); progress history reads progress_events; retention calls; namespaces exist', async () => {
  const sb = fakeSb();
  const { api, calls } = await make(sb, { 'photos.register': { photo: { id: 'pho-1' }, path: 'stu-04/pho-1.jpg', upload: { token: 'tok' } }, 'retention.preview': { asOf: '2026-10-02', categories: {} } });
  const n = sb.snapshots;
  await api.photos.register({ observationId: 'obs-1', soloConfirmed: true });
  await api.photos.complete('pho-1');
  await api.photos.remove('pho-1');
  assert.deepEqual(calls.map(c => [c.body.name, c.body.args]), [['photos.register', [{ observationId: 'obs-1', soloConfirmed: true }]], ['photos.complete', ['pho-1']], ['photos.remove', ['pho-1']]]);
  assert.equal(sb.snapshots, n + 3, 'each write refetches the snapshot');
  const h = await api.progress.history('stu-04', 'prs-1');
  assert.deepEqual(h.map(e => e.seq), [1, 2]);
  assert.deepEqual(sb.queries.at(-1), { table: 'progress_events', filters: [['student_id', 'stu-04'], ['presentation_id', 'prs-1']], select: 'doc', order: ['seq', { ascending: true }] });
  await assert.rejects(api.progress.history('stu-03', 'prs-1'), { code: 'NOT_ALLOWED' }, 'a Toddler child is not this teacher\'s');
  await api.admin.setRetention({ photosMonthsAfterLeaving: 6 });
  assert.equal((await api.admin.retentionPreview()).asOf, '2026-10-02');
  assert.deepEqual(calls.slice(-2).map(c => c.body.name), ['admin.setRetention', 'retention.preview']);
  for (const ns of ['curriculum', 'observations', 'progress', 'reports', 'photos']) assert.equal(typeof api[ns], 'object', ns);
  for (const m of ['list', 'register', 'upload', 'complete', 'remove', 'blob']) assert.equal(typeof api.photos[m], 'function', `photos.${m}`);
  await api.consent.withdraw('photos', { studentIds: ['stu-04'] });
  assert.deepEqual(calls.at(-1).body.args, ['photos', { studentIds: ['stu-04'] }]);
});

test('audit C2: the photo-consent badge asks the server (staff hold no consent rows); one child or a whole program', async () => {
  const sb = fakeSb();
  const { api, calls } = await make(sb, { 'photos.consentStatus': body => (body.args[0].programId ? { 'stu-04': true, 'stu-01': false } : { [body.args[0].studentIds[0]]: body.args[0].studentIds[0] === 'stu-04' }) });
  const n = sb.snapshots;
  assert.equal(await api.photos.consent('stu-04'), true);
  assert.equal(await api.photos.consent('stu-01'), false);
  assert.deepEqual(await api.photos.consentStatus({ programId: 'prog-primary-a' }), { 'stu-04': true, 'stu-01': false });
  assert.deepEqual(calls.map(c => c.body.args[0]), [{ studentIds: ['stu-04'] }, { studentIds: ['stu-01'] }, { programId: 'prog-primary-a' }]);
  assert.ok(calls.every(c => c.body.name === 'photos.consentStatus'));
  assert.equal(sb.snapshots, n, 'reads: no snapshot refetch');
});
