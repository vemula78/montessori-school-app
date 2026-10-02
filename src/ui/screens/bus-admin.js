// Admin fleet view: routes, active trips, trip history.
import { esc, badge, empty, pageHead, fdate, ftime, fullName, indexBy, ago, DASH } from '../components.js';
import { secondsSince } from '../../domain/dates.js';
import { createFleetMap } from '../map.js';

export async function render(ctx) {
  const { api, db } = ctx;
  const routes = await api.transport.routes();
  if (!routes.length) { ctx.el.innerHTML = `${pageHead('Bus fleet')}${empty('No routes set up')}`; return; }
  const staff = indexBy(db.staff);
  ctx.el.innerHTML = `${pageHead('Bus fleet', 'Routes, live position and trip history')}
    <div class="map tall" id="f-map"></div>
    <div id="f-routes" class="grid cols-2" style="margin-top:14px"></div>
    <h2 style="margin-top:18px">Trip history</h2><div id="f-trips"></div>`;
  const mapApi = createFleetMap(ctx.el.querySelector('#f-map'), routes);
  ctx.cleanup(() => mapApi.destroy());

  async function paint() {
    const buses = [];
    const cards = [];
    for (const r of routes) {
      const t = await api.transport.activeTrip(r.id);
      const last = t?.positions?.[t.positions.length - 1];
      if (last) buses.push({ id: r.id, lat: last.lat, lng: last.lng, label: r.busNo.slice(-2) });
      const kids = db.students.filter((s) => s.routeId === r.id && s.status === 'active').length;
      const age = last ? secondsSince(last.ts, new Date().toISOString()) : null;
      cards.push(`<div class="card stack"><div class="row between"><h3 style="margin:0">${esc(r.name)}</h3>${t ? badge(t.simulated ? 'Active (simulated)' : 'Active', 'ok') : badge('Idle', 'mute')}</div>
        <small>Bus ${esc(r.busNo)} &middot; driver ${esc(fullName(staff.get(r.driverId)))} &middot; ${r.stops.length} stops &middot; ${kids} children</small>
        ${t ? `<div>${t.direction === 'pickup' ? 'Morning pickup' : 'Afternoon drop'} since ${ftime(t.startedAt)} &middot; last position ${age == null ? DASH : ago(age)}</div>` : ''}
        <ol style="margin:0;padding-left:20px;font-size:.88rem">${[...r.stops].sort((a, b) => a.seq - b.seq).map((s) => `<li>${esc(s.name)} <small>${esc(s.scheduledPickup)} / ${esc(s.scheduledDrop)}</small></li>`).join('')}</ol></div>`);
    }
    ctx.el.querySelector('#f-routes').innerHTML = cards.join('');
    mapApi.setBuses(buses);
    const trips = (await api.transport.trips({})).slice().sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, 25);
    const rmap = indexBy(routes);
    ctx.el.querySelector('#f-trips').innerHTML = trips.length ? `<div class="tablewrap"><table><thead><tr><th>Date</th><th>Route</th><th>Direction</th><th>Started</th><th>Ended</th><th class="r">Positions</th><th class="r">Stop events</th><th>Kind</th></tr></thead><tbody>
      ${trips.map((t) => `<tr><td>${fdate(t.date)}</td><td>${esc(rmap.get(t.routeId)?.name || t.routeId)}</td><td>${t.direction === 'pickup' ? 'Pickup' : 'Drop'}</td><td>${ftime(t.startedAt)}</td><td>${t.endedAt ? ftime(t.endedAt) : badge('Active', 'ok')}</td><td class="r num">${(t.positions || []).length}</td><td class="r num">${(t.stopEvents || []).length}</td><td>${t.simulated ? badge('Simulated', 'sim') : badge('Real GPS', 'info')}</td></tr>`).join('')}
      </tbody></table></div>` : empty('No trips recorded yet');
  }
  await paint();
  ctx.onChange(paint);
  const tick = setInterval(paint, 3000);
  ctx.cleanup(() => clearInterval(tick));
}
