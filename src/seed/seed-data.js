// Demo database. Everything here is fake: surnames come from FAKE_SURNAMES, phones are +91-90000-00NNN,
// emails end in @example.com, the school and locality are fictional.
//
// Money, notices, messages, attendance, diary and the demo bus trip are built by calling the real domain
// functions (not hand-typed rows), so invoice statuses, receipt/invoice numbers, audit rows and trip events
// are derived exactly as they would be in use. Fixed dates anchor the academic year (AY 2026-27); attendance,
// diary and the demo trip are computed from "today" so the demo looks live whenever it is opened.

import { createEmptyDb } from '../store/schema.js';
import { todayISO, addDays, isWeekend, dateRange } from '../domain/dates.js';
import { appendAudit } from '../domain/audit.js';
import { createEvent, isWorkingDay } from '../domain/calendar.js';
import { saveStructure, generateInvoices, recordPayment, cancelPayment, refund, cancelInvoice, mockOnlinePayment, invoiceBalance } from '../domain/fees.js';
import { sendNotice, markNoticeRead, acknowledgeNotice, openThread, replyThread, markThreadRead, closeThread } from '../domain/messaging.js';
import { markAttendance } from '../domain/attendance.js';
import { addDiaryEntry } from '../domain/diary.js';
import { startTrip, recordPosition, markChild, endTrip } from '../domain/transport.js';
import { simulationPlan } from '../domain/sim.js';
import { SCHOOL, fakePhone, fakeEmail } from './names.js';

const AY = 'AY2026-27';
const AY_PREV = 'AY2025-26';
const P = { td: 'prog-toddler', pa: 'prog-primary-a', pb: 'prog-primary-b' };
const ID = { principal: 'stf-principal', accountant: 'stf-accountant', tPA: 'stf-teacher-pa', tTD: 'stf-teacher-toddler', tPB: 'stf-teacher-pb', tFloat: 'stf-teacher-float', d1: 'stf-driver-1', d2: 'stf-driver-2' };
const ADMIN = { role: 'admin', id: ID.principal };
const ACCT = { role: 'accountant', id: ID.accountant };

const pad = (n) => String(n).padStart(2, '0');
const isoAt = (date, hh = 11, mm = 0) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0).toISOString();
};
const ctxAt = (date, actor, hh = 11, mm = 0) => ({ actor, now: isoAt(date, hh, mm), today: date });

// tiny deterministic generator so the seed is stable between builds
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 0x19660d) + 0x3c6ef35f) >>> 0; return s / 0x100000000; };
}

// ---------------------------------------------------------------- people
const STAFF = [
  [ID.principal, 'Kavita', 'Exampleton', 'admin', []],
  [ID.accountant, 'Mohan', 'Samplekar', 'accountant', []],
  [ID.tPA, 'Anita', 'Demoson', 'teacher', [P.pa]],
  [ID.tTD, 'Rekha', 'Mockrishnan', 'teacher', [P.td]],
  [ID.tPB, 'Sameer', 'Testwala', 'teacher', [P.pb]],
  [ID.tFloat, 'Joseph', 'Pretendkar', 'teacher', [P.pa, P.pb]],
  [ID.d1, 'Sunil', 'Samplekar', 'driver', []],
  [ID.d2, 'Imran', 'Fakeswaran', 'driver', []],
];

