// Wave 2b screens, parent <-> office: conversations with the school office and office hours (#11/#32), UPI paid
// straight to the school (#81), parent-teacher meeting slots (#88).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/api/index.js';
import { buildSeed } from '../src/seed/seed-data.js';
import { memoryBackend } from '../src/store/storage.js';
import { todayISO, addDays, dateInZone, dayOfWeek, IST_OFFSET_MIN } from '../src/domain/dates.js';
import { href } from '../src/ui/router.js';

const NOW = new Date(); // the screens read the real date (todayISO); the seed is built around it
const EVIL = '"><img src=x onerror=alert(1)><script>alert(2)</script>';
const PRINCIPAL = 'persona-stf-principal', ACCOUNTANT = 'persona-stf-accountant', TEACHER = 'persona-stf-teacher-pa', TEACHER_PB = 'persona-stf-teacher-pb';
const PARENT = 'persona-grd-01', OTHER_PARENT = 'persona-grd-02'; // grd-01: Neel (stu-01, Primary A) and Vivaan (stu-02, Primary B, fees open)

function fake() {
  const children = new Map();
  let html = '';
  const el = {
    value: '', checked: false, disabled: false, textContent: '', className: '', files: [], dataset: {}, handlers: {}, children, isConnected: true,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(t, f) { (el.handlers[t] ||= []).push(f); },
    querySelector(sel) { if (!children.has(sel)) children.set(sel, fake()); return children.get(sel); },
    querySelectorAll() { return []; },
    closest: () => null, appendChild() {}, remove() {}, focus() {}, insertAdjacentHTML(_w, h) { html += h; },
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
async function draw(api, who, mod, { query = {}, params = {} } = {}) {
  api.session.set(who);
  const ctx = { api, persona: api.session.current(), query, params, el: fake(), get db() { return api.getDb(); },
    go() {}, setQuery() {}, href, toast() {}, onChange() {}, cleanup() {}, rerender() {} };
  await mod.render(ctx);
  return ctx.el.innerHTML;
}
const noRaw = (html) => { assert.ok(!html.includes('<img src=x') && !html.includes('<script>alert'), 'escaped'); };
// office hours on a day that is not today (school time): the office is closed now, whatever the clock says
const closedHours = () => ({ start: '08:30', end: '16:00', days: [(dayOfWeek(dateInZone(NOW.getTime(), IST_OFFSET_MIN)) + 3) % 7] });

const Threads = await import('../src/ui/screens/threads.js');
const Fees = await import('../src/ui/screens/fees-invoices.js');
const Upi = await import('../src/ui/screens/upi-claims.js');
const Home = await import('../src/ui/screens/home.js');
const Shell = await import('../src/ui/shell.js');

// ---------------------------------------------------------------- #11 / #32 office conversations, office hours

test('#11 a parent writes to the school office: the accountant and the principal see it, the teacher never does; the accountant has Messages', async () => {
  const api = await mkApi();
  api.session.set(PARENT);
  const t = await api.threads.open({ guardianId: 'grd-01', studentId: 'stu-01', subject: `Receipt ${EVIL}`.slice(0, 100), body: 'Where is my receipt?', to: 'accountant' });
  const id = t.thread.id;
  const acc = await draw(api, ACCOUNTANT, Threads);
  assert.match(acc, /Fee questions from parents/);
  assert.ok(acc.includes(`#/messages/${id}`), 'in the accountant inbox');
  assert.match(acc, /1 new/);
  noRaw(acc);
  const principal = await draw(api, PRINCIPAL, Threads);
  assert.ok(principal.includes(`#/messages/${id}`) && /School office/.test(principal), 'the principal sees it, labelled');
  assert.ok(!(await draw(api, TEACHER, Threads)).includes(id), "not in Neel's teacher's list");
  const detail = await draw(api, ACCOUNTANT, Threads, { params: { id } });
  assert.match(detail, /School office \(fees\)/);
  assert.match(detail, /Close conversation/);
  assert.match(detail, /Send reply/);
  assert.ok(Shell.navFor('accountant').some((i) => i.path === '/messages'), 'Messages in the accountant menu');
  // the reply is signed "School office" for a family without the accountant's staff record
  api.session.set(ACCOUNTANT);
  await api.threads.reply(id, 'Sent by email today.');
  const db = api.getDb();
  const saved = db.staff;
  db.staff = saved.filter((s) => s.role !== 'accountant');
  try { assert.match(await draw(api, PARENT, Threads, { params: { id } }), /Sent by email today\.<span class="meta">School office/); } finally { db.staff = saved; }
});

test('#32 outside office hours the parent is told when the school will reply; inside them (or with no hours) nothing is said; nothing is blocked', async () => {
  const api = await mkApi();
  api.session.set(PRINCIPAL);
  await api.school.setDetails({ officeHours: closedHours() });
  const list = await draw(api, PARENT, Threads);
  assert.match(list, /The school will reply during office hours \(/);
  assert.match(list, /next: [A-Z][a-z]+day at 08:30|next: (today|tomorrow) at 08:30/);
  assert.match(list, /New message/, 'writing is still offered');
  api.session.set(PARENT);
  const t = await api.threads.open({ guardianId: 'grd-01', studentId: 'stu-01', subject: 'Late', body: 'Sent at night', to: 'teacher' });
  assert.match(await draw(api, PARENT, Threads, { params: { id: t.thread.id } }), /reply during office hours[\s\S]*Send reply/);
  assert.doesNotMatch(await draw(api, ACCOUNTANT, Threads), /office hours/, 'staff are not told');
  api.session.set(PRINCIPAL);
  await api.school.setDetails({ officeHours: { start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] } });
  assert.doesNotMatch(await draw(api, PARENT, Threads), /office hours/);
  api.session.set(PRINCIPAL);
  await api.school.setDetails({ officeHours: null });
  assert.doesNotMatch(await draw(api, PARENT, Threads), /office hours/);
  // the wording
  const note = Threads.officeHoursNote({ set: true, open: false, hours: { start: '08:30', end: '16:00', days: [1, 2, 3, 4, 5] }, nextOpen: { day: 1, time: '08:30', inDays: 2 } });
  assert.equal(note, 'The school will reply during office hours (Mon-Fri 08:30-16:00; next: Monday at 08:30).');
  assert.equal(Threads.officeHoursNote({ set: true, open: true }), '');
});

test('#11 the parent fees screen offers "Ask the office about fees"', async () => {
  const api = await mkApi();
  assert.match(await draw(api, PARENT, Fees), /id="fi-ask">Ask the office about fees/);
});

// ---------------------------------------------------------------- #81 UPI straight to the school

test('#81 parent: "Pay by UPI app" with the amount due; the online payment stays; another family sees none of it', async () => {
  const api = await mkApi();
  api.session.set(PARENT);
  const link = await api.fees.upiLink('stu-02');
  assert.ok(link.link.startsWith('upi://pay?pa=') && /&am=\d+\.\d{2}&cu=INR&tn=Fees%20INV/.test(link.link), link.link);
  const html = await draw(api, PARENT, Fees);
  assert.match(html, /data-upi="stu-02">Pay ₹[\d,]+\.\d{2} by UPI app/);
  assert.match(html, /data-claim="stu-02">I paid by UPI/);
  assert.match(html, /data-pay="stu-02"/, 'the online payment button is still there');
  assert.doesNotMatch(html, /data-upi="stu-01"/, 'nothing open for Neel');
  api.session.set(PRINCIPAL);
  await api.school.setDetails({ upi: null });
  assert.doesNotMatch(await draw(api, PARENT, Fees), /by UPI/, 'no UPI ID set: no UPI option');
});

test('#81 report -> waiting; the accountant checks it (home + list), confirms -> receipt the parent sees; reject -> reason', async () => {
  const api = await mkApi();
  api.session.set(PARENT);
  const inv = (await api.fees.invoices({ studentId: 'stu-02' })).find((i) => i.balancePaise > 0);
  const c1 = await api.fees.claimUpi({ studentId: 'stu-02', invoiceIds: [inv.id], amountPaise: 100050, reference: 'UTR123456789', paidOn: todayISO() });
  let html = await draw(api, PARENT, Fees);
  assert.match(html, /UPI payments you reported/);
  assert.match(html, /₹1,000\.50/);
  assert.match(html, /Waiting for the school to check/);

  const home = await draw(api, ACCOUNTANT, Home);
  assert.match(home, /#\/fees\/upi[\s\S]*2 UPI payments reported by parents to check against the bank/, 'the seeded one and this one');
  assert.match(await draw(api, ACCOUNTANT, Fees), /href="#\/fees\/upi">UPI reports <span class="badge clay">2</);
  const list = await draw(api, ACCOUNTANT, Upi);
  assert.match(list, /UPI reference <strong>UTR123456789<\/strong>/);
  assert.ok(list.includes(`data-confirm="${c1.id}"`) && list.includes(`data-reject="${c1.id}"`));
  assert.ok(list.includes(inv.number), 'the invoice number is shown');

  api.session.set(ACCOUNTANT);
  const { payment } = await api.fees.confirmClaim(c1.id);
  assert.equal(payment.mode, 'upi');
  html = await draw(api, PARENT, Fees);
  assert.match(html, /Confirmed/);
  assert.ok(html.includes(`href="#/print/receipt/${payment.id}">Receipt ${payment.receiptNumber}`));
  assert.ok((await draw(api, ACCOUNTANT, Upi, { query: { status: 'confirmed' } })).includes(payment.receiptNumber));

  api.session.set(PARENT);
  const c2 = await api.fees.claimUpi({ studentId: 'stu-02', invoiceIds: [inv.id], amountPaise: 5000, reference: 'UTR999999999', paidOn: todayISO() });
  api.session.set(ACCOUNTANT);
  await api.fees.rejectClaim(c2.id, `Not in the bank ${EVIL}`.slice(0, 120));
  html = await draw(api, PARENT, Fees);
  assert.match(html, /Not confirmed/);
  assert.match(html, /Reason: Not in the bank &quot;&gt;&lt;img/);
  noRaw(html);
  assert.match(await draw(api, ACCOUNTANT, Upi, { query: { status: 'rejected' } }), /Rejected .*: Not in the bank/);
  assert.doesNotMatch(await draw(api, OTHER_PARENT, Fees), /UTR123456789|UTR999999999/, "another family's page");
});
