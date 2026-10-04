// Learning. Staff (principal, teachers): observations with photos, progress per child, termly reports, curriculum.
// Parents: the observations the teacher chose to share (with photos) and the published termly reports, for their own
// children. Parents never see a progress grid: progress reaches them only inside a published report.
// Images are drawn from blobs (photo-view.js); nothing here ever puts a server URL in the page.
import { todayISO, addDays } from '../../domain/dates.js';
import { esc, banner, empty, pageHead, badge, fdate, fullName, options, formModal, confirmDialog, openModal, attempt, errMessage, DASH } from '../components.js';
import { AREA_KEYS, AREA_LABEL, STATUS_KEYS, STATUS_LABEL, STATUS_KIND, TERM_NAMES, NARRATIVE_LABEL, REPORT_STATUS } from '../learn-labels.js';
import { photoImg, loadPhotos } from '../photo-view.js';
import { preparePhoto, sizeText } from '../photo-prep.js';
import { renderCurriculum } from './learning-curriculum.js';

const TABS = [['observations', 'Observations'], ['progress', 'Progress'], ['reports', 'Reports'], ['curriculum', 'Curriculum']];

// ---------------------------------------------------------------- photo helpers
const NO_CONSENT_NOTE = 'No photo consent for this child: every guardian using the app must agree to photos (Settings > My privacy choices). You can still write the observation.';

/** The photo part of a form: file, the "only this child" tick, a status line. Returns {html, wire(d, getStudentId)}. */
export function photoBlock(noPhoto) {
  const html = `<div class="field" id="ph-block"><span class="lbl">Photo (optional)</span>
      <input type="file" id="ph-file" accept="image/*" aria-label="Choose a photo">
      <div class="upload-status" id="ph-status" role="status"></div>
      <label class="check"><input type="checkbox" id="ph-solo"> Only this child is in the frame</label>
      <div class="help">One child per photo. The photo is shrunk to 1280 px and re-saved as a JPEG here, which removes camera and location details. If it cannot be prepared it is not uploaded.</div></div>`;
  const state = { prepared: null };
  const wire = (d, studentId) => {
    const file = d.querySelector('#ph-file'), solo = d.querySelector('#ph-solo'), status = d.querySelector('#ph-status');
    const sync = () => {
      const blocked = noPhoto.has(studentId());
      file.disabled = blocked; solo.disabled = blocked;
      if (blocked) { state.prepared = null; status.className = 'upload-status bad'; status.textContent = NO_CONSENT_NOTE; } else if (status.textContent === NO_CONSENT_NOTE) { status.className = 'upload-status'; status.textContent = ''; }
    };
    file.addEventListener('change', async () => {
      state.prepared = null;
      status.className = 'upload-status'; status.textContent = '';
      const f = file.files && file.files[0];
      if (!f) return;
      status.textContent = 'Preparing the photo...';
      try {
        state.prepared = await preparePhoto(f);
        status.className = 'upload-status ok';
        status.textContent = `Ready: ${state.prepared.width} x ${state.prepared.height} px, ${sizeText(state.prepared.bytes)}. Camera and location details removed.`;
      } catch (e) { status.className = 'upload-status bad'; status.textContent = errMessage(e); file.value = ''; }
    });
    sync();
    return { sync, state, solo: () => solo.checked };
  };
  return { html, wire, state };
}

/** register → upload → complete. Throws with a readable message; the observation text is already saved by then. */
async function attachPhoto(api, observationId, prepared) {
  const grant = await api.photos.register({ observationId, soloConfirmed: true });
  await api.photos.upload(prepared.blob, { ...grant, width: prepared.width, height: prepared.height });
  await api.photos.complete(grant.photo.id);
}

/** Save a new observation, then its photo (if any). The text is saved first: a failed photo never loses it. */
export async function saveObservation(ctx, v, prepared = null) {
  const o = await ctx.api.observations.add({ studentId: v.studentId, date: v.date, area: v.area, presentationId: v.presentationId || null, text: v.text });
  if (prepared) {
    try { await attachPhoto(ctx.api, o.id, prepared); } catch (e) {
      // the text is saved; say so, and let the teacher add the photo from the card
      ctx.toast(`Observation saved, but the photo was not added: ${errMessage(e)}`, 'bad');
    }
  }
  return o;
}

