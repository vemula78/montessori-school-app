// Trip drivers at app scope (survive route changes inside the tab): simulated plan runner and real GPS watcher.
// Both feed api.transport.recordPosition.
import { api } from '../api/index.js';
import { notifyQuota } from './components.js';
import { isRealMode } from './mode.js';

// Real app only: GPS fixes are sent over the network, so they are thinned before sending and queued (in order)
// while the phone is offline. The demo records straight into browser storage and is unchanged.
const REAL = isRealMode();
const SEND_EVERY_MS = 3000, SEND_EVERY_M = 5, HEARTBEAT_MS = 20000, QUEUE_CAP = 500, RETRY_MS = 5000;
const queue = [];
let retryTimer = null;
let lastSent = null; // {lat,lng,at}
const metres = (a, b) => {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const isNetworkError = (e) => e?.code === 'NETWORK' || e?.code === 'OFFLINE' || e?.code === 'UNAVAILABLE' || e?.name === 'TypeError' || /failed to fetch|networkerror|load failed|network request failed/i.test(e?.message || '');

const state = {
  mode: 'idle', // 'idle' | 'sim' | 'gps'
  tripId: null,
  personaId: null, // the driver persona that started this run; fixes are only recorded as that persona
  routeId: null,
  step: 0,
  total: 0,
  timer: null,
  watchId: null,
  wakeLock: null,
  gps: { status: 'idle', message: '', lastFixTs: null, accuracy: null, fixes: 0 }, // idle|waiting|ok|denied|unavailable|timeout|insecure|unsupported
  lastError: null,
  // real app only: online = last send worked and the browser says it is online; queued = fixes waiting to be sent
  online: typeof navigator === 'undefined' ? true : navigator.onLine !== false, queued: 0, dropped: 0, sent: 0,
};
const listeners = new Set();
const emit = () => listeners.forEach((f) => { try { f(snapshot()); } catch { /* listener failure must not stop the runner */ } });

export const snapshot = () => ({ ...state, gps: { ...state.gps }, timer: undefined, queued: queue.length });
export function onState(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export const isRunning = () => state.mode !== 'idle';
export const runningTripId = () => state.tripId;

// ---- environment checks ----
export function geoSupport() {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
    return { ok: false, code: 'unsupported', message: 'This browser has no geolocation support. Use "Start simulated trip".' };
  }
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return {
      ok: false, code: 'insecure',
      message: 'Real GPS needs a secure context (https:// or http://localhost). This page is served over plain http from a network address, so the browser blocks location. Use "Start simulated trip", or open the app on localhost / GitHub Pages.',
    };
  }
  return { ok: true };
}

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; emit(); });
    }
  } catch { state.wakeLock = null; }
}
function releaseWakeLock() {
  try { state.wakeLock?.release(); } catch { /* ignore */ }
  state.wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.mode !== 'idle' && !state.wakeLock) acquireWakeLock().then(emit);
});

// ---- real app: thin, queue and flush ------------------------------------------------
function scheduleRetry() {
  if (retryTimer || !queue.length) return;
  retryTimer = setTimeout(() => { retryTimer = null; flush(); }, RETRY_MS);
}

/** Send queued fixes oldest-first. Stops at the first network failure (fix stays queued); any other failure ends the run. */
let inFlight = null;
/** One flush at a time; a caller that arrives meanwhile waits for the running one (so "queue empty" really means sent). */
function flush() {
  if (!inFlight) inFlight = doFlush().finally(() => { inFlight = null; });
  return inFlight;
}
async function doFlush() {
  if (!queue.length) return;
  try {
    while (queue.length) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) { state.online = false; break; }
      const fix = queue[0];
      try {
        const r = await api.transport.recordPosition(state.tripId, fix);
        queue.shift();
        if (r && r.rejected) state.lastError = `A position was refused by the server (${r.rejected}) and skipped.`; else state.lastError = null;
        state.sent += 1; state.online = true;
      } catch (e) {
        if (isNetworkError(e)) { state.online = false; break; }
        notifyQuota(e);
        queue.length = 0;
        stop(`${e?.code ? e.code + ': ' : ''}${e?.message || String(e)}`);
        break;
      }
    }
  } finally { emit(); scheduleRetry(); }
}
if (typeof window !== 'undefined' && REAL) {
  window.addEventListener('online', () => { state.online = true; emit(); flush(); });
  window.addEventListener('offline', () => { state.online = false; emit(); });
}