// kids: [first, dob, programKey, routeNo|null, stopSeq|null, feeCategory]
const FAMILIES = [
  { g: [['Meena', 'Notrealsen', 'Mother']], kids: [['Neel', '2023-04-30', 'pa', 1, 3, 'sibling'], ['Vivaan', '2021-01-22', 'pb', null, null, 'regular']] },
  { g: [['Priyanka', 'Demoson', 'Mother']], kids: [['Aarav', '2024-02-11', 'td', 1, 2, 'sibling'], ['Ira', '2022-06-18', 'pa', null, null, 'regular']] },
  { g: [['Kavya', 'Sampleraj', 'Mother']], kids: [['Anaya', '2024-03-27', 'td', null, null, 'sibling'], ['Dev', '2023-02-14', 'pa', null, null, 'regular']] },
  { g: [['Farhan', 'Testwala', 'Father']], kids: [['Vihaan', '2024-05-14', 'td', null, null, 'sibling'], ['Zoya', '2022-12-20', 'pa', null, null, 'regular']] },
  { g: [['Sunita', 'Exampleton', 'Mother']], kids: [['Arjun', '2022-02-03', 'pa', 2, 2, 'regular']] },
  { g: [['Ananya', 'Mockherjee', 'Mother'], ['Subir', 'Mockherjee', 'Father']], kids: [['Diya', '2024-07-02', 'td', null, null, 'regular']] },
  { g: [['Rekha', 'Placeholdar', 'Mother']], kids: [['Kabir', '2024-08-19', 'td', null, null, 'regular']] },
  { g: [['Nadia', 'Specimenova', 'Mother']], kids: [['Meera', '2024-09-30', 'td', 2, 1, 'regular']] },
  { g: [['Vikram', 'Dummyan', 'Father']], kids: [['Reyansh', '2024-10-09', 'td', 1, 1, 'regular']] },
  { g: [['Lakshmi', 'Fakeswaran', 'Mother']], kids: [['Saanvi', '2024-04-21', 'td', null, null, 'regular']] },
  { g: [['Pooja', 'Samplekar', 'Mother']], kids: [['Navya', '2022-09-15', 'pa', 1, 2, 'regular']] },
  { g: [['Deepak', 'Trialsen', 'Father'], ['Shweta', 'Trialsen', 'Mother']], kids: [['Rohan', '2022-11-26', 'pa', 1, 4, 'regular']] },
  { g: [['Geeta', 'Mockrishnan', 'Mother']], kids: [['Tara', '2023-01-08', 'pa', 1, 5, 'regular']] },
  { g: [['Imtiyaz', 'Fictionwala', 'Father']], kids: [['Aditi', '2020-11-05', 'pb', null, null, 'regular']] },
  { g: [['Nisha', 'Pretendkar', 'Mother']], kids: [['Kiara', '2021-04-17', 'pb', 2, 3, 'regular']] },
  { g: [['Oliver', 'Stubbington', 'Father']], kids: [['Rudra', '2021-07-09', 'pb', 2, 4, 'regular']] },
  { g: [['Hema', 'Fakeswaran', 'Mother']], kids: [['Myra', '2021-09-30', 'pb', null, null, 'regular']] },
  { g: [['Tanmay', 'Mockherjee', 'Father']], kids: [['Yash', '2021-11-14', 'pb', 2, 5, 'regular']] },
  { g: [['Alka', 'Specimenova', 'Mother']], kids: [['Sana', '2020-05-23', 'pb', null, null, 'staffWard']] },
  { g: [['Rohit', 'Placeholdar', 'Father']], kids: [['Anika', '2020-02-29', 'pb', 2, 6, 'regular']] },
];

// ---------------------------------------------------------------- transport (fictional locality, plausible Bengaluru coordinates)
const ROUTE_DEFS = [
  {
    id: 'route-1', name: 'Route 1 - Maple Grove East', busNo: 'KA-00-DEMO-01', driverId: ID.d1, feePaise: 450000,
    stops: [['Banyan Circle', 12.8935, 77.6040], ['Lotus Park Gate', 12.8975, 77.5985], ['Cedar Road Junction', 12.9010, 77.5935], ['Mango Lane Corner', 12.9030, 77.5905], ['Peacock Apartments', 12.9060, 77.5862]],
    pickup: ['07:10', '07:18', '07:26', '07:34', '07:42'], drop: ['15:20', '15:28', '15:36', '15:44', '15:52'],
  },
  {
    id: 'route-2', name: 'Route 2 - Lakeview North', busNo: 'KA-00-DEMO-02', driverId: ID.d2, feePaise: 520000,
    stops: [['Willow Heights', 12.9300, 77.5760], ['Heron Lake Gate', 12.9250, 77.5790], ['Jasmine Court', 12.9200, 77.5815], ['Teak Avenue', 12.9150, 77.5835], ['Orchid Residency', 12.9105, 77.5850], ['Acorn Lane End', 12.9075, 77.5858]],
    pickup: ['07:05', '07:12', '07:19', '07:26', '07:33', '07:40'], drop: ['15:15', '15:22', '15:29', '15:36', '15:43', '15:50'],
  },
];

