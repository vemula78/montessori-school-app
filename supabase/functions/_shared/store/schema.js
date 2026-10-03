// Entity typedefs, schema version and the empty database shape.
// Conventions: ids are prefixed strings; money is integer paise; dates are 'YYYY-MM-DD';
// timestamps are ISO-8601 UTC strings ('2026-10-02T07:42:00.000Z').

export const SCHEMA_VERSION = 1;

/**
 * @typedef {{graceDays:number, mode:'flat'|'perDay', amountPaise:number, capPaise:number|null, shiftDueToWorkingDay:boolean}} LateFeeRule
 * @typedef {{name:string, address:string, phone:string, weeklyOffs:number[], currentAcademicYearId:string|null,
 *   invoicePrefix:string, receiptPrefix:string, refundPrefix:string, lateFeeRule:LateFeeRule|null}} School
 * @typedef {{id:string, label:string, startDate:string, endDate:string}} AcademicYear
 * @typedef {{id:string, name:string, ageRange:string, teacherIds:string[]}} Program
 * @typedef {{id:string, firstName:string, lastName:string, dob:string, programId:string, admissionNo:string,
 *   status:'active'|'left', guardianIds:string[], routeId:string|null, stopId:string|null,
 *   feeCategory:'regular'|'sibling'|'staffWard', healthNotes:string|null}} Student
 * @typedef {{id:string, firstName:string, lastName:string, relation:string, phone:string, email:string, studentIds:string[]}} Guardian
 * @typedef {{id:string, firstName:string, lastName:string, role:'admin'|'teacher'|'accountant'|'driver', programIds:string[], phone:string}} Staff
 * @typedef {{scope:'school'}|{scope:'program', programIds:string[]}|{scope:'students', studentIds:string[]}} Audience
 * @typedef {{id:string, title:string, body:string, audience:Audience, requiresAck:boolean, important:boolean, createdBy:string, createdAt:string}} Notice
 * @typedef {{noticeId:string, guardianId:string, studentIds:string[], readAt:string|null, ackAt:string|null}} NoticeReceipt
 * @typedef {{id:string, guardianId:string, studentId:string, programId:string, subject:string, status:'open'|'closed', createdAt:string}} Thread
 * @typedef {{id:string, threadId:string, senderRole:string, senderId:string, body:string, sentAt:string, readAt:string|null}} Message
 * @typedef {{id:string, academicYearId:string, type:'holiday'|'event'|'ptm'|'halfDay'|'workingSaturday', title:string,
 *   startDate:string, endDate:string, programIds:string[], description:string, source:'manual'|'import', importBatchId:string|null}} CalendarEvent
 * @typedef {{id:string, name:string, lat:number, lng:number, seq:number, scheduledPickup:string, scheduledDrop:string}} Stop
 * @typedef {{id:string, name:string, busNo:string, driverId:string, attendantId:string|null, transportFeePaise:number,
 *   stops:Stop[], path:{lat:number,lng:number}[]|null}} Route
 *   transportFeePaise is charged once per fee installment for a student on the route.
 * @typedef {{lat:number, lng:number, accuracy:number, ts:string}} Fix
 * @typedef {{stopId:string, type:'nearing'|'arrived'|'departed', ts:string}} StopEvent
 * @typedef {{studentId:string, stopId:string, type:'boarded'|'dropped'|'absent', ts:string, by:string}} ChildEvent
 * @typedef {{id:string, routeId:string, direction:'pickup'|'drop', date:string, driverId:string, simulated:boolean,
 *   status:'active'|'ended', startedAt:string, endedAt:string|null, positions:Fix[], stopEvents:StopEvent[],
 *   childEvents:ChildEvent[], tracker?:Object}} Trip
 *   tracker = per-stop hysteresis state used by event derivation (domain/transport.js).
 * @typedef {{id:string, name:string, kind:'tuition'|'transport'|'materials'|'admission'|'lateFee'}} FeeHead
 * @typedef {{headId:string, amountPaise:number}} StructureLine
 * @typedef {{name:string, dueDate:string, lines:StructureLine[]}} Installment
 * @typedef {{id:string, academicYearId:string, programId:string, siblingDiscountBp:number,
 *   staffWardDiscountBp?:number|null, installments:Installment[]}} FeeStructure
 * @typedef {{id:string, headId:string, description:string, amountPaise:number}} InvoiceLine
 * @typedef {{id:string, type:'sibling'|'staffWard'|'scholarship'|'adhoc', description:string, amountPaise:number, approvedBy:string, createdAt:string}} Concession
 * @typedef {{id:string, number:string, studentId:string, academicYearId:string, installmentName:string, issueDate:string,
 *   dueDate:string, lines:InvoiceLine[], concessions:Concession[], status:'issued'|'partiallyPaid'|'paid'|'cancelled',
 *   cancelReason:string|null, createdAt:string}} Invoice
 * @typedef {{invoiceId:string, amountPaise:number}} Allocation
 * @typedef {{id:string, receiptNumber:string, academicYearId?:string, studentId:string, guardianId:string|null, amountPaise:number,
 *   mode:'cash'|'upi'|'cheque'|'bank'|'online-mock'|'credit', reference:string|null, paidOn:string, allocations:Allocation[],
 *   creditPaise:number, status:'valid'|'cancelled', cancelReason:string|null, recordedBy:string, recordedAt:string}} Payment
 * @typedef {{id:string, voucherNumber:string, paymentId:string, invoiceId:string, amountPaise:number, mode:string,
 *   reference:string|null, date:string, reason:string, recordedBy:string}} Refund
 * @typedef {{id:string, studentId:string, amountPaise:number, sourcePaymentId:string, consumedByPaymentId:string|null}} Credit
 * @typedef {{date:string, studentId:string, status:'present'|'absent'|'late'|'leave', markedBy:string, markedAt:string}} AttendanceRecord
 * @typedef {{id:string, studentId:string, date:string, type:'observation'|'meal'|'sleep'|'health'|'activity', data:Object,
 *   createdBy:string, createdAt:string, parentReadAt:string|null}} DiaryEntry
 * @typedef {{id:string, ts:string, actorRole:string, actorId:string, entity:string, entityId:string, action:string, summary:string}} AuditRow
 * @typedef {{invoice:Object<string,number>, receipt:Object<string,number>, refund:Object<string,number>}} Counters
 * @typedef {{schemaVersion:number, rev:number, school:School, academicYears:AcademicYear[], programs:Program[],
 *   students:Student[], guardians:Guardian[], staff:Staff[], notices:Notice[], noticeReceipts:NoticeReceipt[],
 *   threads:Thread[], messages:Message[], calendarEvents:CalendarEvent[], routes:Route[], trips:Trip[],
 *   feeHeads:FeeHead[], feeStructures:FeeStructure[], invoices:Invoice[], payments:Payment[], refunds:Refund[],
 *   credits:Credit[], attendance:AttendanceRecord[], diaryEntries:DiaryEntry[], auditLog:AuditRow[], counters:Counters}} Db
 * @typedef {{role:'admin'|'teacher'|'accountant'|'driver'|'parent'|'system', id:string}} Actor
 * @typedef {{actor:Actor, now:string, today:string}} Ctx  now = ISO timestamp, today = local 'YYYY-MM-DD'
 */

/** Collections that are arrays of entities (used by validate/storage). */
export const COLLECTIONS = [
  'academicYears', 'programs', 'students', 'guardians', 'staff', 'notices', 'noticeReceipts',
  'threads', 'messages', 'calendarEvents', 'routes', 'trips', 'feeHeads', 'feeStructures',
  'invoices', 'payments', 'refunds', 'credits', 'attendance', 'diaryEntries', 'auditLog',
];

/** @returns {Db} */
export function createEmptyDb() {
  /** @type {any} */
  const db = {
    schemaVersion: SCHEMA_VERSION,
    rev: 0,
    school: {
      name: '',
      address: '',
      phone: '',
      weeklyOffs: [0, 6],
      currentAcademicYearId: null,
      invoicePrefix: 'INV',
      receiptPrefix: 'RCP',
      refundPrefix: 'RFD',
      lateFeeRule: null,
    },
    counters: { invoice: {}, receipt: {}, refund: {} },
  };
  for (const c of COLLECTIONS) db[c] = [];
  return db;
}
