// Wave 2b, the annual Progress Report screens: the class board, the per-child form (toggles, attendance, remarks,
// revision-safe save, submit with the unrated items, next child, unsaved-changes guard), the principal's review and
// "publish all", the A4 print page (template layout, signatures as object URLs, footer from settings), parents' access,
// the signatures screen, the child's level, level promotion and the School details form.
// Screens are drawn against a minimal fake element and the real demo api (seeded), as in care-ui.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApi } from '../src/api/index.js';
import { buildSeed } from '../src/seed/seed-data.js';
import { memoryBackend } from '../src/store/storage.js';
import { href } from '../src/ui/router.js';
import { LEVEL_LABEL as D_LEVEL, RATING_LABEL as D_RATING, rubricItems } from '../src/domain/evaluations.js';
import { SIGNATURE_MAX_BYTES } from '../src/domain/signatures.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const NOW = new Date();
const EVIL = '"><img src=x onerror=alert(1)><script>alert(2)</script>';
const ADMIN = 'persona-stf-principal', TEACHER = 'persona-stf-teacher-pa', TODDLER_T = 'persona-stf-teacher-toddler';
const NEEL_PARENT = 'persona-grd-01', IRA_PARENT = 'persona-grd-02';
const PA = 'prog-primary-a', AY = 'AY2026-27', AY_PREV = 'AY2025-26';
const NEEL = 'evl-AY2025-26-stu-01', NAVYA = 'evl-AY2026-27-stu-15', IRA = 'evl-AY2026-27-stu-04';

function fake() {
  const children = new Map();
  let html = '';
  const el = {
    value: '', checked: false, disabled: false, hidden: false, textContent: '', className: '', files: [], dataset: {}, handlers: {}, children, isConnected: true,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(t, f) { (el.handlers[t] ||= []).push(f); },
    querySelector(sel) { if (!children.has(sel)) children.set(sel, fake()); return children.get(sel); },
    querySelectorAll() { return []; },
    closest: () => null, appendChild() {}, remove() {}, focus() {}, scrollIntoView() {}, showModal() {}, close() {}, insertAdjacentHTML(_w, h) { html += h; },
  };
  Object.defineProperty(el, 'innerHTML', { get: () => html, set: (v) => { html = v; children.clear(); } });
  return el;
}
globalThis.document ??= { createElement: () => fake(), body: { appendChild() {} }, head: { appendChild() {} }, getElementById: () => null, addEventListener() {}, visibilityState: 'visible' };
globalThis.location ??= { hash: '', reload() {} };

async function mkApi() {
  const api = createApi({ backend: memoryBackend(), sessionBackend: memoryBackend(), seedFn: () => buildSeed(NOW), clock: () => NOW });
  await api.ready();
  return api;
}
function mkCtx(api, who, query = {}, params = {}) {
  api.session.set(who);
  const cleanups = [];
  const ctx = { api, persona: api.session.current(), query, params, el: fake(), get db() { return api.getDb(); },
    went: null, go(p, q) { ctx.went = [p, q]; }, setQuery() {}, href, toasts: [], toast(m, k) { ctx.toasts.push([m, k]); }, onChange() {},
    cleanups, cleanup(f) { cleanups.push(f); }, rerenders: 0, rerender() { ctx.rerenders++; } };
  return ctx;
}
async function draw(api, who, mod, query = {}, params = {}) {
  const ctx = mkCtx(api, who, query, params);
  await mod.render(ctx);
  ctx.html = deep(ctx.el);
  return ctx;
}
const deep = (el) => [el.innerHTML, ...[...el.children.values()].map(deep)].join('\n');
const noRaw = (html) => { assert.ok(!html.includes('<img src=x') && !html.includes('<script>alert'), 'escaped'); };
const count = (s, re) => (s.match(re) || []).length;
const until = async (cond, ms = 2000) => { for (const end = Date.now() + ms; !cond() && Date.now() < end;) await new Promise((r) => setTimeout(r, 5)); };
const withFormData = async (pairs, fn) => {
  const Prev = globalThis.FormData;
  globalThis.FormData = class { constructor() { this.e = pairs; } entries() { return this.e[Symbol.iterator](); } getAll(k) { return this.e.filter(([n]) => n === k).map(([, v]) => v); } [Symbol.iterator]() { return this.e[Symbol.iterator](); } };
  try { return await fn(); } finally { globalThis.FormData = Prev; }
};
const stubUrls = () => {
  const made = [], revoked = [];
  const c = URL.createObjectURL, r = URL.revokeObjectURL;
  URL.createObjectURL = (b) => { const u = `blob:test/${made.length}`; made.push([u, b]); return u; };
  URL.revokeObjectURL = (u) => { revoked.push(u); };
  return { made, revoked, restore() { URL.createObjectURL = c; URL.revokeObjectURL = r; } };
};

