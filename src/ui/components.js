// Shared UI helpers. Every user-supplied string must pass through esc() before innerHTML.
import { formatPaise } from '../domain/money.js';
import { formatDate, formatDateTime, formatTime } from '../domain/dates.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const DASH = '—';

export const icon = (name, cls = '') => `<span class="ic i-${esc(name)} ${esc(cls)}" aria-hidden="true"></span>`;

// Display formatters: missing values are shown as an em dash, never invented.
export const money = (p) => (p == null || Number.isNaN(p) ? DASH : formatPaise(p));
export const fdate = (iso) => (iso ? formatDate(iso) : DASH);
export const fdatetime = (ts) => (ts ? formatDateTime(ts) : DASH);
export const ftime = (ts) => (ts ? formatTime(ts) : DASH);

export const fullName = (p) => (p ? `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim() || DASH : DASH);
export const initials = (p) => esc(`${(p?.firstName ?? '?').charAt(0)}${(p?.lastName ?? '').charAt(0)}`.toUpperCase());

export const badge = (text, kind = '') => `<span class="badge ${esc(kind)}">${esc(text)}</span>`;

export function empty(title, hint = '') {
  return `<div class="empty"><div class="big">${esc(title)}</div>${hint ? `<div>${esc(hint)}</div>` : ''}</div>`;
}

export function banner(kind, html) {
  return `<div class="banner ${esc(kind)}" role="${kind === 'bad' ? 'alert' : 'status'}">${html}</div>`;
}

/** The school-wide notice as a banner, or '' when nothing is showing on `today` (until = the last day shown). Plain text, always escaped. */
export function announcementBanner(note, today) {
  if (!note || !note.text || (note.until && String(note.until).slice(0, 10) < today)) return '';
  return banner(note.tone === 'warn' ? 'warn' : 'info', `<strong>School notice:</strong> ${esc(note.text)}`);
}

export function pageHead(title, sub = '', actionsHtml = '') {
  return `<div class="page-head"><div><h1>${esc(title)}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>${actionsHtml ? `<div class="row">${actionsHtml}</div>` : ''}</div>`;
}

export function options(items, selected, { blank } = {}) {
  // items: [{value, label}]
  const o = items.map((i) => `<option value="${esc(i.value)}"${String(i.value) === String(selected ?? '') ? ' selected' : ''}>${esc(i.label)}</option>`);
  if (blank != null) o.unshift(`<option value="">${esc(blank)}</option>`);
  return o.join('');
}

export function toast(msg, kind = '') {
  const host = document.getElementById('toasts');
  if (!host) return;
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  host.appendChild(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 6000 : 3200);
}

// Quota failures are persistent and blocking - handled by the shell via this hook.
let quotaHandler = null;
export const onQuotaError = (fn) => { quotaHandler = fn; };
// Any code path that swallows or stops on an error must still raise the persistent warning for quota failures.
export function notifyQuota(e) { if (e && e.code === 'STORAGE_QUOTA' && quotaHandler) quotaHandler(e); }

// For `.catch()` on a lookup: NOT_FOUND / NOT_ALLOWED mean "show not-found"; anything else is a real failure and must surface.
export function notFoundOrThrow(e) {
  if (e && (e.code === 'NOT_FOUND' || e.code === 'NOT_ALLOWED')) return null;
  throw e;
}

export function errMessage(e) {
  if (!e) return 'Unknown error';
  return e.message || String(e);
}

// Run an api call; toast the outcome. Returns {ok:true, value} or {ok:false, error}, so a void call that
// succeeds (value undefined) is never confused with a failure.
export async function attempt(fn, okMsg) {
  try {
    const value = await fn();
    if (okMsg) toast(okMsg);
    return { ok: true, value };
  } catch (e) {
    notifyQuota(e);
    toast(`${e?.code ? e.code + ': ' : ''}${errMessage(e)}`, 'bad');
    return { ok: false, error: e };
  }
}

// ---- modal -------------------------------------------------------------
// openModal({title, body (html), actions:[{label, kind, value}] }) -> Promise<value|null>
export function openModal({ title, body, actions = [{ label: 'Close', value: null }], onOpen }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'modal';
    d.innerHTML = `<div class="m-head"><h2>${esc(title)}</h2><button class="btn sm ghost" data-close aria-label="Close">&times;</button></div>
      <div class="m-body">${body}</div>
      <div class="m-foot">${actions.map((a, i) => `<button class="btn ${esc(a.kind || '')}" data-act="${i}">${esc(a.label)}</button>`).join('')}</div>`;
    document.body.appendChild(d);
    let done = false;
    const finish = (v) => { if (done) return; done = true; d.close(); d.remove(); resolve(v); };
    d.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });
    d.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.hasAttribute('data-close')) return finish(null);
      if (t.dataset.act != null) {
        const a = actions[Number(t.dataset.act)];
        finish(a.value === undefined ? true : a.value);
      }
    });
    d.showModal();
    if (onOpen) onOpen(d);
  });
}

export async function confirmDialog(title, message, { okLabel = 'Confirm', kind = 'primary' } = {}) {
  const r = await openModal({
    title,
    body: `<p>${esc(message)}</p>`,
    actions: [{ label: 'Cancel', value: false }, { label: okLabel, kind, value: true }],
  });
  return r === true;
}

// formModal({title, fieldsHtml, submitLabel, onSubmit(values, form) -> may throw}) ; resolves true if submitted OK
export function formModal({ title, fieldsHtml, submitLabel = 'Save', onSubmit, onOpen }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'modal';
    d.innerHTML = `<form method="dialog" novalidate>
      <div class="m-head"><h2>${esc(title)}</h2><button type="button" class="btn sm ghost" data-close aria-label="Close">&times;</button></div>
      <div class="m-body">${fieldsHtml}<div class="err" data-err role="alert"></div></div>
      <div class="m-foot"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">${esc(submitLabel)}</button></div>
    </form>`;
    document.body.appendChild(d);
    const form = d.querySelector('form');
    const errEl = d.querySelector('[data-err]');
    let done = false;
    const finish = (v) => { if (done) return; done = true; d.close(); d.remove(); resolve(v); };
    d.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); });
    d.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) finish(false); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.textContent = '';
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const values = {};
        for (const [k, v] of new FormData(form).entries()) {
          if (k in values) values[k] = [].concat(values[k], v); else values[k] = v;
        }
        await onSubmit(values, form);
        finish(true);
      } catch (ex) {
        notifyQuota(ex);
        errEl.textContent = `${ex?.code ? ex.code + ': ' : ''}${errMessage(ex)}`;
        btn.disabled = false;
      }
    });
    d.showModal();
    if (onOpen) onOpen(d, form);
  });
}

// ---- misc ---------------------------------------------------------------
export function downloadText(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function readFileText(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error || new Error('Could not read file'));
    r.readAsText(file);
  });
}

export const invoiceStatusBadge = (status, overdue = false) => {
  if (status === 'paid') return badge('Paid', 'ok');
  if (status === 'cancelled') return badge('Cancelled', 'mute');
  if (status === 'partiallyPaid') return badge(overdue ? 'Part-paid - overdue' : 'Part-paid', overdue ? 'bad' : 'warn');
  return badge(overdue ? 'Overdue' : 'Issued', overdue ? 'bad' : 'info');
};

export const PROGRAM_COLORS = ['clay', 'sky', 'ok'];

// Map of studentId -> student, programId -> program, guardianId -> guardian from a Db snapshot.
export function indexBy(arr, key = 'id') {
  const m = new Map();
  for (const x of arr || []) m.set(x[key], x);
  return m;
}

export const ageText = (dobISO, todayISO) => {
  if (!dobISO || !todayISO) return DASH;
  const [by, bm, bd] = dobISO.split('-').map(Number);
  const [ty, tm, td] = todayISO.split('-').map(Number);
  let months = (ty - by) * 12 + (tm - bm) - (td < bd ? 1 : 0);
  if (months < 0) return DASH;
  return `${Math.floor(months / 12)}y ${months % 12}m`;
};

export function ago(seconds) {
  if (seconds == null) return DASH;
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))} s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

// Safe-ish query-selector helpers
export const $ = (root, sel) => root.querySelector(sel);
export const $$ = (root, sel) => [...root.querySelectorAll(sel)];
