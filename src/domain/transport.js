// Bus trips: positions, hysteresis-based stop events, child events, parent view.
// Thresholds (metres): nearing ≤ 400, arrived ≤ 60, departed > 120 after arrival; each needs two
// consecutive qualifying fixes. Fixes with accuracy > 100 m are stored but never drive events.
// Stops get events only in the order the bus visits them (stopsForDirection): the stop it is at and the next
// EVENT_WINDOW stops after the furthest stop it has reached. A stop it only neared re-arms once it is far away again.

import { fail, newId } from './ids.js';
import { tsToMs, secondsSince, formatTime, diffDays, isHHMM } from './dates.js';
import { mustGet, fullName } from './people.js';
import { appendAudit } from './audit.js';

export const NEAR_M = 400, ARRIVE_M = 60, DEPART_M = 120, MAX_ACCURACY_M = 100;
export const DOWNSAMPLE_MS = 5000, DOWNSAMPLE_M = 10, MAX_FIXES = 1500;
export const STALE_AFTER_S = 45, ETA_WINDOW_S = 60, PRUNE_AFTER_DAYS = 30;
export const EVENT_WINDOW = 2, REARM_M = 800;

const R_EARTH = 6371008.8;
const rad = d => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineMeters(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const stopsInOrder = route => [...route.stops].sort((a, b) => a.seq - b.seq);

/**
 * Stops in the order the bus visits them. Pickup: seq. Drop: by scheduled drop time when every stop has one (a drop
 * run may go round the other way), ties and otherwise by seq.
 */
export function stopsForDirection(route, direction) {
  const bySeq = stopsInOrder(route);
  if (direction !== 'drop' || !bySeq.every(s => isHHMM(s.scheduledDrop))) return bySeq;
  return bySeq.slice().sort((a, b) => (a.scheduledDrop < b.scheduledDrop ? -1 : a.scheduledDrop > b.scheduledDrop ? 1 : a.seq - b.seq));
}

/**
 * Append a fix with downsampling: drop if < 5 s AND < 10 m from the last kept fix.
 * When over the cap, thin the middle (every other point), always keeping first and last.
 * Returns true when the fix was kept.
 */
export function downsamplePush(positions, fix, cap = MAX_FIXES) {
  const last = positions[positions.length - 1];
  if (last && tsToMs(fix.ts) - tsToMs(last.ts) < DOWNSAMPLE_MS && haversineMeters(last, fix) < DOWNSAMPLE_M) return false;
  positions.push(fix);
  if (positions.length > cap) {
    const first = positions[0], lastFix = positions[positions.length - 1];
    const middle = positions.slice(1, -1).filter((_, i) => i % 2 === 1);
    positions.length = 0;
    positions.push(first, ...middle, lastFix);
  }
  return true;
}

/** A rejected fix breaks every "two consecutive fixes" streak. */
export function resetHysteresis(tracker) {
  for (const st of Object.values(tracker)) { st.near = 0; st.at = 0; st.away = 0; st.far = 0; }
}

/**
 * Feed one fix into the per-stop hysteresis state machine (idle → nearing → arrived → departed; nearing → idle when
 * the bus is more than REARM_M away again). Only stops in visiting order are eligible: the one the bus is at (to
 * depart) and the next EVENT_WINDOW after the furthest stop reached, so a road that passes a later stop early never
 * fires it. Arriving at the next stop while still "arrived" at the previous one (stops a few metres apart) departs the
 * previous stop first, and needs the bus nearer the new stop than the old one.
 * Mutates tracker; returns new stop events.
 */
export function deriveStopEvents(route, tracker, fix, direction = 'pickup') {
  if (!(fix.accuracy <= MAX_ACCURACY_M)) { resetHysteresis(tracker); return []; }
  const out = [];
  const order = stopsForDirection(route, direction);
  const dist = new Map();
  for (const stop of order) {
    const st = tracker[stop.id] || (tracker[stop.id] = { phase: 'idle', near: 0, at: 0, away: 0 });
    const d = haversineMeters(stop, fix);
    dist.set(stop.id, d);
    st.near = d <= NEAR_M ? st.near + 1 : 0;
    st.at = d <= ARRIVE_M ? st.at + 1 : 0;
    st.away = d > DEPART_M ? st.away + 1 : 0;
    st.far = d > REARM_M ? (st.far || 0) + 1 : 0;
  }
  let reached = -1;
  order.forEach((s, i) => { if (['arrived', 'departed'].includes(tracker[s.id].phase)) reached = i; });
  const ev = (stop, type) => out.push({ stopId: stop.id, type, ts: fix.ts });
  for (let i = Math.max(reached, 0); i < order.length && i <= reached + EVENT_WINDOW; i++) {
    const stop = order[i], st = tracker[stop.id];
    if (st.phase === 'idle' && st.near >= 2) { st.phase = 'nearing'; ev(stop, 'nearing'); }
    else if (st.phase === 'nearing' && st.far >= 2) st.phase = 'idle';
    if (st.phase === 'nearing' && st.at >= 2) {
      const prev = order.slice(0, i).find(p => tracker[p.id].phase === 'arrived');
      if (!prev || dist.get(stop.id) < dist.get(prev.id)) {
        if (prev) { tracker[prev.id].phase = 'departed'; ev(prev, 'departed'); }
        st.phase = 'arrived'; ev(stop, 'arrived');
      }
    }
    if (st.phase === 'arrived' && st.away >= 2) { st.phase = 'departed'; ev(stop, 'departed'); }
  }
  return out;
}

export function activeTripFor(db, routeId) {
  return db.trips.find(t => t.routeId === routeId && t.status === 'active') || null;
}

export function startTrip(db, { routeId, direction, simulated }, ctx) {
  const route = mustGet(db, 'routes', routeId, 'Route');
  if (!['pickup', 'drop'].includes(direction)) fail('VALIDATION', 'Direction must be pickup or drop');
  if (activeTripFor(db, routeId)) fail('VALIDATION', 'A trip is already running on this route');
  const trip = {
    id: newId('trp'), routeId, direction, date: ctx.today,
    driverId: ctx.actor.role === 'driver' ? ctx.actor.id : route.driverId,
    simulated: !!simulated, status: 'active', startedAt: ctx.now, endedAt: null,
    positions: [], stopEvents: [], childEvents: [], tracker: {},
  };
  db.trips.push(trip);
  pruneOldTrips(db, ctx.today);
  appendAudit(db, ctx, { entity: 'trip', entityId: trip.id, action: 'start', summary: `${routeId} ${direction}${trip.simulated ? ' (simulated)' : ''}` });
  return trip;
}

/**
 * opts.busChecked: the driver confirmed that no child is left on board (recorded on the trip). A drop trip needs it,
 * and every child on the route marked dropped or absent first. opts.auto: the system ending a forgotten trip — never
 * refused; the audit row says how many children were left unmarked.
 */
export function endTrip(db, tripId, ctx, { busChecked = false, auto = false } = {}) {
  const trip = mustGet(db, 'trips', tripId, 'Trip');
  if (trip.status !== 'active') fail('VALIDATION', 'Trip has already ended');
  const unmarked = unmarkedChildren(db, trip);
  if (!auto && trip.direction === 'drop') {
    if (unmarked.length) fail('VALIDATION', `Mark every child before ending the trip: ${unmarked.map(c => c.name).join(', ')} ${unmarked.length === 1 ? 'is' : 'are'} not marked dropped or absent.`);
    if (busChecked !== true) fail('VALIDATION', 'Check the bus first: walk to the back and confirm that no child is left on board.');
  }
  if (busChecked === true) { trip.busCheckedAt = ctx.now; trip.busCheckedBy = ctx.actor.id; }
  trip.status = 'ended';
  trip.endedAt = ctx.now;
  const check = `${trip.busCheckedAt ? '; bus checked: no child on board' : ''}${unmarked.length ? `; ${unmarked.length} ${unmarked.length === 1 ? 'child' : 'children'} not marked` : ''}`;
  appendAudit(db, ctx, { entity: 'trip', entityId: trip.id, action: 'end', summary: `${trip.positions.length} fixes kept, ${trip.stopEvents.length} stop events${check}` });
  return trip;
}

/** Child events still standing: a 'corrected' event (undo) cancels the latest standing event of that child. */
export function effectiveChildEvents(trip) {
  const out = [];
  for (const e of trip.childEvents || []) {
    if (e.type !== 'corrected') { out.push(e); continue; }
    for (let i = out.length - 1; i >= 0; i--) if (out[i].studentId === e.studentId) { out.splice(i, 1); break; }
  }
  return out;
}

export function lastChildEvent(trip, studentId) {
  const mine = effectiveChildEvents(trip).filter(e => e.studentId === studentId);
  return mine.length ? mine[mine.length - 1] : null;
}

/** Riders not yet accounted for: on a drop trip every child must end dropped or absent; on a pickup trip boarded or absent. */
export function unmarkedChildren(db, trip) {
  const done = trip.direction === 'drop' ? ['dropped', 'absent'] : ['boarded', 'absent'];
  return routeRoster(db, trip.routeId).filter(r => !done.includes(lastChildEvent(trip, r.studentId)?.type));
}

/**
 * What the driver's screen needs for this trip: the riders not yet marked, the next stop (visiting order) that still
 * has one, and whether the route is finished (last stop left and every child marked).
 */
export function tripChecklist(db, trip) {
  const route = mustGet(db, 'routes', trip.routeId, 'Route');
  const order = stopsForDirection(route, trip.direction);
  const unmarked = unmarkedChildren(db, trip);
  const last = order[order.length - 1];
  const lastLeft = last ? (trip.stopEvents || []).find(e => e.stopId === last.id && e.type === 'departed') || null : null;
  return {
    order: order.map(s => s.id),
    unmarked: unmarked.map(c => ({ studentId: c.studentId, name: c.name, stopId: c.stopId })),
    last: Object.fromEntries(routeRoster(db, trip.routeId).map(r => [r.studentId, lastChildEvent(trip, r.studentId)])),
    nextStopId: order.find(s => unmarked.some(c => c.stopId === s.id))?.id ?? null,
    lastStopLeftAt: lastLeft ? lastLeft.ts : null,
    finished: !!lastLeft && !unmarked.length,
  };
}

export const AUTO_END_AFTER_LAST_STOP_MS = { drop: 30 * 60000, pickup: 60 * 60000 };
export const AUTO_END_STALE_MS = 20 * 60000;

/**
 * Why the system may end this active trip now, or null. Only a finished route qualifies (last stop left, every child
 * marked): a drop 30 minutes after the last stop or with no position for 20 minutes; a pickup 60 minutes after its
 * last stop (the bus still drives the children to school, which is not a stop). Anything else waits for the driver,
 * or for the 3-hour limit.
 */
export function autoEndReason(db, trip, nowIso) {
  if (trip.status !== 'active') return null;
  const c = tripChecklist(db, trip);
  if (!c.finished) return null;
  const now = tsToMs(nowIso);
  if (now - tsToMs(c.lastStopLeftAt) >= AUTO_END_AFTER_LAST_STOP_MS[trip.direction === 'drop' ? 'drop' : 'pickup']) return 'route finished: last stop left and every child marked';
  const lastFix = trip.lastFixTs || (trip.positions.length ? trip.positions[trip.positions.length - 1].ts : null) || trip.startedAt;
  if (trip.direction === 'drop' && now - tsToMs(lastFix) >= AUTO_END_STALE_MS) return 'route finished and no position for 20 minutes';
  return null;
}

/** A fix may be at most this far ahead of the server clock (phone clocks drift a little; hours mean a wrong clock). */
export const MAX_FUTURE_MS = 2 * 60000;

/**
 * ctx (optional): {now} — the server's time; a fix stamped more than MAX_FUTURE_MS after it is refused.
 * A refused fix (future, duplicate, out of order, before the start) changes nothing: a network retry of a fix that
 * was already recorded is a no-op and does not disturb the consecutive-fix counters.
 */
export function recordPosition(db, tripId, { lat, lng, accuracy, ts }, ctx = null) {
  const trip = mustGet(db, 'trips', tripId, 'Trip');
  if (trip.status !== 'active') fail('VALIDATION', 'Trip has ended');
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) fail('VALIDATION', 'Invalid coordinates');
  if (!Number.isFinite(accuracy) || accuracy < 0) fail('VALIDATION', 'Invalid accuracy');
  const ms = tsToMs(ts);
  if (ms === null) fail('VALIDATION', 'Invalid timestamp');
  const route = mustGet(db, 'routes', trip.routeId, 'Route');
  if (!trip.tracker) trip.tracker = {};
  // Future, duplicate (cached/retried), out-of-order and pre-start fixes are refused before event derivation.
  const reject = reason => ({ trip, newEvents: [], rejected: reason });
  const nowMs = ctx && ctx.now ? tsToMs(ctx.now) : null;
  if (nowMs !== null && ms > nowMs + MAX_FUTURE_MS) return reject('in the future by the server clock (check the phone clock)');
  if (ms < tsToMs(trip.startedAt)) return reject('before the trip started');
  const lastTs = trip.lastFixTs || (trip.positions.length ? trip.positions[trip.positions.length - 1].ts : null);
  if (lastTs && ms <= tsToMs(lastTs)) return reject('not newer than the last fix');
  const fix = { lat, lng, accuracy, ts: new Date(ms).toISOString() };
  trip.lastFixTs = fix.ts;
  const newEvents = deriveStopEvents(route, trip.tracker, fix, trip.direction);
  trip.stopEvents.push(...newEvents);
  downsamplePush(trip.positions, fix);
  return { trip, newEvents };
}

