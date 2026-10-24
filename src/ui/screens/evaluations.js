// The annual Progress Report (teachers of the class and the principal). Two pages:
//   #/evaluations?program=&ay=   the class board: each child's level and status; start for the whole class; the
//                                principal publishes every submitted report in one go.
//   #/evaluations/:id            the form: the rubric of the child's level, one two-choice toggle per item (big tap
//                                targets: a teacher rates ~58 items per child on a phone), attendance from the
//                                register (a correction needs a reason), general remarks; save draft, submit, next
//                                child. The principal reviews, publishes and unpublishes (with a reason) here too.
// Every write is an api call (the rules live in the registry). Saving sends the revision the form loaded: when
// someone else saved meanwhile the api answers CONFLICT and the teacher is told to reload. Unsaved changes ask before a
// link is followed, and the browser asks before the tab is closed.
import { esc, banner, empty, pageHead, badge, options, formModal, confirmDialog, openModal, attempt, errMessage, notifyQuota, toast, fdate, fdatetime, DASH } from '../components.js';
import { EVAL_STATUS, RATING_LABEL, yearText } from '../eval-labels.js';

const statusBadge = (st) => badge(...(EVAL_STATUS[st] || [st, 'mute']));

// A message for the next drawing of the board (start/publish results), keyed so it shows on that class only.
let flash = null;

// ---------------------------------------------------------------- board
function yearsOf(db) {
  return [...(db.academicYears || [])].sort((a, b) => (a.startDate < b.startDate ? 1 : -1));
}

/** Publish every submitted row one by one; a failure does not stop the rest. → {published, failed:[{name, message}]} */
export async function publishAll(api, rows, onProgress = () => {}) {
  const subs = rows.filter((r) => r.status === 'submitted' && r.evaluationId);
  let published = 0;
  const failed = [];
  for (let i = 0; i < subs.length; i++) {
    onProgress(i + 1, subs.length);
    try { await api.evaluations.publish(subs[i].evaluationId, { revision: subs[i].revision }); published++; } catch (e) { notifyQuota(e); failed.push({ name: subs[i].name, message: errMessage(e) }); }
  }
  return { published, failed };
}

