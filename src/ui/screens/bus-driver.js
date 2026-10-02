// Driver trip screen: real GPS (watchPosition + wake lock) or a clearly-labelled simulated trip.
import { secondsSince } from '../../domain/dates.js';
import { esc, badge, empty, pageHead, ftime, fullName, options, attempt, toast, ago, confirmDialog, DASH } from '../components.js';
import { createRouteMap } from '../map.js';
import * as runner from '../sim-runner.js';

const nowISO = () => new Date().toISOString();

export async function render(ctx) {
  const { api, db, persona } = ctx;
  const routes = await api.transport.routes();
  const route = routes.find((r) => r.driverId === persona.staffId);
  if (!route) { ctx.el.innerHTML = `${pageHead('Trip')}${empty('No route is assigned to this driver')}`; return; }
  const stops = [...route.stops].sort((a, b) => a.seq - b.seq);
  const kids = db.students.filter((s) => s.status === 'active' && s.routeId === route.id);
  let trip = await api.transport.activeTrip(route.id);
  const geo = runner.geoSupport();
  let direction = 'pickup';

  ctx.el.innerHTML = `${pageHead(route.name, `Bus ${route.busNo} - ${stops.length} stops`)}
    <div id="d-status"></div>
    <div id="d-controls"></div>
    <div class="map" id="d-map" style="margin:14px 0"></div>
    <h2>Stops and children</h2>
    <div id="d-stops" class="stack"></div>
    <div class="banner" style="margin-top:16px"><strong>How live tracking works in this prototype.</strong> There is no server: the bus position is stored in this browser, so a Parent in a second tab of the same browser sees it. A phone and a separate parent phone cannot see each other until a backend exists.</div>`;
  const mapApi = createRouteMap(ctx.el.querySelector('#d-map'), route);
  ctx.cleanup(() => mapApi.destroy());

  async function refresh() {
    trip = await api.transport.activeTrip(route.id);
    paintStatus();
    paintControls();
    paintStops();
    const last = trip?.positions?.[trip.positions.length - 1];
    if (last) mapApi.setBus(last.lat, last.lng, 'BUS');
  }

  function paintStatus() {
    const s = runner.snapshot();
    const el = ctx.el.querySelector('#d-status');
    if (!trip) {
      el.innerHTML = `<div class="card">${badge('No active trip', 'mute')}<div style="margin-top:8px">${geo.ok ? '<small>Real GPS is available on this page (secure context).</small>' : `<div class="banner warn" style="margin:0"><strong>Real GPS unavailable.</strong> ${esc(geo.message)}</div>`}</div></div>`;
      return;
    }
    const fixes = trip.positions || [];
    const last = fixes[fixes.length - 1];
    const age = last ? secondsSince(last.ts, nowISO()) : null;
    const mine = s.tripId === trip.id;
    let runnerLine;
    if (trip.simulated) runnerLine = mine && s.mode === 'sim' ? `Simulated trip running - step ${s.step} of ${s.total}` : (mine && s.step >= s.total && s.total ? 'Simulation finished - end the trip when ready.' : 'Simulation is not running (the page was reloaded or it was stopped). End the trip and start a new one.');
    else if (mine && s.mode === 'gps') runnerLine = s.gps.status === 'ok' ? `GPS fix OK${s.gps.accuracy != null ? ` (accuracy ${Math.round(s.gps.accuracy)} m)` : ''}` : s.gps.message || 'Waiting for GPS...';
    else runnerLine = 'GPS is not running in this tab.';
    const gpsBad = !trip.simulated && mine && ['denied', 'unavailable', 'timeout'].includes(s.gps.status);
    const idle = age != null && age > 20 * 60;
    el.innerHTML = `<div class="card stack">
      <div class="row between"><div class="row"><span class="pulse"></span><strong>Trip active</strong> ${badge(trip.direction === 'pickup' ? 'Morning pickup' : 'Afternoon drop', 'info')}${trip.simulated ? badge('SIMULATED', 'sim') : ''}</div><small>Started ${ftime(trip.startedAt)}</small></div>
      ${gpsBad ? `<div class="banner bad" style="margin:0"><strong>${esc(s.gps.status === 'denied' ? 'Location permission denied' : s.gps.status === 'timeout' ? 'GPS timeout' : 'Position unavailable')}.</strong> ${esc(s.gps.message)}</div>` : ''}
      ${idle ? '<div class="banner warn" style="margin:0"><strong>No position for over 20 minutes.</strong> End the trip if it is finished.</div>' : ''}
      <div class="grid cols-3">
        <div class="kpi"><div class="v">${fixes.length}</div><div class="l">positions stored</div></div>
        <div class="kpi"><div class="v">${age == null ? DASH : ago(age)}</div><div class="l">last position</div></div>
        <div class="kpi"><div class="v">${s.wakeLock ? 'On' : trip.simulated ? DASH : 'Off'}</div><div class="l">screen kept awake</div></div>
      </div>
      <div class="muted">${esc(runnerLine)}</div>
      ${trip.simulated ? '' : '<small>Keep this screen on and the browser in the foreground - phones pause location updates when the screen locks.</small>'}
      ${s.lastError ? `<div class="err">${esc(s.lastError)}</div>` : ''}</div>`;
  }

  let ctlKey = null;
  function paintControls(force = false) {
    const el = ctx.el.querySelector('#d-controls');
    const key = `${trip?.id || 'none'}|${runner.snapshot().mode}`;
    if (!force && key === ctlKey) return; // keep the speed picker etc. stable between position commits
    ctlKey = key;
    if (!trip) {
      el.innerHTML = `<div class="card stack" style="margin-top:12px">
        <div class="seg" role="group" aria-label="Direction"><button data-dir="pickup" aria-pressed="${direction === 'pickup'}">Morning pickup</button><button data-dir="drop" aria-pressed="${direction === 'drop'}">Afternoon drop</button></div>
        <button class="btn primary block" id="d-start-gps"${geo.ok ? '' : ' disabled'}>Start trip (real GPS)</button>
        <div class="row"><button class="btn block grow" id="d-start-sim">Start simulated trip</button>
          <label class="row" style="gap:6px"><span class="lbl" style="font-size:.8rem;font-weight:800">Speed</span><select id="d-speed" style="width:auto">${options([{ value: 1, label: '1x (real time)' }, { value: 5, label: '5x' }, { value: 20, label: '20x' }], 5)}</select></label></div>
        <small>A simulated trip is clearly marked to parents. Use it to demo, or when GPS is blocked. Faster speeds also shorten the ETA parents see.</small></div>`;
      return;
    }
    const s = runner.snapshot();
    const canResume = !trip.simulated && s.mode !== 'gps' && geo.ok;
    el.innerHTML = `<div class="row" style="margin-top:12px">${canResume ? '<button class="btn sky" id="d-resume">Resume GPS</button>' : ''}<button class="btn danger" id="d-end">End trip</button></div>`;
  }

  function paintStops() {
    const el = ctx.el.querySelector('#d-stops');
    const evs = trip?.stopEvents || [];
    const cevs = trip?.childEvents || [];
    const pickup = (trip?.direction || direction) === 'pickup';
    el.innerHTML = stops.map((st) => {
      const se = evs.filter((e) => e.stopId === st.id);
      const lastEv = se[se.length - 1];
      const here = kids.filter((k) => k.stopId === st.id);
      const stBadge = lastEv ? badge(lastEv.type === 'nearing' ? 'Nearing' : lastEv.type === 'arrived' ? 'Arrived' : 'Departed', lastEv.type === 'departed' ? 'mute' : lastEv.type === 'arrived' ? 'ok' : 'warn') : '';
      return `<div class="card"><div class="row between"><div><div class="item-title">${esc(st.seq)}. ${esc(st.name)}</div><small>${pickup ? `Scheduled pickup ${esc(st.scheduledPickup)}` : `Scheduled drop ${esc(st.scheduledDrop)}`}</small></div>${stBadge}</div>
        ${here.length ? `<ul class="list" style="margin-top:8px">${here.map((k) => {
          const ce = cevs.filter((c) => c.studentId === k.id);
          const l = ce[ce.length - 1];
          const state = l ? badge(`${l.type === 'boarded' ? 'Boarded' : l.type === 'dropped' ? 'Dropped' : 'Absent'} ${ftime(l.ts)}`, l.type === 'absent' ? 'bad' : 'ok') : '';
          return `<li><div class="row between"><span>${esc(fullName(k))}</span><span class="row">${state}${trip && !l ? `<button class="btn sm sage" data-child="${esc(k.id)}" data-stop="${esc(st.id)}" data-type="${pickup ? 'boarded' : 'dropped'}">${pickup ? 'Boarded' : 'Dropped'}</button><button class="btn sm" data-child="${esc(k.id)}" data-stop="${esc(st.id)}" data-type="absent">Absent</button>` : ''}</span></div></li>`;
        }).join('')}</ul>` : '<small class="muted">No children assigned to this stop.</small>'}</div>`;
    }).join('');
  }

  ctx.el.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.dir) { direction = t.dataset.dir; paintControls(true); return; }
    if (t.id === 'd-start-gps' || t.id === 'd-start-sim') {
      const simulated = t.id === 'd-start-sim';
      const speed = Number(ctx.el.querySelector('#d-speed')?.value || 5);
      const tr = await attempt(() => api.transport.startTrip({ routeId: route.id, direction, simulated }));
      if (!tr.ok) return;
      if (simulated) {
        const pr = await attempt(() => api.transport.simulationPlan(route.id, { speedKmph: 20, tickMs: 1000 }));
        const plan = pr.ok ? pr.value : null;
        if (!plan || !plan.length) { toast('Could not build a simulation plan for this route', 'bad'); }
        else runner.startSimulated(tr.value.id, route.id, plan, { speedUp: speed });
      } else {
        runner.startGps(tr.value.id, route.id);
      }
      await refresh();
    } else if (t.id === 'd-resume') {
      runner.startGps(trip.id, route.id);
      await refresh();
    } else if (t.id === 'd-end') {
      if (!(await confirmDialog('End trip', 'End this trip now? Positions stop being recorded.', { okLabel: 'End trip', kind: 'danger' }))) return;
      runner.resetAfterTripEnd();
      await attempt(() => api.transport.endTrip(trip.id), 'Trip ended');
      await refresh();
    } else if (t.dataset.child) {
      await attempt(() => api.transport.markChild(trip.id, { studentId: t.dataset.child, stopId: t.dataset.stop, type: t.dataset.type }));
      await refresh();
    }
  });

  const off = runner.onState(() => { paintStatus(); paintControls(); });
  ctx.cleanup(off);
  ctx.onChange(() => { if (!ctx.el.isConnected) return; refresh(); });
  // keep "last position N s ago" ticking even between commits
  const tick = setInterval(paintStatus, 1000);
  ctx.cleanup(() => clearInterval(tick));
  await refresh();
}
