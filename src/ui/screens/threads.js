// Two-way parent <-> teacher messaging. Read receipts are set by the api only when the *other* party opens a thread.
import { esc, icon, badge, empty, pageHead, fdatetime, ftime, fullName, indexBy, formModal, attempt, notFoundOrThrow, DASH, options } from '../components.js';

const me = (p) => p.guardianId || p.staffId;

function senderName(db, m) {
  if (m.senderRole === 'parent') return fullName(db.guardians.find((g) => g.id === m.senderId));
  return fullName(db.staff.find((s) => s.id === m.senderId));
}

async function newThread(ctx) {
  const { api, db, persona } = ctx;
  let kids;
  if (persona.role === 'parent') kids = (await api.people.childrenOf(persona.guardianId)).filter((k) => k.status === 'active');
  else kids = (await api.people.students()).filter((s) => s.status === 'active');
  const fields = `
    <label class="field"><span class="lbl">About child</span><select name="studentId" id="nt-student" required>${options(kids.map((k) => ({ value: k.id, label: fullName(k) })), '', { blank: 'Choose child' })}</select></label>
    ${persona.role === 'parent' ? '' : '<label class="field"><span class="lbl">To guardian</span><select name="guardianId" id="nt-guardian" required><option value="">Choose child first</option></select></label>'}
    <label class="field"><span class="lbl">Subject</span><input name="subject" required maxlength="120"></label>
    <label class="field"><span class="lbl">Message</span><textarea name="body" required></textarea></label>`;
  let createdId = null;
  const ok = await formModal({
    title: 'New message', fieldsHtml: fields, submitLabel: 'Send',
    onOpen: (d) => {
      const stu = d.querySelector('#nt-student');
      const gsel = d.querySelector('#nt-guardian');
      if (gsel) stu.addEventListener('change', () => {
        const s = db.students.find((x) => x.id === stu.value);
        const gs = (s?.guardianIds || []).map((id) => db.guardians.find((g) => g.id === id)).filter(Boolean);
        gsel.innerHTML = gs.length ? gs.map((g) => `<option value="${esc(g.id)}">${esc(fullName(g))} (${esc(g.relation)})</option>`).join('') : '<option value="">No guardian</option>';
      });
    },
    onSubmit: async (v) => {
      if (!v.studentId) throw new Error('Choose a child.');
      const guardianId = persona.role === 'parent' ? persona.guardianId : v.guardianId;
      if (!guardianId) throw new Error('Choose a guardian.');
      const t = await api.threads.open({ guardianId, studentId: v.studentId, subject: v.subject.trim(), body: v.body.trim() });
      createdId = t?.id || t?.thread?.id || null;
    },
  });
  return ok ? createdId || true : null;
}