async function feedReal(pos) {
  if (state.mode === 'gps' && lastSent) {
    const dt = Date.parse(pos.ts) - lastSent.at;
    const moved = metres(lastSent, pos);
    // too soon, or too close to the last sent fix - unless it has been quiet for a while (so parents see the bus is alive)
    if (dt < HEARTBEAT_MS && (dt < SEND_EVERY_MS || moved < SEND_EVERY_M)) return true;
  }
  lastSent = { lat: pos.lat, lng: pos.lng, at: Date.parse(pos.ts) || Date.now() };
  queue.push(pos);
  if (queue.length > QUEUE_CAP) { queue.shift(); state.dropped += 1; } // oldest goes first; the newest positions matter most
  await flush();
  return state.mode !== 'idle'; // false only when the flush ended the run (fatal error)
}

/** Best-effort: send what is queued (used before ending a trip). */
export async function flushNow() { await flush(); return queue.length; }

// Returns true only if the fix was recorded (or, in the real app, safely queued). On any other failure the run is
// stopped and the error surfaced - the runner never advances past a fix that was not stored, and never records as a different persona.
async function feed(pos) {
  try {
    if (api.session.current()?.id !== state.personaId) {
      const err = new Error('The persona changed since this trip was started, so the trip is no longer being recorded. Switch back to the driver and resume.');
      err.code = 'NOT_ALLOWED';
      throw err;
    }
    if (REAL) return await feedReal(pos);
    await api.transport.recordPosition(state.tripId, pos);
    state.lastError = null;
    return true;
  } catch (e) {
    notifyQuota(e);
    stop(`${e?.code ? e.code + ': ' : ''}${e?.message || String(e)}`);
    return false;
  }
}

// ---- simulated trip ----
// plan = api.transport.simulationPlan(routeId, {...}) -> [{lat,lng,accuracy,dtMs}]
export async function startSimulated(tripId, routeId, plan, { speedUp = 1 } = {}) {
  stop();
  state.personaId = api.session.current()?.id ?? null;
  state.mode = 'sim'; state.tripId = tripId; state.routeId = routeId; state.step = 0; state.total = plan.length; state.lastError = null;
  const tick = async () => {
    if (state.mode !== 'sim') return;
    const p = plan[state.step];
    if (!p) { state.mode = 'idle'; emit(); return; }
    if (!(await feed({ lat: p.lat, lng: p.lng, accuracy: p.accuracy, ts: new Date().toISOString() }))) return; // failed: do not advance
    state.step += 1;
    if (state.step >= plan.length) { state.mode = 'idle'; state.timer = null; emit(); return; }
    state.timer = setTimeout(tick, Math.max(50, (plan[state.step].dtMs ?? 1000) / speedUp));
  };
  emit();
  tick();
}

// ---- real GPS ----
export function startGps(tripId, routeId) {
  stop();
  const sup = geoSupport();
  state.personaId = api.session.current()?.id ?? null;
  state.tripId = tripId; state.routeId = routeId; state.lastError = null;
  if (!sup.ok) {
    state.mode = 'idle';
    state.gps = { status: sup.code, message: sup.message, lastFixTs: null, accuracy: null, fixes: 0 };
    emit();
    return false;
  }
  state.mode = 'gps';
  state.gps = { status: 'waiting', message: 'Waiting for the first GPS fix. Allow location access if the browser asks.', lastFixTs: null, accuracy: null, fixes: 0 };
  acquireWakeLock().then(emit);
  state.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      state.gps = { status: 'ok', message: '', lastFixTs: new Date().toISOString(), accuracy: pos.coords.accuracy, fixes: state.gps.fixes + 1 };
      feed({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, ts: new Date(pos.timestamp).toISOString() });
    },
    (err) => {
      // Surface every failure as a visible state; the marker never silently freezes.
      const map = {
        1: ['denied', 'Location permission was denied. Enable location for this site in the browser settings, then start again.'],
        2: ['unavailable', 'The device could not determine its position (POSITION_UNAVAILABLE). Check that location services are on, or move to open sky.'],
        3: ['timeout', 'No GPS fix within 15 seconds. Still trying - check signal, or use "Start simulated trip".'],
      };
      const [status, message] = map[err.code] || ['unavailable', err.message || 'Unknown location error'];
      state.gps = { ...state.gps, status, message };
      if (err.code === 1) { navigator.geolocation.clearWatch(state.watchId); state.watchId = null; state.mode = 'idle'; releaseWakeLock(); }
      emit();
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
  );
  emit();
  return true;
}

export function stop(reason) {
  if (reason) state.lastError = reason;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  if (state.watchId != null) { try { navigator.geolocation.clearWatch(state.watchId); } catch { /* ignore */ } }
  state.watchId = null;
  releaseWakeLock();
  const was = state.mode;
  state.mode = 'idle';
  if (was !== 'idle') emit();
}

export function resetAfterTripEnd() {
  stop();
  queue.length = 0; lastSent = null; state.dropped = 0; state.sent = 0;
  state.tripId = null; state.routeId = null; state.step = 0; state.total = 0;
  state.gps = { status: 'idle', message: '', lastFixTs: null, accuracy: null, fixes: 0 };
  emit();
}