/** type 'corrected' undoes the child's latest standing mark (a wrong tap); the parent is told it was a mistake. */
export function markChild(db, tripId, { studentId, stopId, type }, ctx) {
  const trip = mustGet(db, 'trips', tripId, 'Trip');
  if (trip.status !== 'active') fail('VALIDATION', 'Trip has ended');
  if (!['boarded', 'dropped', 'absent', 'corrected'].includes(type)) fail('VALIDATION', `Unknown child event: ${type}`);
  const s = mustGet(db, 'students', studentId, 'Student');
  if (s.routeId !== trip.routeId) fail('VALIDATION', 'Child is not on this route');
  if (type === 'corrected') {
    const last = lastChildEvent(trip, studentId);
    if (!last) fail('VALIDATION', 'There is no mark to undo for this child');
    const ev = { studentId, stopId: last.stopId, type, corrects: last.type, correctsTs: last.ts, ts: ctx.now, by: ctx.actor.id };
    trip.childEvents.push(ev);
    return ev;
  }
  const route = mustGet(db, 'routes', trip.routeId, 'Route');
  const stop = stopId || s.stopId;
  if (!route.stops.some(x => x.id === stop)) fail('VALIDATION', 'Stop is not on this route');
  const ev = { studentId, stopId: stop, type, ts: ctx.now, by: ctx.actor.id };
  trip.childEvents.push(ev);
  return ev;
}

