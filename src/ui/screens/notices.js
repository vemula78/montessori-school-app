// Notice board: staff compose (with up to 3 files), correct or withdraw, and see who has not read; parents read + acknowledge.
// Attachments are shown ONLY through blob object URLs from api.notices.fileBlob (images inline, a PDF in a new tab), revoked
// when the screen is left.
import { esc, icon, badge, empty, pageHead, fdatetime, fullName, indexBy, formModal, attempt, toast, notifyQuota, errMessage, DASH } from '../components.js';

const STAFF = ['admin', 'teacher'];
// as the server allows (NOTICE_FILE_MAX_BYTES, NOTICE_FILE_MIMES, at most 3 per notice); it checks the bytes again
const FILE_MAX = 3;
const FILE_BYTES = 2 * 1024 * 1024;
const FILE_EXT = /\.(pdf|jpe?g|png)$/i;
const FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
const ACCEPT = 'application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png';
const sizeText = (b) => (b == null ? '' : b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`);

/** What is wrong with the chosen files before anything is uploaded ('' when fine); `kept` = attachments already on the notice. */
export function filesProblem(files, kept = 0) {
  if (files.length + kept > FILE_MAX) return `A notice can carry at most ${FILE_MAX} files.`;
  for (const f of files) {
    if (!(FILE_TYPES.includes(f.type) || (!f.type && FILE_EXT.test(f.name || '')))) return `${f.name}: only PDF, JPEG or PNG files can be attached.`;
    if (f.size > FILE_BYTES) return `${f.name} is ${sizeText(f.size)}; each file must be at most 2 MB.`;
  }
  return '';
}
const chosenFiles = (form) => [...(form.querySelector('#n-files')?.files || [])].filter((f) => f && f.size !== 0);
const fileField = (label) => `<label class="field"><span class="lbl">${esc(label)}</span><input type="file" name="files" id="n-files" accept="${ACCEPT}" multiple>
  <small>Up to ${FILE_MAX} PDF, JPEG or PNG files, 2 MB each.</small><span class="err" id="n-files-err" role="alert"></span></label>`;
const watchFiles = (form, kept = () => 0) => form.querySelector('#n-files')?.addEventListener('change', () => { form.querySelector('#n-files-err').textContent = filesProblem(chosenFiles(form), kept()); });

// Staged files that a failed send leaves behind: removed at once (the server also clears unused ones within a day).
const discardAll = async (api, ids) => { for (const id of ids) await api.notices.discardFile(id).catch((e) => { notifyQuota(e); console.error(e); }); };
async function uploadAll(api, files) {
  const ids = [];
  try { for (const f of files) ids.push((await api.notices.uploadFile(f, f.name)).id); } catch (e) { await discardAll(api, ids); throw e; }
  return ids;
}

// forParent: never enumerate other children; the parent's own children come from their receipt ("About").
function audienceText(db, a, forParent = false) {
  if (!a) return DASH;
  if (a.scope === 'school') return 'Whole school';
  if (a.scope === 'program') {
    const p = indexBy(db.programs);
    return 'Programme: ' + a.programIds.map((id) => p.get(id)?.name || id).join(', ');
  }
  if (a.scope === 'route') return 'School bus families';
  if (forParent) return 'Selected children';
  const s = indexBy(db.students);
  const names = a.studentIds.map((id) => s.get(id)?.firstName || id);
  return `Children: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` +${names.length - 4}` : ''}`;
}

function childNames(db, ids) {
  const s = indexBy(db.students);
  return (ids || []).map((id) => s.get(id)?.firstName || id).join(', ');
}

const stateBadge = (n) => (n.withdrawnAt ? badge('Withdrawn', 'mute') : n.correctedAt ? badge('Corrected', 'info') : '');

async function composeModal(ctx) {
  const { db, persona, api } = ctx;
  const progs = persona.role === 'teacher' ? db.programs.filter((p) => (persona.programIds || []).includes(p.id)) : db.programs;
  const students = (await api.people.students()).filter((s) => s.status === 'active');
  const fields = `
    <label class="field"><span class="lbl">Title</span><input name="title" required maxlength="120"></label>
    <label class="field"><span class="lbl">Message</span><textarea name="body" required></textarea></label>
    <fieldset class="field" style="border:0;padding:0;margin:0 0 12px"><legend class="lbl" style="font-size:.82rem;font-weight:800;margin-bottom:4px">Send to</legend>
      ${persona.role === 'admin' ? '<label class="check"><input type="radio" name="scope" value="school"> Whole school</label>' : ''}
      <label class="check"><input type="radio" name="scope" value="program" ${persona.role === 'teacher' ? 'checked' : ''}> Programme(s)</label>
      <div id="n-progs" style="margin-left:30px">${progs.map((p) => `<label class="check sm"><input type="checkbox" name="programIds" value="${esc(p.id)}"${persona.role === 'teacher' && progs.length === 1 ? ' checked' : ''}> ${esc(p.name)}</label>`).join('')}</div>
      <label class="check"><input type="radio" name="scope" value="students"> Specific children</label>
      <div id="n-studs" style="margin-left:30px;max-height:150px;overflow:auto">${students.map((s) => `<label class="check sm"><input type="checkbox" name="studentIds" value="${esc(s.id)}"> ${esc(fullName(s))}</label>`).join('')}</div>
    </fieldset>
    ${fileField('Attach files (optional)')}
    <label class="check"><input type="checkbox" name="requiresAck"> Requires acknowledgement</label>
    <label class="check"><input type="checkbox" name="important"> Mark as important</label>`;
  let createdId = null;
  const ok = await formModal({
    title: 'New notice', fieldsHtml: fields, submitLabel: 'Send notice',
    onOpen: (d, form) => watchFiles(form),
    onSubmit: async (v, form) => {
      const scope = v.scope;
      if (!scope) throw new Error('Choose who receives this notice.');
      let audience;
      if (scope === 'school') audience = { scope: 'school' };
      else if (scope === 'program') {
        const ids = [].concat(v.programIds || []);
        if (!ids.length) throw new Error('Tick at least one programme.');
        audience = { scope: 'program', programIds: ids };
      } else {
        const ids = [].concat(v.studentIds || []);
        if (!ids.length) throw new Error('Tick at least one child.');
        audience = { scope: 'students', studentIds: ids };
      }
      const files = chosenFiles(form);
      const problem = filesProblem(files);
      if (problem) throw new Error(problem);
      const attachmentIds = await uploadAll(api, files);
      try {
        const n = await api.notices.send({ title: v.title.trim(), body: v.body.trim(), audience, requiresAck: v.requiresAck === 'on', important: v.important === 'on', ...(attachmentIds.length ? { attachmentIds } : {}) });
        createdId = n?.id || null;
      } catch (e) { await discardAll(api, attachmentIds); throw e; }
    },
  });
  return ok ? createdId || true : null;
}

/** Fix a sent notice: wording, files, and a reason (kept with the earlier wording; parents see "corrected"). */
function correctModal(ctx, n) {
  const { api } = ctx;
  const atts = n.attachments || [];
  const keepCount = (form) => form.querySelectorAll('input[name="keep"]:checked').length;
  return formModal({
    title: 'Correct this notice', submitLabel: 'Save correction',
    fieldsHtml: `<p class="muted" style="margin-top:0">Parents see the corrected notice marked "corrected". Read and acknowledged marks stay as they are.</p>
      <label class="field"><span class="lbl">Title</span><input name="title" required maxlength="120" value="${esc(n.title)}"></label>
      <label class="field"><span class="lbl">Message</span><textarea name="body" required>${esc(n.body)}</textarea></label>
      ${atts.length ? `<fieldset class="field" style="border:0;padding:0;margin:0 0 12px"><legend class="lbl" style="font-size:.82rem;font-weight:800">Files on the notice (untick to remove)</legend>
        ${atts.map((a) => `<label class="check sm"><input type="checkbox" name="keep" value="${esc(a.id)}" checked> ${esc(a.name)}</label>`).join('')}</fieldset>` : ''}
      ${fileField('Add files (optional)')}
      <label class="field"><span class="lbl">What was wrong</span><input name="reason" required maxlength="200" placeholder="For example: the date was wrong"></label>`,
    onOpen: (d, form) => watchFiles(form, () => keepCount(form)),
    onSubmit: async (v, form) => {
      const reason = String(v.reason || '').trim();
      if (!reason) throw new Error('Say what was wrong.');
      const keep = [].concat(v.keep || []);
      const files = chosenFiles(form);
      const problem = filesProblem(files, keep.length);
      if (problem) throw new Error(problem);
      const patch = { reason };
      if (v.title.trim() !== n.title) patch.title = v.title.trim();
      if (v.body.trim() !== n.body.trim()) patch.body = v.body.trim();
      const filesChanged = files.length > 0 || keep.length !== atts.length;
      if (!patch.title && !patch.body && !filesChanged) throw new Error('Change the title, the message or the files first.');
      const added = await uploadAll(api, files);
      try { await api.notices.correct(n.id, { ...patch, ...(filesChanged ? { attachmentIds: [...keep, ...added] } : {}) }); } catch (e) { await discardAll(api, added); throw e; }
    },
  });
}

function withdrawModal(ctx, n) {
  return formModal({
    title: 'Withdraw this notice', submitLabel: 'Withdraw notice',
    fieldsHtml: `<p style="margin-top:0">Parents keep seeing the notice, marked <strong>withdrawn</strong> with your reason; its files are no longer shown to them. This cannot be undone.</p>
      <label class="field"><span class="lbl">Reason</span><input name="reason" required maxlength="200" placeholder="For example: the trip is cancelled"></label>`,
    onSubmit: async (v) => {
      const reason = String(v.reason || '').trim();
      if (!reason) throw new Error('Give the reason parents will see.');
      await ctx.api.notices.withdraw(n.id, reason);
    },
  });
}

async function list(ctx) {
  const { api, db, persona } = ctx;
  const notices = (await api.notices.list()).slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const staff = STAFF.includes(persona.role);
  const rmap = new Map(notices.filter((n) => n.receipt).map((n) => [n.id, n.receipt]));
  const counts = new Map();
  if (staff) {
    for (const n of notices) {
      try {
        const rec = await api.notices.recipients(n.id);
        counts.set(n.id, { total: rec.length, read: rec.filter((r) => r.readAt).length, ack: rec.filter((r) => r.ackAt).length });
      } catch { /* no counts */ }
    }
  }
  const items = notices.map((n) => {
    const r = rmap.get(n.id);
    const c = counts.get(n.id);
    let status = '';
    if (n.withdrawnAt) status = '';
    else if (staff && c) status = n.requiresAck ? badge(`Ack ${c.ack}/${c.total}`, c.ack === c.total ? 'ok' : 'warn') : badge(`Read ${c.read}/${c.total}`, 'info');
    else if (r) status = n.requiresAck ? (r.ackAt ? badge('Acknowledged', 'ok') : badge('Needs acknowledgement', 'warn')) : (r.readAt ? badge('Read', 'mute') : badge('New', 'clay'));
    const files = (n.attachments || []).length && !(n.withdrawnAt && !staff) ? ` &middot; ${esc(n.attachments.length)} file${n.attachments.length === 1 ? '' : 's'}` : '';
    return `<li class="link"><a href="#/notices/${esc(n.id)}">
      <div class="row between"><div class="item-title">${n.important && !n.withdrawnAt ? badge('Important', 'bad') + ' ' : ''}${esc(n.title)}</div><div class="row">${stateBadge(n)}${status}</div></div>
      <small>${esc(audienceText(db, n.audience, !staff))} &middot; ${fdatetime(n.createdAt)}${files}</small></a></li>`;
  });
  ctx.el.innerHTML = `${pageHead('Notices', staff ? 'Broadcast to the school, a programme or chosen children' : '', staff ? `<button class="btn primary" id="n-new">${icon('plus', 'sm')} New notice</button>` : '')}
    ${items.length ? `<ul class="list card-list">${items.join('')}</ul>` : empty('No notices yet', staff ? 'Use "New notice" to send the first one.' : 'Nothing has been sent to you.')}`;
  ctx.el.querySelector('#n-new')?.addEventListener('click', async () => {
    const id = await composeModal(ctx);
    if (id) { toast('Notice sent'); typeof id === 'string' ? ctx.go(`/notices/${id}`) : ctx.rerender(); }
  });
}

// Images inline, PDFs as a button that opens the file in a new tab; nothing is downloaded until it is shown or tapped.
function attachmentsHtml(n, canSee) {
  const atts = n.attachments || [];
  if (!atts.length) return '';
  if (!canSee) return '<p class="muted" style="margin:0">The files of a withdrawn notice are no longer available.</p>';
  return `<div class="stack"><h2 style="margin:0">Attachments</h2>${atts.map((a) => (String(a.mime).startsWith('image/')
    ? `<figure style="margin:0"><img data-nfile="${esc(a.id)}" alt="${esc(a.name)}" style="max-width:100%;height:auto;border-radius:10px"><figcaption><small>${esc(a.name)}</small></figcaption></figure>`
    : `<div><button type="button" class="btn" data-open-file="${esc(a.id)}">Open ${esc(a.name)}</button> <small class="muted">PDF${a.bytes ? `, ${esc(sizeText(a.bytes))}` : ''}</small></div>`)).join('')}</div>`;
}

/** Fill img[data-nfile] from blobs and wire the PDF buttons; every object URL is revoked when the screen is left. */
function wireAttachments(ctx) {
  const urls = [];
  let closed = false;
  ctx.cleanup(() => { closed = true; for (const u of urls.splice(0)) URL.revokeObjectURL(u); });
  for (const img of ctx.el.querySelectorAll('img[data-nfile]')) {
    Promise.resolve().then(() => ctx.api.notices.fileBlob(img.dataset.nfile)).then((blob) => {
      if (closed) return;
      const u = URL.createObjectURL(blob);
      urls.push(u);
      img.src = u;
    }).catch((e) => { notifyQuota(e); if (!closed) img.alt = `${img.alt}: this file could not be loaded`; });
  }
  ctx.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-open-file]');
    if (!b) return;
    // the tab is opened inside the tap (a phone's pop-up blocker allows that), and the file goes into it once it has arrived
    const w = typeof window !== 'undefined' && window.open ? window.open('', '_blank') : null;
    try {
      const blob = await ctx.api.notices.fileBlob(b.dataset.openFile);
      const u = URL.createObjectURL(blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' }));
      urls.push(u);
      if (w) w.location.href = u; else toast('Allow pop-ups for this app to open the file', 'bad');
    } catch (err) { w?.close(); notifyQuota(err); console.error(err); toast(errMessage(err), 'bad'); }
  });
}

const telOf = (phone) => String(phone || '').replace(/[^\d+]/g, '');
function followUpList(title, rows, db) {
  if (!rows.length) return '';
  return `<h2 style="margin-top:18px">${esc(title)} (${esc(rows.length)})</h2><ul class="list card-list">${rows.map((r) => `<li><div class="row between"><div><div class="item-title">${esc(r.guardianName)}</div>
    <small>About ${esc((r.studentNames || []).join(', ') || childNames(db, r.studentIds))}${r.phone ? ` &middot; ${esc(r.phone)}` : ''}</small></div>
    ${r.phone ? `<a class="btn sm" href="tel:${esc(telOf(r.phone))}" aria-label="Call ${esc(r.guardianName)}">Call</a>` : '<small class="muted">No phone</small>'}</div></li>`).join('')}</ul>`;
}

async function detail(ctx) {
  const { api, db, persona } = ctx;
  const id = ctx.params.id;
  const notices = await api.notices.list();
  const n = notices.find((x) => x.id === id);
  if (!n) { ctx.el.innerHTML = `${empty('Notice not found')}<p><a class="btn" href="#/notices">Back to notices</a></p>`; return; }
  const staff = STAFF.includes(persona.role);
  let body = '';
  let rec = null;
  let recNote = '';
  if (staff) {
    // recipients can be NOT_ALLOWED for a listed notice (e.g. a school-wide one for a teacher): show the notice anyway
    try { rec = await api.notices.recipients(id); } catch (e) { if (e && e.code === 'NOT_ALLOWED') recNote = 'Recipient details are not available for this notice.'; else throw e; }
  }
  const canManage = staff && rec !== null; // recipients() is allowed to exactly those who may correct or withdraw it
  if (staff && rec) {
    const read = rec.filter((r) => r.readAt).length;
    const ack = rec.filter((r) => r.ackAt).length;
    let follow = '';
    if (!n.withdrawnAt) {
      try {
        const u = await api.notices.unread(id);
        const notReadIds = new Set(u.notRead.map((r) => r.guardianId));
        follow = `${followUpList('Not read yet', u.notRead, db)}${n.requiresAck ? followUpList('Read, not acknowledged yet', u.notAcknowledged.filter((r) => !notReadIds.has(r.guardianId)), db) : ''}`;
      } catch (e) { notifyQuota(e); follow = '<div class="banner warn">The list of families who have not read it could not be loaded.</div>'; }
    }
    body = `<div class="grid cols-3" style="margin:12px 0">
        <div class="kpi"><div class="v">${rec.length}</div><div class="l">guardians addressed</div></div>
        <div class="kpi"><div class="v">${read}</div><div class="l">have read</div></div>
        <div class="kpi ${n.requiresAck && ack < rec.length ? 'bad' : 'good'}"><div class="v">${n.requiresAck ? ack : DASH}</div><div class="l">${n.requiresAck ? 'acknowledged' : 'acknowledgement not required'}</div></div></div>
      ${follow}
      <h2 style="margin-top:18px">Recipients</h2><p class="muted" style="font-size:.88rem">One row per guardian, not per child.</p>
      ${rec.length ? `<div class="tablewrap"><table><thead><tr><th>Guardian</th><th>About</th><th>Read</th><th>Acknowledged</th></tr></thead><tbody>
        ${rec.map((r) => `<tr><td>${esc(r.guardianName)}</td><td>${esc(childNames(db, r.studentIds))}</td><td>${fdatetime(r.readAt)}</td><td>${n.requiresAck ? fdatetime(r.ackAt) : DASH}</td></tr>`).join('')}
      </tbody></table></div>` : empty('No recipients', 'The audience resolved to no guardians.')}`;
  } else if (staff) {
    body = `<div class="banner">${esc(recNote)}</div>`;
  } else {
    const fresh = n.receipt;
    const about = n.aboutStudentIds || fresh?.studentIds || [];
    body = `${fresh ? `<p><small>About: <strong>${esc(childNames(ctx.db, about))}</strong></small></p>` : ''}
      ${n.requiresAck && !n.withdrawnAt ? (fresh?.ackAt ? `<div class="banner ok">You acknowledged this on ${fdatetime(fresh.ackAt)}.</div>` : fresh ? '<button class="btn primary" id="n-ack">Acknowledge</button>' : '') : ''}`;
  }
  const last = (n.history || []).at(-1);
  const changed = `${n.withdrawnAt ? `<div class="banner warn"><strong>Withdrawn ${fdatetime(n.withdrawnAt)}.</strong>${n.withdrawReason ? ` ${esc(n.withdrawReason)}` : ''}</div>` : ''}
    ${n.correctedAt ? `<div class="banner info"><strong>Corrected ${fdatetime(n.correctedAt)}.</strong>${last?.reason ? ` ${esc(last.reason)}` : ''}</div>` : ''}`;
  const earlier = staff && n.history?.length ? `<details style="margin-top:10px"><summary>Earlier wording (${esc(n.history.length)})</summary><div class="stack" style="margin-top:8px">${n.history.slice().reverse().map((h) => `<div class="card flat"><div class="item-title">${esc(h.title)}</div>
      <small>${fdatetime(h.at)} &middot; replaced because: ${esc(h.reason || DASH)}</small><div style="white-space:pre-wrap">${esc(h.body)}</div></div>`).join('')}</div></details>` : '';
  const manage = canManage && !n.withdrawnAt ? '<div class="row"><button class="btn sm" id="n-correct">Correct</button><button class="btn sm danger" id="n-withdraw">Withdraw</button></div>' : '';
  ctx.el.innerHTML = `<p><a href="#/notices">&larr; All notices</a></p>
    ${changed}
    <div class="card stack"><div class="row between"><h1 style="margin:0">${esc(n.title)}</h1><div class="row">${n.important && !n.withdrawnAt ? badge('Important', 'bad') : ''}${stateBadge(n)}</div></div>
    <small>${esc(audienceText(ctx.db, n.audience, !staff))} &middot; sent ${fdatetime(n.createdAt)}${n.requiresAck ? ' &middot; acknowledgement required' : ''}</small>
    <div style="white-space:pre-wrap">${esc(n.body)}</div>
    ${attachmentsHtml(n, staff || !n.withdrawnAt)}${manage}${earlier}</div>
    <div style="margin-top:14px">${body}</div>`;
  wireAttachments(ctx);
  ctx.el.querySelector('#n-ack')?.addEventListener('click', async () => {
    const ok = await attempt(() => api.notices.acknowledge(id), 'Acknowledged');
    if (ok.ok) ctx.rerender();
  });
  ctx.el.querySelector('#n-correct')?.addEventListener('click', async () => { if (await correctModal(ctx, n)) { toast('Notice corrected'); ctx.rerender(); } });
  ctx.el.querySelector('#n-withdraw')?.addEventListener('click', async () => { if (await withdrawModal(ctx, n)) { toast('Notice withdrawn'); ctx.rerender(); } });
  // the read receipt goes after the notice is on screen; a failure is not the parent's problem (console only)
  if (!staff && n.receipt && !n.receipt.readAt) api.notices.markRead(id).catch((err) => { notifyQuota(err); console.error(err); });
}

export async function render(ctx) {
  if (ctx.params.id) await detail(ctx); else await list(ctx);
}
