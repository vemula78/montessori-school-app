// Which push notifications a committed command produces (pure; node-testable). Delivery is push.ts.
// Recipients are guardians; every message names the children it concerns (studentIds), and delivery requires live
// consent for EACH purpose (push, plus bus_live for bus events) for one of those children, at the current notice
// version — a sibling's or an old-version consent does not count — plus an active app link and a stored
// subscription on a known push service. Payload text carries a child's first name at most.

import { formatPaise } from './domain/money.js';
import { byId } from './domain/people.js';

const STOP_TEXT = { nearing: 'Bus is nearing', arrived: 'Bus has arrived at' };
const CHILD_TEXT = { boarded: 'boarded the bus at', dropped: 'was dropped at', absent: 'was marked absent at' };

const guardiansOf = (db, studentIds) => [...new Set(studentIds.flatMap(id => byId(db.students, id)?.guardianIds || []))];

/**
 * May guardian g be sent a message about studentIds for these purposes? rows: live consents {guardian_id, student_id,
 * purpose, version} (withdrawn ones already excluded).
 */
export function consentAllows(rows, guardianId, studentIds, purposes, version) {
  return studentIds.some(sid => purposes.every(p => rows.some(c => c.guardian_id === guardianId && c.student_id === sid && c.purpose === p && c.version === version)));
}

// Web Push services browsers use. Delivery goes only to https endpoints on these hosts (no internal addresses).
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];

/** extraOrigins: exact origins allowed in addition (the local mock endpoint in tests; never set in production). */
export function pushEndpointAllowed(url, extraOrigins = []) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.username || u.password) return false;
  if (extraOrigins.includes(u.origin)) return true;
  if (u.protocol !== 'https:' || (u.port && u.port !== '443')) return false;
  return PUSH_HOSTS.some(re => re.test(u.hostname));
}

/** @returns {{guardianIds:string[], studentIds:string[], purposes:string[], payload:{title:string, body:string, url:string, tag:string}}[]} */
export function pushMessages(name, before, after, result) {
  const out = [];
  if (name === 'transport.recordPosition' && result && result.newEvents && result.newEvents.length) {
    const trip = byId(after.trips, result.trip.id);
    const route = trip && byId(after.routes, trip.routeId);
    for (const ev of result.newEvents) {
      if (!STOP_TEXT[ev.type] || !route) continue;
      const stop = route.stops.find(s => s.id === ev.stopId);
      const kids = after.students.filter(s => s.status === 'active' && s.routeId === route.id && s.stopId === ev.stopId).map(s => s.id);
      if (!kids.length) continue;
      out.push({ guardianIds: guardiansOf(after, kids), studentIds: kids, purposes: ['push', 'bus_live'],
        payload: { title: 'School bus', body: `${STOP_TEXT[ev.type]} ${stop ? stop.name : 'your stop'}`, url: '#/parent/bus', tag: `trip-${trip.id}-${ev.stopId}-${ev.type}` } });
    }
  }
  if (name === 'transport.markChild' && result && result.studentId) {
    const s = byId(after.students, result.studentId);
    const trip = after.trips.find(t => (t.childEvents || []).some(e => e.ts === result.ts && e.studentId === result.studentId)) || null;
    const route = trip ? byId(after.routes, trip.routeId) : (s && byId(after.routes, s.routeId));
    const stop = route && route.stops.find(x => x.id === result.stopId);
    if (s && CHILD_TEXT[result.type]) {
      out.push({ guardianIds: guardiansOf(after, [s.id]), studentIds: [s.id], purposes: ['push', 'bus_live'],
        payload: { title: 'School bus', body: `${s.firstName} ${CHILD_TEXT[result.type]} ${stop ? stop.name : 'the stop'}`, url: '#/parent/bus', tag: `child-${s.id}-${result.type}-${result.ts}` } });
    }
  }
  const pay = name === 'fees.recordGatewayPayment' ? (result && result.created ? result.payment : null)
    : ['fees.recordPayment', 'fees.mockOnlinePayment'].includes(name) ? result : null;
  if (pay && pay.receiptNumber) {
    const s = byId(after.students, pay.studentId);
    out.push({ guardianIds: guardiansOf(after, [pay.studentId]), studentIds: [pay.studentId], purposes: ['push'],
      payload: { title: 'Payment received', body: `${formatPaise(pay.amountPaise)}${s ? ` for ${s.firstName}` : ''} — receipt ${pay.receiptNumber}`, url: '#/parent/fees', tag: `pay-${pay.id}` } });
  }
  if (name === 'notices.send' && result && result.important) {
    const rs = after.noticeReceipts.filter(r => r.noticeId === result.id);
    out.push({ guardianIds: [...new Set(rs.map(r => r.guardianId))], studentIds: [...new Set(rs.flatMap(r => r.studentIds || []))], purposes: ['push'], payload: { title: 'Important notice', body: result.title, url: '#/parent/notices', tag: `notice-${result.id}` } });
  }
  return out.filter(m => m.guardianIds.length);
}
