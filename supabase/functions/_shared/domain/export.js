// DPDP access request: everything the app holds about one guardian and their children, as plain data.
// Bus positions are the bus's, not the family's, and are not included; other families never appear.

import { fail } from './ids.js';
import { byId, childrenOf } from './people.js';
import { invoiceAmounts } from './fees.js';

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
  };
}