/** Trips older than 30 days keep their events but drop positions (storage growth). */
export function pruneOldTrips(db, today) {
  for (const t of db.trips) {
    if (diffDays(t.date, today) > PRUNE_AFTER_DAYS && t.status === 'ended' && t.positions.length) {
      t.positions = [];
      t.positionsPruned = true;
    }
  }
}

/**
 * ETA in whole minutes to `target`, or null (never fabricated) when there are fewer than two
 * qualifying fixes in the last 60 s or the bus is effectively stationary. Straight-line distance.
 */
export function etaMinutes(positions, target, nowIso) {
  const nowMs = tsToMs(nowIso);
  const recent = positions.filter(p => p.accuracy <= MAX_ACCURACY_M && nowMs - tsToMs(p.ts) <= ETA_WINDOW_S * 1000 && nowMs >= tsToMs(p.ts));
  if (recent.length < 2) return null;
  // Net displacement between the mean positions of the older and newer halves of the window,
  // not summed segments: stationary GPS jitter must not look like motion.
  const half = Math.floor(recent.length / 2);
  const mean = pts => ({
    lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length,
    lng: pts.reduce((a, p) => a + p.lng, 0) / pts.length,
    ms: pts.reduce((a, p) => a + tsToMs(p.ts), 0) / pts.length,
  });
  const older = mean(recent.slice(0, half)), newer = mean(recent.slice(recent.length - half));
  const dist = haversineMeters(older, newer);
  const secs = (newer.ms - older.ms) / 1000;
  if (secs <= 0) return null;
  const speed = dist / secs;
  if (speed < 0.5) return null;
  return Math.ceil(haversineMeters(recent[recent.length - 1], target) / speed / 60);
}

