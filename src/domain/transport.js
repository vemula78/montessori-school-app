// Bus trips: positions, hysteresis-based stop events, child events, parent view.
// Thresholds (metres): nearing ≤ 400, arrived ≤ 60, departed > 120 after arrival; each needs two
// consecutive qualifying fixes. Fixes with accuracy > 100 m are stored but never drive events.

import { fail, newId } from './ids.js';
import { tsToMs, secondsSince, formatTime, diffDays } from './dates.js';
import { mustGet, fullName } from './people.js';
import { appendAudit } from './audit.js';

export const NEAR_M = 400, ARRIVE_M = 60, DEPART_M = 120, MAX_ACCURACY_M = 100;
export const DOWNSAMPLE_MS = 5000, DOWNSAMPLE_M = 10, MAX_FIXES = 1500;
export const STALE_AFTER_S = 45, ETA_WINDOW_S = 60, PRUNE_AFTER_DAYS = 30;

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
  for (const st of Object.values(tracker)) { st.near = 0; st.at = 0; st.away = 0; }
}

/**
 * Feed one fix into the per-stop hysteresis state machine (idle → nearing → arrived → departed).
 * Mutates tracker; returns new stop events.
 */
export function deriveStopEvents(route, tracker, fix) {
  if (!(fix.accuracy <= MAX_ACCURACY_M)) { resetHysteresis(tracker); return []; }
  const out = [];
  for (const stop of stopsInOrder(route)) {
    const st = tracker[stop.id] || (tracker[stop.id] = { phase: 'idle', near: 0, at: 0, away: 0 });
    const d = haversineMeters(stop, fix);
    st.near = d <= NEAR_M ? st.near + 1 : 0;
    st.at = d <= ARRIVE_M ? st.at + 1 : 0;
    st.away = d > DEPART_M ? st.away + 1 : 0;
    if (st.phase === 'idle' && st.near >= 2) { st.phase = 'nearing'; out.push({ stopId: stop.id, type: 'nearing', ts: fix.ts }); }
    if (st.phase === 'nearing' && st.at >= 2) { st.phase = 'arrived'; out.push({ stopId: stop.id, type: 'arrived', ts: fix.ts }); }
    if (st.phase === 'arrived' && st.away >= 2) { st.phase = 'departed'; out.push({ stopId: stop.id, type: 'departed', ts: fix.ts }); }
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

export function endTrip(db, tripId, ctx) {
  const trip = mustGet(db, 'trips', tripId, 'Trip');
  if (trip.status !== 'active') fail('VALIDATION', 'Trip has already ended');
  trip.status = 'ended';
  trip.endedAt = ctx.now;
  appendAudit(db, ctx, { entity: 'trip', entityId: trip.id, action: 'end', summary: `${trip.positions.length} fixes kept, ${trip.stopEvents.length} stop events` });
  return trip;
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
  const newEvents = deriveStopEvents(route, trip.tracker, fix);
  trip.stopEvents.push(...newEvents);
  downsamplePush(trip.positions, fix);
  return { trip, newEvents };
}

export function markChild(db, tripId, { studentId, stopId, type }, ctx) {
  const trip = mustGet(db, 'trips', tripId, 'Trip');
  if (trip.status !== 'active') fail('VALIDATION', 'Trip has ended');
  if (!['boarded', 'dropped', 'absent'].includes(type)) fail('VALIDATION', `Unknown child event: ${type}`);
  const s = mustGet(db, 'students', studentId, 'Student');
  if (s.routeId !== trip.routeId) fail('VALIDATION', 'Child is not on this route');
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
  for (const e of trip.childEvents) {
    if (e.studentId !== studentId) continue;
    const st = route.stops.find(x => x.id === e.stopId);
    events.push({ ts: e.ts, text: `${s.firstName} ${CHILD_TEXT[e.type]} ${st ? st.name : 'stop'} ${formatTime(e.ts)}`, kind: 'child' });
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