function buildRoute(def) {
  const stops = def.stops.map(([name, lat, lng], i) => ({ id: `${def.id}-stop-${i + 1}`, name, lat, lng, seq: i + 1, scheduledPickup: def.pickup[i], scheduledDrop: def.drop[i] }));
  // path passes exactly through every stop, with a gentle bend between them
  const path = [];
  stops.forEach((s, i) => {
    path.push({ lat: s.lat, lng: s.lng });
    const n = stops[i + 1];
    if (n) path.push({ lat: +((s.lat + n.lat) / 2 + 0.0004).toFixed(5), lng: +((s.lng + n.lng) / 2 - 0.0004).toFixed(5) });
  });
  return { id: def.id, name: def.name, busNo: def.busNo, driverId: def.driverId, attendantId: null, transportFeePaise: def.feePaise, stops, path };
}

// ---------------------------------------------------------------- fee data
const HEADS = [
  { id: 'fh-tuition', name: 'Tuition fee', kind: 'tuition' },
  { id: 'fh-materials', name: 'Montessori materials fee', kind: 'materials' },
  { id: 'fh-transport', name: 'Transport fee', kind: 'transport' },
  { id: 'fh-admission', name: 'Admission fee', kind: 'admission' },
  { id: 'fh-latefee', name: 'Late fee', kind: 'lateFee' },
];

const tuitionByProgram = { [AY]: { td: 1650000, pa: 1950000, pb: 2100000 }, [AY_PREV]: { td: 1500000, pa: 1800000, pb: 1950000 } };
const materials = { [AY]: 250000, [AY_PREV]: 200000 };
const dueDates = { [AY]: ['2026-06-12', '2026-10-15', '2027-01-15'], [AY_PREV]: ['2025-06-12', '2025-10-15', '2026-01-15'] };

function structureFor(ayId, key) {
  const t = tuitionByProgram[ayId][key];
  const lines = (i) => [{ headId: 'fh-tuition', amountPaise: t }].concat(i === 0 ? [{ headId: 'fh-materials', amountPaise: materials[ayId] }] : []);
  return {
    id: `fst-${ayId}-${key}`, academicYearId: ayId, programId: P[key], siblingDiscountBp: 1000, staffWardDiscountBp: 5000,
    installments: ['Term 1', 'Term 2', 'Term 3'].map((name, i) => ({ name, dueDate: dueDates[ayId][i], lines: lines(i) })),
  };
}

