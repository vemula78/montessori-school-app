// Leaflet wrapper (vendored Leaflet 1.9.4, global L). OSM raster tiles are the only network requests.
// Tiles failing (offline) leaves a grey map; route, stops and bus marker still draw.
import { esc } from './components.js';

const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const hasLeaflet = () => typeof window !== 'undefined' && !!window.L;

const sortedStops = (route) => [...route.stops].sort((a, b) => a.seq - b.seq);
const routePoints = (route) => (route.path && route.path.length ? route.path : sortedStops(route)).map((p) => [p.lat, p.lng]);

// route: Route. opts: {myStopId, height}. Returns {setBus(lat,lng), setBuses([{id,lat,lng,label}]), refit(), destroy()}.
export function createRouteMap(el, route, opts = {}) {
  const noop = { setBus() {}, setBuses() {}, refit() {}, destroy() {} };
  if (!hasLeaflet()) {
    el.innerHTML = '<div class="map-msg">The map library could not be loaded. The route and stops are listed below instead.</div>';
    return noop;
  }
  const L = window.L;
  el.innerHTML = '';
  const map = L.map(el, { scrollWheelZoom: false, zoomControl: true });
  L.tileLayer(OSM, { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  const pts = routePoints(route);
  let bounds = null;
  if (pts.length) {
    const line = L.polyline(pts, { color: '#4F7CAC', weight: 5, opacity: 0.85 }).addTo(map);
    bounds = line.getBounds();
  }
  for (const s of sortedStops(route)) {
    const mine = opts.myStopId && s.id === opts.myStopId;
    L.marker([s.lat, s.lng], {
      icon: L.divIcon({ className: '', html: `<div class="stop-pin${mine ? ' mine' : ''}">${esc(s.seq)}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
      title: s.name,
    }).addTo(map).bindTooltip(`${esc(s.seq)}. ${esc(s.name)}${mine ? ' (your stop)' : ''}`);
  }
  if (bounds && bounds.isValid()) map.fitBounds(bounds, { padding: [28, 28] });
  else map.setView([12.96, 77.64], 13);

  const busIcon = (label) => L.divIcon({ className: '', html: `<div class="bus-pin">${esc(label || 'BUS')}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
  const buses = new Map();
  const place = (id, lat, lng, label) => {
    if (typeof lat !== 'number' || typeof lng !== 'number') return;
    let m = buses.get(id);
    if (!m) { m = L.marker([lat, lng], { icon: busIcon(label), zIndexOffset: 1000 }).addTo(map); buses.set(id, m); }
    else m.setLatLng([lat, lng]);
    if (!map.getBounds().contains([lat, lng])) map.fitBounds(L.latLngBounds([...pts, [lat, lng]]), { padding: [28, 28] });
  };
  setTimeout(() => map.invalidateSize(), 0);
  return {
    setBus: (lat, lng, label) => place('one', lat, lng, label),
    setBuses: (list) => { for (const b of list) place(b.id, b.lat, b.lng, b.label); },
    refit: () => { map.invalidateSize(); if (bounds && bounds.isValid()) map.fitBounds(bounds, { padding: [28, 28] }); },
    destroy: () => { try { map.remove(); } catch { /* already gone */ } },
  };
}

const FLEET_COLORS = ['#4F7CAC', '#B3472F', '#5F8A74', '#9B2C4B'];
// All routes on one map. Returns {setBuses([{id,lat,lng,label}]), destroy()}.
export function createFleetMap(el, routes) {
  if (!hasLeaflet()) {
    el.innerHTML = '<div class="map-msg">The map library could not be loaded.</div>';
    return { setBuses() {}, destroy() {} };
  }
  const L = window.L;
  el.innerHTML = '';
  const map = L.map(el, { scrollWheelZoom: false });
  L.tileLayer(OSM, { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  const all = [];
  routes.forEach((r, i) => {
    const pts = routePoints(r);
    all.push(...pts);
    if (pts.length) L.polyline(pts, { color: FLEET_COLORS[i % FLEET_COLORS.length], weight: 5, opacity: 0.85 }).addTo(map).bindTooltip(esc(r.name));
    for (const s of sortedStops(r)) {
      L.marker([s.lat, s.lng], { icon: L.divIcon({ className: '', html: `<div class="stop-pin">${esc(s.seq)}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }) })
        .addTo(map).bindTooltip(`${esc(r.name)}: ${esc(s.name)}`);
    }
  });
  if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [28, 28] }); else map.setView([12.96, 77.64], 13);
  const buses = new Map();
  setTimeout(() => map.invalidateSize(), 0);
  return {
    setBuses: (list) => {
      const live = new Set(list.map((b) => b.id));
      for (const [id, m] of buses) if (!live.has(id)) { m.remove(); buses.delete(id); } // trip ended: marker goes
      for (const b of list) {
        const m = buses.get(b.id);
        if (m) m.setLatLng([b.lat, b.lng]);
        else buses.set(b.id, L.marker([b.lat, b.lng], { icon: L.divIcon({ className: '', html: `<div class="bus-pin">${esc(b.label || 'BUS')}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] }), zIndexOffset: 1000 }).addTo(map));
      }
    },
    destroy: () => { try { map.remove(); } catch { /* already gone */ } },
  };
}
