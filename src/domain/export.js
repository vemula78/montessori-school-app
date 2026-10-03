// DPDP access request: everything the app holds about one guardian and their children, as plain data.
// Bus positions are the bus's, not the family's, and are not included (the children's own boarding/drop-off events
// are); other families never appear. Server-only collections (sign-in links, invites, erasure requests, reminders,
// push devices, payment orders, raw import rows) are present in the real app and empty in the demo.

import { fail } from './ids.js';
import { byId, childrenOf } from './people.js';
import { invoiceAmounts } from './fees.js';
import { normalisePhone } from './import-people.js';

export function guardianExport(db, guardianId) {
  const g = byId(db.guardians, guardianId);
  if (!g) fail('NOT_FOUND', 'Guardian not found');
  const kids = childrenOf(db, guardianId);
  const ids = new Set(kids.map(k => k.id));
  const mine = x => ids.has(x.studentId);
  const threads = db.threads.filter(t => t.guardianId === guardianId);
  const threadIds = new Set(threads.map(t => t.id));
  const receipts = db.noticeReceipts.filter(r => r.guardianId === guardianId);
  const noticeIds = new Set(receipts.map(r => r.noticeId));
  return {
    exportedFor: guardianId,
    note: 'Personal data held by the school app for this guardian and their children. Fee records are retained as the law requires.',
    guardian: { id: g.id, firstName: g.firstName, lastName: g.lastName, relation: g.relation, phone: g.phone, email: g.email },
    children: kids.map(k => ({ id: k.id, firstName: k.firstName, lastName: k.lastName, dob: k.dob, admissionNo: k.admissionNo, programId: k.programId, status: k.status, routeId: k.routeId, stopId: k.stopId, healthNotes: k.healthNotes ?? null })),
    invoices: db.invoices.filter(mine).map(i => ({ ...i, ...invoiceAmounts(db, i) })),
    payments: db.payments.filter(mine),
    refunds: db.refunds.filter(r => ids.has(byId(db.payments, r.paymentId)?.studentId)),
    credits: db.credits.filter(mine),
    notices: db.notices.filter(n => noticeIds.has(n.id)).map(n => ({ id: n.id, title: n.title, body: n.body, createdAt: n.createdAt, receipt: receipts.find(r => r.noticeId === n.id) })),
    threads: threads.map(t => ({ ...t, messages: db.messages.filter(m => m.threadId === t.id) })),
    attendance: db.attendance.filter(mine),
    diary: db.diaryEntries.filter(mine),
    consents: (db.consents || []).filter(c => c.guardianId === guardianId),
    messagesCounted: db.messages.filter(m => threadIds.has(m.threadId)).length,
    transportEvents: (db.trips || []).flatMap(t => (t.childEvents || []).filter(e => ids.has(e.studentId))
      .map(e => ({ tripId: t.id, date: t.date, routeId: t.routeId, direction: t.direction, studentId: e.studentId, stopId: e.stopId, type: e.type, ts: e.ts }))),
    account: (db.appUsers || []).filter(u => u.guardianId === guardianId).map(u => ({ userId: u.id, role: u.role, status: u.status, linkedAt: u.linkedAt ?? null })),
    invites: (db.invites || []).filter(i => i.guardianId === guardianId)
      .map(i => ({ id: i.id, createdAt: i.createdAt ?? null, expiresAt: i.expiresAt, redeemedAt: i.redeemedAt, revokedAt: i.revokedAt, failedAttempts: i.failedAttempts || 0 })),
    erasureRequests: (db.erasureRequests || []).filter(r => r.guardianId === guardianId),
    reminders: (db.remindersSent || []).filter(r => ids.has(byId(db.invoices, r.invoiceId)?.studentId)),
    // the endpoint itself is a capability URL for the device: only the push service and the date are exported
    pushDevices: (db.pushSubscriptions || []).filter(x => (db.appUsers || []).some(u => u.id === x.userId && u.guardianId === guardianId))
      .map(x => ({ service: hostOf(x.endpoint), createdAt: x.createdAt })),
    paymentOrders: (db.gatewayOrders || []).filter(o => o.guardianId === guardianId || ids.has(o.studentId)),
    // stored payment-gateway events of this guardian's own payments (as kept; erasure scrubs payer details)
    gatewayEvents: gatewayEventsFor(db, guardianId),
    importRecords: importRecordsFor(db, kids.map(k => k.admissionNo), g),
  };
}

function gatewayEventsFor(db, guardianId) {
  const orders = new Set((db.gatewayOrders || []).filter(o => o.guardianId === guardianId).map(o => o.id));
  const pays = new Set((db.payments || []).filter(p => p.gatewayOrderId && orders.has(p.gatewayOrderId)).map(p => p.gatewayPaymentId));
  return (db.gatewayEvents || []).filter(e => {
    const p = e.payload?.payload || {};
    const ent = p.payment?.entity || p.refund?.entity || {};
    return orders.has(ent.order_id) || pays.has(ent.payment_id) || pays.has(ent.id);
  }).map(e => ({ eventId: e.eventId, event: e.event, receivedAt: e.receivedAt, payload: e.payload }));
}

const hostOf = url => { try { return new URL(url).host; } catch { return null; } };

/**
 * Raw import rows (as read from the file) about these children: children rows and fee rows by admission number.
 * Another guardian's columns on the same row (the co-parent) are another person's data and are blanked.
 */
function importRecordsFor(db, admissionNos, g) {
  const out = [];
  const phone = normalisePhone(g.phone), email = String(g.email || '').toLowerCase();
  for (const r of db.importRows || []) {
    const b = byId(db.importBatches || [], r.batchId);
    const m = (b && b.mapping) || {};
    if (!m.admissionNo || !admissionNos.includes(String(r.values?.[m.admissionNo] ?? '').trim())) continue;
    const values = { ...r.values };
    for (const n of [1, 2]) {
      const v = f => String(values[m[`guardian${n}${f}`]] ?? '').trim();
      const mine = (phone && normalisePhone(v('Phone')) === phone) || (email && v('Email').toLowerCase() === email)
        || (!v('Phone') && !v('Email') && v('Name').toLowerCase() === `${g.firstName} ${g.lastName}`.trim().toLowerCase());
      if (!mine) for (const f of ['Name', 'Relation', 'Phone', 'Email']) if (m[`guardian${n}${f}`] in values) values[m[`guardian${n}${f}`]] = '';
    }
    out.push({ batchId: r.batchId, kind: b.kind, line: r.line, values });
  }
  return out;
}