async function board(ctx) {
  const { api, db, persona, query } = ctx;
  const isAdmin = persona.role === 'admin';
  const progs = persona.role === 'teacher' ? db.programs.filter((p) => (persona.programIds || []).includes(p.id)) : db.programs.filter((p) => p.active !== false);
  if (!progs.length) { ctx.el.innerHTML = `${pageHead('Progress Reports')}${empty('No class assigned to you')}`; return; }
  const years = yearsOf(db);
  const ay = years.find((a) => a.id === query.ay) || years.find((a) => a.id === db.school.currentAcademicYearId) || years[0];
  if (!ay) { ctx.el.innerHTML = `${pageHead('Progress Reports')}${empty('No academic year set up')}`; return; }
  const prog = progs.find((p) => p.id === query.program) || progs[0];
  const rows = await api.evaluations.classStatus({ programId: prog.id, academicYearId: ay.id });
  const n = (st) => rows.filter((r) => r.status === st).length;
  const toStart = rows.filter((r) => r.status === 'not_started' && r.level).length;
  const noLevel = rows.filter((r) => !r.level && r.status === 'not_started').length;
  const submitted = n('submitted');
  const key = `${prog.id}|${ay.id}`;
  const msg = flash && flash.key === key ? flash : null;
  flash = null;
  const here = { program: prog.id, ay: ay.id };
  const action = (r) => {
    if (r.evaluationId) {
      return `<a class="btn sm${(r.status === 'draft' || (r.status === 'submitted' && isAdmin)) ? ' primary' : ''}" href="${esc(ctx.href(`/evaluations/${r.evaluationId}`, { program: prog.id }))}">${r.status === 'published' ? 'View' : isAdmin && r.status === 'submitted' ? 'Review' : 'Open'}</a>`
        + (r.status === 'published' ? ` <a class="btn sm" href="${esc(ctx.href(`/print/evaluation/${r.evaluationId}`))}">Print</a>` : '');
    }
    if (r.level) return `<button class="btn sm primary" data-start="${esc(r.studentId)}">Start</button>`;
    return isAdmin ? `<a class="btn sm" href="${esc(ctx.href(`/people/${r.studentId}`))}">Set the level</a>` : '';
  };
  const detail = (r) => {
    const lvl = r.levelLabel ? esc(r.levelLabel) : '<span class="ev-nolevel">Level not set: ask the principal</span>';
    const miss = r.status === 'draft' && r.missing ? ` &middot; ${esc(r.missing)} not rated yet` : '';
    return `${lvl}${miss}`;
  };
  ctx.el.innerHTML = `${pageHead('Progress Reports', `Annual progress report · ${prog.name} · ${yearText(ay)}`,
    `<a class="btn" href="${esc(ctx.href('/evaluations/signatures'))}">Signatures</a>${isAdmin ? `<a class="btn" href="${esc(ctx.href('/evaluations/promote'))}">Promote levels</a>` : ''}`)}
    <div class="row" style="margin-bottom:12px">
      <label class="field" style="margin:0"><span class="lbl">Academic year</span><select id="ev-ay">${options(years.map((a) => ({ value: a.id, label: a.label || a.id })), ay.id)}</select></label>
      ${progs.length > 1 ? `<label class="field" style="margin:0"><span class="lbl">Class</span><select id="ev-prog">${options(progs.map((p) => ({ value: p.id, label: p.name })), prog.id)}</select></label>` : ''}
    </div>
    ${msg ? banner(msg.kind, msg.html) : ''}
    <div class="grid cols-4" style="margin-bottom:12px">${['not_started', 'draft', 'submitted', 'published'].map((st) => `<div class="kpi"><div class="v">${esc(n(st))}</div><div class="l">${esc(EVAL_STATUS[st][0].toLowerCase())}</div></div>`).join('')}</div>
    ${noLevel ? banner('warn', `${esc(noLevel)} ${noLevel === 1 ? 'child has' : 'children have'} no level yet, so ${noLevel === 1 ? 'their report cannot' : 'their reports cannot'} be started. ${isAdmin ? 'Set the level on the child’s page (Children &amp; families).' : 'Ask the principal to set it.'}`) : ''}
    <div class="row" style="margin-bottom:12px">
      ${toStart ? `<button class="btn primary" id="ev-start-all">Start for the whole class (${esc(toStart)})</button>` : ''}
      ${isAdmin && submitted ? `<button class="btn sage" id="ev-pub-all">Publish all submitted (${esc(submitted)})</button>` : ''}
      <span class="muted" id="ev-progress" role="status"></span>
    </div>
    ${rows.length ? `<ul class="list card-list">${rows.map((r) => `<li data-row="${esc(r.studentId)}"><div class="row between">
        <div><div class="item-title">${esc(r.name)}</div><small>${detail(r)}</small></div>
        <div class="row">${statusBadge(r.status)}${action(r)}</div></div></li>`).join('')}</ul>`
      : empty('No children in this class')}`;

  ctx.el.querySelector('#ev-ay')?.addEventListener('change', (e) => ctx.setQuery({ ...here, ay: e.target.value }));
  ctx.el.querySelector('#ev-prog')?.addEventListener('change', (e) => ctx.setQuery({ ...here, program: e.target.value }));
  ctx.el.querySelector('#ev-start-all')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    const r = await attempt(() => api.evaluations.startClass({ programId: prog.id, academicYearId: ay.id }));
    if (r.ok) {
      const x = r.value;
      flash = { key, kind: x.skippedNoLevel ? 'warn' : 'ok', html: `<strong>Started ${esc(x.started)} of ${esc(x.children)}.</strong> ${esc(x.skippedExisting)} already started, ${esc(x.skippedNoLevel)} without a level${x.skippedNoLevel ? ' (the principal sets the level on the child’s page)' : ''}.` };
      ctx.rerender();
    } else e.target.disabled = false;
  });
  ctx.el.querySelector('#ev-pub-all')?.addEventListener('click', async (e) => {
    if (!(await confirmDialog('Publish all submitted', `Publish ${submitted} progress report${submitted === 1 ? '' : 's'}? The families can then read and print them. A published report is frozen; to correct one, unpublish it with a reason.`, { okLabel: 'Publish all' }))) return;
    e.target.disabled = true;
    const line = ctx.el.querySelector('#ev-progress');
    const res = await publishAll(api, rows, (i, of) => { line.textContent = `Publishing ${i} of ${of}…`; });
    flash = { key, kind: res.failed.length ? 'bad' : 'ok',
      html: `<strong>Published ${esc(res.published)} of ${esc(res.published + res.failed.length)}.</strong>${res.failed.length ? ` Not published:<ul>${res.failed.map((f) => `<li>${esc(f.name)}: ${esc(f.message)}</li>`).join('')}</ul>` : ''}` };
    ctx.rerender();
  });
  ctx.el.addEventListener('click', async (e) => {
    const b = e.target.closest?.('[data-start]');
    if (!b) return;
    b.disabled = true;
    const r = await attempt(() => api.evaluations.start({ studentId: b.dataset.start, academicYearId: ay.id }));
    if (r.ok) ctx.go(`/evaluations/${r.value.id}`, { program: prog.id }); else b.disabled = false;
  });
}

