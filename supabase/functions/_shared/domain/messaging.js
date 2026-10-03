// Notices (broadcast with per-guardian receipts) and parent ↔ staff threads.

import { fail, newId } from './ids.js';
import { byId, mustGet, activeStudents, fullName, guardiansOf } from './people.js';
import { appendAudit } from './audit.js';

const STAFF_ROLES = ['admin', 'teacher', 'accountant', 'driver'];

/**
 * Audience → Map(guardianId → studentIds concerned). One entry per guardian even when siblings
 * fall in two targeted programs; a student with two guardians yields two entries.
 */
export function resolveAudience(db, audience) {
  let students;
  if (!audience || !audience.scope) fail('VALIDATION', 'Audience is required');
  if (audience.scope === 'school') students = activeStudents(db);
  else if (audience.scope === 'program') {
    const ids = audience.programIds || [];
    if (!ids.length) fail('VALIDATION', 'Choose at least one program');
    for (const p of ids) if (!byId(db.programs, p)) fail('VALIDATION', `Unknown program: ${p}`);
    students = activeStudents(db).filter(s => ids.includes(s.programId));
  } else if (audience.scope === 'students') {
    const ids = audience.studentIds || [];
    if (!ids.length) fail('VALIDATION', 'Choose at least one child');
    students = ids.map(id => mustGet(db, 'students', id, 'Student')).filter(s => s.status === 'active');
  } else fail('VALIDATION', `Unknown audience scope: ${audience.scope}`);
  const map = new Map();
  for (const s of students) {
    for (const g of guardiansOf(db, s.id)) {
      if (!map.has(g.id)) map.set(g.id, []);
      map.get(g.id).push(s.id);
    }
  }
  return map;
}

/** Program ids an audience touches (used for teacher scoping). Empty array = whole school. */
export function audiencePrograms(db, audience) {
  if (audience.scope === 'school') return [];
  if (audience.scope === 'program') return [...audience.programIds];
  return [...new Set(audience.studentIds.map(id => byId(db.students, id)?.programId).filter(Boolean))];
}

export function sendNotice(db, { title, body, audience, requiresAck = false, important = false }, ctx) {
  if (!title || !String(title).trim()) fail('VALIDATION', 'Title is required');
  if (!body || !String(body).trim()) fail('VALIDATION', 'Message body is required');
  const recipients = resolveAudience(db, audience);
  if (recipients.size === 0) fail('VALIDATION', 'This audience has no guardians');
  const notice = {
    id: newId('ntc'), title: String(title).trim(), body: String(body), audience: structuredClone(audience),
    requiresAck: !!requiresAck, important: !!important, createdBy: ctx.actor.id, createdAt: ctx.now,
  };
  db.notices.push(notice);
  for (const [guardianId, studentIds] of recipients) {
    db.noticeReceipts.push({ noticeId: notice.id, guardianId, studentIds, readAt: null, ackAt: null });
  }
  appendAudit(db, ctx, { entity: 'notice', entityId: notice.id, action: 'send', summary: `audience ${audience.scope}, ${recipients.size} guardians` });
  return notice;
}

function receiptFor(db, noticeId, guardianId) {
  const r = db.noticeReceipts.find(x => x.noticeId === noticeId && x.guardianId === guardianId);
  if (!r) fail('NOT_FOUND', 'This notice was not sent to you');
  return r;
}

export function markNoticeRead(db, noticeId, guardianId, ctx) {
  const r = receiptFor(db, noticeId, guardianId);
  if (!r.readAt) r.readAt = ctx.now;
  return r;
}

export function acknowledgeNotice(db, noticeId, guardianId, ctx) {
  const n = mustGet(db, 'notices', noticeId, 'Notice');
  if (!n.requiresAck) fail('VALIDATION', 'This notice does not ask for acknowledgement');
  const r = receiptFor(db, noticeId, guardianId);
  if (!r.readAt) r.readAt = ctx.now;
  if (!r.ackAt) {
    r.ackAt = ctx.now;
    appendAudit(db, ctx, { entity: 'notice', entityId: noticeId, action: 'acknowledge', summary: `guardian ${guardianId}` });
  }
  return r;
}