// ---------------------------------------------------------------- observation cards
function obsCard(o, s, { staff, canShare, noPhoto }) {
  const photos = (o.photoIds || []).map((id) => (staff
    ? `<div class="stack" style="margin:0"><div>${photoImg(id)}</div><button class="btn" data-rm-photo="${esc(id)}" aria-label="Remove this photo">Remove</button></div>`
    : photoImg(id)));
  const shared = o.sharedAt ? badge(`Shared ${fdate(String(o.sharedAt).slice(0, 10))}`, 'ok') : badge('Staff only', 'mute');
  return `<div class="card stack obs-card" data-obs="${esc(o.id)}">
    <div class="row between"><div><div class="item-title">${esc(s ? fullName(s) : DASH)}</div><small>${fdate(o.date)}</small></div>
      <div class="row">${badge(AREA_LABEL[o.area] || o.area, 'clay')}${staff ? shared : ''}</div></div>
    ${o.presentationName ? `<small>${esc(o.presentationName)}</small>` : ''}
    <div class="obs-text">${esc(o.text)}</div>
    ${photos.length ? `<div class="photo-row">${photos.join('')}</div>` : ''}
    ${staff && canShare ? `<div class="row">
      ${o.sharedAt ? `<button class="btn" data-unshare="${esc(o.id)}">Unshare</button>` : `<button class="btn primary" data-share="${esc(o.id)}">Share with family</button><button class="btn" data-edit="${esc(o.id)}">Edit</button>`}
      ${noPhoto.has(o.studentId) ? '' : `<button class="btn" data-add-photo="${esc(o.id)}">Add photo</button>`}
      ${noPhoto.has(o.studentId) ? badge('No photo consent', 'warn') : ''}</div>` : ''}</div>`;
}

// ---------------------------------------------------------------- staff: observations tab
async function observationsTab(ctx, host, { programId, students }) {
  const { api, query } = ctx;
  const today = todayISO();
  const days = Number(query.days) === 90 ? 90 : 30;
  const studentId = students.find((s) => s.id === query.student)?.id || '';
  const [obs, presentations] = await Promise.all([
    api.observations.list(studentId ? { studentId, from: addDays(today, -days) } : { programId, from: addDays(today, -days) }),
    api.curriculum.list({ includeRetired: false }),
  ]);
  const noPhoto = new Set();
  // one call for the whole list (the real app asks the server; teachers cannot read consent records themselves)
  const consentOk = students.length ? await api.photos.consentStatus({ studentIds: students.map((s) => s.id) }) : {};
  for (const s of students) if (!consentOk[s.id]) noPhoto.add(s.id);
  const byStudent = new Map(students.map((s) => [s.id, s]));
  host.innerHTML = `<div class="row" style="margin-bottom:12px">
      <select id="l-child" style="width:auto" aria-label="Child"><option value="">All children</option>${options(students.map((s) => ({ value: s.id, label: fullName(s) })), studentId)}</select>
      <select id="l-days" style="width:auto" aria-label="How far back">${options([{ value: 30, label: 'Last 30 days' }, { value: 90, label: 'Last 90 days' }], days)}</select>
      <span class="grow"></span><button class="btn primary" id="l-add">Add observation</button></div>
    <div class="stack">${obs.length ? obs.map((o) => obsCard(o, byStudent.get(o.studentId), { staff: true, canShare: true, noPhoto })).join('') : empty('No observations in this period', 'Add one for a child. It stays staff-only until you share it.')}</div>`;
  loadPhotos(ctx, host);
  const go = (patch) => ctx.setQuery({ tab: 'observations', program: programId, student: studentId, days, ...patch });
  host.querySelector('#l-child').addEventListener('change', (e) => go({ student: e.target.value }));
  host.querySelector('#l-days').addEventListener('change', (e) => go({ days: e.target.value }));
  host.querySelector('#l-add').addEventListener('click', async () => { if (await observationForm(ctx, { students, presentations, noPhoto, studentId })) ctx.rerender(); });
  host.addEventListener('click', async (e) => {
    const t = (sel) => e.target.closest(sel);
    let b;
    if ((b = t('[data-share]'))) {
      const o = obs.find((x) => x.id === b.dataset.share);
      const s = byStudent.get(o.studentId);
      if (await confirmDialog('Share with the family', `${s ? s.firstName : 'The child'}'s family will see this observation${(o.photoIds || []).length ? ' and its photos' : ''} in the app. Continue?`, { okLabel: 'Share' })
        && (await attempt(() => api.observations.share(o.id), 'Shared with the family')).ok) ctx.rerender();
    } else if ((b = t('[data-unshare]'))) {
      if (await confirmDialog('Unshare', 'Hide this observation from the family again? Use this for a mistake; a teacher can do it within 24 hours of sharing.', { okLabel: 'Unshare', kind: 'danger' })
        && (await attempt(() => api.observations.unshare(b.dataset.unshare), 'Unshared')).ok) ctx.rerender();
    } else if ((b = t('[data-edit]'))) {
      const o = obs.find((x) => x.id === b.dataset.edit);
      if (await observationForm(ctx, { students, presentations, noPhoto, edit: o })) ctx.rerender();
    } else if ((b = t('[data-add-photo]'))) {
      if (await addPhotoForm(ctx, obs.find((x) => x.id === b.dataset.addPhoto), noPhoto)) ctx.rerender();
    } else if ((b = t('[data-rm-photo]'))) {
      if (await confirmDialog('Remove photo', 'Delete this photo? The family will no longer see it and the file is deleted.', { okLabel: 'Remove', kind: 'danger' })
        && (await attempt(() => api.photos.remove(b.dataset.rmPhoto), 'Photo removed')).ok) ctx.rerender();
    }
  });
}