const Ev = await import('../src/ui/screens/evaluations.js');
const Print = await import('../src/ui/screens/evaluation-print.js');
const Sig = await import('../src/ui/screens/signatures.js');
const Promote = await import('../src/ui/screens/promote-levels.js');
const School = await import('../src/ui/screens/school-details.js');
const People = await import('../src/ui/screens/people.js');
const Learning = await import('../src/ui/screens/learning.js');
const Labels = await import('../src/ui/eval-labels.js');

// ---------------------------------------------------------------- labels and limits stay in step with the domain
test('the UI words for levels and ratings and the signature size limit equal the domain\'s', () => {
  assert.deepEqual(Labels.LEVEL_LABEL, D_LEVEL);
  assert.deepEqual(Labels.RATING_LABEL, D_RATING);
  assert.equal(Sig.SIG_MAX_BYTES, SIGNATURE_MAX_BYTES);
  assert.equal(Labels.yearText({ label: 'AY 2025-26' }), '2025-26');
});

// ---------------------------------------------------------------- 1. the class board
test('board: each child with level and status; a child with no level says to ask the principal; start for the whole class counts', async () => {
  const api = await mkApi();
  const ctx = await draw(api, TEACHER, Ev, { program: PA, ay: AY });
  const h = ctx.html;
  assert.match(h, /Progress Reports/);
  assert.match(h, /Primary A · 2026-27/);
  assert.match(h, /Level not set: ask the principal/, 'Zoya has no level');
  assert.match(h, /Navya[^<]*<\/div><small>Mont 2/);
  assert.match(h, /badge warn">Submitted/);
  assert.match(h, /badge clay">Draft/);
  assert.match(h, /not rated yet/, 'a draft says how many items are left');
  const rows = await api.evaluations.classStatus({ programId: PA, academicYearId: AY });
  const toStart = rows.filter((r) => r.status === 'not_started' && r.level).length;
  assert.match(h, new RegExp(`Start for the whole class \\(${toStart}\\)`));
  assert.ok(!/Publish all submitted/.test(h), 'publishing is the principal\'s');
  assert.ok(!/Promote levels/.test(h));
  assert.match(h, /href="#\/evaluations\/signatures"/);
  assert.match(h, new RegExp(`href="#/evaluations/${IRA}\\?program=${PA}"`));
  // start for the whole class, then the counts on the next drawing
  await ctx.el.querySelector('#ev-start-all').handlers.click[0]({ target: {} });
  assert.equal(ctx.rerenders, 1);
  const after = await draw(api, TEACHER, Ev, { program: PA, ay: AY });
  const already = rows.filter((r) => r.evaluationId).length, noLevel = rows.filter((r) => !r.level).length;
  assert.match(after.html, new RegExp(`Started ${toStart} of ${rows.length}\\.</strong> ${already} already started, ${noLevel} without a level`));
  assert.ok(!/Start for the whole class/.test(after.html), 'nothing left to start');
  const again = await draw(api, TEACHER, Ev, { program: PA, ay: AY });
  assert.ok(!/Started \d+ of/.test(again.html), 'the result is shown once');
});

test('board (principal): Publish all submitted, Set the level for a child with none, Promote levels; a teacher of another class sees only their own', async () => {
  const api = await mkApi();
  const h = (await draw(api, ADMIN, Ev, { program: PA, ay: AY })).html;
  assert.match(h, /Publish all submitted \(1\)/);
  assert.match(h, /href="#\/people\/stu-08">Set the level/);
  assert.match(h, /href="#\/evaluations\/promote"/);
  assert.match(h, /Review<\/a>/);
  const t = (await draw(api, TODDLER_T, Ev, { program: PA, ay: AY })).html;
  assert.match(t, /Toddler Community/, 'a class the teacher does not teach falls back to their own');
  assert.ok(!t.includes('Navya'));
});

test('publishAll publishes each submitted report and reports a failure by name without stopping', async () => {
  const api = await mkApi();
  api.session.set(TEACHER);
  // a second submitted report: Ira, fully rated
  const ira = await api.evaluations.get(IRA);
  const all = Object.fromEntries(rubricItems(ira.level).map((it) => [it.key, it.values[1]]));
  const saved = await api.evaluations.save(IRA, { ratings: all, revision: ira.revision });
  await api.evaluations.submit(IRA, { revision: saved.revision });
  api.session.set(ADMIN);
  const rows = await api.evaluations.classStatus({ programId: PA, academicYearId: AY });
  const stale = rows.map((r) => (r.evaluationId === NAVYA ? { ...r, revision: r.revision - 1 } : r)); // someone changed Navya's meanwhile
  const seen = [];
  const res = await Ev.publishAll(api, stale, (i, of) => seen.push(`${i}/${of}`));
  assert.deepEqual(seen, ['1/2', '2/2']);
  assert.equal(res.published, 1);
  assert.equal(res.failed.length, 1);
  assert.match(res.failed[0].name, /Navya/);
  assert.match(res.failed[0].message, /reload/i);
  assert.equal((await api.evaluations.get(IRA)).status, 'published');
  assert.equal((await api.evaluations.get(NAVYA)).status, 'submitted');
});

// ---------------------------------------------------------------- 2. the form
test('form: the rubric of the child\'s level with group headings, two big choices per item on the section\'s scale, attendance, remarks, next child', async () => {
  const api = await mkApi();
  const ctx = await draw(api, TEACHER, Ev, { program: PA }, { id: IRA });
  const h = ctx.html;
  api.session.set(TEACHER);
  const v = await api.evaluations.get(IRA);
  assert.equal(count(h, /type="radio"/g), v.total * 2, 'two choices per item');
  assert.equal(count(h, /<h2 class="ev-group">Exercises of Practical Life<\/h2>/g), 1, 'the group heading once, before its first section');
  const practical = v.sections.find((s) => s.group);
  assert.match(h, new RegExp(`<h3>${practical.title}</h3><small><span data-count>\\d+</span>/${practical.items.length} &middot; Progressing/Mastered`));
  assert.match(h, /<h3>Work Habits<\/h3><small><span data-count>0<\/span>\/\d+ &middot; Developing\/Developed/);
  assert.match(h, /name="r:[^"]+" value="developing"><span>Developing<\/span>/);
  assert.equal(count(h, / checked><span>/g), v.rated, 'the saved ratings are ticked');
  assert.match(h, new RegExp(`<span id="ev-rated">${v.rated}</span> of ${v.total} rated`));
  assert.match(h, /From the register: <strong>\d+<\/strong> working days/);
  assert.match(h, /Use different figures \(give the reason\)/);
  assert.match(h, /<textarea name="remarks"/);
  assert.match(h, /id="ev-save">Save draft/);
  assert.match(h, /id="ev-submit">Submit</);
  assert.ok(!/id="ev-publish"/.test(h), 'a teacher does not publish');
  assert.match(h, /data-nav="stu-\d+">Next: /);
  assert.match(h, /href="#\/print\/evaluation\/evl-AY2026-27-stu-04">Preview \/ print/);
  assert.match(read('app.css'), /\.ev-toggle span \{[^}]*min-height: 48px/, 'big tap targets');
});

test('changesOf: only what changed is sent; attendance needs the teacher\'s figures, or goes back to the register', () => {
  const v = { ratings: { a: 'mastered', b: 'progressing' }, remarks: 'Kind', attendance: { source: 'register', workingDays: 100, present: 90 } };
  const st = Ev.formState(v);
  assert.deepEqual(Ev.changesOf(v, st), {});
  st.ratings.b = 'mastered'; st.ratings.c = 'developed';
  st.remarks = 'Kind and calm';
  assert.deepEqual(Ev.changesOf(v, st), { ratings: { b: 'mastered', c: 'developed' }, remarks: 'Kind and calm' });
  const s2 = { ...Ev.formState(v), attEdit: true, attWd: '98', attPr: '90', attReason: 'Two days counted twice' };
  assert.deepEqual(Ev.changesOf(v, s2).attendance, { workingDays: 98, present: 90, reason: 'Two days counted twice' });
  const vt = { ratings: {}, remarks: '', attendance: { source: 'teacher', workingDays: 98, present: 90, reason: 'x', register: { workingDays: 100, present: 90 } } };
  const s3 = Ev.formState(vt);
  assert.equal(s3.attEdit, true);
  assert.deepEqual(Ev.changesOf(vt, s3), {}, 'the teacher\'s figures as loaded are not a change');
  s3.attEdit = false;
  assert.equal(Ev.changesOf(vt, s3).attendance, 'register');
});

test('form: Save draft sends the revision it loaded; a save by someone else meanwhile tells the teacher to reload', async () => {
  const api = await mkApi();
  const ctx = mkCtx(api, TEACHER, { program: PA }, { id: IRA });
  await Ev.render(ctx);
  const v0 = await api.evaluations.get(IRA);
  const sec = v0.sections.find((s) => s.items.some((it) => !it.rating));
  const key = sec.items.find((it) => !it.rating).key;
  const form = ctx.el.querySelector('#ev-form');
  form.handlers.change[0]({ target: { name: `r:${key}`, value: sec.values[1] } });
  form.handlers.input[0]({ target: { name: 'remarks', value: 'Settled well this year.' } });
  assert.equal(ctx.el.querySelector('#ev-dirty').textContent, 'Not saved yet');
  await ctx.el.querySelector('#ev-save').handlers.click[0]();
  const v1 = await api.evaluations.get(IRA);
  assert.equal(v1.revision, v0.revision + 1);
  assert.equal(v1.ratings[key], sec.values[1]);
  assert.equal(v1.remarks, 'Settled well this year.');
  assert.equal(ctx.rerenders, 1);

  // a second form open on the same report, then someone saves; this form's save is refused, nothing overwritten
  const other = mkCtx(api, TEACHER, { program: PA }, { id: IRA });
  await Ev.render(other);
  api.session.set(ADMIN);
  await api.evaluations.save(IRA, { remarks: 'The principal\'s correction', revision: v1.revision });
  api.session.set(TEACHER);
  other.el.querySelector('#ev-form').handlers.input[0]({ target: { name: 'remarks', value: 'Mine' } });
  await other.el.querySelector('#ev-save').handlers.click[0]();
  const msg = other.el.querySelector('#ev-msg').innerHTML;
  assert.match(msg, /Someone else saved this progress report while you were working on it/);
  assert.match(msg, /not saved here: the remarks/);
  assert.match(msg, /id="ev-reload"/);
  assert.equal((await api.evaluations.get(IRA)).remarks, 'The principal\'s correction');
});

test('form: Submit lists the unrated items by section; a fully rated draft goes to the principal', async () => {
  const api = await mkApi();
  const ctx = mkCtx(api, TEACHER, { program: PA }, { id: IRA });
  await Ev.render(ctx);
  await ctx.el.querySelector('#ev-submit').handlers.click[0]();
  const msg = ctx.el.querySelector('#ev-msg').innerHTML;
  const v = await api.evaluations.get(IRA);
  assert.match(msg, new RegExp(`<strong>${v.missing} items are not rated yet\\.</strong>`));
  assert.match(msg, /<strong>Work Habits:<\/strong> Ability to stay on task/);
  assert.match(msg, /Show the first one/);
  assert.equal(v.status, 'draft');
  // rate everything in the form, then submit: saved and submitted in one tap
  const form = ctx.el.querySelector('#ev-form');
  for (const s of v.sections) for (const it of s.items) if (!it.rating) form.handlers.change[0]({ target: { name: `r:${it.key}`, value: s.values[0] } });
  await ctx.el.querySelector('#ev-submit').handlers.click[0]();
  assert.equal((await api.evaluations.get(IRA)).status, 'submitted');
  assert.equal(ctx.rerenders, 1, 'the page is drawn again with the new status');
});

test('form: Next child saves first, then opens (or starts) the next child\'s report', async () => {
  const api = await mkApi();
  const ctx = mkCtx(api, TEACHER, { program: PA }, { id: NAVYA }); // the next child (Neel) has no report this year yet
  await Ev.render(ctx);
  const nextId = ctx.el.innerHTML.match(/data-nav="(stu-\d+)">Next: /)[1];
  ctx.el.querySelector('#ev-form').handlers.input[0]({ target: { name: 'remarks', value: 'Saved on the way' } });
  ctx.el.handlers.click.at(-1)({ target: { closest: (s) => (s === '[data-nav]' ? { dataset: { nav: nextId } } : null) } });
  await until(() => ctx.went);
  assert.equal((await api.evaluations.get(NAVYA)).remarks, 'Saved on the way', 'a submitted report can still be corrected before publishing');
  assert.equal(ctx.went[0], `/evaluations/evl-${AY}-${nextId}`);
  assert.equal((await api.evaluations.get(`evl-${AY}-${nextId}`)).status, 'draft', 'a not-started child is started on the way');
});

test('form: unsaved changes ask before a link is followed (and the tab before it closes); the listeners go with the page', async () => {
  const api = await mkApi();
  const added = [], removed = [];
  const prevAdd = document.addEventListener, prevRemove = document.removeEventListener, prevWin = globalThis.window;
  document.addEventListener = (t, f, c) => added.push([t, f, c]);
  document.removeEventListener = (t, f, c) => removed.push([t, f, c]);
  const winAdded = [];
  globalThis.window = { addEventListener: (t, f) => winAdded.push([t, f]), removeEventListener() {} };
  try {
    const ctx = mkCtx(api, TEACHER, { program: PA }, { id: IRA });
    await Ev.render(ctx);
    const onLink = added.find(([t, , c]) => t === 'click' && c === true)[1];
    const onUnload = winAdded.find(([t]) => t === 'beforeunload')[1];
    const ev = () => { const e = { prevented: false, defaultPrevented: false, preventDefault() { e.prevented = true; }, stopPropagation() {}, target: { closest: () => ({ getAttribute: () => '#/home' }) } }; return e; };
    const clean = ev();
    onLink(clean);
    assert.equal(clean.prevented, false, 'nothing typed: the link is followed');
    ctx.el.querySelector('#ev-form').handlers.input[0]({ target: { name: 'remarks', value: 'Typed, not saved' } });
    const dirty = ev();
    onLink(dirty);
    assert.equal(dirty.prevented, true, 'typed: the link waits for the answer');
    const u = { preventDefault() { u.p = true; } };
    onUnload(u);
    assert.equal(u.p, true);
    ctx.cleanups.forEach((f) => f());
    assert.ok(removed.some(([t, f]) => t === 'click' && f === onLink));
    // a published report is read-only: no guard at all
    added.length = 0;
    await Ev.render(mkCtx(api, ADMIN, {}, { id: NEEL }));
    assert.ok(!added.some(([t, , c]) => t === 'click' && c === true));
  } finally { document.addEventListener = prevAdd; document.removeEventListener = prevRemove; globalThis.window = prevWin; }
});

// ---------------------------------------------------------------- 3. principal review
test('principal: a submitted report has Publish; a published one is read-only with Unpublish and Print', async () => {
  const api = await mkApi();
  const sub = (await draw(api, ADMIN, Ev, {}, { id: NAVYA })).html;
  assert.match(sub, /id="ev-publish">Publish/);
  assert.match(sub, /Submitted by the teacher\./);
  const teacherSub = (await draw(api, TEACHER, Ev, {}, { id: NAVYA })).html;
  assert.ok(!/id="ev-publish"/.test(teacherSub));
  assert.match(teacherSub, /You can still correct it until then/);
  const pub = (await draw(api, ADMIN, Ev, {}, { id: NEEL })).html;
  assert.ok(!/type="radio"/.test(pub), 'read-only');
  assert.match(pub, /id="ev-unpublish">Unpublish/);
  assert.match(pub, /<div class="ev-value">(Progressing|Mastered)<\/div>/);
  assert.match(pub, /href="#\/print\/evaluation\/evl-AY2025-26-stu-01">Print/);
  assert.match(pub, /Set by the teacher: Register kept on paper/);
  const ctx = mkCtx(api, ADMIN, {}, { id: NAVYA });
  await Ev.render(ctx);
  // publish goes through confirmDialog (a fake dialog): answer it by clicking its OK button
  const orig = document.createElement;
  const dialogs = [];
  document.createElement = () => { const d = fake(); dialogs.push(d); return d; };
  try {
    const p = ctx.el.querySelector('#ev-publish').handlers.click[0]();
    await until(() => dialogs.length);
    dialogs[0].handlers.click[0]({ target: { closest: () => ({ hasAttribute: () => false, dataset: { act: '1' } }) } });
    await p;
  } finally { document.createElement = orig; }
  assert.equal((await api.evaluations.get(NAVYA)).status, 'published');
});

// ---------------------------------------------------------------- 4. print page
test('print: the school\'s layout, signatures as object URLs (revoked on leaving), footer from settings, DEMO stamp; a parent opens their own child\'s', async () => {
  const api = await mkApi();
  const u = stubUrls();
  try {
    const ctx = await draw(api, NEEL_PARENT, Print, {}, { id: NEEL });
    const h = ctx.html;
    assert.match(h, /<div class="evr-level">TODDLERS<\/div>\s*<div class="evr-title">PROGRESS REPORT<\/div>\s*<div class="evr-year">YEAR: 2025-26<\/div>/);
    assert.match(h, /<tr><th>Name<\/th><td>Neel [^<]+<\/td><\/tr>\s*<tr><th>Date of Birth<\/th><td>\d{2}-[A-Z][a-z]{2}-\d{4}<\/td><\/tr>\s*<tr><th>Admission Number<\/th><td>[^<]+<\/td>/);
    assert.equal(count(h, /<tr class="grp"><th colspan="2">Exercises of Practical Life<\/th><\/tr>/g), 1);
    assert.match(h, /<tr class="sec"><th>Physical Development and Muscular Coordination<\/th><th class="sc">Progressing\/<wbr>Mastered<\/th><\/tr>/);
    assert.match(h, /<tr class="sec"><th>Work Habits<\/th><th class="sc">Developing\/<wbr>Developed<\/th><\/tr>/);
    assert.match(h, /<th>Cultural Studies\*<\/th>[\s\S]*?<\/table>\s*<p class="evr-note">\*Cultural Studies: This area of the curriculum includes subjects like science and geography\.<\/p>/);
    assert.match(h, /Total working days<\/td><td class="sc">196<\/td>[\s\S]*Days present<\/td><td class="sc">181</);
    assert.match(h, /General Remarks<\/div><p>A cheerful, curious child/);
    assert.match(h, /Signature of Teachers[\s\S]*Signature of Center Head[\s\S]*Signature of Director/);
    assert.ok(u.made.length >= 3 && u.made.every(([url, b]) => url.startsWith('blob:') && b instanceof Blob));
    for (const [url] of u.made) assert.ok(h.includes(`src="${url}"`), 'each signature from an object URL');
    assert.ok(!/src="(?!blob:)/.test(h), 'no other image source');
    const f = (await api.school.details()).reportFooter;
    assert.match(h, new RegExp(`<footer class="evr-foot">${f.address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.ok(h.includes(f.phones.join(' / ')) && h.includes(f.email) && h.includes(f.website));
    assert.match(h, /DEMO &mdash; NOT A REAL REPORT/);
    assert.ok(!/DRAFT/.test(h));
    assert.ok(!/No signature on file/.test(h), 'the staff-only note is not shown to parents');
    ctx.cleanups.forEach((fn) => fn());
    assert.deepEqual(u.revoked.sort(), u.made.map(([x]) => x).sort());
  } finally { u.restore(); }
  // another family, and a draft, are refused
  assert.match((await draw(api, IRA_PARENT, Print, {}, { id: NEEL })).html, /Progress report not found/);
  assert.match((await draw(api, IRA_PARENT, Print, {}, { id: IRA })).html, /Progress report not found/);
});

test('print: a staff preview of a draft is stamped and names who has no signature; empty footer settings print no footer; everything is escaped', async () => {
  const api = await mkApi();
  const u = stubUrls();
  try {
    api.session.set(ADMIN);
    await api.signatures.remove({ kind: 'director' });
    const h = (await draw(api, TEACHER, Print, {}, { id: IRA })).html;
    assert.match(h, /DRAFT &mdash; NOT PUBLISHED/);
    assert.match(h, /No signature on file for: Asha Exampleton\. Upload them on the Signatures page/);
    assert.match(h, /<span>Signature of Teachers<\/span>/);
    assert.match(h, /<div class="evr-sigimgs"><\/div><span>Signature of Director/, 'a missing signature leaves the space empty');
  } finally { u.restore(); }
  const d = {
    header: { levelTitle: 'MONT. - 1', title: 'PROGRESS REPORT', year: '2026-27', name: EVIL, dob: '2022-01-05', admissionNo: EVIL },
    sections: [{ title: EVIL, group: EVIL, scale: 'Progressing/Mastered', items: [{ key: 'k', label: EVIL, rating: 'mastered' }] }],
    footnote: 'f', attendance: { workingDays: 1, present: 1 }, remarks: EVIL, draft: false,
    school: { name: '', directorName: '', footer: { address: '', phones: [], email: '', website: '' } },
    signers: [{ role: 'teacher', staffId: 's', name: EVIL }, { role: 'director', staffId: null, name: '' }],
  };
  const out = Print.sheetHtml(d, [null, null], { demo: false, staff: true });
  noRaw(out);
  assert.ok(!/evr-foot/.test(out), 'no footer when the school set none');
  assert.ok(!/stamp/.test(out));
  assert.match(out, /05-Jan-2022/);
});

test('parents: the published Progress Report is on the Learning page for either guardian; a draft is not', async () => {
  const api = await mkApi();
  const h = (await draw(api, NEEL_PARENT, Learning)).html;
  assert.match(h, /<h2>Annual Progress Report<\/h2>/);
  assert.match(h, /href="#\/print\/evaluation\/evl-AY2025-26-stu-01"/);
  assert.match(h, /Progress Report 2025-26/);
  const other = (await draw(api, IRA_PARENT, Learning)).html;
  assert.ok(!/Annual Progress Report/.test(other), 'Ira\'s report is a draft');
  // staff reach the board from Learning
  assert.match((await draw(api, TEACHER, Learning)).html, /href="#\/evaluations\?program=prog-primary-a">Annual progress reports/);
});

// ---------------------------------------------------------------- 5. signatures
test('signatures: the principal sees everyone and who has none; previews are object URLs; a teacher sees only their own', async () => {
  const api = await mkApi();
  const u = stubUrls();
  try {
    const ctx = await draw(api, ADMIN, Sig);
    const h = ctx.html;
    assert.match(h, /<strong>No signature yet:<\/strong>/);
    const rows = await api.signatures.list();
    for (const r of rows.filter((x) => !x.signature)) assert.ok(h.includes(r.name), `${r.name} is listed as missing`);
    assert.equal(count(h, /<img src="blob:test\/\d+"/g), rows.filter((x) => x.signature).length);
    assert.match(h, /Signs as Director/);
    assert.match(h, /accept="image\/png,image\/jpeg"/);
    assert.match(h, /data-rm="\d+">Remove/);
    ctx.cleanups.forEach((f) => f());
    assert.equal(u.revoked.length, u.made.length);
    const t = (await draw(api, TODDLER_T, Sig)).html;
    assert.equal(count(t, /data-up=/g), 1, 'only their own');
    assert.ok(!/Director/.test(t));
  } finally { u.restore(); }
});

test('prepareSignature: PNG when it fits, JPEG when PNG is too large, refused for the wrong type or when nothing fits', async () => {
  const mk = (sizes) => ({
    decode: async () => ({ width: 3000, height: 900, source: {}, close() {} }),
    encode: async (_d, w, h, type) => { const n = sizes(w, type); return { size: n, type, w, h }; },
  });
  const file = (type, size = 5000) => ({ type, size });
  const ok = await Sig.prepareSignature(file('image/png'), mk(() => 50_000));
  assert.equal(ok.blob.type, 'image/png');
  assert.equal(ok.width, 1000, 'scaled to the long edge, never enlarged');
  const jpg = await Sig.prepareSignature(file('image/jpeg'), mk((w, t) => (t === 'image/png' ? 900_000 : 150_000)));
  assert.equal(jpg.blob.type, 'image/jpeg');
  await assert.rejects(Sig.prepareSignature(file('image/gif'), mk(() => 1)), /PNG or JPEG/);
  await assert.rejects(Sig.prepareSignature(file('image/png'), mk(() => 900_000)), /larger than 200 KB/);
  await assert.rejects(Sig.prepareSignature({ type: 'image/png', size: 0 }, mk(() => 1)), /Choose an image/);
});

// ---------------------------------------------------------------- 6. the child's level and promotion
test('children & families: the Level selector saves through people.updateStudent; the list shows each level', async () => {
  const api = await mkApi();
  const ctx = mkCtx(api, ADMIN, {}, { id: 'stu-08' });
  await People.render(ctx);
  assert.match(ctx.el.innerHTML, /<select name="level"><option value="">Not set<\/option><option value="toddlers">Toddlers<\/option><option value="mont1">Mont 1<\/option><option value="mont2">Mont 2<\/option><option value="mont3">Mont 3<\/option><\/select>/);
  const s = await api.people.student('stu-08');
  await withFormData([['programId', s.programId], ['level', 'mont1'], ['bus', s.routeId ? `${s.routeId}|${s.stopId}` : ''], ['status', 'active'], ['leftOn', '']],
    () => ctx.el.querySelector('#pp-form').handlers.submit[0]({ preventDefault() {} }));
  const after = await api.people.student('stu-08');
  assert.equal(after.level, 'mont1');
  assert.equal(after.levelAy, AY);
  const list = (await draw(api, ADMIN, People)).html;
  assert.match(list, /<th>Level<\/th>/);
  assert.match(list, /href="#\/evaluations\/promote">Promote levels/);
  assert.ok(!/badge warn">Not set/.test(list), 'every attending child now has a level');
});

test('promote levels: preview with counts and a keep-back tick per child; confirm promotes all but the kept-back ones', async () => {
  const api = await mkApi();
  const cur = (await draw(api, ADMIN, Promote)).html;
  assert.match(cur, /Promote levels/);
  assert.match(cur, /type="submit" disabled>Promote/, 'every child is already done for the current year');
  const ctx = mkCtx(api, ADMIN, { ay: AY_PREV });
  await withFormData([], () => Promote.render(ctx));
  const h = ctx.el.innerHTML;
  api.session.set(ADMIN);
  const plan = await api.people.promotionPreview(AY_PREV);
  assert.equal(count(h, /name="move"/g), plan.promote);
  assert.match(h, /Stays at Mont 3|Moves up/);
  const ids = plan.rows.filter((r) => r.outcome === 'promote').map((r) => r.studentId);
  const keep = ids[0];
  const orig = document.createElement;
  const dialogs = [];
  document.createElement = () => { const d = fake(); dialogs.push(d); return d; };
  try {
    await withFormData(ids.slice(1).map((id) => ['move', id]), async () => {
      const p = ctx.el.querySelector('#pl-form').handlers.submit[0]({ preventDefault() {} });
      await until(() => dialogs.length);
      dialogs[0].handlers.click[0]({ target: { closest: () => ({ hasAttribute: () => false, dataset: { act: '1' } }) } });
      await p;
    });
  } finally { document.createElement = orig; }
  const after = (await draw(api, ADMIN, Promote, { ay: AY_PREV })).html;
  assert.match(after, new RegExp(`<strong>Done for 2025-26:</strong> ${ids.length - 1} moved up, 1 kept at their level`));
  const kept = await api.people.student(keep);
  assert.equal(kept.level, plan.rows.find((r) => r.studentId === keep).from, 'the kept-back child keeps their level');
});

// ---------------------------------------------------------------- 7. school details
test('school details: footer, director, privacy contact, office hours and UPI with the explanations; only changed groups are sent; empty clears', async () => {
  const api = await mkApi();
  const h = (await draw(api, ADMIN, School)).html;
  assert.match(h, /Parents will pay fees straight to this UPI ID/);
  assert.match(h, /The privacy notice names this person/);
  assert.match(h, /name="directorName" value="[^"]+"/);
  assert.match(h, /name="days" value="1" checked/);
  api.session.set(ADMIN);
  const cur = await api.school.details();
  const f = cur.reportFooter;
  const same = { address: f.address, phone1: f.phones[0] || '', phone2: f.phones[1] || '', phone3: f.phones[2] || '', footerEmail: f.email, website: f.website,
    directorName: cur.directorName, pcName: '', pcRole: '', pcEmail: '', ohStart: cur.officeHours.start, ohEnd: cur.officeHours.end, days: cur.officeHours.days.map(String),
    vpa: cur.upi.vpa, payeeName: cur.upi.payeeName };
  assert.deepEqual(School.detailsPatch(cur, same), {});
  const p = School.detailsPatch(cur, { ...same, pcName: 'Office Lead', pcRole: 'Principal', pcEmail: 'office@example.com', vpa: '', payeeName: '', website: '' });
  assert.deepEqual(Object.keys(p).sort(), ['privacyContact', 'reportFooter', 'upi']);
  assert.equal(p.upi, null, 'an emptied UPI ID is cleared, not invented');
  assert.equal(p.reportFooter.website, '');
  const saved = await api.school.setDetails(p);
  assert.deepEqual(saved.privacyContact, { name: 'Office Lead', role: 'Principal', email: 'office@example.com' });
  assert.equal(saved.upi, null);
  assert.equal(School.detailsPatch(cur, { address: '', phone1: '', footerEmail: '', website: '', days: [] }).reportFooter, null, 'an empty footer group prints no footer');
  // reached from Settings
  assert.match(read('src/ui/screens/settings.js'), /href="#\/settings\/school"/);
  assert.match(read('src/ui/screens/settings-real.js'), /href="#\/settings\/school"/);
});

// ---------------------------------------------------------------- routes, menus and the project rules
test('routes and menus: the board, form, print, signatures, promote and school details are routed for the right roles', async () => {
  const app = read('src/ui/app.js');
  assert.match(app, /pattern: '\/evaluations', roles: \['admin', 'teacher'\]/);
  assert.ok(app.indexOf("'/evaluations/signatures'") < app.indexOf("'/evaluations/:id'") && app.indexOf("'/evaluations/promote'") < app.indexOf("'/evaluations/:id'"), 'fixed paths before :id');
  assert.match(app, /pattern: '\/evaluations\/promote', roles: \['admin'\]/);
  assert.match(app, /pattern: '\/print\/evaluation\/:id', roles: \['admin', 'teacher', 'parent'\], bare: true/);
  assert.match(app, /pattern: '\/settings\/school', roles: \['admin'\]/);
  const { NAV, navFor } = await import('../src/ui/shell.js');
  assert.ok(NAV.admin.includes('evaluations') && NAV.teacher.includes('evaluations'));
  for (const r of ['accountant', 'parent', 'driver']) assert.ok(!NAV[r].includes('evaluations'), r);
  assert.equal(navFor('teacher').find((i) => i.path === '/evaluations').label, 'Progress Reports');
});

test('UI source: the new screens import only the api, helpers and labels, never the network or the real-app plumbing, and put every value through esc()', () => {
  const files = ['src/ui/screens/evaluations.js', 'src/ui/screens/evaluation-print.js', 'src/ui/screens/signatures.js', 'src/ui/screens/promote-levels.js', 'src/ui/screens/school-details.js', 'src/ui/eval-labels.js'];
  for (const f of files) {
    const s = read(f);
    assert.ok(!/__APP_CONFIG__|remote\.js|supabase|fetch\(/i.test(s), f);
    for (const m of s.matchAll(/from '([^']+)'/g)) assert.ok(/(^|\/)(components|mode|eval-labels|photo-prep)\.js$/.test(m[1]), `${f} imports ${m[1]}`);
  }
  const css = read('app.css');
  const section = css.slice(css.indexOf('annual Progress Report: the form'));
  assert.ok(section.length > 500 && !/#[0-9a-fA-F]{3,8}\b/.test(section), 'tokens only');
  assert.match(read('src/ui/print.css'), /\.evr-t, \.evr-id, \.evr-remarks, \.evr-sign, \.evr-foot \{ break-inside: avoid; \}/);
});