// ---------------------------------------------------------------- form helpers (pure; tested)

/** The form's state from a loaded evaluation view. */
export function formState(v) {
  const a = v.attendance || {};
  const teacher = a.source === 'teacher';
  return { ratings: { ...(v.ratings || {}) }, remarks: v.remarks || '', attEdit: teacher,
    attWd: teacher ? String(a.workingDays ?? '') : '', attPr: teacher ? String(a.present ?? '') : '', attReason: teacher ? a.reason || '' : '' };
}

/** What to send to evaluations.save for the changes in `st` since view `v` ({} when nothing changed). */
export function changesOf(v, st) {
  const out = {};
  const before = v.ratings || {};
  const ratings = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(st.ratings)])) {
    if ((before[k] || null) !== (st.ratings[k] || null)) ratings[k] = st.ratings[k] || null;
  }
  if (Object.keys(ratings).length) out.ratings = ratings;
  if (String(st.remarks).trim() !== String(v.remarks || '').trim()) out.remarks = String(st.remarks);
  const a = v.attendance || {};
  const wasTeacher = a.source === 'teacher';
  if (st.attEdit) {
    const next = { workingDays: st.attWd === '' ? NaN : Number(st.attWd), present: st.attPr === '' ? NaN : Number(st.attPr), reason: String(st.attReason || '').trim() };
    if (!wasTeacher || next.workingDays !== a.workingDays || next.present !== a.present || next.reason !== (a.reason || '')) out.attendance = next;
  } else if (wasTeacher) out.attendance = 'register';
  return out;
}

/** How many items are rated in the form's state. */
export const ratedCount = (v, st) => v.sections.reduce((n, s) => n + s.items.filter((it) => st.ratings[it.key]).length, 0);

const groupStarts = (sections) => sections.map((s, i) => Boolean(s.group) && (i === 0 || sections[i - 1].group !== s.group));

function itemRow(it, values, rating, editable) {
  const id = `ev-l-${it.key}`;
  if (!editable) {
    return `<div class="ev-item" data-item="${esc(it.key)}"><div class="ev-label">${esc(it.label)}</div><div class="ev-value">${rating ? esc(RATING_LABEL[rating] || rating) : `<span class="muted">${DASH} not rated</span>`}</div></div>`;
  }
  return `<div class="ev-item${rating ? '' : ' unrated'}" data-item="${esc(it.key)}" role="radiogroup" aria-labelledby="${esc(id)}">
    <div class="ev-label" id="${esc(id)}">${esc(it.label)}</div>
    <div class="ev-toggle">${values.map((val) => `<label><input type="radio" name="${esc(`r:${it.key}`)}" value="${esc(val)}"${rating === val ? ' checked' : ''}><span>${esc(RATING_LABEL[val] || val)}</span></label>`).join('')}</div></div>`;
}