/** Add (no `edit`) or edit (unshared only) an observation; add also takes one optional photo. Resolves true when saved. */
function observationForm(ctx, { students, presentations, noPhoto, studentId = '', edit = null }) {
  const { api } = ctx;
  const today = todayISO();
  const firstId = edit ? edit.studentId : (studentId || students[0]?.id || '');
  const ph = edit ? null : photoBlock(noPhoto);
  let photo = null;
  const presFor = (area) => presentations.filter((p) => p.area === area);
  const presOptions = (area, sel) => `<option value="">Not linked to a presentation</option>${options(presFor(area).map((p) => ({ value: p.id, label: p.name })), sel)}`;
  const area0 = edit ? edit.area : 'practicalLife';
  return formModal({
    title: edit ? 'Edit observation' : 'Add observation', submitLabel: edit ? 'Save changes' : 'Save observation',
    fieldsHtml: `${edit ? '' : `<label class="field"><span class="lbl">Child</span><select name="studentId" id="o-child">${options(students.map((s) => ({ value: s.id, label: fullName(s) })), firstId)}</select></label>`}
      <div class="grid cols-2"><label class="field"><span class="lbl">Date</span><input type="date" name="date" value="${esc(edit ? edit.date : today)}" max="${esc(today)}" required></label>
      <label class="field"><span class="lbl">Montessori area</span><select name="area" id="o-area">${options(AREA_KEYS.map((a) => ({ value: a, label: AREA_LABEL[a] })), area0)}</select></label></div>
      <label class="field"><span class="lbl">Presentation (optional)</span><select name="presentationId" id="o-pres">${presOptions(area0, edit ? edit.presentationId : '')}</select></label>
      <label class="field"><span class="lbl">What did you observe?</span><textarea name="text" required maxlength="4000">${esc(edit ? edit.text : '')}</textarea></label>
      ${ph ? ph.html : ''}
      <div class="help">${edit ? 'Only an unshared observation can be edited.' : 'Staff only until you share it. Nothing is saved offline: keep this window open until it saves.'}</div>`,
    onOpen: (d) => {
      const area = d.querySelector('#o-area'), pres = d.querySelector('#o-pres');
      area.addEventListener('change', () => { pres.innerHTML = presOptions(area.value, ''); });
      if (ph) photo = ph.wire(d, () => d.querySelector('#o-child').value);
      d.querySelector('#o-child')?.addEventListener('change', () => photo && photo.sync());
    },
    onSubmit: async (v) => {
      if (edit) { await api.observations.edit(edit.id, { date: v.date, area: v.area, presentationId: v.presentationId || null, text: v.text }); return; }
      if (photo && photo.state.prepared && !photo.solo()) throw new Error('Tick "Only this child is in the frame" to add the photo, or choose no photo.');
      await saveObservation(ctx, v, photo && photo.state.prepared);
    },
  });
}

