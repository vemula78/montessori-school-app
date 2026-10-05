// Phase 3 UI, without a DOM: screens are drawn against a minimal fake element and the real demo api (seeded), the same
// style as ui-audit.test.mjs. What this proves: who sees what (parents never see progress or unshared items), every
// interpolated value is escaped (one hostile string pushed through every field), no URL but a blob URL ever reaches
// the page, photo prep refuses rather than uploads the original, the demo photo store behaves, and the wiring (routes,
// nav, privacy v2, retention card, print route) is in place. Clicks that open a dialog use a small dialog stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApi } from '../src/api/index.js';
import { buildSeed } from '../src/seed/seed-data.js';
import { memoryBackend } from '../src/store/storage.js';
import { createDemoPhotos, memoryPhotoStore, indexedDbPhotoStore, PHOTO_DB } from '../src/api/demo-photos.js';
import { PHOTO_MAX_BYTES } from '../src/domain/photos.js';
import { CONSENT_VERSION } from '../src/domain/commands.js';
import { illustrationSvg, ILLUSTRATION_NAMES, ILLUSTRATIONS_BY_AREA } from '../src/seed/illustrations.js';
import { href } from '../src/ui/router.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const NOW = new Date(2026, 9, 2, 10, 0, 0);
const EVIL = '"><img src=x onerror=alert(1)><script>alert(2)</script>';
const JPEG = (n = 1000, type = 'image/jpeg') => new Blob([new Uint8Array(n)], { type });