// ---------------------------------------------------------------- build
/** @param {Date} [now] injectable for tests */
export function buildSeed(now = new Date()) {
  const today = todayISO(now);
  const db = createEmptyDb();

  db.school = {
    ...db.school, ...SCHOOL, weeklyOffs: [0, 6], currentAcademicYearId: AY,
    invoicePrefix: 'INV', receiptPrefix: 'RCP', refundPrefix: 'RFD',
    lateFeeRule: { graceDays: 7, mode: 'perDay', amountPaise: 1000, capPaise: 50000, shiftDueToWorkingDay: true },
  };
  db.academicYears = [
    { id: AY_PREV, label: 'AY 2025-26', startDate: '2025-06-01', endDate: '2026-05-31' },
    { id: AY, label: 'AY 2026-27', startDate: '2026-06-01', endDate: '2027-05-31' }, // contiguous with the previous year: no unusable April/May gap
  ];
  db.programs = [
    { id: P.td, name: 'Toddler Community', ageRange: '1.5 to 3 years', teacherIds: [ID.tTD] },
    { id: P.pa, name: 'Primary A', ageRange: '3 to 4.5 years', teacherIds: [ID.tPA, ID.tFloat] },
    { id: P.pb, name: 'Primary B', ageRange: '4.5 to 6 years', teacherIds: [ID.tPB, ID.tFloat] },
  ];
  // staff sign in with the email on their staff record (the real app links a new login to staff by exact email)
  const STAFF_EMAIL = { [ID.principal]: 'principal', [ID.accountant]: 'accountant', [ID.tPA]: 'teacher-pa', [ID.tTD]: 'teacher-toddler', [ID.tPB]: 'teacher-pb', [ID.tFloat]: 'teacher-float', [ID.d1]: 'driver1', [ID.d2]: 'driver2' };
  db.staff = STAFF.map(([id, firstName, lastName, role, programIds], i) => ({ id, firstName, lastName, role, programIds, phone: fakePhone(101 + i), email: `${STAFF_EMAIL[id]}@example.com` }));
  db.routes = ROUTE_DEFS.map(buildRoute);

  // guardians + students (bidirectional links built together)
  let gn = 0, sn = 0;
  const stu = {}; // first name -> student id
  const grd = {}; // first name of first child -> first guardian id
  for (const fam of FAMILIES) {
    const gids = fam.g.map(([first, last, relation]) => {
      gn += 1;
      const g = { id: `grd-${pad(gn)}`, firstName: first, lastName: last, relation, phone: fakePhone(200 + gn), email: fakeEmail(first, last, gn), studentIds: [] };
      db.guardians.push(g);
      return g.id;
    });
    for (const [first, dob, pk, routeNo, seq, feeCategory, status] of fam.kids) {
      sn += 1;
      const lastName = fam.g[0][1];
      const route = routeNo ? db.routes[routeNo - 1] : null;
      const s = {
        id: `stu-${pad(sn)}`, firstName: first, lastName, dob, programId: P[pk], admissionNo: `ADM-26-${String(sn).padStart(3, '0')}`,
        status: status || 'active', guardianIds: [...gids], routeId: route ? route.id : null, stopId: route ? route.stops[seq - 1].id : null,
        feeCategory, healthNotes: null,
      };
      db.students.push(s);
      stu[first] = s.id;
      grd[first] = gids[0];
      for (const gid of gids) db.guardians.find((g) => g.id === gid).studentIds.push(s.id);
    }
  }
  db.students.find((s) => s.id === stu.Kabir).healthNotes = 'Mild dust allergy (demo data)';
  db.students.find((s) => s.id === stu.Anika).healthNotes = 'Uses a spectacle prescription (demo data)';

  db.feeHeads = HEADS.map((h) => ({ ...h }));

  appendAudit(db, { actor: { role: 'system', id: 'seed' }, now: isoAt(today, 6, 0), today }, { entity: 'seed', entityId: 'seed', action: 'build', summary: 'Demo database built from seed data (fake data only)' });

  // ---------------------------------------------------------------- calendar (manual entries; the CSV adds the rest)
  const calCtx = ctxAt('2026-06-01', ADMIN);
  const ev = (type, title, startDate, endDate, programIds = [], description = '') =>
    createEvent(db, { academicYearId: AY, type, title: `${title} (sample)`, startDate, endDate, programIds, description }, calCtx);
  createEvent(db, { academicYearId: AY, type: 'holiday', title: 'Independence Day (sample — verify with school)', startDate: '2026-08-15', endDate: '2026-08-15', programIds: [], description: '' }, calCtx);
  ev('event', "Teachers' Day celebration", '2026-09-05', '2026-09-05');
  ev('holiday', 'Toddler Community: staff training day', '2026-10-13', '2026-10-13', [P.td], 'Toddler programme closed; other programmes run as usual.');
  ev('ptm', 'Parent-teacher meeting - Primary A and B', '2026-10-17', '2026-10-17', [P.pa, P.pb], 'Primary programmes only.');
  ev('workingSaturday', 'Working Saturday', '2026-11-07', '2026-11-07');
  ev('event', "Children's Day celebration", '2026-11-14', '2026-11-14');
  ev('event', 'Annual Day', '2026-12-18', '2026-12-18');
  ev('halfDay', 'Half day before winter break', '2026-12-23', '2026-12-23');

  // ---------------------------------------------------------------- fees
  for (const key of ['td', 'pa', 'pb']) {
    saveStructure(db, structureFor(AY_PREV, key), ctxAt('2025-05-20', ADMIN));
    saveStructure(db, structureFor(AY, key), ctxAt('2026-05-20', ADMIN));
  }

  const invoiceOf = (first, installment) => db.invoices.find((i) => i.studentId === stu[first] && i.academicYearId === AY && i.installmentName === installment && i.status !== 'cancelled');
  const events = [];
  let order = 0;
  const at = (date, fn) => events.push({ date, order: order++, fn });
  const payFull = (first, date, mode, reference, inst = 'Term 1', extraPaise = 0) => at(date, () => {
    const inv = invoiceOf(first, inst);
    recordPayment(db, { studentId: stu[first], amountPaise: invoiceBalance(db, inv) + extraPaise, mode, reference, paidOn: date, guardianId: grd[first] }, ctxAt(date, ACCT));
  });
  const payPart = (first, date, mode, reference, pct, inst = 'Term 1') => at(date, () => {
    const inv = invoiceOf(first, inst);
    const amt = Math.floor((invoiceBalance(db, inv) * pct) / 100 / 10000) * 10000; // whole hundreds of rupees
    recordPayment(db, { studentId: stu[first], amountPaise: amt, mode, reference, paidOn: date, guardianId: grd[first] }, ctxAt(date, ACCT));
  });

  at('2026-06-01', () => { for (const key of ['td', 'pa', 'pb']) generateInvoices(db, { academicYearId: AY, programId: P[key], installmentName: 'Term 1' }, ctxAt('2026-06-01', ADMIN)); });
  payFull('Saanvi', '2026-06-03', 'cash', null);
  payFull('Aarav', '2026-06-04', 'upi', 'UPI-DEMO-1041');
  payFull('Ira', '2026-06-04', 'upi', 'UPI-DEMO-1042');
  payFull('Anaya', '2026-06-05', 'cash', null);
  payFull('Dev', '2026-06-05', 'bank', 'NEFT-DEMO-2210');
  payFull('Neel', '2026-06-06', 'upi', 'UPI-DEMO-1050');
  payFull('Vivaan', '2026-06-06', 'upi', 'UPI-DEMO-1051');
  payFull('Vihaan', '2026-06-08', 'bank', 'NEFT-DEMO-2214');
  payFull('Zoya', '2026-06-08', 'cash', null);
  payFull('Navya', '2026-06-08', 'cash', null);
  payFull('Arjun', '2026-06-09', 'cheque', 'CHQ-DEMO-000417');
  payFull('Kabir', '2026-06-09', 'upi', 'UPI-DEMO-1060');
  payPart('Diya', '2026-06-10', 'cash', null, 50);
  payFull('Tara', '2026-06-10', 'upi', 'UPI-DEMO-1063');
  payFull('Aditi', '2026-06-10', 'cash', null);
  payFull('Kiara', '2026-06-11', 'bank', 'NEFT-DEMO-2219');
  payFull('Reyansh', '2026-06-11', 'cash', null);
  payFull('Myra', '2026-06-11', 'upi', 'UPI-DEMO-1071');
  payFull('Sana', '2026-06-11', 'cash', null);
  at('2026-06-12', () => {
    const cheque = db.payments.find((p) => p.reference === 'CHQ-DEMO-000417');
    cancelPayment(db, cheque.id, 'Cheque dishonoured by the bank', ctxAt('2026-06-12', ACCT, 10, 30));
  });
  payFull('Arjun', '2026-06-12', 'cash', null);
  payFull('Anika', '2026-06-12', 'upi', 'UPI-DEMO-1075');
  payPart('Rohan', '2026-06-12', 'upi', 'UPI-DEMO-1076', 60);
  payPart('Yash', '2026-06-12', 'cash', null, 30);
  at('2026-07-02', () => {
    const inv = invoiceOf('Saanvi', 'Term 1');
    const pay = db.payments.find((p) => p.studentId === stu.Saanvi && p.status === 'valid');
    refund(db, { paymentId: pay.id, invoiceId: inv.id, amountPaise: pay.amountPaise, mode: 'cash', reference: null, date: '2026-07-02', reason: 'Child withdrew before the term began; full fee refunded' }, ctxAt('2026-07-02', ACCT));
    cancelInvoice(db, inv.id, 'Child withdrew; fee refunded in full', ctxAt('2026-07-02', ACCT));
    db.students.find((s) => s.id === stu.Saanvi).status = 'left';
  });
  at('2026-09-14', () => { for (const key of ['td', 'pb']) generateInvoices(db, { academicYearId: AY, programId: P[key], installmentName: 'Term 2' }, ctxAt('2026-09-14', ADMIN)); });
  payFull('Aarav', '2026-09-20', 'cash', null, 'Term 2');
  payPart('Anaya', '2026-09-21', 'upi', 'UPI-DEMO-1103', 50, 'Term 2');
  payFull('Aditi', '2026-09-22', 'upi', 'UPI-DEMO-1104', 'Term 2', 50000); // pays ₹500 extra -> credit on account
  at('2026-09-24', () => {
    const inv = invoiceOf('Kabir', 'Term 2');
    mockOnlinePayment(db, { studentId: stu.Kabir, invoiceIds: [inv.id], guardianId: grd.Kabir }, ctxAt('2026-09-24', { role: 'parent', id: grd.Kabir }, 19, 15));
  });
  payPart('Diya', '2026-09-28', 'cash', null, 40, 'Term 2');
  payFull('Myra', '2026-09-30', 'upi', 'UPI-DEMO-1112', 'Term 2');
  payFull('Sana', '2026-10-01', 'cash', null, 'Term 2');

  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));
  for (const e of events) e.fn();

  // ---------------------------------------------------------------- notices
  const noticeDate = new Map();
  const sendOn = (date, actor, notice) => { const n = sendNotice(db, notice, ctxAt(date, actor, 9, 30)); noticeDate.set(n.id, date); return n; };
  const engage = (notice, { skipRead = [], skipAck = [], salt = 0 }) => {
    const recs = db.noticeReceipts.filter((r) => r.noticeId === notice.id);
    recs.forEach((r, i) => {
      const day = noticeDate.get(notice.id);
      if (skipRead.includes(r.guardianId) || (i + salt) % 5 === 0) return;
      markNoticeRead(db, notice.id, r.guardianId, ctxAt(addDays(day, 1), ADMIN, 8 + (i % 6), 10 + i));
      if (notice.requiresAck && !skipAck.includes(r.guardianId) && (i + salt) % 3 !== 1) acknowledgeNotice(db, notice.id, r.guardianId, ctxAt(addDays(day, 1), ADMIN, 9 + (i % 6), 5 + i));
    });
  };
  const n1 = sendOn('2026-09-10', ADMIN, { title: 'Term 2 begins - fee reminder', body: 'Term 2 invoices are being issued from 14 September and are due on 15 October. You can view invoices and pay from the Fees tab. Sample text for the demo.', audience: { scope: 'school' }, requiresAck: false, important: true });
  const n2 = sendOn('2026-09-18', ADMIN, { title: 'Field trip to the city farm: permission slip', body: 'Primary A and B visit the city farm next month. Please acknowledge to give permission for your child to travel with the class. Sample text for the demo.', audience: { scope: 'program', programIds: [P.pa, P.pb] }, requiresAck: true, important: false });
  const n3 = sendOn('2026-09-22', { role: 'teacher', id: ID.tTD }, { title: 'Please send a spare set of clothes', body: 'Toddlers sometimes need a change of clothes. Please keep a labelled spare set in the bag. Sample text for the demo.', audience: { scope: 'program', programIds: [P.td] }, requiresAck: false, important: false });
  const n4 = sendOn('2026-09-25', ADMIN, { title: 'Seasonal flu advisory', body: 'Please keep your child at home if they have a fever, and let us know. Acknowledge that you have read this advisory. Sample text for the demo.', audience: { scope: 'school' }, requiresAck: true, important: true });
  const route2Kids = db.students.filter((s) => s.routeId === 'route-2' && s.status === 'active').map((s) => s.id);
  const n5 = sendOn('2026-09-28', ADMIN, { title: 'Route 2 morning pickup timings revised', body: 'From Monday the Route 2 morning pickup starts five minutes earlier. See the Bus tab for the new stop times. Sample text for the demo.', audience: { scope: 'students', studentIds: route2Kids }, requiresAck: false, important: false });
  const n6 = sendOn('2026-10-01', ADMIN, { title: 'Parent-teacher meeting - Primary A and B', body: 'The parent-teacher meeting for Primary A and B is on Saturday 17 October. Slots will be shared by the class teacher. Sample text for the demo.', audience: { scope: 'program', programIds: [P.pa, P.pb] }, requiresAck: false, important: false });
  const g1 = grd.Neel; // the "parent with siblings" persona keeps to-dos open: no ack on the field-trip slip or the flu advisory
  engage(n1, { salt: 1 });
  engage(n2, { skipAck: [g1], salt: 0 });
  engage(n3, { salt: 2 });
  engage(n4, { skipAck: [g1], salt: 0 });
  engage(n5, { salt: 3 });
  engage(n6, { skipRead: [g1], salt: 1 });

  // ---------------------------------------------------------------- threads
  const par = (first) => ({ role: 'parent', id: grd[first] });
  const tea = (id) => ({ role: 'teacher', id });
  const t1 = openThread(db, { guardianId: grd.Neel, studentId: stu.Neel, subject: 'Afternoon nap and pickup', body: 'Neel seems tired after lunch. Could he have a short rest before pickup? Sample text for the demo.' }, ctxAt(addDays(today, -3), par('Neel'), 12, 5)).thread;
  markThreadRead(db, t1.id, ctxAt(addDays(today, -3), tea(ID.tPA), 14, 10));
  replyThread(db, t1.id, 'Of course. We will give him a quiet rest corner after lunch and tell you how it goes.', ctxAt(addDays(today, -3), tea(ID.tPA), 14, 20));
  markThreadRead(db, t1.id, ctxAt(addDays(today, -3), par('Neel'), 18, 0));
  replyThread(db, t1.id, 'Thank you. He slept well last night, so let us see how today goes.', ctxAt(addDays(today, -2), par('Neel'), 8, 45));
  const t2 = openThread(db, { guardianId: grd.Ira, studentId: stu.Ira, subject: 'Water bottle missing', body: 'Ira came home without her blue water bottle. Could you check the classroom shelf? Sample text for the demo.' }, ctxAt(addDays(today, -1), par('Ira'), 16, 40)).thread;
  const t3 = openThread(db, { guardianId: grd.Anaya, studentId: stu.Anaya, subject: 'Feeding schedule', body: 'Anaya usually has a snack at 10. Is that fine at school? Sample text for the demo.' }, ctxAt(addDays(today, -5), par('Anaya'), 9, 10)).thread;
  markThreadRead(db, t3.id, ctxAt(addDays(today, -5), tea(ID.tTD), 11, 20));
  replyThread(db, t3.id, 'Yes, snack is at 10:00 and lunch at 12:00. She is eating well.', ctxAt(addDays(today, -5), tea(ID.tTD), 11, 30));
  markThreadRead(db, t3.id, ctxAt(addDays(today, -4), par('Anaya'), 8, 30));
  const t4 = openThread(db, { guardianId: grd.Aditi, studentId: stu.Aditi, subject: 'Early pickup on Friday', body: 'My brother will collect Aditi at 12:30 this Friday. Sample text for the demo.' }, ctxAt(addDays(today, -6), par('Aditi'), 10, 0)).thread;
  markThreadRead(db, t4.id, ctxAt(addDays(today, -6), tea(ID.tPB), 11, 5));
  replyThread(db, t4.id, 'Noted. Please ask him to carry an ID and sign at the gate.', ctxAt(addDays(today, -6), tea(ID.tPB), 11, 15));
  markThreadRead(db, t4.id, ctxAt(addDays(today, -6), par('Aditi'), 12, 0));
  closeThread(db, t4.id, ctxAt(addDays(today, -5), tea(ID.tPB), 9, 0));
  // t2 and the last reply on t1 stay unread by the teacher
  void t2;

  // ---------------------------------------------------------------- attendance (last 14 days) and diary (last 3 school days)
  const programOf = (s) => s.programId;
  const active = db.students.filter((s) => s.status === 'active');
  const days = dateRange(addDays(today, -13), today);
  const rnd = lcg(2026);
  const workingDays = [];
  for (const d of days) {
    if (isWeekend(d, db.school.weeklyOffs) && !isWorkingDay(db, d, P.pa)) continue;
    for (const pid of Object.values(P)) {
      if (!isWorkingDay(db, d, pid)) continue;
      if (d === today && pid === P.pa) continue; // leave today's Primary A register open for the demo
      const entries = active.filter((s) => programOf(s) === pid).map((s) => {
        const r = rnd() * 100;
        return { studentId: s.id, status: r < 84 ? 'present' : r < 90 ? 'late' : r < 97 ? 'absent' : 'leave' };
      });
      const marker = tea(pid === P.td ? ID.tTD : pid === P.pa ? ID.tPA : ID.tPB);
      markAttendance(db, d, entries, d === today ? { actor: marker, now: now.toISOString(), today } : ctxAt(d, marker, 9, 45));
    }
    if (!workingDays.includes(d)) workingDays.push(d);
  }

  const recent = workingDays.filter((d) => d < today || now.getHours() >= 15).slice(-3); // entries are stamped 15:00, so none 'from the future' for today
  const AREAS = ['practicalLife', 'sensorial', 'language', 'math', 'culture'];
  const OBS = {
    practicalLife: ['Poured water between two jugs without spilling.', 'Buttoned and unbuttoned the dressing frame on her own.', 'Wiped the table carefully after snack.'],
    sensorial: ['Matched the pink tower cubes in order, then rebuilt it from memory.', 'Sorted the colour tablets into three shades.', 'Explored the sound cylinders with focus.'],
    language: ['Traced sandpaper letters and said the sounds aloud.', 'Built three-letter words with the moveable alphabet.', 'Listened to a story and retold the middle part.'],
    math: ['Counted the number rods up to ten with one-to-one touch.', 'Worked with the spindle boxes, counting to nine.', 'Matched numerals to quantities with the cards and counters.'],
    culture: ['Placed the continent puzzle pieces with the correct names.', 'Watered the classroom plants and described the leaves.', 'Sorted living and non-living objects.'],
  };
  const ACT = ['Group songs and finger play in the circle.', 'Painting with sponges on large paper.', 'Outdoor play in the garden with sand and water.', 'Story time with picture cards.'];
  const dr = lcg(77);
  recent.forEach((d, di) => {
    active.forEach((s, si) => {
      if (!isWorkingDay(db, d, s.programId)) return; // programme closed that day (e.g. the Toddler-only closure)
      const c = ctxAt(d, tea(s.programId === P.td ? ID.tTD : s.programId === P.pa ? ID.tPA : ID.tPB), 15, 0); // end of day, after the nap
      const present = db.attendance.find((a) => a.date === d && a.studentId === s.id);
      if (present && (present.status === 'absent' || present.status === 'leave')) return; // no diary for absent children
      addDiaryEntry(db, { studentId: s.id, date: d, type: 'meal', data: { meal: 'lunch', ate: dr() < 0.7 ? 'all' : 'some', note: '' } }, c);
      if (s.programId === P.td) addDiaryEntry(db, { studentId: s.id, date: d, type: 'sleep', data: { from: '12:40', to: dr() < 0.5 ? '14:10' : '14:25' } }, c);
      else {
        const area = AREAS[(si + di) % AREAS.length];
        addDiaryEntry(db, { studentId: s.id, date: d, type: 'observation', data: { area, text: OBS[area][(si + di) % 3] } }, c);
      }
      if ((si + di) % 4 === 0) addDiaryEntry(db, { studentId: s.id, date: d, type: 'activity', data: { text: ACT[(si + di) % ACT.length] } }, c);
      if ((si + di) % 11 === 0) addDiaryEntry(db, { studentId: s.id, date: d, type: 'health', data: { temperatureC: Number((36.6 + (si % 3) * 0.1).toFixed(1)), note: 'Routine check, no concerns.' } }, c);
    });
  });

  // ---------------------------------------------------------------- one ended simulated trip (previous school day)
  const prevDay = (() => { let d = addDays(today, -1); for (let i = 0; i < 10 && !isWorkingDay(db, d, P.td); i++) d = addDays(d, -1); return d; })();
  {
    const route = db.routes[0];
    const dctx = (ms) => ({ actor: { role: 'driver', id: ID.d1 }, now: new Date(ms).toISOString(), today: prevDay });
    const [y, m, d] = prevDay.split('-').map(Number);
    let ms = new Date(y, m - 1, d, 7, 5, 0).getTime();
    const trip = startTrip(db, { routeId: route.id, direction: 'pickup', simulated: true }, dctx(ms));
    const plan = simulationPlan(route, { speedKmph: 20, tickMs: 1000 });
    const kidsAt = (stopId) => db.students.filter((s) => s.stopId === stopId && s.status === 'active');
    for (const p of plan) {
      ms += p.dtMs;
      const { newEvents } = recordPosition(db, trip.id, { lat: p.lat, lng: p.lng, accuracy: p.accuracy, ts: new Date(ms).toISOString() });
      for (const e of newEvents) {
        if (e.type !== 'arrived') continue;
        for (const k of kidsAt(e.stopId)) markChild(db, trip.id, { studentId: k.id, stopId: e.stopId, type: k.id === stu.Reyansh ? 'absent' : 'boarded' }, dctx(ms + 20000));
      }
    }
    endTrip(db, trip.id, dctx(ms + 60000));
  }

  return db;
}
