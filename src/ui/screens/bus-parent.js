// Parent bus view: only the child's own route; same-browser live updates (storage event / polling).
import { secondsSince } from '../../domain/dates.js';
import { esc, badge, empty, pageHead, ftime, fullName, ago, DASH } from '../components.js';
import { createRouteMap } from '../map.js';
import { isRealMode } from '../mode.js';

const nowISO = () => new Date().toISOString();
// parentView event kinds are trip|stop|child; colour the dot from the wording as well
const timelineClass = (e) => { const t = String(e.text).toLowerCase(); return t.includes('arrived') ? 'arrived' : t.includes('nearing') ? 'nearing' : t.includes('boarded') || t.includes('dropped') ? 'boarded' : t.includes('absent') ? 'absent' : ''; };

export async function render(ctx) {
  const { api, persona, query } = ctx;
  const all = await api.people.childrenOf(persona.guardianId);
  const kids = all.filter((k) => k.routeId && k.status === 'active');
  if (!kids.length) { ctx.el.innerHTML = `${pageHead('Bus')}${empty('No school bus assigned', 'Your children are not on a bus route.')}`; return; }
  const kid = kids.find((k) => k.id === query.student) || kids[0];

  const real = isRealMode();
  let view = await api.transport.parentView(kid.id);
  if (!view || !view.route) { ctx.el.innerHTML = `${pageHead('Bus')}${empty('Route information is not available')}`; return; }
  const route = view.route;
  // Live location is a separate, optional consent. Without it the server sends no positions at all (not just hidden by this page).
  let liveOff = false;
  if (real) {
    try { liveOff = !(await api.consent.status())?.purposes?.bus_live?.given; } catch { liveOff = false; /* unknown: the server still enforces it */ }
  }

  ctx.el.innerHTML = `${pageHead('Bus', fullName(kid))}
    ${kids.length > 1 ? `<div class="seg" style="margin-bottom:12px">${kids.map((k) => `<button data-kid="${esc(k.id)}" aria-pressed="${k.id === kid.id}">${esc(k.firstName)}</button>`).join('')}</div>` : ''}
    <div id="b-status" class="stack"></div>
    <div class="map tall" id="b-map" style="margin:14px 0"></div>
    <h2>Today's updates</h2><div id="b-events"></div>
    <p class="muted" style="font-size:.82rem;margin-top:14px">${real ? 'The bus position comes from the driver&rsquo;s phone and can pause if that phone loses signal or its screen locks.' : 'Live updates work between tabs of the same browser in this prototype (no server).'} Map tiles &copy; OpenStreetMap contributors.</p>`;
  ctx.el.querySelectorAll('[data-kid]').forEach((b) => b.addEventListener('click', () => ctx.setQuery({ student: b.dataset.kid })));

  const mapApi = createRouteMap(ctx.el.querySelector('#b-map'), route, { myStopId: view.stop?.id });
  ctx.cleanup(() => mapApi.destroy());

  let reloadFailedAt = null; // set while the latest re-read failed: what is on screen may be out of date
  let liveFix = null; // newest fix from the live feed (ahead of the snapshot in the real app)
  function paint() {
    const trip = view.trip;
    const fix = liveFix && (!view.lastFix || !(Date.parse(view.lastFix.ts) > Date.parse(liveFix.ts))) ? liveFix : view.lastFix; // timestamps compared as instants, not strings
    const age = fix ? secondsSince(fix.ts, nowISO()) : null;
    const active = trip && trip.status === 'active';
    const stale = active && (view.stale || (age != null && age > 45));
    const stop = view.stop;
    let main;
    if (liveOff) main = `<div class="card"><div class="row">${badge('Live location off', 'mute')}</div><p style="margin:8px 0 0">The map shows the route only.${stop ? ` Scheduled pickup at <strong>${esc(stop.scheduledPickup)}</strong>, drop at <strong>${esc(stop.scheduledDrop)}</strong> (${esc(stop.name)}).` : ''}</p></div>`;
    else if (!trip) main = `<div class="card"><div class="row">${badge('No trip running', 'mute')}</div><p style="margin:8px 0 0">The bus is not on the road right now.${stop ? ` Scheduled pickup at <strong>${esc(stop.scheduledPickup)}</strong>, drop at <strong>${esc(stop.scheduledDrop)}</strong> (${esc(stop.name)}).` : ''}</p></div>`;
    else main = `<div class="card stack">
        <div class="row between"><div class="row">${active ? '<span class="pulse"></span><strong>Bus is on the way</strong>' : badge('Trip ended', 'mute')}${trip.simulated ? badge('SIMULATED', 'sim') : ''}</div><small>${trip.direction === 'pickup' ? 'Morning pickup' : 'Afternoon drop'} - started ${ftime(trip.startedAt)}</small></div>
        <div class="grid cols-3">
          <div class="kpi"><div class="v">${view.etaMinutes == null ? DASH : esc(view.etaMinutes) + ' min'}</div><div class="l">ETA to ${esc(stop?.name || 'your stop')}</div></div>
          <div class="kpi"><div class="v">${active ? (age == null ? DASH : ago(age)) : DASH}</div><div class="l">last update</div></div>
          <div class="kpi"><div class="v">${esc((trip.direction === 'drop' ? stop?.scheduledDrop : stop?.scheduledPickup) || DASH)}</div><div class="l">scheduled ${trip.direction === 'drop' ? 'drop' : 'pickup'} at your stop</div></div>
        </div>
        ${stale ? '<div class="banner warn" style="margin:0"><strong>No recent bus updates.</strong> The last position is more than 45 seconds old - the driver\'s phone may be offline or the screen locked. The marker shows the last known position.</div>' : ''}
        ${trip.simulated ? '<small>This is a simulated trip for demonstration - not a real bus.</small>' : ''}</div>`;
    const offline = reloadFailedAt ? `<div class="banner warn" role="status"><strong>Could not refresh the bus status.</strong> You may be offline. Refreshing has failed since ${ftime(reloadFailedAt)}, so what you see may be out of date; we keep trying.</div>` : '';
    ctx.el.querySelector('#b-status').innerHTML = offline + (liveOff ? '<div class="banner warn"><strong>Live bus location is switched off.</strong> You chose not to receive it. You can turn it on in <a href="#/settings">Settings</a> (privacy choices).</div>' : '') + main;
    if (fix && !liveOff) mapApi.setBus(fix.lat, fix.lng, 'BUS');
    const evs = (view.events || []).slice().sort((a, b) => (a.ts < b.ts ? 1 : -1));
    ctx.el.querySelector('#b-events').innerHTML = liveOff ? empty('Bus updates are off', 'Turn on live bus location in Settings to see boarding and arrival updates here.') : evs.length
      ? `<ul class="timeline">${evs.map((e) => `<li class="${esc(timelineClass(e))}"><div class="t">${ftime(e.ts)}</div>${esc(e.text)}</li>`).join('')}</ul>`
      : empty('No updates yet today', 'Arrival and boarding updates for your child appear here during a trip.');
  }

  async function reload() {
    try { view = (await api.transport.parentView(kid.id)) || view; reloadFailedAt = null; } catch { reloadFailedAt = reloadFailedAt || nowISO(); /* keep the last view, but say so */ }
    if (ctx.el.isConnected) paint();
  }
  paint();
  ctx.onChange(reload);
  // live feed: fixes move the marker at once; trip changes (started, nearing, arrived, ended) re-read the full view
  let lastReload = 0;
  const offTrip = api.transport.subscribeTrip?.(route.id, (ev) => {
    if (!ctx.el.isConnected) return;
    if (ev.type === 'position' && ev.fix) {
      liveFix = ev.fix;
      if (!view.trip) reload(); // first fix of a trip we did not know about yet
      else { paint(); if (real && Date.now() - lastReload > 10000) { lastReload = Date.now(); reload(); } } // keeps the ETA fresh without a read per fix
    } else if (ev.type === 'trip') { lastReload = Date.now(); reload(); }
  });
  if (offTrip) ctx.cleanup(offTrip);
  // fallback if the live feed drops: the demo re-reads every 2 s (local storage), the real app every 30 s
  const tick = setInterval(reload, real ? 30000 : 2000);
  ctx.cleanup(() => clearInterval(tick));
  // keep "last update N s ago" and the stale banner honest between events
  const clock = setInterval(() => { if (ctx.el.isConnected) paint(); }, 5000);
  ctx.cleanup(() => clearInterval(clock));
}