/** The rubric, section by section, with the group heading before the first section of a group. */
export function sectionsHtml(v, st, editable) {
  const starts = groupStarts(v.sections);
  return v.sections.map((s, i) => {
    const rated = s.items.filter((it) => st.ratings[it.key]).length;
    return `${starts[i] ? `<h2 class="ev-group">${esc(s.group)}</h2>` : ''}
    <section class="card ev-sec" data-sec="${esc(i)}">
      <div class="row between ev-sec-head"><h3>${esc(s.title)}</h3><small><span data-count>${esc(rated)}</span>/${esc(s.items.length)} &middot; ${esc(s.scale)}</small></div>
      ${s.items.map((it) => itemRow(it, s.values, st.ratings[it.key] || null, editable)).join('')}
    </section>`;
  }).join('');
}

function attendanceHtml(v, st, editable) {
  const a = v.attendance || {};
  const reg = a.source === 'teacher' ? a.register || null : a;
  const regLine = reg ? `From the register: <strong>${esc(reg.workingDays)}</strong> working days, <strong>${esc(reg.present)}</strong> present${reg.unmarked ? ` (${esc(reg.unmarked)} ${reg.unmarked === 1 ? 'day' : 'days'} not marked)` : ''}${a.from ? `, ${fdate(a.from)} to ${fdate(a.to)}` : ''}.` : 'The register figures are not available.';
  if (!editable) {
    return `<p style="margin:0">Working days: <strong>${esc(a.workingDays ?? DASH)}</strong> &middot; Days present: <strong>${esc(a.present ?? DASH)}</strong></p>
      <small>${a.source === 'teacher' ? `Set by the teacher: ${esc(a.reason || '')}. ` : ''}${regLine}</small>`;
  }
  return `<p style="margin:0">${regLine}</p>
    <label class="ev-check"><input type="checkbox" id="ev-att-edit"${st.attEdit ? ' checked' : ''}> Use different figures (give the reason)</label>
    <div id="ev-att-fields" class="stack"${st.attEdit ? '' : ' hidden'}>
      <div class="row"><label class="field grow"><span class="lbl">Total working days</span><input type="number" inputmode="numeric" min="0" max="366" step="1" name="attWd" value="${esc(st.attWd)}"></label>
        <label class="field grow"><span class="lbl">Days present</span><input type="number" inputmode="numeric" min="0" max="366" step="1" name="attPr" value="${esc(st.attPr)}"></label></div>
      <label class="field"><span class="lbl">Reason for changing the register’s figures</span><input name="attReason" maxlength="200" value="${esc(st.attReason)}" placeholder="For example: register kept on paper until August"></label>
    </div>`;
}

const missingHtml = (missing) => {
  const bySec = new Map();
  for (const m of missing) { if (!bySec.has(m.section)) bySec.set(m.section, []); bySec.get(m.section).push(m.label); }
  return `<strong>${esc(missing.length)} ${missing.length === 1 ? 'item is' : 'items are'} not rated yet.</strong> Rate ${missing.length === 1 ? 'it' : 'them'}, then submit again.
    <ul style="margin:6px 0 0;padding-left:18px">${[...bySec].map(([sec, labels]) => `<li><strong>${esc(sec)}:</strong> ${esc(labels.join('; '))}</li>`).join('')}</ul>
    <button type="button" class="btn sm" data-goto-missing style="margin-top:6px">Show the first one</button>`;
};