function addPhotoForm(ctx, o, noPhoto) {
  const ph = photoBlock(noPhoto);
  let photo = null;
  return formModal({
    title: 'Add photo', submitLabel: 'Upload photo', fieldsHtml: ph.html,
    onOpen: (d) => { photo = ph.wire(d, () => o.studentId); },
    onSubmit: async () => {
      if (!photo.state.prepared) throw new Error('Choose a photo first');
      if (!photo.solo()) throw new Error('Tick "Only this child is in the frame" to add the photo.');
      await attachPhoto(ctx.api, o.id, photo.state.prepared);
    },
  });
}

// ---------------------------------------------------------------- staff: progress tab
const rank = (s) => STATUS_KEYS.indexOf(s);

async function progressTab(ctx, host, { programId, students }) {
  const { api, query } = ctx;
  const studentId = students.find((s) => s.id === query.student)?.id || '';
  if (!studentId) {
    const state = await api.progress.state({ programId });
    const rows = students.map((s) => {
      const mine = state.filter((x) => x.studentId === s.id);
      const cell = (area) => { const l = mine.filter((x) => x.area === area); const n = (st) => l.filter((x) => x.status === st).length; return l.length ? `${n('mastered')} &middot; ${n('practising')} &middot; ${n('introduced')}` : DASH; };
      return `<tr><td><a href="${esc(ctx.href('/learning', { tab: 'progress', program: programId, student: s.id }))}">${esc(fullName(s))}</a></td>${AREA_KEYS.map((a) => `<td class="num">${cell(a)}</td>`).join('')}</tr>`;
    });
    host.innerHTML = `<div class="stack"><p class="muted" style="margin:0">Each cell shows presentations <strong>mastered &middot; practising &middot; introduced</strong>. Choose a child to record progress.</p>
      ${students.length ? `<div class="tablewrap"><table><thead><tr><th>Child</th>${AREA_KEYS.map((a) => `<th>${esc(AREA_LABEL[a])}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : empty('No children in this programme')}</div>`;
    return;
  }
  const s = students.find((x) => x.id === studentId);
  const area = AREA_KEYS.includes(query.area) ? query.area : 'practicalLife';
  const [list, state] = await Promise.all([api.curriculum.list({ area }), api.progress.state({ studentId })]);
  const cur = new Map(state.map((x) => [x.presentationId, x]));
  const shown = list.filter((p) => p.active || cur.has(p.id));
  host.innerHTML = `<div class="stack">
    <div class="row between"><div class="row"><a class="btn" href="${esc(ctx.href('/learning', { tab: 'progress', program: programId }))}">&larr; All children</a><h2 style="margin:0">${esc(fullName(s))}</h2></div></div>
    <div class="seg" role="tablist" aria-label="Area">${AREA_KEYS.map((a) => `<a href="${esc(ctx.href('/learning', { tab: 'progress', program: programId, student: studentId, area: a }))}"${a === area ? ' aria-current="page"' : ''}>${esc(AREA_LABEL[a])}</a>`).join('')}</div>
    <div class="lbox">${shown.length ? shown.map((p) => {
      const c = cur.get(p.id);
      return `<div class="lrow${p.active ? '' : ' retired'}"><div><div class="lname">${esc(p.name)}</div>
        <small>${c ? `${badge(STATUS_LABEL[c.status], STATUS_KIND[c.status])} ${fdate(c.date)}` : 'Not started'}${p.active ? '' : ' &middot; retired'}${p.ageFromMonths != null ? ` &middot; ages ${esc(Math.floor(p.ageFromMonths / 12))}${p.ageToMonths != null ? `&ndash;${esc(Math.ceil(p.ageToMonths / 12))}` : '+'}` : ''}</small></div>
        <div class="row"><button class="btn primary" data-rec="${esc(p.id)}">Record</button>${c ? `<button class="btn" data-hist="${esc(p.id)}">History</button>` : ''}</div></div>`;
    }).join('') : empty('No presentations in this area', 'The principal can load the starter list in the Curriculum tab.')}</div></div>`;
  host.addEventListener('click', async (e) => {
    const r = e.target.closest('[data-rec]');
    const h = e.target.closest('[data-hist]');
    if (r) { const p = list.find((x) => x.id === r.dataset.rec); if (await recordForm(ctx, s, p, cur.get(p.id))) ctx.rerender(); }
    if (h) {
      const p = list.find((x) => x.id === h.dataset.hist);
      const hist = await attempt(() => api.progress.history(studentId, p.id));
      if (!hist.ok) return;
      await openModal({ title: `${p.name} - history`, body: `<ul class="list card-list">${hist.value.map((ev) => `<li><div class="row between"><span>${badge(STATUS_LABEL[ev.status], STATUS_KIND[ev.status])} ${fdate(ev.date)}</span>${ev.correction ? badge('Correction', 'warn') : ''}</div>${ev.note ? `<div>${esc(ev.note)}</div>` : ''}${ev.reason ? `<small>Reason: ${esc(ev.reason)}</small>` : ''}</li>`).join('')}</ul>` });
    }
  });
}

function recordForm(ctx, s, p, cur) {
  const today = todayISO();
  const next = cur ? STATUS_KEYS[Math.min(rank(cur.status) + 1, 2)] : 'introduced';
  return formModal({
    title: `${s.firstName}: ${p.name}`, submitLabel: 'Record',
    fieldsHtml: `${cur ? `<p class="muted">Now: ${esc(STATUS_LABEL[cur.status])} since ${fdate(cur.date)}</p>` : ''}
      <label class="field"><span class="lbl">Status</span><select name="status" id="r-status">${options(STATUS_KEYS.map((k) => ({ value: k, label: STATUS_LABEL[k] })), next)}</select></label>
      <label class="field"><span class="lbl">Date</span><input type="date" name="date" value="${esc(today)}" max="${esc(today)}" required></label>
      <label class="field"><span class="lbl">Note (optional)</span><textarea name="note" maxlength="1000" style="min-height:60px"></textarea></label>
      <div id="r-corr" class="${cur && rank(next) <= rank(cur.status) ? '' : 'hide'}"><div class="banner warn">Going back, or recording the same status again, is a correction and needs a reason. Without ticking it the record is refused.</div>
        <label class="check"><input type="checkbox" name="correction" id="r-corr-on"> This is a correction</label>
        <label class="field"><span class="lbl">Reason for the correction</span><input name="reason" id="r-reason"></label></div>`,
    onOpen: (d) => {
      const sel = d.querySelector('#r-status'), box = d.querySelector('#r-corr');
      const sync = () => box.classList.toggle('hide', !(cur && rank(sel.value) <= rank(cur.status)));
      sel.addEventListener('change', sync); sync();
    },
    onSubmit: async (v) => {
      await ctx.api.progress.record({ studentId: s.id, presentationId: p.id, status: v.status, date: v.date, note: (v.note || '').trim(), correction: v.correction === 'on', reason: v.correction === 'on' ? (v.reason || '').trim() : null });
    },
  });
}

// ---------------------------------------------------------------- staff: reports tab
async function reportsTab(ctx, host, { programId, students }) {
  const { api, db, query } = ctx;
  if (query.report) return reportEditor(ctx, host, query.report, { programId, students });
  const ids = new Set(students.map((s) => s.id));
  const names = new Map(students.map((s) => [s.id, fullName(s)]));
  const reports = (await api.reports.list({})).filter((r) => ids.has(r.studentId));
  host.innerHTML = `<div class="stack"><div class="row between"><p class="muted" style="margin:0">A report is a frozen copy: progress as of the term end and the observations you shared. Parents see it only once the principal publishes it.</p><button class="btn primary" id="rp-new">Start a report</button></div>
    ${reports.length ? `<div class="tablewrap"><table><thead><tr><th>Child</th><th>Term</th><th>Dates</th><th>Status</th><th></th></tr></thead><tbody>${reports.map((r) => `<tr><td>${esc(names.get(r.studentId))}</td><td>${esc(r.termName)}</td><td class="nowrap">${fdate(r.fromDate)} to ${fdate(r.toDate)}</td>
      <td>${badge(...REPORT_STATUS[r.status])}</td><td><a class="btn" href="${esc(ctx.href('/learning', { tab: 'reports', program: programId, report: r.id }))}">Open</a></td></tr>`).join('')}</tbody></table></div>` : empty('No reports yet', 'Start one for a child at the end of a term.')}</div>`;
  host.querySelector('#rp-new').addEventListener('click', async () => {
    const ay = db.academicYears.find((a) => a.id === db.school.currentAcademicYearId);
    if (!ay) { ctx.toast('No current academic year is set', 'bad'); return; }
    let made = null;
    const ok = await formModal({
      title: 'Start a termly report', submitLabel: 'Create report',
      fieldsHtml: `<label class="field"><span class="lbl">Child</span><select name="studentId">${options(students.map((s) => ({ value: s.id, label: fullName(s) })), '')}</select></label>
        <label class="field"><span class="lbl">Term</span><select name="termName">${options(TERM_NAMES.map((t) => ({ value: t, label: t })), 'Term 1')}</select></label>
        <div class="grid cols-2"><label class="field"><span class="lbl">From</span><input type="date" name="fromDate" value="${esc(ay.startDate)}" min="${esc(ay.startDate)}" max="${esc(ay.endDate)}" required></label>
        <label class="field"><span class="lbl">To</span><input type="date" name="toDate" value="${esc(todayISO() > ay.endDate ? ay.endDate : todayISO())}" min="${esc(ay.startDate)}" max="${esc(ay.endDate)}" required></label></div>
        <div class="help">Academic year ${esc(ay.label || ay.id)}. Choose the dates this term covers; progress is taken as of the end date.</div>`,
      onSubmit: async (v) => { made = await api.reports.generate({ studentId: v.studentId, academicYearId: ay.id, termName: v.termName, fromDate: v.fromDate, toDate: v.toDate }); },
    });
    if (ok && made) ctx.go('/learning', { tab: 'reports', program: programId, report: made.id });
  });
}

async function reportEditor(ctx, host, id, { programId, students }) {
  const { api, persona } = ctx;
  const r = await api.reports.get(id).catch((e) => { if (e && (e.code === 'NOT_FOUND' || e.code === 'NOT_ALLOWED')) return null; throw e; });
  const back = `<a class="btn" href="${esc(ctx.href('/learning', { tab: 'reports', program: programId }))}">&larr; All reports</a>`;
  if (!r) { host.innerHTML = `<div class="stack">${empty('Report not found')}${back}</div>`; return; }
  const s = students.find((x) => x.id === r.studentId);
  const locked = r.status === 'published';
  const [label, kind] = REPORT_STATUS[r.status];
  const byArea = (a) => r.progress.filter((x) => x.area === a);
  host.innerHTML = `<div class="stack">
    <div class="row between">${back}<span class="row">${badge(label, kind)}<small>version ${esc(r.revision)}</small></span></div>
    <div><h2 style="margin:0">${esc(s ? fullName(s) : DASH)} &middot; ${esc(r.termName)}</h2><small>${fdate(r.fromDate)} to ${fdate(r.toDate)}</small></div>
    ${r.unpublishReason && r.status !== 'published' ? banner('warn', `Unpublished for correction: ${esc(r.unpublishReason)}`) : ''}
    ${locked ? banner('ok', 'Published. The family can read and print this report. To change it the principal must unpublish it first.') : ''}
    <div class="card stack"><h3>What parents will read</h3>
      ${['overall', ...AREA_KEYS].map((k) => `<div><label class="field" style="margin:0"><span class="lbl">${esc(NARRATIVE_LABEL[k])}</span><textarea data-narr="${esc(k)}" maxlength="4000"${locked ? ' disabled' : ''}>${esc(r.narratives?.[k] || '')}</textarea></label>
        ${k !== 'overall' ? `<small>${byArea(k).length ? byArea(k).map((x) => `${esc(x.name)}: ${esc(STATUS_LABEL[x.status] || x.status)}`).join(' &middot; ') : 'No progress recorded in this area.'}</small>` : ''}</div>`).join('')}
      ${locked ? '' : '<div class="row"><button class="btn" id="rp-save">Save text</button></div>'}</div>
    <div class="card stack"><h3>Observations included (${esc(r.observations.length)})</h3>
      ${r.observations.length ? `<ul class="list">${r.observations.map((o) => `<li><small>${fdate(o.date)} &middot; ${esc(AREA_LABEL[o.area] || o.area)}</small><div>${esc(o.text)}</div></li>`).join('')}</ul>` : '<p class="muted" style="margin:0">None. Only observations shared with the family, dated inside the term, are included.</p>'}</div>
    <div class="row">
      <a class="btn" href="${esc(ctx.href('/print/report/' + r.id))}">Preview / print</a>
      ${locked ? '' : '<button class="btn" id="rp-refresh">Refresh from current records</button>'}
      ${r.status === 'draft' ? '<button class="btn primary" id="rp-submit">Submit for publishing</button>' : ''}
      ${persona.role === 'admin' && r.status === 'submitted' ? '<button class="btn primary" id="rp-publish">Publish to the family</button>' : ''}
      ${persona.role === 'admin' && locked ? '<button class="btn danger" id="rp-unpublish">Unpublish</button>' : ''}</div></div>`;
  const narratives = () => Object.fromEntries([...host.querySelectorAll('[data-narr]')].map((t) => [t.dataset.narr, t.value]));
  const act = async (fn, msg) => { if ((await attempt(fn, msg)).ok) ctx.rerender(); };
  host.querySelector('#rp-save')?.addEventListener('click', () => act(() => api.reports.saveNarratives(r.id, { narratives: narratives(), revision: r.revision }), 'Saved'));
  host.querySelector('#rp-refresh')?.addEventListener('click', async () => {
    if (await confirmDialog('Refresh from current records', 'Take the latest progress and shared observations for this term? Your text is kept and the report goes back to draft.', { okLabel: 'Refresh' })) {
      await act(() => api.reports.generate({ studentId: r.studentId, academicYearId: r.academicYearId, termName: r.termName, fromDate: r.fromDate, toDate: r.toDate }), 'Refreshed');
    }
  });
  host.querySelector('#rp-submit')?.addEventListener('click', async () => {
    // unsaved text is saved first so the principal publishes what is on screen
    const saved = await attempt(() => api.reports.saveNarratives(r.id, { narratives: narratives(), revision: r.revision }));
    if (saved.ok && (await attempt(() => api.reports.submit(r.id), 'Submitted for publishing')).ok) ctx.rerender();
  });
  host.querySelector('#rp-publish')?.addEventListener('click', async () => {
    if (await confirmDialog('Publish', 'Publish this report? The family will be able to read and print it. It is then frozen.', { okLabel: 'Publish' })) await act(() => api.reports.publish(r.id), 'Published');
  });
  host.querySelector('#rp-unpublish')?.addEventListener('click', async () => {
    let reason = '';
    const ok = await formModal({
      title: 'Unpublish this report', submitLabel: 'Unpublish',
      fieldsHtml: '<p>The family will no longer see it until it is corrected, submitted and published again.</p><label class="field"><span class="lbl">Reason</span><input name="reason" required></label>',
      onSubmit: async (v) => { reason = (v.reason || '').trim(); await api.reports.unpublish(r.id, reason); },
    });
    if (ok) ctx.rerender();
  });
}

// ---------------------------------------------------------------- staff entry
async function staffView(ctx) {
  const { api, db, persona, query } = ctx;
  const tab = TABS.some(([k]) => k === query.tab) ? query.tab : 'observations';
  const progs = persona.role === 'teacher' ? db.programs.filter((p) => (persona.programIds || []).includes(p.id)) : db.programs;
  if (!progs.length) { ctx.el.innerHTML = `${pageHead('Learning')}${empty('No programme assigned to you')}`; return; }
  const programId = progs.find((p) => p.id === query.program)?.id || progs[0].id;
  const students = (await api.people.students({ programId })).filter((s) => s.status === 'active');
  const tabs = TABS.map(([k, l]) => `<a href="${esc(ctx.href('/learning', { tab: k, program: programId }))}"${k === tab ? ' aria-current="page"' : ''}>${esc(l)}</a>`).join('');
  ctx.el.innerHTML = `${pageHead('Learning', progs.find((p) => p.id === programId).name)}
    <div class="row" style="margin-bottom:12px">
      ${progs.length > 1 ? `<select id="l-prog" style="width:auto" aria-label="Programme">${options(progs.map((p) => ({ value: p.id, label: p.name })), programId)}</select>` : ''}
      <div class="seg" role="tablist" aria-label="Learning sections">${tabs}</div></div>
    <div id="l-body"></div>`;
  ctx.el.querySelector('#l-prog')?.addEventListener('change', (e) => ctx.setQuery({ tab, program: e.target.value, student: '', report: '' }));
  const host = ctx.el.querySelector('#l-body');
  if (tab === 'observations') await observationsTab(ctx, host, { programId, students });
  else if (tab === 'progress') await progressTab(ctx, host, { programId, students });
  else if (tab === 'reports') await reportsTab(ctx, host, { programId, students });
  else await renderCurriculum(ctx, host);
}

// ---------------------------------------------------------------- parent
async function parentView(ctx) {
  const { api, persona, query } = ctx;
  const kids = await api.people.childrenOf(persona.guardianId);
  if (!kids.length) { ctx.el.innerHTML = `${pageHead('Learning')}${empty('No children linked to this account')}`; return; }
  const kid = kids.find((k) => k.id === query.student) || kids[0];
  const [obs, reports] = await Promise.all([api.observations.list({ studentId: kid.id }), api.reports.list({ studentId: kid.id })]);
  ctx.el.innerHTML = `${pageHead('Learning', fullName(kid))}
    ${kids.length > 1 ? `<div class="row" style="margin-bottom:12px"><div class="seg" role="tablist">${kids.map((k) => `<button role="tab" aria-pressed="${k.id === kid.id}" data-kid="${esc(k.id)}">${esc(k.firstName)}</button>`).join('')}</div></div>` : ''}
    <div class="stack">
      <h2>Termly reports</h2>
      ${reports.length ? `<ul class="list card-list">${reports.map((r) => `<li class="link"><a href="${esc(ctx.href('/print/report/' + r.id))}"><div class="row between"><div><div class="item-title">${esc(r.termName)}</div><small>${fdate(r.fromDate)} to ${fdate(r.toDate)}</small></div>${badge('Read and print', 'clay')}</div></a></li>`).join('')}</ul>`
        : empty('No termly report yet', 'Your child’s teacher and the principal publish a report at the end of each term.')}
      <h2>Shared by the teacher</h2>
      ${obs.length ? obs.map((o) => obsCard(o, kid, { staff: false, canShare: false, noPhoto: new Set() })).join('') : empty('Nothing shared yet', 'The teacher chooses which observations and photos to share with you.')}</div>`;
  loadPhotos(ctx, ctx.el);
  ctx.el.querySelectorAll('[data-kid]').forEach((b) => b.addEventListener('click', () => ctx.setQuery({ student: b.dataset.kid })));
}

export async function render(ctx) {
  if (ctx.persona.role === 'parent') await parentView(ctx); else await staffView(ctx);
}