const STOP_TEXT = { nearing: 'Bus is nearing', arrived: 'Bus arrived at', departed: 'Bus left' };
const CHILD_TEXT = { boarded: 'boarded at', dropped: 'dropped at', absent: 'marked absent at' };
const CHILD_FACT = { boarded: 'boarded', dropped: 'dropped', absent: 'marked absent' };

/** Everything a parent screen needs for one child; only that child's stop and events. */
export function parentView(db, studentId, nowIso, today) {
  const s = mustGet(db, 'students', studentId, 'Student');
  if (!s.routeId) return { route: null, stop: null, trip: null, lastFix: null, fixAgeSeconds: null, stale: false, etaMinutes: null, events: [] };
  const route = mustGet(db, 'routes', s.routeId, 'Route');
  const stop = route.stops.find(x => x.id === s.stopId) || null;
  const todays = db.trips.filter(t => t.routeId === route.id && t.date === today).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  const trip = activeTripFor(db, route.id) || todays[0] || null;
  if (!trip) return { route, stop, trip: null, lastFix: null, fixAgeSeconds: null, stale: false, etaMinutes: null, events: [] };
  const lastFix = trip.positions.length ? trip.positions[trip.positions.length - 1] : null;
  const fixAgeSeconds = lastFix ? secondsSince(lastFix.ts, nowIso) : null;
  const exactAge = lastFix ? (tsToMs(nowIso) - tsToMs(lastFix.ts)) / 1000 : null;
  const active = trip.status === 'active';
  const stale = active && (exactAge === null || exactAge > STALE_AFTER_S);
  const done = trip.stopEvents.some(e => e.stopId === s.stopId && (e.type === 'arrived' || e.type === 'departed'));
  const eta = active && !stale && stop && !done ? etaMinutes(trip.positions, stop, nowIso) : null;
  const events = [{ ts: trip.startedAt, text: `Bus started (${trip.direction})${trip.simulated ? ' — simulated trip' : ''}`, kind: 'trip' }];
  for (const e of trip.stopEvents) if (e.stopId === s.stopId) events.push({ ts: e.ts, text: `${STOP_TEXT[e.type]} ${stop ? stop.name : 'your stop'}`, kind: 'stop' });
  const standing = new Set(effectiveChildEvents(trip));
  for (const e of trip.childEvents) {
    if (e.studentId !== studentId) continue;
    const st = route.stops.find(x => x.id === e.stopId);
    if (e.type === 'corrected') events.push({ ts: e.ts, text: `Correction: "${s.firstName} ${CHILD_FACT[e.corrects] || 'marked'}" at ${formatTime(e.correctsTs)} was a mistake and has been withdrawn by the driver`, kind: 'correction' });
    else if (standing.has(e)) events.push({ ts: e.ts, text: `${s.firstName} ${CHILD_TEXT[e.type]} ${st ? st.name : 'stop'} ${formatTime(e.ts)}`, kind: 'child' });
  }
  if (trip.endedAt) events.push({ ts: trip.endedAt, text: 'Trip ended', kind: 'trip' });
  events.sort((a, b) => tsToMs(a.ts) - tsToMs(b.ts));
  const tripOut = { ...trip, positions: trip.positions.slice(-50), childEvents: trip.childEvents.filter(e => e.studentId === studentId),
    stopEvents: trip.stopEvents.filter(e => e.stopId === s.stopId) };
  delete tripOut.tracker;
  return { route, stop, trip: tripOut, lastFix, fixAgeSeconds, stale, etaMinutes: eta, events };
}

/** Students riding a route (for the driver's boarding list). */
export function routeRoster(db, routeId) {
  const route = mustGet(db, 'routes', routeId, 'Route');
  return db.students.filter(s => s.status === 'active' && s.routeId === routeId)
    .map(s => ({ studentId: s.id, name: fullName(s), stopId: s.stopId, stopSeq: route.stops.find(x => x.id === s.stopId)?.seq ?? null }))
    .sort((a, b) => (a.stopSeq ?? 0) - (b.stopSeq ?? 0) || a.name.localeCompare(b.name));
}