// ---------------------------------------------------------------- form
async function form(ctx) {
  const { api, db, persona, query } = ctx;
  let v = await api.evaluations.get(ctx.params.id).catch((e) => { if (e && (e.code === 'NOT_FOUND' || e.code === 'NOT_ALLOWED')) return null; throw e; });
  if (!v) { ctx.el.innerHTML = `${pageHead('Progress Report')}${empty('Progress report not found')}<p><a class="btn" href="${esc(ctx.href('/evaluations'))}">All progress reports</a></p>`; return; }
  const isAdmin = persona.role === 'admin';
  const ay = (db.academicYears || []).find((a) => a.id === v.academicYearId);
  const programId = query.program || v.programId;
  const back = ctx.href('/evaluations', { program: programId, ay: v.academicYearId });
  const editable = v.status !== 'published';
  let st = formState(v);

  // previous / next child of the class with a level (the board's order)
  const list = await Promise.resolve().then(() => api.evaluations.classStatus({ programId, academicYearId: v.academicYearId })).catch(() => []);
  const at = list.findIndex((r) => r.studentId === v.studentId);
  const prev = at > 0 ? [...list.slice(0, at)].reverse().find((r) => r.level) : null;
  const next = at >= 0 ? list.slice(at + 1).find((r) => r.level) : null;

  const a = v.attendance || {};
  const notes = [
    v.status === 'draft' && v.unpublishedReason ? banner('warn', `<strong>Unpublished for a correction${v.lastPublishedAt ? ` (was published ${fdatetime(v.lastPublishedAt)})` : ''}:</strong> ${esc(v.unpublishedReason)}`) : '',
    v.status === 'submitted' ? banner('info', isAdmin ? '<strong>Submitted by the teacher.</strong> Review it, then publish: the family can then read and print it.' : `<strong>Submitted${v.submittedAt ? ` ${fdatetime(v.submittedAt)}` : ''}.</strong> The principal reviews and publishes it. You can still correct it until then.`) : '',
    v.status === 'published' ? banner('ok', `<strong>Published ${fdatetime(v.publishedAt)}.</strong> The family can read and print it. It cannot be changed${isAdmin ? '; to correct it, unpublish it with a reason' : '; the principal can unpublish it for a correction'}.`) : '',
  ].join('');
  // the sticky bar stays one row on a phone: Save, Submit and a short "Next"; the names are in the row below the form
  const nav = `<div class="row ev-nav">${prev ? `<button type="button" class="btn" data-nav="${esc(prev.studentId)}">&larr; ${esc(prev.name)}</button>` : ''}${next ? `<button type="button" class="btn" data-nav="${esc(next.studentId)}">Next: ${esc(next.name)} &rarr;</button>` : ''}</div>`;
  const nextShort = next ? `<button type="button" class="btn" data-nav="${esc(next.studentId)}" aria-label="Next child: ${esc(next.name)}">Next &rarr;</button>` : '';
  ctx.el.innerHTML = `${pageHead(v.studentName, `${v.levelLabel} · Progress Report ${yearText(ay) || v.academicYearId}`,
    `<a class="btn" href="${esc(back)}">&larr; Class</a><a class="btn" href="${esc(ctx.href(`/print/evaluation/${v.id}`))}">${v.status === 'published' ? 'Print' : 'Preview / print'}</a>`)}
    <div class="row" style="margin-bottom:10px">${statusBadge(v.status)}<span class="muted"><span id="ev-rated">${esc(ratedCount(v, st))}</span> of ${esc(v.total)} rated</span></div>
    ${notes}
    <div id="ev-msg" role="alert"></div>
    <form id="ev-form" class="stack ev-form" novalidate>
      ${sectionsHtml(v, st, editable)}
      <section class="card stack ev-sec"><h3>Attendance</h3>${attendanceHtml(v, st, editable)}</section>
      <section class="card stack ev-sec"><h3>General Remarks</h3>
        ${editable ? `<textarea name="remarks" rows="5" maxlength="4000" aria-label="General remarks">${esc(st.remarks)}</textarea>` : `<p class="narr" style="white-space:pre-wrap;margin:0">${esc(v.remarks || DASH)}</p>`}</section>
      <div class="sticky-actions ev-actions">
        <div class="row">
          ${editable ? `<button type="button" class="btn" id="ev-save">${v.status === 'draft' ? 'Save draft' : 'Save changes'}</button>` : ''}
          ${v.status === 'draft' ? '<button type="button" class="btn primary" id="ev-submit">Submit</button>' : ''}
          ${isAdmin && v.status === 'submitted' ? '<button type="button" class="btn primary" id="ev-publish">Publish</button>' : ''}
          ${isAdmin && v.status === 'published' ? '<button type="button" class="btn" id="ev-unpublish">Unpublish</button>' : ''}
          ${nextShort}
          <span class="muted" id="ev-dirty" aria-live="polite"></span>
        </div>
      </div>
    </form>
    ${nav}`;

  const formEl = ctx.el.querySelector('#ev-form');
  const msgEl = ctx.el.querySelector('#ev-msg');
  const dirtyEl = ctx.el.querySelector('#ev-dirty');
  const isDirty = () => editable && Object.keys(changesOf(v, st)).length > 0;
  const showDirty = () => { dirtyEl.textContent = isDirty() ? 'Not saved yet' : ''; };
  const ratedEl = ctx.el.querySelector('#ev-rated');

  formEl.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name && t.name.startsWith('r:')) {
      st.ratings[t.name.slice(2)] = t.value;
      ratedEl.textContent = String(ratedCount(v, st));
      const row = t.closest?.('.ev-item');
      row?.classList.remove('unrated', 'missing');
      const sec = t.closest?.('.ev-sec');
      const i = sec ? Number(sec.dataset.sec) : -1;
      if (v.sections[i]) { const c = sec.querySelector('[data-count]'); if (c) c.textContent = String(v.sections[i].items.filter((it) => st.ratings[it.key]).length); }
    } else if (t.id === 'ev-att-edit') {
      st.attEdit = t.checked;
      const f = ctx.el.querySelector('#ev-att-fields');
      if (f) f.hidden = !t.checked;
      if (t.checked && st.attWd === '' && st.attPr === '') {
        const reg = (a.source === 'teacher' ? a.register : a) || {};
        st.attWd = String(reg.workingDays ?? ''); st.attPr = String(reg.present ?? '');
        const wd = formEl.querySelector('[name="attWd"]'); const pr = formEl.querySelector('[name="attPr"]');
        if (wd) wd.value = st.attWd; if (pr) pr.value = st.attPr;
      }
    }
    showDirty();
  });
  formEl.addEventListener('input', (e) => {
    const t = e.target;
    if (t.name === 'remarks') st.remarks = t.value;
    else if (t.name === 'attWd') st.attWd = t.value;
    else if (t.name === 'attPr') st.attPr = t.value;
    else if (t.name === 'attReason') st.attReason = t.value;
    showDirty();
  });
  formEl.addEventListener('submit', (e) => e.preventDefault());

  const conflict = () => {
    const c = changesOf(v, st);
    const what = [c.ratings ? `${Object.keys(c.ratings).length} rating${Object.keys(c.ratings).length === 1 ? '' : 's'}` : '', c.remarks !== undefined ? 'the remarks' : '', c.attendance ? 'the attendance' : ''].filter(Boolean).join(', ');
    msgEl.innerHTML = banner('bad', `<div class="stack"><span><strong>Someone else saved this progress report while you were working on it.</strong> Reload to see their version, then make your changes again${what ? ` (not saved here: ${esc(what)})` : ''}.</span><div><button type="button" class="btn sm" id="ev-reload">Reload</button></div></div>`);
    msgEl.querySelector('#ev-reload')?.addEventListener('click', () => { st = formState(v); ctx.rerender(); });
  };
  let busy = false;
  const setBusy = (on) => { busy = on; formEl.querySelectorAll('.ev-actions button').forEach((b) => { b.disabled = on; }); };
  // → true when nothing was left to save or the save worked; the loaded view and the baseline move on with it
  async function save() {
    const patch = changesOf(v, st);
    if (!Object.keys(patch).length) return true;
    msgEl.innerHTML = '';
    try {
      v = await api.evaluations.save(v.id, { ...patch, revision: v.revision });
      st = formState(v);
      showDirty();
      return true;
    } catch (e) {
      notifyQuota(e);
      console.error(e);
      if (e && e.code === 'CONFLICT') conflict(); else msgEl.innerHTML = banner('bad', esc(errMessage(e)));
      return false;
    }
  }
  const run = async (fn) => { if (busy) return; setBusy(true); try { await fn(); } finally { setBusy(false); } };

  ctx.el.querySelector('#ev-save')?.addEventListener('click', () => run(async () => {
    if (!isDirty()) { toast('Nothing to save'); return; }
    if (await save()) { toast('Draft saved'); ctx.rerender(); }
  }));
  ctx.el.querySelector('#ev-submit')?.addEventListener('click', () => run(async () => {
    if (!(await save())) return;
    try {
      await api.evaluations.submit(v.id, { revision: v.revision });
      toast('Submitted to the principal');
      ctx.rerender();
    } catch (e) {
      notifyQuota(e);
      if (e && e.code === 'CONFLICT') { conflict(); return; }
      const missing = e?.details?.missing;
      if (Array.isArray(missing) && missing.length) {
        msgEl.innerHTML = banner('warn', missingHtml(missing));
        const keys = new Set(missing.map((m) => m.key));
        formEl.querySelectorAll('.ev-item').forEach((row) => { if (keys.has(row.dataset.item)) row.classList.add('missing'); });
        msgEl.querySelector('[data-goto-missing]')?.addEventListener('click', () => formEl.querySelector('.ev-item.missing')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
        msgEl.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      } else msgEl.innerHTML = banner('bad', esc(errMessage(e)));
    }
  }));
  ctx.el.querySelector('#ev-publish')?.addEventListener('click', () => run(async () => {
    if (!(await save())) return;
    if (!(await confirmDialog('Publish', `Publish ${v.studentName}’s progress report? The family can then read and print it. It is frozen once published.`, { okLabel: 'Publish' }))) return;
    if ((await attempt(() => api.evaluations.publish(v.id, { revision: v.revision }), 'Published')).ok) ctx.rerender();
  }));
  ctx.el.querySelector('#ev-unpublish')?.addEventListener('click', async () => {
    const ok = await formModal({
      title: 'Unpublish for a correction',
      fieldsHtml: `<p style="margin-top:0">The family will no longer see this report until it is published again. The reason is kept with the report.</p>
        <label class="field"><span class="lbl">Reason</span><input name="reason" maxlength="200" required></label>`,
      submitLabel: 'Unpublish',
      onSubmit: async (val) => { await api.evaluations.unpublish(v.id, String(val.reason || '').trim()); },
    });
    if (ok) { toast('Unpublished'); ctx.rerender(); }
  });
  ctx.el.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-nav]');
    if (!b) return;
    run(async () => {
      if (!(await save())) return;
      const r = list.find((x) => x.studentId === b.dataset.nav);
      if (!r) return;
      let id = r.evaluationId;
      if (!id) {
        const made = await attempt(() => api.evaluations.start({ studentId: r.studentId, academicYearId: v.academicYearId }));
        if (!made.ok) return;
        id = made.value.id;
      }
      ctx.go(`/evaluations/${id}`, { program: programId });
    });
  });

  // ---- unsaved changes: ask before a link is followed; the browser asks before the tab closes or reloads
  if (!editable) return;
  const onLink = async (e) => {
    const link = e.target?.closest?.('a[href^="#"]');
    if (!link || e.defaultPrevented || !isDirty()) return;
    e.preventDefault();
    e.stopPropagation();
    const choice = await openModal({
      title: 'Leave without saving?',
      body: '<p>Your changes to this progress report are not saved yet.</p>',
      actions: [{ label: 'Stay', value: 'stay' }, { label: 'Leave without saving', kind: 'danger', value: 'leave' }, { label: 'Save and leave', kind: 'primary', value: 'save' }],
    });
    if (choice === 'save') { if (!(await save())) return; } else if (choice !== 'leave') return;
    st = formState(v); // nothing to ask about any more
    location.hash = link.getAttribute('href');
  };
  const onUnload = (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } };
  document.addEventListener('click', onLink, true);
  if (typeof window !== 'undefined') window.addEventListener('beforeunload', onUnload);
  ctx.cleanup(() => {
    document.removeEventListener?.('click', onLink, true);
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', onUnload);
  });
}

export async function render(ctx) {
  if (ctx.params.id) return form(ctx);
  return board(ctx);
}
