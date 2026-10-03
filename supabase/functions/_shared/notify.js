// Which push notifications a committed command produces (pure; node-testable). Delivery is push.ts.
// Recipients are guardians; delivery later filters by live consent (push, plus bus_live for bus events),
// an active app link and a stored subscription. Payload text carries a child's first name at most.

import { formatPaise } from './domain/money.js';
import { byId } from './domain/people.js';

const STOP_TEXT = { nearing: 'Bus is nearing', arrived: 'Bus has arrived at' };
const CHILD_TEXT = { boarded: 'boarded the bus at', dropped: 'was dropped at', absent: 'was marked absent at' };

const guardiansOf = (db, studentIds) => [...new Set(studentIds.flatMap(id => byId(db.students, id)?.guardianIds || []))];

/** @returns {{guardianIds:string[], purposes:string[], payload:{title:string, body:string, url:string, tag:string}}[]} */
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
      out.push({ guardianIds: guardiansOf(after, kids), purposes: ['push', 'bus_live'],
        payload: { title: 'School bus', body: `${STOP_TEXT[ev.type]} ${stop ? stop.name : 'your stop'}`, url: '#/parent/bus', tag: `trip-${trip.id}-${ev.stopId}-${ev.type}` } });
    }
  }
  if (name === 'transport.markChild' && result && result.studentId) {
    const s = byId(after.students, result.studentId);
    const trip = after.trips.find(t => (t.childEvents || []).some(e => e.ts === result.ts && e.studentId === result.studentId)) || null;
    const route = trip ? byId(after.routes, trip.routeId) : (s && byId(after.routes, s.routeId));
    const stop = route && route.stops.find(x => x.id === result.stopId);
    if (s && CHILD_TEXT[result.type]) {
      out.push({ guardianIds: guardiansOf(after, [s.id]), purposes: ['push', 'bus_live'],
        payload: { title: 'School bus', body: `${s.firstName} ${CHILD_TEXT[result.type]} ${stop ? stop.name : 'the stop'}`, url: '#/parent/bus', tag: `child-${s.id}-${result.type}-${result.ts}` } });
    }
  }
  const pay = name === 'fees.recordGatewayPayment' ? (result && result.created ? result.payment : null)
    : ['fees.recordPayment', 'fees.mockOnlinePayment'].includes(name) ? result : null;
  if (pay && pay.receiptNumber) {
    const s = byId(after.students, pay.studentId);
    out.push({ guardianIds: guardiansOf(after, [pay.studentId]), purposes: ['push'],
      payload: { title: 'Payment received', body: `${formatPaise(pay.amountPaise)}${s ? ` for ${s.firstName}` : ''} — receipt ${pay.receiptNumber}`, url: '#/parent/fees', tag: `pay-${pay.id}` } });
  }
  if (name === 'notices.send' && result && result.important) {
    const ids = after.noticeReceipts.filter(r => r.noticeId === result.id).map(r => r.guardianId);
    out.push({ guardianIds: [...new Set(ids)], purposes: ['push'], payload: { title: 'Important notice', body: result.title, url: '#/parent/notices', tag: `notice-${result.id}` } });
  }
  return out.filter(m => m.guardianIds.length);
}