async function list(ctx) {
  const { api, db, persona } = ctx;
  const threads = await api.threads.list();
  const stu = indexBy(db.students);
  const prog = indexBy(db.programs);
  const rows = threads.map((t) => {
    const msgs = db.messages.filter((m) => m.threadId === t.id).sort((a, b) => (a.sentAt < b.sentAt ? -1 : 1));
    const last = msgs[msgs.length - 1];
    const fromOtherSide = (m) => (persona.role === 'parent' ? m.senderRole !== 'parent' : m.senderRole === 'parent');
    const unread = msgs.filter((m) => !m.readAt && fromOtherSide(m)).length;
    return { t, last, unread };
  }).sort((a, b) => ((a.last?.sentAt || a.t.createdAt) < (b.last?.sentAt || b.t.createdAt) ? 1 : -1));
  ctx.el.innerHTML = `${pageHead('Messages', persona.role === 'parent' ? 'Talk to your child’s teacher' : 'Conversations with parents', `<button class="btn primary" id="t-new">${icon('plus', 'sm')} New message</button>`)}
    ${rows.length ? `<ul class="list card-list">${rows.map(({ t, last, unread }) => `<li class="link"><a href="#/messages/${esc(t.id)}">
      <div class="row between"><div class="item-title">${esc(t.subject)}</div>${unread ? badge(`${unread} new`, 'clay') : t.status === 'closed' ? badge('Closed', 'mute') : ''}</div>
      <small>${esc(fullName(stu.get(t.studentId)))} &middot; ${esc(prog.get(t.programId)?.name || DASH)} &middot; ${last ? fdatetime(last.sentAt) : DASH}</small>
      ${last ? `<div class="muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(last.body)}</div>` : ''}</a></li>`).join('')}</ul>` : empty('No conversations yet', 'Start one with "New message".')}`;
  ctx.el.querySelector('#t-new').addEventListener('click', async () => {
    const r = await newThread(ctx);
    if (typeof r === 'string') ctx.go(`/messages/${r}`); else if (r) ctx.rerender();
  });
}

async function detail(ctx) {
  const { api, db, persona } = ctx;
  const id = ctx.params.id;
  await attempt(() => api.threads.markRead(id)); // marks the OTHER party's messages as read
  const got = await api.threads.get(id).catch(notFoundOrThrow);
  if (!got || !got.thread) { ctx.el.innerHTML = `${empty('Conversation not found')}<p><a class="btn" href="#/messages">Back</a></p>`; return; }
  const { thread, messages } = got;
  const stu = db.students.find((s) => s.id === thread.studentId);
  const mine = (m) => m.senderRole === persona.role && m.senderId === me(persona);
  ctx.el.innerHTML = `<p><a href="#/messages">&larr; All messages</a></p>
    <div class="page-head"><div><h1>${esc(thread.subject)}</h1><div class="sub">About ${esc(fullName(stu))} &middot; ${esc(db.programs.find((p) => p.id === thread.programId)?.name || DASH)}</div></div>
      ${thread.status === 'closed' ? badge('Closed', 'mute') : persona.role !== 'parent' ? '<button class="btn sm" id="t-close">Close conversation</button>' : ''}</div>
    <div class="bubbles" aria-live="polite">${messages.map((m) => `<div class="bubble ${mine(m) ? 'mine' : ''}">${esc(m.body)}<span class="meta">${esc(senderName(db, m))} &middot; ${ftime(m.sentAt)}${mine(m) ? (m.readAt ? ` &middot; Read ${ftime(m.readAt)}` : ' &middot; Sent') : ''}</span></div>`).join('')}</div>
    ${thread.status === 'closed' ? '<div class="banner" style="margin-top:14px">This conversation is closed.</div>' : `
    <form id="t-reply" class="stack" style="margin-top:14px"><label class="field"><span class="lbl">Reply</span><textarea name="body" required></textarea></label><button class="btn primary" type="submit">Send reply</button></form>`}`;
  ctx.el.querySelector('#t-reply')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = e.target.body.value.trim();
    if (!body) return;
    const r = await attempt(() => api.threads.reply(id, body), 'Sent');
    if (r.ok) ctx.rerender();
  });
  ctx.el.querySelector('#t-close')?.addEventListener('click', async () => {
    const r = await attempt(() => api.threads.close(id), 'Conversation closed');
    if (r.ok) ctx.rerender();
  });
  // cross-tab: a reply sent from another tab appears; only when the message count changed (read receipts must not loop) and no draft is half-typed
  // signature covers message count AND read receipts, so "Sent" turns into "Read" when the other party opens the thread
  const sig = () => ctx.db.messages.filter((m) => m.threadId === id).map((m) => `${m.id}:${m.readAt || ''}`).join('|');
  const shown = sig();
  ctx.onChange(() => { const ta = ctx.el.querySelector('#t-reply textarea'); if (sig() !== shown && (!ta || !ta.value)) ctx.rerender(); });
}

export async function render(ctx) {
  if (ctx.params.id) await detail(ctx); else await list(ctx);
}
