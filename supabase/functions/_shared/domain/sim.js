// Simulated trip plan (pure). The UI drives timing; each point is fed to recordPosition.
// Visits stops in seq order, dwells at each, ends at the last stop. Deterministic: no jitter.

import { haversineMeters, stopsInOrder } from './transport.js';

export const DWELL_TICKS = 3;
export const SIM_ACCURACY_M = 8;
const PATH_SNAP_M = 30;

/** Index of the first path vertex within 30 m of stop at or after `from`, or -1. */
function snapIndex(path, stop, from) {
  for (let i = from; i < path.length; i++) if (haversineMeters(path[i], stop) <= PATH_SNAP_M) return i;
  return -1;
}

/** route.path is trusted only if it starts at the first stop, ends at the last and passes every stop in seq order. */
export function pathFollowsStops(path, stops) {
  if (!path || path.length < 2 || !stops.length) return false;
  if (haversineMeters(path[0], stops[0]) > PATH_SNAP_M || haversineMeters(path[path.length - 1], stops[stops.length - 1]) > PATH_SNAP_M) return false;
  let at = 0;
  for (const s of stops) {
    const i = snapIndex(path, s, at);
    if (i < 0) return false;
    at = i;
  }
  return true;
}

/** Use route.path only if it follows the stops in order; otherwise straight lines between stops. */
function waypoints(route) {
  const stops = stopsInOrder(route);
  const path = route.path;
  if (pathFollowsStops(path, stops)) {
    return path.map(p => ({ lat: p.lat, lng: p.lng, stop: stops.some(s => haversineMeters(p, s) <= PATH_SNAP_M) }));
  }
  return stops.map(s => ({ lat: s.lat, lng: s.lng, stop: true }));
}

/** @returns {{lat:number, lng:number, accuracy:number, dtMs:number}[]} */
export function simulationPlan(route, { speedKmph = 20, tickMs = 1000 } = {}) {
  if (!route || !route.stops || route.stops.length === 0) return [];
  if (!(speedKmph > 0) || !(tickMs > 0)) throw new RangeError('speedKmph and tickMs must be positive');
  const step = (speedKmph * 1000 / 3600) * (tickMs / 1000);
  const wps = waypoints(route);
  const out = [];
  const push = (lat, lng) => out.push({ lat, lng, accuracy: SIM_ACCURACY_M, dtMs: out.length ? tickMs : 0 });
  const dwell = wp => { for (let i = 0; i < DWELL_TICKS; i++) push(wp.lat, wp.lng); };
  push(wps[0].lat, wps[0].lng);
  if (wps[0].stop) dwell(wps[0]);
  for (let i = 1; i < wps.length; i++) {
    const a = wps[i - 1], b = wps[i];
    const n = Math.max(1, Math.ceil(haversineMeters(a, b) / step));
    for (let k = 1; k <= n; k++) push(a.lat + ((b.lat - a.lat) * k) / n, a.lng + ((b.lng - a.lng) * k) / n);
    if (b.stop) dwell(b);
  }
  return out;
}
