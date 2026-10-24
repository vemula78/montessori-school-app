// Which push notifications a committed command produces (pure; node-testable). Delivery is push.ts.
// Recipients are guardians; every message names the children it concerns (studentIds), and delivery requires live
// consent for EACH purpose (push, plus bus_live for bus events) for one of those children, at the current notice
// version — a sibling's or an old-version consent does not count — plus an active app link and a stored
// subscription on a known push service. Payload text carries a child's first name at most.

import { formatPaise } from './domain/money.js';
import { byId } from './domain/people.js';
import { stopsForDirection, effectiveChildEvents } from './domain/transport.js';

const STOP_TEXT = { nearing: 'Bus is nearing', arrived: 'Bus has arrived at' };
const NEED_TEXT = { spareClothes: 'spare clothes', nappies: 'nappies', wipes: 'wipes', other: 'something else (see the diary)' };
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
  // stop events: nearing/arrived to the families at that stop; leaving a stop tells the next stop (visiting order) it is
  // next, unless the bus is already nearing it. A child marked absent on this trip is left out. A batch of backlog
  // fixes (recordPositions) can hold several events for one stop: only the latest is news.
  if ((name === 'transport.recordPosition' || name === 'transport.recordPositions') && result && result.newEvents && result.newEvents.length) {
    const trip = byId(after.trips, result.trip.id);
    const route = trip && byId(after.routes, trip.routeId);
    const absent = new Set(trip ? effectiveChildEvents(trip).filter(e => e.type === 'absent').map(e => e.studentId) : []);
    const ridersAt = stopId => after.students.filter(s => s.status === 'active' && s.routeId === route.id && s.stopId === stopId && !absent.has(s.id)).map(s => s.id);
    const send = (kids, body, tag) => { if (kids.length) out.push({ guardianIds: guardiansOf(after, kids), studentIds: kids, purposes: ['push', 'bus_live'], payload: { title: 'School bus', body, url: '#/bus', tag } }); };
    const latest = new Map(result.newEvents.map(ev => [ev.stopId, ev]));
    const order = route ? stopsForDirection(route, trip.direction) : [];
    for (const ev of result.newEvents) {
      if (!route || trip.simulated || latest.get(ev.stopId) !== ev) continue; // a simulated trip (demo, training) never alerts real parents
      const stop = route.stops.find(s => s.id === ev.stopId);
      if (STOP_TEXT[ev.type]) send(ridersAt(ev.stopId), `${STOP_TEXT[ev.type]} ${stop ? stop.name : 'your stop'}`, `trip-${trip.id}-${ev.stopId}-${ev.type}`);
      const next = ev.type === 'departed' ? order[order.findIndex(s => s.id === ev.stopId) + 1] : null;
      if (next && !(trip.stopEvents || []).some(e => e.stopId === next.id)) {
        const at = trip.direction === 'drop' ? next.scheduledDrop : next.scheduledPickup;
        send(ridersAt(next.id), `Bus left ${stop ? stop.name : 'the previous stop'}. ${next.name} is next${at ? ` (scheduled ${at})` : ''}`, `trip-${trip.id}-${next.id}-next`);
      }
    }
  }
  if (name === 'transport.markChild' && result && result.studentId) {
    const s = byId(after.students, result.studentId);
    const trip = after.trips.find(t => (t.childEvents || []).some(e => e.ts === result.ts && e.studentId === result.studentId)) || null;
    const route = trip ? byId(after.routes, trip.routeId) : (s && byId(after.routes, s.routeId));
    const stop = route && route.stops.find(x => x.id === result.stopId);
    if (s && CHILD_TEXT[result.type]) {
      // a drop names who took the child: a parent, the relation of someone on the family's list, or "someone else"
      const r = result.receivedBy;
      const contact = r && r.kind === 'contact' ? (after.pickupContacts || []).find(c => c.id === r.contactId) : null;
      const handed = !r ? '' : r.kind === 'guardian' ? ', handed to a parent' : contact ? `, handed to ${contact.relation.toLowerCase()} (on your list)` : r.kind === 'other' ? ', handed to someone not on your list' : '';
      out.push({ guardianIds: guardiansOf(after, [s.id]), studentIds: [s.id], purposes: ['push', 'bus_live'],
        payload: { title: 'School bus', body: `${s.firstName} ${CHILD_TEXT[result.type]} ${stop ? stop.name : 'the stop'}${handed}`, url: '#/bus', tag: `child-${s.id}-${result.type}-${result.ts}` } });
    }
    // an undone mark (a wrong tap): same tag as the wrong message, so the phone replaces it
    if (s && result.type === 'corrected' && CHILD_TEXT[result.corrects]) {
      out.push({ guardianIds: guardiansOf(after, [s.id]), studentIds: [s.id], purposes: ['push', 'bus_live'],
        payload: { title: 'School bus', body: `Correction: ${s.firstName} ${CHILD_TEXT[result.corrects]} ${stop ? stop.name : 'the stop'} was a mistake. Please ignore that message.`, url: '#/bus', tag: `child-${s.id}-${result.corrects}-${result.correctsTs}` } });
    }
  }
  const pay = name === 'fees.recordGatewayPayment' ? (result && result.created ? result.payment : null)
    : name === 'fees.confirmClaim' ? (result && result.payment) || null
    : ['fees.recordPayment', 'fees.mockOnlinePayment'].includes(name) ? result : null;
  if (pay && pay.receiptNumber) {
    const s = byId(after.students, pay.studentId);
    out.push({ guardianIds: guardiansOf(after, [pay.studentId]), studentIds: [pay.studentId], purposes: ['push'],
      payload: { title: 'Payment received', body: `${formatPaise(pay.amountPaise)}${s ? ` for ${s.firstName}` : ''} — receipt ${pay.receiptNumber}`, url: '#/fees', tag: `pay-${pay.id}` } });
  }
  // learning: a shared observation / a published termly report — the child's guardians only (push consent per child)
  if ((name === 'observations.share' && result && result.sharedAt && !byId(before.observations || [], result.id)?.sharedAt)
    || (name === 'reports.publish' && result && result.status === 'published')) {
    const s = byId(after.students, result.studentId);
    const report = name === 'reports.publish';
    out.push({ guardianIds: guardiansOf(after, [result.studentId]), studentIds: [result.studentId], purposes: ['push'],
      payload: { title: report ? 'Termly report' : 'New from the classroom', body: report ? `${s ? `${s.firstName}'s ` : ''}${result.termName} report is ready` : `A note about ${s ? s.firstName : 'your child'}'s work was shared`,
        url: '#/learning', tag: report ? `report-${result.id}-${result.revision}` : `obs-${result.id}` } });
  }
  // a message from the school (a reply, or a conversation staff started): the thread's guardian only; never the text
  const sent = name === 'threads.reply' ? result : name === 'threads.open' ? result && result.messages && result.messages[0] : null;
  if (sent && sent.threadId && sent.senderRole && sent.senderRole !== 'parent') {
    const t = byId(after.threads || [], sent.threadId);
    const s = t && byId(after.students, t.studentId);
    if (t && t.guardianId) {
      out.push({ guardianIds: [t.guardianId], studentIds: [t.studentId], purposes: ['push'],
        payload: { title: 'Message from school', body: `New message about ${s ? s.firstName : 'your child'}`, url: `#/messages/${t.id}`, tag: `msg-${sent.id}` } });
    }
  }
  // a "please send" diary entry (#83): the child's guardians, never the note
  const needs = name === 'diary.add' ? (result && result.type === 'needs' ? [result] : []) : name === 'diary.addMany' ? ((result && result.entries) || []).filter(e => e.type === 'needs') : [];
  for (const e of needs) {
    const s = byId(after.students, e.studentId);
    const items = (e.data.items || []).map(i => NEED_TEXT[i] || i).join(', ');
    out.push({ guardianIds: guardiansOf(after, [e.studentId]), studentIds: [e.studentId], purposes: ['push'],
      payload: { title: 'Please send to school', body: `${items}${s ? ` for ${s.firstName}` : ''}`, url: '#/diary', tag: `needs-${e.id}` } });
  }
  if ((name === 'notices.send' || name === 'transport.runningLate') && result && result.important) {
    const rs = after.noticeReceipts.filter(r => r.noticeId === result.id);
    out.push({ guardianIds: [...new Set(rs.map(r => r.guardianId))], studentIds: [...new Set(rs.flatMap(r => r.studentIds || []))], purposes: ['push'], payload: { title: 'Important notice', body: result.title, url: `#/notices/${result.id}`, tag: `notice-${result.id}` } });
  }
  return out.filter(m => m.guardianIds.length);
}
