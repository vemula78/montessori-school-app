// Notice board: staff compose + track recipients; parents read + acknowledge.
import { esc, icon, badge, empty, pageHead, fdatetime, fullName, indexBy, formModal, attempt, toast, DASH } from '../components.js';

const STAFF = ['admin', 'teacher'];

// forParent: never enumerate other children; the parent's own children come from their receipt ("About").
function audienceText(db, a, forParent = false) {
  if (!a) return DASH;
  if (a.scope === 'school') return 'Whole school';
  if (a.scope === 'program') {
    const p = indexBy(db.programs);
    return 'Programme: ' + a.programIds.map((id) => p.get(id)?.name || id).join(', ');
  }
  if (forParent) return 'Selected children';
  const s = indexBy(db.students);
  const names = a.studentIds.map((id) => s.get(id)?.firstName || id);
  return `Children: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` +${names.length - 4}` : ''}`;
}

function childNames(db, ids) {
  const s = indexBy(db.students);
  return (ids || []).map((id) => s.get(id)?.firstName || id).join(', ');
}

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
      <div id="n-progs" style="margin-left:30px">${progs.map((p) => `<label class="check sm"><input type="checkbox" name="programIds" value="${esc(p.id)}"> ${esc(p.name)}</label>`).join('')}</div>
      <label class="check"><input type="radio" name="scope" value="students"> Specific children</label>
      <div id="n-studs" style="margin-left:30px;max-height:150px;overflow:auto">${students.map((s) => `<label class="check sm"><input type="checkbox" name="studentIds" value="${esc(s.id)}"> ${esc(fullName(s))}</label>`).join('')}</div>
    </fieldset>
    <label class="check"><input type="checkbox" name="requiresAck"> Requires acknowledgement</label>
    <label class="check"><input type="checkbox" name="important"> Mark as important</label>`;
  let createdId = null;
  const ok = await formModal({
    title: 'New notice', fieldsHtml: fields, submitLabel: 'Send notice',
    onSubmit: async (v) => {
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
      const n = await api.notices.send({ title: v.title.trim(), body: v.body.trim(), audience, requiresAck: v.requiresAck === 'on', important: v.important === 'on' });
      createdId = n?.id || null;
    },
  });
  return ok ? createdId || true : null;
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
    if (staff && c) status = n.requiresAck ? badge(`Ack ${c.ack}/${c.total}`, c.ack === c.total ? 'ok' : 'warn') : badge(`Read ${c.read}/${c.total}`, 'info');
    else if (r) status = n.requiresAck ? (r.ackAt ? badge('Acknowledged', 'ok') : badge('Needs acknowledgement', 'warn')) : (r.readAt ? badge('Read', 'mute') : badge('New', 'clay'));
    return `<li class="link"><a href="#/notices/${esc(n.id)}">
      <div class="row between"><div class="item-title">${n.important ? badge('Important', 'bad') + ' ' : ''}${esc(n.title)}</div>${status}</div>
      <small>${esc(audienceText(db, n.audience, !staff))} &middot; ${fdatetime(n.createdAt)}</small></a></li>`;
  });
  ctx.el.innerHTML = `${pageHead('Notices', staff ? 'Broadcast to the school, a programme or chosen children' : '', staff ? `<button class="btn primary" id="n-new">${icon('plus', 'sm')} New notice</button>` : '')}
    ${items.length ? `<ul class="list card-list">${items.join('')}</ul>` : empty('No notices yet', staff ? 'Use "New notice" to send the first one.' : 'Nothing has been sent to you.')}`;
  ctx.el.querySelector('#n-new')?.addEventListener('click', async () => {
    const id = await composeModal(ctx);
    if (id) { toast('Notice sent'); typeof id === 'string' ? ctx.go(`/notices/${id}`) : ctx.rerender(); }
  });
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
  if (staff && rec) {
    const read = rec.filter((r) => r.readAt).length;
    const ack = rec.filter((r) => r.ackAt).length;
    body = `<div class="grid cols-3" style="margin:12px 0">
        <div class="kpi"><div class="v">${rec.length}</div><div class="l">guardians addressed</div></div>
        <div class="kpi"><div class="v">${read}</div><div class="l">have read</div></div>
        <div class="kpi ${n.requiresAck && ack < rec.length ? 'bad' : 'good'}"><div class="v">${n.requiresAck ? ack : DASH}</div><div class="l">${n.requiresAck ? 'acknowledged' : 'acknowledgement not required'}</div></div></div>
      <h2>Recipients</h2><p class="muted" style="font-size:.88rem">One row per guardian, not per child.</p>
      ${rec.length ? `<div class="tablewrap"><table><thead><tr><th>Guardian</th><th>About</th><th>Read</th><th>Acknowledged</th></tr></thead><tbody>
        ${rec.map((r) => `<tr><td>${esc(r.guardianName)}</td><td>${esc(childNames(db, r.studentIds))}</td><td>${fdatetime(r.readAt)}</td><td>${n.requiresAck ? fdatetime(r.ackAt) : DASH}</td></tr>`).join('')}
      </tbody></table></div>` : empty('No recipients', 'The audience resolved to no guardians.')}`;
  } else if (staff) {
    body = `<div class="banner">${esc(recNote)}</div>`;
  } else {
    let cur = n;
    if (cur.receipt && !cur.receipt.readAt) {
      await attempt(() => api.notices.markRead(id));
      cur = (await api.notices.list()).find((x) => x.id === id) || cur; // re-read: markRead committed
    }
    const fresh = cur.receipt;
    const about = cur.aboutStudentIds || fresh?.studentIds || [];
    body = `${fresh ? `<p><small>About: <strong>${esc(childNames(ctx.db, about))}</strong></small></p>` : ''}
      ${n.requiresAck ? (fresh?.ackAt ? `<div class="banner ok">You acknowledged this on ${fdatetime(fresh.ackAt)}.</div>` : fresh ? '<button class="btn primary" id="n-ack">Acknowledge</button>' : '') : ''}`;
  }
  ctx.el.innerHTML = `<p><a href="#/notices">&larr; All notices</a></p>
    <div class="card stack"><div class="row between"><h1 style="margin:0">${esc(n.title)}</h1>${n.important ? badge('Important', 'bad') : ''}</div>
    <small>${esc(audienceText(ctx.db, n.audience, !staff))} &middot; sent ${fdatetime(n.createdAt)}${n.requiresAck ? ' &middot; acknowledgement required' : ''}</small>
    <div style="white-space:pre-wrap">${esc(n.body)}</div></div>
    <div style="margin-top:14px">${body}</div>`;
  ctx.el.querySelector('#n-ack')?.addEventListener('click', async () => {
    const ok = await attempt(() => api.notices.acknowledge(id), 'Acknowledged');
    if (ok.ok) ctx.rerender();
  });
}

export async function render(ctx) {
  if (ctx.params.id) await detail(ctx); else await list(ctx);
}