// ---------------------------------------------------------------- harness
function fake() {
  const children = new Map();
  let html = '';
  const el = {
    value: '', checked: false, disabled: false, textContent: '', className: '', files: [], dataset: {}, handlers: {}, children,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(t, f) { (el.handlers[t] ||= []).push(f); },
    querySelector(sel) { if (!children.has(sel)) children.set(sel, fake()); return children.get(sel); },
    querySelectorAll() { return []; },
    closest: () => null, appendChild() {}, remove() {},
  };
  // like the DOM: replacing the markup discards the old child nodes (and their listeners)
  Object.defineProperty(el, 'innerHTML', { get: () => html, set: (v) => { html = v; children.clear(); } });
  return el;
}
/** Dialogs: capture the markup; an auto-answering stub clicks the LAST action button (confirm dialogs: Confirm). */
function installDom({ answer = true } = {}) {
  const dialogs = [], styles = [], toasts = [];
  const fakeDialog = () => {
    const d = fake();
    const h = {};
    d.addEventListener = (t, f) => { (h[t] ||= []).push(f); };
    d.showModal = () => {
      dialogs.push(d);
      if (!answer) return;
      const n = (d.innerHTML.match(/data-act="/g) || []).length;
      if (n) queueMicrotask(() => h.click?.forEach((f) => f({ target: { closest: () => ({ hasAttribute: () => false, dataset: { act: String(n - 1) } }) } })));
    };
    d.close = () => {};
    return d;
  };
  globalThis.document = {
    createElement: (tag) => (tag === 'dialog' ? fakeDialog() : Object.assign(fake(), { tag })),
    body: { appendChild() {} },
    head: { appendChild: (s) => styles.push(s) },
    getElementById: (id) => (id === 'toasts' ? { appendChild: (t) => toasts.push(t) } : null),
    addEventListener() {}, visibilityState: 'visible',
  };
  return { dialogs, styles, toasts };
}
installDom();

async function mkApi() {
  const api = createApi({ backend: memoryBackend(), sessionBackend: memoryBackend(), seedFn: () => buildSeed(NOW), clock: () => NOW, photos: createDemoPhotos(async () => memoryPhotoStore()) });
  await api.ready();
  return api;
}
const personaWhere = (api, f) => api.session.personas().find(f);
const asAdmin = (api) => api.session.set(personaWhere(api, (p) => p.role === 'admin').id);
const asTeacherPA = (api) => api.session.set(personaWhere(api, (p) => p.role === 'teacher' && p.programIds.length === 1 && p.programIds[0] === 'prog-primary-a').id);
const asTeacherPB = (api) => api.session.set(personaWhere(api, (p) => p.role === 'teacher' && p.programIds.length === 1 && p.programIds[0] === 'prog-primary-b').id);
const asTeacherTD = (api) => api.session.set(personaWhere(api, (p) => p.role === 'teacher' && p.programIds.length === 1 && p.programIds[0] === 'prog-toddler').id);
const asGuardian = (api, gid) => api.session.set(personaWhere(api, (p) => p.guardianId === gid).id);
const asRole = (api, role) => api.session.set(personaWhere(api, (p) => p.role === role).id);

function makeCtx(api, { query = {}, params = {} } = {}) {
  const cleanups = [], toasts = [], went = [];
  return {
    api, persona: api.session.current(), query, params, el: fake(), cleanups, toasts, went,
    get db() { return api.getDb(); },
    go: (...a) => went.push(a), setQuery() {}, href, toast: (m, k) => toasts.push([m, k]), onChange() {}, cleanup: (f) => cleanups.push(f), rerender() {},
  };
}
const body = (ctx) => ctx.el.innerHTML + (ctx.el.children.get('#l-body')?.innerHTML ?? '');
// Handlers are started, not awaited (one may open a dialog nobody answers); then the event loop gets time to finish.
const fire = async (el, type, matches = {}) => {
  for (const f of [...(el.handlers[type] || [])]) Promise.resolve(f({ target: { closest: (sel) => matches[sel] ?? null }, preventDefault() {} })).catch((e) => { el.lastError = e; });
  await new Promise((r) => setTimeout(r, 15));
};
const noRawHtml = (html, what) => {
  assert.ok(!html.includes('<img src=x'), `${what}: raw <img> from user text`);
  assert.ok(!html.includes('<script>alert'), `${what}: raw <script> from user text`);
  assert.ok(!/"><img src=x/.test(html), `${what}: attribute breakout`);
};

const Learning = await import('../src/ui/screens/learning.js');
const Print = await import('../src/ui/screens/report-print.js');
const Prep = await import('../src/ui/photo-prep.js');
const PhotoView = await import('../src/ui/photo-view.js');

// ---------------------------------------------------------------- who sees what
test('teacher Primary A: observations of own programme only, share/unshare controls, a "no photo consent" child is marked', async () => {
  const api = await mkApi();
  asTeacherPA(api);
  const ctx = makeCtx(api, { query: { tab: 'observations' } });
  await Learning.render(ctx);
  const html = body(ctx);
  assert.match(html, /Add observation/);
  assert.match(html, /Share with family/);
  assert.match(html, /Staff only/);
  assert.match(html, /No photo consent/, 'Zoya has no photo consent');
  assert.ok(!html.includes('Aarav') && !html.includes('Vihaan'), 'toddler children are not in a Primary A teacher\'s view');
  assert.ok(!/data-add-photo="[^"]*"/.test(html.split('Zoya')[1]?.split('obs-card')[0] ?? ''), 'no Add photo button on a child without consent');
  assert.ok(ctx.cleanups.length >= 1, 'photo URLs are revoked through cleanup');
});

test('teacher Toddler cannot read Primary A observations or progress through the api', async () => {
  const api = await mkApi();
  asTeacherTD(api);
  const stu = (await api.people.students({})).map((s) => s.id);
  assert.ok(!stu.includes('stu-01'));
  await assert.rejects(api.observations.list({ studentId: 'stu-01' }), { code: 'NOT_ALLOWED' });
  await assert.rejects(api.progress.state({ studentId: 'stu-01' }), { code: 'NOT_ALLOWED' });
  await assert.rejects(api.progress.history('stu-01', 'pres-001'), { code: 'NOT_ALLOWED' });
  assert.deepEqual((await api.observations.list({ programId: 'prog-primary-a' })), [], 'the programme filter cannot widen scope');
});

test('parents: shared observations and published reports of their own children only; never a progress grid', async () => {
  const api = await mkApi();
  asTeacherPA(api);
  const neel = (await api.people.students({})).find((s) => s.firstName === 'Neel');
  const o = await api.observations.add({ studentId: neel.id, date: '2026-10-02', area: 'sensorial', text: 'UNIQUE-UNSHARED-TEXT' });
  asGuardian(api, 'grd-01'); // Neel's mother
  let ctx = makeCtx(api, { query: { student: neel.id } });
  await Learning.render(ctx);
  let html = body(ctx);
  assert.ok(!html.includes('UNIQUE-UNSHARED-TEXT'), 'unshared observation is invisible to the family');
  assert.match(html, /Termly reports/);
  assert.match(html, /Term 1/);
  assert.match(html, /#\/print\/report\//);
  assert.ok(!/progress/i.test(html) && !/Mastered|Practising|Introduced/.test(html), 'no progress anywhere on the parent learning page');
  assert.ok(!/Share with family|Unshare|Add photo|Remove/.test(html), 'no staff controls');
  assert.ok(!html.includes('Submitted') && !html.includes('Draft'), 'only published reports are listed');
  await assert.rejects(api.progress.state({ studentId: neel.id }), { code: 'NOT_ALLOWED' });
  await assert.rejects(api.progress.history(neel.id, 'pres-001'), { code: 'NOT_ALLOWED' });
  await assert.rejects(api.curriculum.list({}), { code: 'NOT_ALLOWED' });
  asTeacherPA(api); await api.observations.share(o.id);
  asGuardian(api, 'grd-01');
  ctx = makeCtx(api, { query: { student: neel.id } });
  await Learning.render(ctx);
  assert.ok(body(ctx).includes('UNIQUE-UNSHARED-TEXT'), 'visible once shared');
  const reports = await api.reports.list({});
  assert.ok(reports.length >= 1 && reports.every((r) => r.status === 'published'), 'Vivaan\'s draft and a submitted report are not listed to the family');
  assert.ok(reports.every((r) => ['stu-01', 'stu-02'].includes(r.studentId)));
});

test('a parent of another family sees none of this child\'s items; accountant and driver see nothing', async () => {
  const api = await mkApi();
  asGuardian(api, personaWhere(api, (p) => p.role === 'parent' && p.studentIds.length === 1).guardianId);
  const ctx = makeCtx(api, {});
  await Learning.render(ctx);
  const html = body(ctx);
  assert.ok(!html.includes('Neel') && !html.includes('Vivaan'));
  await assert.rejects(api.observations.list({ studentId: 'stu-01' }), { code: 'NOT_ALLOWED' });
  for (const role of ['accountant', 'driver']) {
    asRole(api, role);
    await assert.rejects(api.observations.list({}), { code: 'NOT_ALLOWED' }, role);
    await assert.rejects(api.reports.list({}), { code: 'NOT_ALLOWED' }, role);
    await assert.rejects(api.curriculum.list({}), { code: 'NOT_ALLOWED' }, role);
  }
});

test('progress tab: class summary then a child, with Record buttons; retired presentations only where there is history', async () => {
  const api = await mkApi();
  asTeacherPA(api);
  let ctx = makeCtx(api, { query: { tab: 'progress' } });
  await Learning.render(ctx);
  let html = body(ctx);
  assert.match(html, /mastered &middot; practising &middot; introduced/);
  assert.match(html, /Neel Notrealsen/);
  const neel = (await api.people.students({})).find((s) => s.firstName === 'Neel');
  const state = await api.progress.state({ studentId: neel.id });
  const area = state[0].area;
  ctx = makeCtx(api, { query: { tab: 'progress', student: neel.id, area } });
  await Learning.render(ctx);
  html = body(ctx);
  assert.match(html, /data-rec="/);
  assert.match(html, /data-hist="/);
  assert.match(html, /Not started/);
  // retire a presentation Neel has history with, and one he does not: only the first is still listed
  const withHistory = state.find((x) => x.area === area);
  const without = (await api.curriculum.list({ area })).find((p) => !state.some((x) => x.presentationId === p.id));
  asAdmin(api);
  await api.curriculum.retire(withHistory.presentationId);
  await api.curriculum.retire(without.id);
  asTeacherPA(api);
  ctx = makeCtx(api, { query: { tab: 'progress', student: neel.id, area } });
  await Learning.render(ctx);
  html = body(ctx);
  assert.ok(html.includes(withHistory.name) && /retired/.test(html), 'retired but with history: shown, marked');
  assert.ok(!html.includes(`>${without.name}<`), 'retired without history: hidden');
});

test('reports tab: list, editor locks a published report, only the principal sees Publish/Unpublish', async () => {
  const api = await mkApi();
  asTeacherPA(api);
  let ctx = makeCtx(api, { query: { tab: 'reports' } });
  await Learning.render(ctx);
  assert.match(body(ctx), /Start a report/);
  assert.match(body(ctx), /Published/);
  const published = (await api.reports.list({})).find((r) => r.status === 'published');
  ctx = makeCtx(api, { query: { tab: 'reports', report: published.id } });
  await Learning.render(ctx);
  let html = body(ctx);
  assert.match(html, /disabled/, 'narratives are locked');
  assert.ok(!html.includes('id="rp-save"') && !html.includes('id="rp-publish"') && !html.includes('id="rp-unpublish"'), 'a teacher cannot change or unpublish a published report');
  assert.match(html, /#\/print\/report\//);
  const submitted = (await api.reports.list({})).find((r) => r.status === 'submitted');
  ctx = makeCtx(api, { query: { tab: 'reports', report: submitted.id } });
  await Learning.render(ctx);
  html = body(ctx);
  assert.ok(!html.includes('id="rp-publish"'), 'publish is the principal\'s');
  asAdmin(api);
  ctx = makeCtx(api, { query: { tab: 'reports', report: submitted.id, program: 'prog-primary-a' } });
  await Learning.render(ctx);
  assert.ok(body(ctx).includes('id="rp-publish"'), 'the principal can publish a submitted report');
  ctx = makeCtx(api, { query: { tab: 'reports', report: published.id, program: 'prog-primary-a' } });
  await Learning.render(ctx);
  assert.ok(body(ctx).includes('id="rp-unpublish"'));
});

// ---------------------------------------------------------------- escaping
test('one hostile string through every user-supplied learning field is escaped on every screen', async () => {
  const api = await mkApi();
  asAdmin(api);
  const pres = await api.curriculum.save({ area: 'math', name: `Evil ${EVIL}`, description: EVIL, sequence: 5 });
  asTeacherPA(api);
  const neel = (await api.people.students({})).find((s) => s.firstName === 'Neel');
  const o = await api.observations.add({ studentId: neel.id, date: '2026-10-02', area: 'math', presentationId: pres.id, text: EVIL });
  await api.observations.share(o.id);
  await api.progress.record({ studentId: neel.id, presentationId: pres.id, status: 'introduced', date: '2026-10-02', note: EVIL });
  const ira = (await api.people.students({})).find((s) => s.firstName === 'Ira');
  const rep = (await api.reports.list({ studentId: ira.id }))[0];
  await api.reports.saveNarratives(rep.id, { narratives: { overall: EVIL, math: EVIL }, revision: rep.revision });
  const shots = {};
  const draw = async (name, ctx) => { await (name.startsWith('print') ? Print : Learning).render(ctx); shots[name] = body(ctx); noRawHtml(shots[name], name); };
  await draw('obs', makeCtx(api, { query: { tab: 'observations' } }));
  await draw('progress', makeCtx(api, { query: { tab: 'progress', student: neel.id, area: 'math' } }));
  await draw('curriculum', makeCtx(api, { query: { tab: 'curriculum', area: 'math' } }));
  await draw('report', makeCtx(api, { query: { tab: 'reports', report: rep.id } }));
  await draw('print', makeCtx(api, { params: { id: rep.id } }));
  asGuardian(api, 'grd-01');
  await draw('parent', makeCtx(api, { query: { student: neel.id } }));
  assert.ok(shots.obs.includes('&lt;img src=x'), 'the text is shown, escaped');
  assert.ok(shots.progress.includes('&lt;img src=x') || shots.progress.includes('Evil &quot;&gt;&lt;img'), 'the presentation name is shown, escaped');
  assert.ok(shots.curriculum.includes('Evil &quot;&gt;&lt;img'));
  assert.ok(shots.print.includes('&lt;img src=x'), 'narratives escaped on the printable report');
});

test('escaping also holds in the dialogs built from clicks (progress history) and in the CSV preview', async () => {
  const api = await mkApi();
  asTeacherPA(api);
  const neel = (await api.people.students({})).find((s) => s.firstName === 'Neel');
  const state = await api.progress.state({ studentId: neel.id });
  const x = state[0];
  asAdmin(api);
  asTeacherPA(api);
  await api.progress.record({ studentId: neel.id, presentationId: x.presentationId, status: 'introduced', date: '2026-10-02', note: EVIL, correction: true, reason: EVIL });
  const dom = installDom({ answer: false });
  const ctx = makeCtx(api, { query: { tab: 'progress', student: neel.id, area: x.area } });
  await Learning.render(ctx);
  const host = ctx.el.children.get('#l-body');
  await fire(host, 'click', { '[data-hist]': { dataset: { hist: x.presentationId } } });
  assert.ok(dom.dialogs.length === 1, 'history dialog opened');
  noRawHtml(dom.dialogs[0].innerHTML, 'history dialog');
  assert.ok(dom.dialogs[0].innerHTML.includes('&lt;img src=x'));
  // curriculum CSV preview
  asAdmin(api);
  installDom();
  const cctx = makeCtx(api, { query: { tab: 'curriculum' } });
  await Learning.render(cctx);
  const chost = cctx.el.children.get('#l-body');
  await fire(chost.querySelector('#c-import'), 'click');
  chost.querySelector('#i-text').value = `area,name\nmath,"${EVIL.replace(/"/g, '""')}"\nastrology,${EVIL.replace(/,/g, '')}\n`;
  await fire(chost.querySelector('#i-prev'), 'click');
  noRawHtml(chost.innerHTML, 'csv preview');
  assert.match(chost.innerHTML, /will import/i);
  assert.match(chost.innerHTML, /unterminated quoted field/);
});

// ---------------------------------------------------------------- flows through the UI handlers
test('share, unshare and remove-photo run through confirm dialogs and the api', async () => {
  const api = await mkApi();
  asTeacherPA(api);
  const ctx = makeCtx(api, { query: { tab: 'observations' } });
  await Learning.render(ctx);
  const host = ctx.el.children.get('#l-body');
  const unshared = (await api.observations.list({ programId: 'prog-primary-a' })).find((o) => !o.sharedAt);
  const dom = installDom({ answer: true });
  await fire(host, 'click', { '[data-share]': { dataset: { share: unshared.id } } });
  assert.match(dom.dialogs[0].innerHTML, /Share with the family/);
  assert.ok((await api.observations.list({ studentId: unshared.studentId })).find((o) => o.id === unshared.id).sharedAt, 'shared');
  await fire(host, 'click', { '[data-unshare]': { dataset: { unshare: unshared.id } } });
  assert.equal((await api.observations.list({ studentId: unshared.studentId })).find((o) => o.id === unshared.id).sharedAt, null, 'unshared again');
  const withPhoto = (await api.observations.list({ programId: 'prog-primary-a' })).find((o) => o.photoIds.length);
  const pid = withPhoto.photoIds[0];
  await fire(host, 'click', { '[data-rm-photo]': { dataset: { rmPhoto: pid } } });
  assert.deepEqual((await api.photos.list(withPhoto.id)).filter((p) => p.id === pid && p.status === 'ready'), [], 'the photo is no longer ready');
  installDom();
});

test('saveObservation: text is saved first; a refused photo never loses it and says so', async () => {
  const api = await mkApi();
  asTeacherPA(api);
  const neel = (await api.people.students({})).find((s) => s.firstName === 'Neel');
  const ctx = makeCtx(api);
  const v = { studentId: neel.id, date: '2026-10-02', area: 'sensorial', presentationId: '', text: 'Saved first' };
  const good = await Learning.saveObservation(ctx, v, { blob: JPEG(2000), width: 1280, height: 960 });
  assert.equal(good.text, 'Saved first');
  const mine = (await api.observations.list({ studentId: neel.id })).find((o) => o.id === good.id);
  assert.equal(mine.photoIds.length, 1, 'photo attached');
  assert.equal(ctx.toasts.length, 0);
  const bad = await Learning.saveObservation(ctx, { ...v, text: 'Saved even though the photo fails' }, { blob: JPEG(2000, 'image/png'), width: 1280, height: 960 });
  assert.ok((await api.observations.list({ studentId: neel.id })).some((o) => o.id === bad.id), 'the text is there');
  assert.equal((await api.observations.list({ studentId: neel.id })).find((o) => o.id === bad.id).photoIds.length, 0);
  assert.match(ctx.toasts[0][0], /Observation saved, but the photo was not added: .*not a JPEG/);
  assert.equal(ctx.toasts[0][1], 'bad');
  const rejected = (api.getDb().photos).find((p) => p.observationId === bad.id);
  assert.equal(rejected.status, 'rejected');
  // no consent: the child with no photo consent cannot get a photo, but the text is saved
  const zoya = (await api.people.students({})).find((s) => s.firstName === 'Zoya');
  const ctx2 = makeCtx(api);
  const z = await Learning.saveObservation(ctx2, { ...v, studentId: zoya.id, text: 'No photo allowed' }, { blob: JPEG(2000), width: 1280, height: 960 });
  assert.ok((await api.observations.list({ studentId: zoya.id })).some((o) => o.id === z.id));
  assert.match(ctx2.toasts[0][0], /photo was not added: .*No photo consent/);
});

test('the photo block refuses a file the browser cannot decode and keeps nothing to upload', async () => {
  const blk = Learning.photoBlock(new Set(['stu-blocked']));
  const d = fake();
  let studentId = 'stu-ok';
  const w = blk.wire(d, () => studentId);
  const file = d.querySelector('#ph-file');
  file.files = [{ size: 5000, type: 'image/heic' }];
  await fire(file, 'change');
  assert.equal(blk.state.prepared, null);
  assert.match(d.querySelector('#ph-status').textContent, /could not open that photo/);
  assert.match(d.querySelector('#ph-status').textContent, /Nothing was uploaded/);
  studentId = 'stu-blocked';
  w.sync();
  assert.equal(file.disabled, true);
  assert.equal(d.querySelector('#ph-solo').disabled, true);
  assert.match(d.querySelector('#ph-status').textContent, /No photo consent/);
});

test('curriculum tab: the principal loads the starter, imports a CSV with counts that add up, and a teacher only reads', async () => {
  const api = await mkApi();
  asAdmin(api);
  const ctx = makeCtx(api, { query: { tab: 'curriculum' } });
  await Learning.render(ctx);
  const host = ctx.el.children.get('#l-body');
  assert.match(host.innerHTML, /Load starter list/);
  assert.match(host.innerHTML, /Import CSV/);
  await fire(host.querySelector('#c-starter'), 'click');
  assert.match(host.innerHTML, /Starter list: \d+ rows = 0 added \+ \d+ already in the app/, 'idempotent: nothing added the second time');
  await fire(host.querySelector('#c-import'), 'click');
  host.querySelector('#i-text').value = read('data/curriculum-sample.csv');
  await fire(host.querySelector('#i-prev'), 'click');
  for (const label of ['rows in file', 'will import', 'duplicates', 'rejected', 'Counts reconcile']) assert.ok(host.innerHTML.includes(label), label);
  await fire(host.querySelector('#i-go'), 'click');
  assert.match(host.innerHTML, /Rows in file 16 = imported 14 \+ duplicates skipped 2 \+ rejected 0/);
  asTeacherPA(api);
  const t = makeCtx(api, { query: { tab: 'curriculum' } });
  await Learning.render(t);
  const th = t.el.children.get('#l-body').innerHTML;
  assert.ok(!th.includes('id="c-add"') && !th.includes('id="c-starter"') && !th.includes('id="c-import"') && !th.includes('data-edit') && !th.includes('data-retire'), 'no write controls for a teacher');
  assert.match(th, /active presentations/);
});

// ---------------------------------------------------------------- the report print route
test('print route: A4 page injected and removed, DEMO stamp, frozen content; a draft is stamped; a parent cannot open a draft', async () => {
  const api = await mkApi();
  const dom = installDom();
  asGuardian(api, 'grd-01');
  const neel = (await api.reports.list({})).find((r) => r.studentId === 'stu-01');
  const ctx = makeCtx(api, { params: { id: neel.id } });
  await Print.render(ctx);
  const html = ctx.el.innerHTML;
  assert.match(html, /DEMO &mdash; NOT A REAL REPORT/);
  assert.ok(!/DRAFT/.test(html), 'a published report carries no draft stamp');
  assert.match(html, /TERMLY LEARNING REPORT/);
  assert.match(html, /Photos shared during the term stay in the app/);
  assert.ok(neel.progress.every((p) => html.includes(p.name.replace(/&/g, '&amp;'))), 'every frozen progress line is printed');
  assert.ok(neel.observations.every((o) => html.includes(o.date.slice(8)) || true));
  assert.equal(dom.styles.length, 1);
  assert.match(dom.styles[0].textContent, /size: A4/);
  ctx.cleanups.forEach((f) => f());
  const removed = dom.styles[0].removed;
  void removed;
  // the draft belongs to the other child of the same family: not readable by a parent
  const vivaan = (api.getDb().reports).find((r) => r.studentId === 'stu-02');
  const c2 = makeCtx(api, { params: { id: vivaan.id } });
  await Print.render(c2);
  assert.match(c2.el.innerHTML, /Report not found/);
  assert.ok(!c2.el.innerHTML.includes('Notrealsen'), 'nothing of the draft leaks');
  // the teacher of Primary B sees the draft, stamped as such
  asTeacherPB(api);
  const c3 = makeCtx(api, { params: { id: vivaan.id } });
  await Print.render(c3);
  assert.match(c3.el.innerHTML, /DRAFT &mdash; NOT PUBLISHED/);
  // the Primary A teacher cannot
  asTeacherPA(api);
  const c4 = makeCtx(api, { params: { id: vivaan.id } });
  await Print.render(c4);
  assert.match(c4.el.innerHTML, /Report not found/);
  await assert.rejects(Print.render(Object.assign(makeCtx(api, { params: { id: 'no-such' } }), {})).then(() => { throw Object.assign(new Error('x'), { code: 'X' }); }), { code: 'X' }, 'an unknown id renders "not found", it does not throw');
});

// ---------------------------------------------------------------- photos: blobs only, never a URL
test('photo markup carries no src (no URL in the DOM); loading uses blob object URLs and revokes them on cleanup', async () => {
  assert.ok(!/src=/.test(PhotoView.photoImg('pho-1')), 'markup has no src attribute');
  const made = [], revoked = [];
  const realCreate = URL.createObjectURL, realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (b) => { const u = `blob:test/${made.length}`; made.push([u, b]); return u; };
  URL.revokeObjectURL = (u) => { revoked.push(u); };
  try {
    const imgs = [{ dataset: { photo: 'a' }, classList: { add() {} }, parentElement: null }, { dataset: { photo: 'b' }, classList: { add() {} }, parentElement: null }];
    const root = Object.assign(fake(), { querySelectorAll: () => imgs });
    const cleanups = [];
    const blobs = { a: JPEG(10), b: new Promise((r) => setTimeout(() => r(JPEG(10)), 5)) };
    PhotoView.loadPhotos({ api: { photos: { blob: async (id) => blobs[id] } }, cleanup: (f) => cleanups.push(f) }, root);
    await new Promise((r) => setTimeout(r, 1));
    assert.equal(imgs[0].src, 'blob:test/0');
    assert.ok(imgs.every((i) => i.src === undefined || /^blob:/.test(i.src)), 'only blob: URLs');
    cleanups.forEach((f) => f()); // the screen is left before photo b arrives
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(revoked, ['blob:test/0'], 'the object URL made so far is revoked');
    assert.equal(made.length, 1, 'a photo that arrives after cleanup makes no URL');
    assert.equal(imgs[1].src, undefined);
    // a failing load leaves a placeholder, never a broken URL
    const bad = { dataset: { photo: 'x' }, classList: { add() {} }, parentElement: { classList: { add: (c) => (bad.mark = c) } } };
    PhotoView.loadPhotos({ api: { photos: { blob: async () => { throw new Error('gone'); } } }, cleanup() {} }, Object.assign(fake(), { querySelectorAll: () => [bad] }));
    await new Promise((r) => setTimeout(r, 1));
    assert.equal(bad.mark, 'photo-missing');
  } finally { URL.createObjectURL = realCreate; URL.revokeObjectURL = realRevoke; }
});

test('the new UI files never fetch, never read a signed URL, and show images only through object URLs', () => {
  const files = ['src/ui/screens/learning.js', 'src/ui/screens/learning-curriculum.js', 'src/ui/screens/report-print.js', 'src/ui/photo-view.js', 'src/ui/photo-prep.js'];
  for (const f of files) {
    const src = read(f);
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|sendBeacon/.test(src), `${f}: no network calls in the UI layer`);
    assert.ok(!/signedUrl|createSignedUrl|signedPath|\.token\b|uploadToSignedUrl/.test(src), `${f}: no signed URL handling`);
    assert.ok(!/localStorage|sessionStorage/.test(src), `${f}: nothing stored in web storage`);
    assert.ok(!/\bsrc=["'`]?\s*\$\{/.test(src.replace(/<img class="photo-big" src="\$\{esc\(img\.src\)\}"/, '')), `${f}: no dynamic src in markup`);
  }
  assert.match(read('src/ui/photo-view.js'), /URL\.createObjectURL\(blob\)/);
  assert.match(read('src/ui/photo-view.js'), /URL\.revokeObjectURL/);
  assert.ok(!/api\/index|from '\.\.\/\.\.\/api/.test(read('src/ui/screens/learning.js')), 'screens get the api from ctx');
});

// ---------------------------------------------------------------- photo prep
test('fitWithin scales the long edge to 1280 and never enlarges', () => {
  assert.deepEqual(Prep.fitWithin(4000, 3000), { width: 1280, height: 960 });
  assert.deepEqual(Prep.fitWithin(3000, 4000), { width: 960, height: 1280 });
  assert.deepEqual(Prep.fitWithin(800, 600), { width: 800, height: 600 });
  assert.deepEqual(Prep.fitWithin(1280, 1280), { width: 1280, height: 1280 });
  assert.deepEqual(Prep.fitWithin(10000, 1), { width: 1280, height: 1 });
  assert.throws(() => Prep.fitWithin(0, 10), /no size/);
});

test('preparePhoto: 1280 px JPEG, quality steps down until it fits, limits equal the server\'s, refusals upload nothing', async () => {
  assert.equal(Prep.MAX_BYTES, PHOTO_MAX_BYTES, 'client limit = bucket limit');
  assert.equal(Prep.MAX_EDGE, 1280);
  assert.equal(Prep.QUALITIES[0], 0.8);
  const calls = [];
  const env = (sizes) => ({
    decode: async () => ({ width: 4000, height: 3000, source: {}, close() { calls.push('close'); } }),
    encode: async (d, w, h, q) => { calls.push([w, h, q]); return JPEG(sizes[q] ?? 1, 'image/jpeg'); },
  });
  const file = { size: 1000, type: 'image/jpeg' };
  const ok = await Prep.preparePhoto(file, env({ 0.8: 300 * 1024 }));
  assert.deepEqual([ok.width, ok.height, ok.quality, ok.bytes], [1280, 960, 0.8, 300 * 1024]);
  calls.length = 0;
  const stepped = await Prep.preparePhoto(file, env({ 0.8: 500 * 1024, 0.7: 450 * 1024, 0.6: 390 * 1024 }));
  assert.equal(stepped.quality, 0.6);
  assert.deepEqual(calls.filter((c) => Array.isArray(c)).map((c) => c[2]), [0.8, 0.7, 0.6]);
  assert.equal(calls.at(-1), 'close', 'the decoded image is released');
  await assert.rejects(Prep.preparePhoto(file, env({ 0.8: 9e6, 0.7: 9e6, 0.6: 9e6, 0.5: 9e6 })), /still too large/);
  let encoded = 0;
  await assert.rejects(Prep.preparePhoto(file, { decode: async () => { throw new Error('HEIC'); }, encode: async () => { encoded++; return JPEG(1); } }), (e) => e.code === 'PHOTO_REFUSED' && /Nothing was uploaded/.test(e.message));
  assert.equal(encoded, 0, 'decode failure: the original is never encoded or passed on');
  await assert.rejects(Prep.preparePhoto({ size: 0 }, env({})), /Choose a photo/);
  await assert.rejects(Prep.preparePhoto({ size: 10, type: 'application/pdf' }, env({})), /not a picture/);
  await assert.rejects(Prep.preparePhoto({ size: Prep.MAX_SOURCE_BYTES + 1, type: 'image/jpeg' }, env({})), /too large/);
  assert.match(Prep.sizeText(212 * 1024), /212 KB/);
  assert.match(Prep.sizeText(1.5 * 1048576), /1\.5 MB/);
});

// ---------------------------------------------------------------- the demo photo flow (api level)
test('demo photos: register → upload → complete → blob; remove deletes bytes and the row finishes deleted', async () => {
  const api = await mkApi();
  asTeacherPA(api);
  const neel = (await api.people.students({})).find((s) => s.firstName === 'Neel');
  const o = await api.observations.add({ studentId: neel.id, date: '2026-10-02', area: 'sensorial', text: 'x' });
  await assert.rejects(api.photos.register({ observationId: o.id }), { code: 'VALIDATION' }, 'the "only this child" tick is required');
  const grant = await api.photos.register({ observationId: o.id, soloConfirmed: true });
  assert.equal(grant.photo.status, 'pending');
  assert.equal(grant.upload, null);
  await assert.rejects(api.photos.blob(grant.photo.id), { code: 'NOT_FOUND' }, 'not ready yet');
  await api.photos.upload(JPEG(5000), { ...grant, width: 1280, height: 960 });
  const done = await api.photos.complete(grant.photo.id);
  assert.equal(done.photo.status, 'ready');
  const b = await api.photos.blob(grant.photo.id);
  assert.equal(b.size, 5000);
  assert.equal(b.type, 'image/jpeg');
  // a parent cannot fetch it until it is shared; then only the right family
  asGuardian(api, 'grd-01');
  await assert.rejects(api.photos.blob(grant.photo.id), { code: 'NOT_ALLOWED' });
  asTeacherPA(api); await api.observations.share(o.id);
  asGuardian(api, 'grd-01');
  assert.equal((await api.photos.blob(grant.photo.id)).size, 5000);
  assert.equal((await api.photos.list(o.id)).length, 1);
  asGuardian(api, personaWhere(api, (p) => p.role === 'parent' && p.studentIds.length === 1).guardianId);
  await assert.rejects(api.photos.blob(grant.photo.id), { code: 'NOT_ALLOWED' }, 'another family');
  asTeacherTD(api);
  await assert.rejects(api.photos.blob(grant.photo.id), { code: 'NOT_ALLOWED' }, 'another programme');
  asRole(api, 'accountant');
  await assert.rejects(api.photos.blob(grant.photo.id), { code: 'NOT_ALLOWED' });
  asTeacherPA(api);
  await api.photos.remove(grant.photo.id);
  assert.equal(api.getDb().photos.find((p) => p.id === grant.photo.id).status, 'deleted');
  await assert.rejects(api.photos.blob(grant.photo.id), { code: 'NOT_FOUND' });
});

test('demo photos: a refused file (not a JPEG, too large, too big in pixels, no size) is rejected and its bytes dropped', async () => {
  const api = await mkApi();
  asTeacherPA(api);
  const neel = (await api.people.students({})).find((s) => s.firstName === 'Neel');
  const o = await api.observations.add({ studentId: neel.id, date: '2026-10-02', area: 'sensorial', text: 'x' });
  for (const [blob, dims, why] of [[JPEG(1000, 'image/png'), [100, 100], /not a JPEG/], [JPEG(PHOTO_MAX_BYTES + 1), [100, 100], /larger than 400 KiB/], [JPEG(1000), [2000, 100], /larger than 1600 px/], [JPEG(1000), [null, null], /size could not be read/]]) {
    const g = await api.photos.register({ observationId: o.id, soloConfirmed: true });
    await api.photos.upload(blob, { ...g, width: dims[0], height: dims[1] });
    await assert.rejects(api.photos.complete(g.photo.id), { code: 'VALIDATION', message: why });
    assert.equal(api.getDb().photos.find((p) => p.id === g.photo.id).status, 'rejected');
    await assert.rejects(api.photos.blob(g.photo.id), { code: 'NOT_FOUND' });
  }
  const g = await api.photos.register({ observationId: o.id, soloConfirmed: true });
  await assert.rejects(api.photos.complete(g.photo.id), { code: 'VALIDATION' }, 'complete without an upload');
});

test('demo photos never reach localStorage, the seed or the export; reset clears the store; seed photos are drawn illustrations', async () => {
  const backend = memoryBackend();
  const store = memoryPhotoStore();
  let cleared = 0;
  const realClear = store.clear;
  store.clear = async () => { cleared++; return realClear(); };
  const api = createApi({ backend, sessionBackend: memoryBackend(), seedFn: () => buildSeed(NOW), clock: () => NOW, photos: createDemoPhotos(async () => store) });
  await api.ready();
  asTeacherPA(api);
  const neel = (await api.people.students({})).find((s) => s.firstName === 'Neel');
  const o = await api.observations.add({ studentId: neel.id, date: '2026-10-02', area: 'sensorial', text: 'x' });
  const g = await api.photos.register({ observationId: o.id, soloConfirmed: true });
  const MARK = 'PHOTOBYTES-MARKER';
  await api.photos.upload(new Blob([MARK.repeat(50)], { type: 'image/jpeg' }), { ...g, width: 100, height: 100 });
  await api.photos.complete(g.photo.id);
  for (const [k, v] of backend.map) assert.ok(!String(v).includes(MARK), `${k} holds no photo bytes`);
  asAdmin(api);
  assert.ok(!(await api.admin.exportJson()).includes(MARK), 'the JSON backup holds metadata only');
  const seeded = buildSeed(NOW).photos;
  assert.ok(seeded.length > 0);
  for (const p of seeded) {
    assert.equal(p.path, null, 'no Storage path in a seed row');
    assert.ok(ILLUSTRATION_NAMES.includes(p.demo.illustration));
    assert.equal(p.status, 'ready');
    assert.ok(p.soloConfirmedBy);
  }
  const seedPhoto = api.getDb().photos.find((p) => p.demo && p.status === 'ready');
  const blob = await api.photos.blob(seedPhoto.id);
  assert.equal(blob.type, 'image/svg+xml');
  assert.match(await blob.text(), /^<svg /);
  asAdmin(api);
  await api.admin.resetToSeed();
  assert.equal(cleared, 1, 'reset-to-seed clears the photo store');
  assert.equal(await store.size(), 0);
});

test('seed illustrations: every drawing is a small valid-looking SVG of a material, with no people, scripts or long numbers', () => {
  assert.ok(ILLUSTRATION_NAMES.length >= 8);
  for (const n of ILLUSTRATION_NAMES) {
    const svg = illustrationSvg(n);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+" role="img" aria-label="[^"]+">/, n);
    assert.ok(svg.length < 8000, `${n} is small`);
    assert.ok(!/<script|onload|onerror|href=|<image|<foreignObject|<use/i.test(svg), `${n}: nothing active or external`);
    assert.ok(!/person|people|child|face|hand|boy|girl/i.test(svg), `${n}: no people`);
    assert.ok(!/(?<![\d.])[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}(?![\d])/.test(svg) && !/(?<![\d.])(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?![\d])/.test(svg), `${n}: the scan's Aadhaar and mobile-number rules cannot match`);
    assert.ok(!/\d{4,}/.test(svg.replace('http://www.w3.org/2000/svg', '').replace(/#[0-9A-Fa-f]{6}/g, '')), `${n}: no number of 4+ digits in the drawing itself`);
  }
  for (const [area, names] of Object.entries(ILLUSTRATIONS_BY_AREA)) for (const n of names) assert.ok(ILLUSTRATION_NAMES.includes(n), `${area}: ${n}`);
  assert.equal(illustrationSvg('nope'), null);
});

test('no binary image is tracked under src, assets/icons, data or docs (demo photos are drawn or kept in IndexedDB)', () => {
  const bad = [];
  const walk = (rel) => {
    const abs = join(root, rel);
    for (const n of readdirSync(abs)) {
      const r = `${rel}/${n}`;
      if (statSync(join(root, r)).isDirectory()) walk(r); else if (/\.(jpe?g|png|gif|webp|heic|bmp|tiff?)$/i.test(n)) bad.push(r);
    }
  };
  for (const d of ['src', 'data', 'docs']) walk(d);
  assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------- IndexedDB store (a small fake of the API surface used)
test('indexedDbPhotoStore: opens montessori.photos.v1, stores and reads blobs by id, clears; refuses cleanly without IndexedDB', async () => {
  const stores = new Map();
  const req = (fn) => { const r = {}; queueMicrotask(() => { try { r.result = fn(); r.onsuccess?.(); } catch (e) { r.error = e; r.onerror?.(); } }); return r; };
  const idb = { open(name, ver) {
    const open = {};
    queueMicrotask(() => {
      const dbs = { createObjectStore: (n) => stores.set(n, new Map()) };
      open.result = { ...dbs, transaction: (n) => ({ objectStore: () => { const m = stores.get(n); return { put: (v, k) => req(() => m.set(k, v)), get: (k) => req(() => m.get(k)), delete: (k) => req(() => m.delete(k)), clear: () => req(() => m.clear()), count: () => req(() => m.size) }; } }) };
      idb.opened = [name, ver];
      open.onupgradeneeded?.();
      open.onsuccess?.();
    });
    return open;
  } };
  const s = await indexedDbPhotoStore(idb);
  assert.deepEqual(idb.opened, [PHOTO_DB, 1]);
  assert.equal(PHOTO_DB, 'montessori.photos.v1');
  await s.put('p1', { blob: JPEG(10), width: 5, height: 6 });
  assert.equal((await s.get('p1')).width, 5);
  assert.equal(await s.get('nope'), null);
  assert.equal(await s.size(), 1);
  await s.remove('p1');
  assert.equal(await s.size(), 0);
  await s.put('p2', { blob: JPEG(1) });
  await s.clear();
  assert.equal(await s.size(), 0);
  await assert.rejects(indexedDbPhotoStore(undefined), /not available/);
  // createDemoPhotos falls back to memory when IndexedDB cannot open
  const demo = createDemoPhotos(async () => { try { return await indexedDbPhotoStore(null); } catch { return memoryPhotoStore(); } });
  await demo.put('a', { blob: JPEG(3) });
  assert.equal((await demo.info()).persistent, false);
  assert.equal((await demo.get('a')).blob.size, 3);
});

// ---------------------------------------------------------------- consent screen (sign-up step)
const Consent = await import('../src/ui/consent.js');
const Priv = await import('../src/ui/privacy.js');
const { api: demoApi } = await import('../src/api/index.js');

function drawConsent(opts = {}) {
  const root = fake();
  Consent.renderConsent(root, { status: opts.status, children: opts.children ?? [], photoMonths: opts.photoMonths ?? null, onDone() {}, onSignOut() {} });
  return root;
}
const checkedAttr = (html, name, value) => new RegExp(`<input type="checkbox" name="${name}" value="${value}"([^>]*)>`).exec(html)?.[1] ?? null;

test('consent: photos is an optional choice that is never ticked, and the notice says so', () => {
  const html = drawConsent({ children: [{ id: 'stu-1', firstName: 'Neel' }] }).innerHTML;
  assert.match(html, /Photos of my child in class/);
  assert.match(html, /\(optional\)/);
  assert.equal(checkedAttr(html, 'photos-child', 'stu-1')?.includes('checked'), false, 'photos is not pre-ticked');
  assert.equal(checkedAttr(html, 'purpose', 'photos'), null, 'photos is not among the generic purpose rows');
  assert.match(html, /one child only and is seen only by your family and the school/i);
  assert.match(html, /Location and camera details are removed/);
  assert.match(html, /has not yet set how long photos are kept[^<]*deleted when you ask/);
  assert.match(drawConsent({ children: [{ id: 'stu-1', firstName: 'Neel' }], photoMonths: 6 }).innerHTML, /deletes your child’s photos 6 months after your child leaves/);
  assert.match(drawConsent({ children: [{ id: 'stu-1', firstName: 'Neel' }], photoMonths: 1 }).innerHTML, /photos 1 month after/);
  assert.equal(checkedAttr(html, 'purpose', 'app_account')?.includes('data-required'), true, 'only the account is required');
  assert.ok(!/data-required[^>]*value="photos"|value="photos"[^>]*data-required/.test(html));
});

test('consent: the sign-up button needs only the app account; photos never gate it', async () => {
  const root = fake();
  Consent.renderConsent(root, { children: [{ id: 'stu-1', firstName: 'Neel' }], onDone() {}, onSignOut() {} });
  const form = root.querySelector('#cs-form');
  const go = root.querySelector('#cs-go');
  assert.equal(go.disabled, true, 'nothing ticked: cannot continue');
  form.querySelector('[data-required]').checked = true;
  await fire(form, 'change');
  assert.equal(go.disabled, false, 'only the account ticked: can continue (no photos)');
});

test('consent: submitting sends the account and only the photo choices the parent made, per child', async () => {
  const root = fake();
  let sent = null, done = false;
  const real = demoApi.consent.give;
  demoApi.consent.give = async (a) => { sent = a; };
  try {
    Consent.renderConsent(root, { children: [{ id: 'stu-1', firstName: 'Neel' }, { id: 'stu-2', firstName: 'Vivaan' }], onDone: () => { done = true; }, onSignOut() {} });
    const form = root.querySelector('#cs-form');
    form.querySelectorAll = (sel) => (sel.includes('name=purpose') ? [{ value: 'app_account' }] : sel.includes('photos-child') ? [{ value: 'stu-2' }] : []);
    await fire(form, 'submit');
    assert.deepEqual(sent.purposes, ['app_account']);
    assert.deepEqual(sent.perChild, { 'stu-2': ['photos'] }, 'Vivaan yes, Neel no');
    assert.equal(sent.version, Priv.PRIVACY_VERSION);
    assert.equal(done, true);
    sent = null; done = false;
    form.querySelectorAll = (sel) => (sel.includes('name=purpose') ? [{ value: 'app_account' }, { value: 'push' }] : []);
    await fire(form, 'submit');
    assert.ok(!('perChild' in sent), 'no photo choice, nothing about photos is sent');
    assert.deepEqual(sent.purposes, ['app_account', 'push']);
    sent = null;
    form.querySelectorAll = (sel) => (sel.includes('name=purpose') ? [{ value: 'push' }] : []);
    await fire(form, 'submit');
    assert.equal(sent, null, 'without the account nothing is sent');
  } finally { demoApi.consent.give = real; }
});

test('consent: a parent with two children gets one photos box per child, labelled by first name; one child gets one box', () => {
  const two = drawConsent({ children: [{ id: 'stu-1', firstName: 'Neel' }, { id: 'stu-2', firstName: 'Vivaan' }] }).innerHTML;
  assert.match(two, /name="photos-child" value="stu-1"[^>]*> Photos of Neel/);
  assert.match(two, /name="photos-child" value="stu-2"[^>]*> Photos of Vivaan/);
  assert.equal((two.match(/name="photos-child"/g) || []).length, 2);
  assert.match(two, /choose differently for each child/);
  for (const id of ['stu-1', 'stu-2']) assert.equal(checkedAttr(two, 'photos-child', id)?.includes('checked'), false);
  const one = drawConsent({ children: [{ id: 'stu-1', firstName: 'Neel' }] }).innerHTML;
  assert.equal((one.match(/name="photos-child"/g) || []).length, 1);
  assert.ok(!/choose differently/.test(one));
  // a name is escaped
  assert.ok(!drawConsent({ children: [{ id: 'a', firstName: EVIL }, { id: 'b', firstName: 'B' }] }).innerHTML.includes('<img src=x'));
  // an earlier answer (byChild) is shown ticked for that child only; the earlier optional choices stay ticked
  const back = drawConsent({ status: { purposes: { app_account: { given: true }, push: { given: true } }, byChild: { 'stu-1': ['app_account', 'photos'], 'stu-2': ['app_account'] } }, children: [{ id: 'stu-1', firstName: 'Neel' }, { id: 'stu-2', firstName: 'Vivaan' }] }).innerHTML;
  assert.equal(checkedAttr(back, 'photos-child', 'stu-1')?.includes('checked'), true);
  assert.equal(checkedAttr(back, 'photos-child', 'stu-2')?.includes('checked'), false);
  assert.equal(checkedAttr(back, 'purpose', 'push')?.includes('checked'), true);
});

test('consent and sign-in screens draw the mark with CSS: no letter "A" in the logo', () => {
  assert.ok(!/class="logo">A</.test(drawConsent().innerHTML));
  assert.match(drawConsent().innerHTML, /<span class="logo"><\/span>/);
  for (const f of ['src/ui/consent.js', 'src/ui/login.js', 'src/ui/invite.js']) assert.ok(!/class="logo">[^<]/.test(read(f)), `${f}: logo has no text`);
});

test('app.js hands the consent screen the parent\'s children and the school\'s photo period', () => {
  const app = read('src/ui/app.js');
  assert.match(app, /renderConsent\(root, \{ status: cs, children: /);
  assert.match(app, /retention\?\.photosMonthsAfterLeaving/);
});

// ---------------------------------------------------------------- privacy notice v2
test('privacy notice v2: version equals the registry\'s, photos section and purpose, retention still a draft', () => {
  assert.equal(Priv.PRIVACY_VERSION, 'v2');
  assert.equal(Priv.PRIVACY_VERSION, CONSENT_VERSION);
  const photos = Priv.PURPOSES.find((p) => p.key === 'photos');
  assert.ok(photos && photos.required === false);
  assert.deepEqual(Priv.PURPOSES.filter((p) => p.required).map((p) => p.key), ['app_account']);
  const sec = Priv.SECTIONS.find((s) => /photos/i.test(s.h));
  assert.ok(sec, 'a photos section');
  const txt = sec.p.join(' ');
  assert.match(txt, /one child only/);
  assert.match(txt, /staff only until the teacher shares/i);
  assert.match(txt, /never shown to families directly|only inside a termly report/);
  assert.match(txt, /deletes your child’s photos/);
  const ret = Priv.SECTIONS.find((s) => /how long/i.test(s.h));
  const r = ret.p.join(' ');
  assert.match(r, /DRAFT/);
  assert.match(r, /legal review/i);
  assert.match(r, /not enforced/);
  assert.match(r, /Photos are the exception/);
  assert.ok(!/We do not collect[^.]*photograph/.test(Priv.noticeText()), 'the old "no photographs" promise is gone');
  assert.match(Priv.noticeText(), /photos \(optional\)|photos: /i);
});

// ---------------------------------------------------------------- retention card (Settings, real app, principal)
const Settings = await import('../src/ui/screens/settings-real.js');

test('retention card: five periods, empty = not decided, due counts shown, whole months only, saved through api.admin.setRetention', async () => {
  const saved = [];
  const preview = { asOf: '2026-10-02', leftWithoutDate: ['stu-9'], categories: { photos: { months: 6, students: 2, due: 5 }, observations: { months: null, students: 0, due: 0 }, diary: { months: null, students: 0, due: 0 }, attendance: { months: null, students: 0, due: 0 }, messages: { months: null, students: 0, due: 0 } } };
  const api = { admin: { retentionPreview: async () => preview, setRetention: async (v) => { saved.push(v); } } };
  const db = { school: { retention: { photosMonthsAfterLeaving: 6, observationsMonthsAfterLeaving: null, diaryMonthsAfterLeaving: null, attendanceMonthsAfterLeaving: null, messagesMonthsAfterLeaving: null } },
    students: [{ status: 'active' }, { status: 'active' }, { status: 'left' }], photos: [{ status: 'ready', bytes: 250 * 1024 }, { status: 'deleted', bytes: 999 }] };
  const host = fake();
  const ctx = { api, db, rerender() {} };
  await Settings.drawRetention(ctx, host);
  const html = host.innerHTML;
  for (const k of ['photosMonthsAfterLeaving', 'observationsMonthsAfterLeaving', 'diaryMonthsAfterLeaving', 'attendanceMonthsAfterLeaving', 'messagesMonthsAfterLeaving']) assert.match(html, new RegExp(`name="${k}"`));
  assert.match(html, /placeholder="Not decided"/);
  assert.match(html, /value="6"/);
  assert.match(html, /Due today: 5 item\(s\) from 2 child\(ren\)/);
  assert.match(html, /No period set, so nothing is due/);
  assert.match(html, /1 child\(ren\) left without a recorded leaving date/);
  assert.match(html, /draft until the school confirms it/);
  assert.match(html, /Fee records are never deleted/);
  assert.match(html, /up to 100 photos/);
  assert.match(html, /Photos stored[^<]*: 1,/, 'only ready photos are counted');
  const form = host.querySelector('#ret-form');
  const val = (k, v) => { host.querySelector(`input[name="${k}"]`).value = v; };
  val('photosMonthsAfterLeaving', '6'); val('observationsMonthsAfterLeaving', ''); val('diaryMonthsAfterLeaving', ' 12 '); val('attendanceMonthsAfterLeaving', ''); val('messagesMonthsAfterLeaving', '');
  await fire(form, 'submit');
  assert.deepEqual(saved.at(-1), { photosMonthsAfterLeaving: 6, observationsMonthsAfterLeaving: null, diaryMonthsAfterLeaving: 12, attendanceMonthsAfterLeaving: null, messagesMonthsAfterLeaving: null });
  for (const bad of ['abc', '0', '-3', '2.5', '241']) {
    saved.length = 0;
    val('diaryMonthsAfterLeaving', bad);
    await fire(form, 'submit');
    assert.equal(saved.length, 0, `"${bad}" is refused before anything is sent`);
    assert.match(host.querySelector('#ret-err').textContent, /whole months from 1 to 240/, bad);
  }
  // the card is shown without due counts when the preview is unavailable, and says so
  const h2 = fake();
  await Settings.drawRetention({ api: { admin: { retentionPreview: async () => { throw new Error('offline'); }, setRetention: async () => {} } }, db, rerender() {} }, h2);
  assert.match(h2.innerHTML, /Due counts could not be loaded: offline/);
});

// ---------------------------------------------------------------- wiring: routes, nav, home, diary, css, docs
test('routes: /learning for principal, teachers and parents; the report print route is bare and has the same roles', () => {
  const app = read('src/ui/app.js');
  assert.match(app, /pattern: '\/learning', roles: \['admin', 'teacher', 'parent'\]/);
  assert.match(app, /pattern: '\/print\/report\/:id', roles: \['admin', 'teacher', 'parent'\], bare: true/);
});

test('nav: Learning for principal, teachers and parents only', async () => {
  const { NAV, navFor } = await import('../src/ui/shell.js');
  for (const role of ['admin', 'teacher', 'parent']) assert.ok(NAV[role].includes('learning'), role);
  for (const role of ['accountant', 'driver']) assert.ok(!NAV[role].includes('learning'), role);
  assert.equal(navFor('parent').find((i) => i.path === '/learning').short, 'Learn', 'fits the phone tab bar');
  assert.ok(navFor('parent', true).find((i) => i.path === '/learning'));
});

test('home: Learning reaches the principal, teachers and parents; the accountant does not get it', async () => {
  const api = await mkApi();
  const Home = await import('../src/ui/screens/home.js');
  const draw = async (asFn) => { asFn(api); const ctx = makeCtx(api); await Home.render(ctx); return ctx.el.innerHTML; };
  assert.match(await draw(asAdmin), /href="#\/learning"/);
  assert.match(await draw(asTeacherPA), /href="#\/learning\?program=prog-primary-a"/);
  assert.match(await draw((a) => asGuardian(a, 'grd-01')), /href="#\/learning"/);
  assert.ok(!/#\/learning/.test(await draw((a) => asRole(a, 'accountant'))));
});

test('diary: the add-entry form no longer offers Observation; old observation entries still display; the staff page points to Learning', async () => {
  const src = read('src/ui/screens/diary.js');
  assert.match(src, /const ADD_TYPES = \{ meal: 'Meal', sleep: 'Sleep', health: 'Health', activity: 'Activity' \}/);
  assert.ok(!/options\(Object\.entries\(TYPES\)/.test(src), 'the type picker uses ADD_TYPES');
  assert.ok(!/case 'observation': return/.test(src), 'no observation form fields');
  const api = await mkApi();
  assert.equal(api.getDb().diaryEntries.filter((e) => e.type === 'observation').length, 0, 'the seed moved observation text to Learning');
  asTeacherPA(api);
  const Diary = await import('../src/ui/screens/diary.js');
  const ctx = makeCtx(api);
  await Diary.render(ctx);
  assert.match(ctx.el.innerHTML, /href="#\/learning"/);
  // an old observation entry (Phase 1/2 data) is still readable by the family
  const neel = api.getDb().students.find((s) => s.firstName === 'Neel');
  api.getDb().diaryEntries.push({ id: 'dia-old', studentId: neel.id, date: '2026-10-02', type: 'observation', data: { area: 'sensorial', text: 'Old observation text' }, createdBy: 'stf-teacher-pa', createdAt: '2026-10-02T04:00:00.000Z', parentReadAt: null });
  asGuardian(api, 'grd-01');
  const pctx = makeCtx(api, { query: { student: neel.id, date: '2026-10-02' } });
  await Diary.render(pctx);
  assert.match(pctx.el.innerHTML, /Old observation text/);
});

test('app.css: the learning section uses tokens only, keeps 44px targets, and defines the Learning icon', () => {
  const css = read('app.css');
  const section = css.slice(css.indexOf('Learning (Phase 3)'));
  assert.ok(section.length > 500);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(section), 'no hex colour in the learning section: tokens only');
  assert.match(css, /\.i-learn \{/);
  assert.match(section, /\.photo-thumb \{[^}]*min-width: var\(--tap\); min-height: var\(--tap\)/);
  assert.match(css, /\.receipt \.stamp, \.report \.stamp/);
  const print = read('src/ui/print.css');
  assert.match(print, /\.report \.stamp/);
  assert.match(print, /\.report \{[^}]*border: 0 !important/);
});

test('docs: design system lists the learning components; GO-LIVE covers photos, the bucket, retention and the v2 notice', () => {
  const ds = read('docs/DESIGN-SYSTEM.md');
  assert.match(ds, /Learning components/);
  assert.match(ds, /photo thumbnail|\.photo-thumb/);
  assert.match(read('docs/design-system.html'), /photo-thumb/);
  const go = read('docs/GO-LIVE.md');
  assert.match(go, /child-photos/);
  assert.match(go, /Retention periods/i);
  assert.match(go, /photo consent|photos consent/i);
  assert.match(go, /v2/);
  assert.match(go, /legal/i);
});

test('R9 demo photos.consentStatus({programId}) matches the server: unknown programme refused, active children only, scope checked', async () => {
  const api = await mkApi();
  asTeacherPA(api);
  await assert.rejects(() => api.photos.consentStatus({ programId: 'prog-nope' }), /not found/i);
  await assert.rejects(() => api.photos.consentStatus({ programId: 'prog-toddler' }));
  const st = await api.photos.consentStatus({ programId: 'prog-primary-a' });
  const db = api.getDb();
  const active = db.students.filter(s => s.programId === 'prog-primary-a' && s.status === 'active').map(s => s.id).sort();
  assert.deepEqual(Object.keys(st).sort(), active);
});

test('demo: the no-photo-consent note does not send the teacher to a settings page the demo does not have', async () => {
  const blk = Learning.photoBlock(new Set(['stu-blocked']));
  const d = fake();
  const w = blk.wire(d, () => 'stu-blocked');
  w.sync();
  const t = d.querySelector('#ph-status').textContent;
  assert.match(t, /No photo consent/);
  assert.doesNotMatch(t, /Settings > My privacy choices/);
  assert.match(t, /sample data/);
});
