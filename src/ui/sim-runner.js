// Trip drivers at app scope (survive route changes inside the tab): simulated plan runner and real GPS watcher.
// Both feed api.transport.recordPosition.
import { api } from '../api/index.js';
import { notifyQuota } from './components.js';

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
};
const listeners = new Set();
const emit = () => listeners.forEach((f) => { try { f(snapshot()); } catch { /* listener failure must not stop the runner */ } });

export const snapshot = () => ({ ...state, gps: { ...state.gps }, timer: undefined });
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

// Returns true only if the fix was recorded. On any failure the run is stopped and the error surfaced -
// the runner never advances past a fix that was not stored, and never records as a different persona.
async function feed(pos) {
  try {
    if (api.session.current()?.id !== state.personaId) {
      const err = new Error('The persona changed since this trip was started, so the trip is no longer being recorded. Switch back to the driver and resume.');
      err.code = 'NOT_ALLOWED';
      throw err;
    }
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
  state.tripId = null; state.routeId = null; state.step = 0; state.total = 0;
  state.gps = { status: 'idle', message: '', lastFixTs: null, accuracy: null, fixes: 0 };
  emit();
}