export function noticeRecipients(db, noticeId) {
  mustGet(db, 'notices', noticeId, 'Notice');
  return db.noticeReceipts.filter(r => r.noticeId === noticeId).map(r => ({
    guardianId: r.guardianId,
    guardianName: fullName(byId(db.guardians, r.guardianId)),
    studentIds: [...r.studentIds],
    readAt: r.readAt,
    ackAt: r.ackAt,
  }));
}

/** Counts are per guardian (receipt), never per child. */
export function noticeStats(db, noticeId) {
  const rs = db.noticeReceipts.filter(r => r.noticeId === noticeId);
  return { recipientCount: rs.length, readCount: rs.filter(r => r.readAt).length, ackCount: rs.filter(r => r.ackAt).length };
}

export function noticesForGuardian(db, guardianId) {
  const mine = db.noticeReceipts.filter(r => r.guardianId === guardianId);
  return mine.map(r => ({ ...byId(db.notices, r.noticeId), receipt: { ...r } })).filter(n => n.id);
}

/** Teacher sees school-wide notices plus those touching any of their programs. */
export function noticesForPrograms(db, programIds) {
  return db.notices.filter(n => {
    const ps = audiencePrograms(db, n.audience);
    return ps.length === 0 || ps.some(p => programIds.includes(p));
  });
}

// ---------------- threads ----------------

const side = role => (role === 'parent' ? 'parent' : 'staff');

export function openThread(db, { guardianId, studentId, subject, body }, ctx) {
  const g = mustGet(db, 'guardians', guardianId, 'Guardian');
  const s = mustGet(db, 'students', studentId, 'Student');
  if (!g.studentIds.includes(s.id) || !s.guardianIds.includes(g.id)) fail('VALIDATION', 'Guardian is not linked to this child');
  if (!subject || !String(subject).trim()) fail('VALIDATION', 'Subject is required');
  if (!body || !String(body).trim()) fail('VALIDATION', 'Message is required');
  const thread = { id: newId('thr'), guardianId, studentId, programId: s.programId, subject: String(subject).trim(), status: 'open', createdAt: ctx.now };
  db.threads.push(thread);
  const message = pushMessage(db, thread, body, ctx);
  return { thread, messages: [message] };
}

function pushMessage(db, thread, body, ctx) {
  if (!body || !String(body).trim()) fail('VALIDATION', 'Message is required');
  if (![...STAFF_ROLES, 'parent'].includes(ctx.actor.role)) fail('NOT_ALLOWED', 'Unknown sender role');
  const m = { id: newId('msg'), threadId: thread.id, senderRole: ctx.actor.role, senderId: ctx.actor.id, body: String(body), sentAt: ctx.now, readAt: null };
  db.messages.push(m);
  return m;
}

export function replyThread(db, threadId, body, ctx) {
  const t = mustGet(db, 'threads', threadId, 'Thread');
  if (t.status === 'closed') fail('VALIDATION', 'This conversation is closed');
  return pushMessage(db, t, body, ctx);
}

/** Marks messages from the OTHER side as read. The sender's own view never marks read. */
export function markThreadRead(db, threadId, ctx) {
  mustGet(db, 'threads', threadId, 'Thread');
  const me = side(ctx.actor.role);
  let n = 0;
  for (const m of db.messages) {
    if (m.threadId === threadId && !m.readAt && side(m.senderRole) !== me) { m.readAt = ctx.now; n++; }
  }
  return n;
}

export function closeThread(db, threadId, ctx) {
  const t = mustGet(db, 'threads', threadId, 'Thread');
  t.status = 'closed';
  appendAudit(db, ctx, { entity: 'thread', entityId: threadId, action: 'close', summary: 'closed' });
  return t;
}

export function threadMessages(db, threadId) {
  return db.messages.filter(m => m.threadId === threadId).sort((a, b) => (a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : 0));
}

/** Thread summary for lists; unreadCount is from the viewer's side. */
export function threadView(db, t, viewerRole) {
  const msgs = threadMessages(db, t.id);
  const me = side(viewerRole);
  return {
    ...t,
    guardianName: fullName(byId(db.guardians, t.guardianId)),
    studentName: fullName(byId(db.students, t.studentId)),
    programName: byId(db.programs, t.programId)?.name ?? '—',
    lastMessage: msgs.length ? msgs[msgs.length - 1] : null,
    messageCount: msgs.length,
    unreadCount: msgs.filter(m => !m.readAt && side(m.senderRole) !== me).length,
  };
}
