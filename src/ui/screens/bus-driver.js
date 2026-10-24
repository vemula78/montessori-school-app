// Driver trip screen: real GPS (watchPosition + wake lock) or a clearly-labelled simulated trip.
// While a trip runs it is laid out for driving: the next stop's children first with large buttons, the map behind a
// button (no tile downloads until it is opened). Ending a trip needs every child marked (drop) and a "bus checked"
// tick; a page that was reloaded or killed resumes GPS by itself when location permission is already granted, and
// otherwise shows a red "Tracking is OFF" banner.
import { secondsSince, nowHHMM } from '../../domain/dates.js';
import { esc, badge, empty, pageHead, ftime, fullName, options, attempt, toast, ago, openModal, formModal, DASH } from '../components.js';
import { createRouteMap } from '../map.js';
import * as runner from '../sim-runner.js';
import { isRealMode } from '../mode.js';

const nowISO = () => new Date().toISOString();
const UNDO_MS = 2 * 60000; // a wrong Boarded/Dropped/Absent tap can be undone this long

export async function render(ctx) {
  const { api, db, persona } = ctx;
  const routes = await api.transport.routes();
  const route = routes.find((r) => r.driverId === persona.staffId);
  if (!route) { ctx.el.innerHTML = `${pageHead('Trip')}${empty('No route is assigned to this driver')}`; return; }
  const kids = db.students.filter((s) => s.status === 'active' && s.routeId === route.id);
  let trip = await api.transport.activeTrip(route.id);
  let check = null; // api.transport.checklist(trip): unmarked riders, standing marks, next stop, finished
  const geo = runner.geoSupport();
  const real = isRealMode();
  let direction = nowHHMM() >= '12:00' ? 'drop' : 'pickup'; // afternoon: the drop run
  // stops in the order the bus visits them for this direction (a drop run may go the other way round)
  const stopsInVisitOrder = () => (check?.order ? check.order.map((id) => route.stops.find((s) => s.id === id)).filter(Boolean) : [...route.stops].sort((a, b) => a.seq - b.seq));
  const stopName = (id) => route.stops.find((s) => s.id === id)?.name || 'stop';

  ctx.el.innerHTML = `${pageHead(route.name, `Bus ${route.busNo} - ${route.stops.length} stops`)}
    <div id="d-status"></div>
    <div id="d-controls"></div>
    <div id="d-next" style="margin-top:12px"></div>
    <button class="btn block" id="d-map-toggle" style="margin-top:12px" aria-expanded="false">Show map</button>
    <div class="map" id="d-map" style="margin:14px 0" hidden></div>
    <h2>All stops</h2>
    <div id="d-stops" class="stack"></div>
    ${real
      ? '<div class="banner" style="margin-top:16px"><strong>How live tracking works.</strong> Each position is sent to the school server and appears on parents\' phones within seconds. Phones pause location updates when the screen locks, so keep this screen on and this app in the foreground for the whole trip.</div>'
      : '<div class="banner" style="margin-top:16px"><strong>How live tracking works in this prototype.</strong> There is no server: the bus position is stored in this browser, so a Parent in a second tab of the same browser sees it. A phone and a separate parent phone cannot see each other until a backend exists.</div>'}`;
  // the map is built the first time it is shown (no tile downloads while it stays closed)
  let mapApi = null;
  const showMap = () => {
    const el = ctx.el.querySelector('#d-map');
    if (!mapApi) { mapApi = createRouteMap(el, route); ctx.cleanup(() => mapApi.destroy()); }
    const last = newest();
    if (last) mapApi.setBus(last.lat, last.lng, 'BUS');
    mapApi.refit();
  };

  // newest position seen, from the trip document or from the live feed (the feed is ahead of the document in the real app)
  let liveFix = null;
  const newest = () => {
    const doc = trip?.positions?.[trip.positions.length - 1] || null;
    return liveFix && trip && (!doc || !(Date.parse(doc.ts) > Date.parse(liveFix.ts))) ? liveFix : doc;
  };

  async function loadCheck() {
    try { check = await api.transport.checklist(trip || { routeId: route.id, direction, stopEvents: [], childEvents: [] }); } catch { check = null; }
  }
  async function refresh() {
    trip = await api.transport.activeTrip(route.id);
    if (!trip) liveFix = null;
    await loadCheck();
    paintStatus();
    paintControls();
    paintStops();
    const last = newest();
    if (last && mapApi) mapApi.setBus(last.lat, last.lng, 'BUS');
  }

  function paintStatus() {
    const s = runner.snapshot();
    const el = ctx.el.querySelector('#d-status');
    if (!trip) {
      el.innerHTML = `<div class="card">${badge('No active trip', 'mute')}<div style="margin-top:8px">${geo.ok ? '<small>Real GPS is available on this page (secure context).</small>' : `<div class="banner warn" style="margin:0"><strong>Real GPS unavailable.</strong> ${esc(geo.message)}</div>`}</div></div>`;
      return;
    }
    const fixes = trip.positions || [];
    const last = newest();
    const age = last ? secondsSince(last.ts, nowISO()) : null;
    const mine = s.tripId === trip.id;
    const trackingOff = !trip.simulated && !(mine && s.mode === 'gps');
    let runnerLine;
    if (trip.simulated) runnerLine = mine && s.mode === 'sim' ? `Simulated trip running - step ${s.step} of ${s.total}` : (mine && s.step >= s.total && s.total ? 'Simulation finished - end the trip when ready.' : 'Simulation is not running (the page was reloaded or it was stopped). End the trip and start a new one.');
    else if (!trackingOff) runnerLine = s.gps.status === 'ok' ? `GPS fix OK${s.gps.accuracy != null ? ` (accuracy ${Math.round(s.gps.accuracy)} m)` : ''}` : s.gps.message || 'Waiting for GPS...';
    else runnerLine = '';
    const gpsBad = !trip.simulated && mine && ['denied', 'unavailable', 'timeout'].includes(s.gps.status);
    const idle = age != null && age > 20 * 60;
    const offline = real && mine && (s.online === false || s.queued > 0);
    el.innerHTML = `<div class="card stack">
      ${trackingOff ? `<div class="banner alarm" role="alert" style="margin:0"><strong>Tracking is OFF.</strong> Parents cannot see the bus.${geo.ok ? '<button class="btn block" data-resume style="margin-top:8px">Tap to resume tracking</button>' : ` ${esc(geo.message)}`}</div>` : ''}
      <div class="row between"><div class="row"><span class="pulse"></span><strong>Trip active</strong> ${badge(trip.direction === 'pickup' ? 'Morning pickup' : 'Afternoon drop', 'info')}${trip.simulated ? badge('SIMULATED', 'sim') : ''}</div><small>Started ${ftime(trip.startedAt)}</small></div>
      ${gpsBad ? `<div class="banner bad" style="margin:0"><strong>${esc(s.gps.status === 'denied' ? 'Location permission denied' : s.gps.status === 'timeout' ? 'GPS timeout' : 'Position unavailable')}.</strong> ${esc(s.gps.message)}</div>` : ''}
      ${offline ? `<div class="banner warn" style="margin:0"><strong>${s.online === false ? 'No connection.' : 'Catching up.'}</strong> ${esc(s.queued)} position${s.queued === 1 ? '' : 's'} waiting to be sent${s.online === false ? ' - they will go out, in order, as soon as the phone is back online' : ''}. Parents see the bus where it was last reported.${s.dropped ? ` ${esc(s.dropped)} oldest position${s.dropped === 1 ? ' was' : 's were'} dropped because the wait was too long.` : ''} Do not close this app: waiting positions are lost if it is closed.</div>` : ''}
      ${idle ? '<div class="banner warn" style="margin:0"><strong>No position for over 20 minutes.</strong> End the trip if it is finished.</div>' : ''}
      <div class="grid cols-3">
        <div class="kpi"><div class="v">${real && mine ? esc(s.sent) : fixes.length}</div><div class="l">positions ${real && mine ? 'sent this session' : 'stored'}</div></div>
        <div class="kpi"><div class="v">${age == null ? DASH : ago(age)}</div><div class="l">last position</div></div>
        <div class="kpi"><div class="v">${s.wakeLock ? 'On' : trip.simulated ? DASH : 'Off'}</div><div class="l">screen kept awake</div></div>
      </div>
      ${runnerLine ? `<div class="muted">${esc(runnerLine)}</div>` : ''}
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
      const label = direction === 'drop' ? 'afternoon drop' : 'morning pickup';
      el.innerHTML = `<div class="card stack" style="margin-top:12px">
        <div class="seg" role="group" aria-label="Direction"><button data-dir="pickup" aria-pressed="${direction === 'pickup'}">Morning pickup</button><button data-dir="drop" aria-pressed="${direction === 'drop'}">Afternoon drop</button></div>
        <button class="btn primary block" id="d-start-gps"${geo.ok ? '' : ' disabled'}>Start ${esc(label)} (real GPS)</button>
        ${real ? `<small>${geo.ok ? 'Keep this screen open during the trip.' : 'Allow location for this site in the phone settings, then reload.'}</small>` : `<div class="row"><button class="btn block grow" id="d-start-sim">Start simulated ${esc(label)}</button>
          <label class="row" style="gap:6px"><span class="lbl" style="font-size:.8rem;font-weight:800">Speed</span><select id="d-speed" style="width:auto">${options([{ value: 1, label: '1x (real time)' }, { value: 5, label: '5x' }, { value: 20, label: '20x' }], 5)}</select></label></div>
        <small>A simulated trip is clearly marked to parents. Faster speeds also shorten the ETA parents see.</small>`}</div>`;
      return;
    }
    el.innerHTML = `<div class="row" style="margin-top:12px"><button class="btn danger" id="d-end">End trip</button></div>`;
  }

  // one child row: the standing mark (with Undo for two minutes) or large Boarded/Dropped and Absent buttons
  let undoKey = '';
  const undoable = (l) => l && Date.now() - Date.parse(l.ts) < UNDO_MS;
  function childRow(k, st, pickup) {
    const l = check?.last?.[k.id] ?? null;
    const state = l ? badge(`${l.type === 'boarded' ? 'Boarded' : l.type === 'dropped' ? 'Dropped' : 'Absent'} ${ftime(l.ts)}`, l.type === 'absent' ? 'bad' : 'ok') : '';
    const buttons = trip && !l ? `<button class="btn sage" data-child="${esc(k.id)}" data-stop="${esc(st.id)}" data-type="${pickup ? 'boarded' : 'dropped'}">${pickup ? 'Boarded' : 'Dropped'}</button><button class="btn" data-child="${esc(k.id)}" data-stop="${esc(st.id)}" data-type="absent">Absent</button>` : '';
    const undo = trip && undoable(l) ? `<button class="btn" data-undo="${esc(k.id)}">Undo</button>` : '';
    return `<li><div class="row between"><span>${esc(fullName(k))}</span><span class="row">${state}${undo}${buttons}</span></div></li>`;
  }
  function stopCard(st, pickup, title = '') {
    const se = (trip?.stopEvents || []).filter((e) => e.stopId === st.id);
    const lastEv = se[se.length - 1];
    const here = kids.filter((k) => k.stopId === st.id);
    const stBadge = lastEv ? badge(lastEv.type === 'nearing' ? 'Nearing' : lastEv.type === 'arrived' ? 'Arrived' : 'Departed', lastEv.type === 'departed' ? 'mute' : lastEv.type === 'arrived' ? 'ok' : 'warn') : '';
    return `<div class="card">${title}<div class="row between"><div><div class="item-title">${esc(st.seq)}. ${esc(st.name)}</div><small>${pickup ? `Scheduled pickup ${esc(st.scheduledPickup)}` : `Scheduled drop ${esc(st.scheduledDrop)}`}</small></div>${stBadge}</div>
      ${here.length ? `<ul class="list" style="margin-top:8px">${here.map((k) => childRow(k, st, pickup)).join('')}</ul>` : '<small class="muted">No children assigned to this stop.</small>'}</div>`;
  }
  function paintStops() {
    const pickup = (trip?.direction || direction) === 'pickup';
    const order = stopsInVisitOrder();
    undoKey = kids.filter((k) => undoable(check?.last?.[k.id])).map((k) => k.id).join(',');
    const next = ctx.el.querySelector('#d-next');
    if (!trip) next.innerHTML = '';
    else if (check?.nextStopId) next.innerHTML = stopCard(route.stops.find((s) => s.id === check.nextStopId), pickup, '<div class="lbl">Next stop</div>');
    else if (check?.finished) next.innerHTML = '<div class="card stack"><div class="banner ok" style="margin:0"><strong>Last stop done and every child marked.</strong> Check the bus, then end the trip.</div><button class="btn danger block" data-end>End trip</button></div>';
    else if (check) next.innerHTML = '<div class="card"><strong>Every child is marked.</strong> <small>End the trip after the last stop.</small></div>';
    ctx.el.querySelector('#d-stops').innerHTML = order.map((st) => stopCard(st, pickup)).join('');
  }

  // Ending: a drop trip needs every child marked; every trip asks the driver to walk the bus and tick "no child on board"
  async function endFlow() {
    let c;
    try { c = await api.transport.checklist(trip); } catch { c = check; }
    const unmarked = c?.unmarked || [];
    const list = unmarked.map((u) => `<li>${esc(u.name)} <small>(${esc(stopName(u.stopId))})</small></li>`).join('');
    if (trip.direction === 'drop' && unmarked.length) {
      await openModal({ title: 'Mark every child first', body: `<p>Before a drop trip can end, mark each child Dropped or Absent. Not marked yet:</p><ul>${list}</ul>`, actions: [{ label: 'Back to the list', value: null }] });
      return;
    }
    const left = real ? await runner.flushNow() : 0; // send what is still queued before the trip closes
    const ended = await formModal({
      title: 'Check the bus',
      fieldsHtml: `${unmarked.length ? `<div class="banner warn"><strong>Not marked:</strong> make sure none of these children is on the bus.<ul style="margin:6px 0 0">${list}</ul></div>` : ''}
        ${left ? `<div class="banner warn">${esc(left)} position${left === 1 ? '' : 's'} could not be sent (no connection) and will be lost.</div>` : ''}
        <p>Walk to the back of the bus and look at every seat, under the seats and in the luggage space.</p>
        <label class="row" style="gap:10px;align-items:flex-start"><input type="checkbox" name="checked" value="yes" style="width:auto;margin-top:4px"> <span>I have checked the whole bus. No child is left on board.</span></label>`,
      submitLabel: 'End trip',
      onSubmit: async (v) => {
        if (v.checked !== 'yes') throw new Error('Tick the box once you have checked the whole bus.');
        await api.transport.endTrip(trip.id, { busChecked: true });
      },
    });
    if (!ended) return;
    runner.resetAfterTripEnd();
    toast('Trip ended');
    await refresh();
  }

  async function resumeGps() {
    runner.startGps(trip.id, route.id);
    await refresh();
  }

  ctx.el.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.dir) { direction = t.dataset.dir; paintControls(true); await loadCheck(); paintStops(); return; }
    if (t.id === 'd-map-toggle') {
      const el = ctx.el.querySelector('#d-map');
      el.hidden = !el.hidden;
      t.setAttribute('aria-expanded', String(!el.hidden));
      t.textContent = el.hidden ? 'Show map' : 'Hide map';
      if (!el.hidden) showMap();
      return;
    }
    if (t.id === 'd-start-gps' || t.id === 'd-start-sim') {
      const simulated = t.id === 'd-start-sim';
      const speed = Number(ctx.el.querySelector('#d-speed')?.value || 5);
      const tr = await attempt(() => api.transport.startTrip({ routeId: route.id, direction, simulated }));
      if (!tr.ok) return;
      if (simulated) {
        const pr = await attempt(() => api.transport.simulationPlan(route.id, { speedKmph: 20, tickMs: 1000, direction }));
        const plan = pr.ok ? pr.value : null;
        if (!plan || !plan.length) { toast('Could not build a simulation plan for this route', 'bad'); }
        else runner.startSimulated(tr.value.id, route.id, plan, { speedUp: speed });
      } else {
        runner.startGps(tr.value.id, route.id);
      }
      await refresh();
    } else if (t.dataset.resume != null) {
      await resumeGps();
    } else if (t.id === 'd-end' || t.dataset.end != null) {
      await endFlow();
    } else if (t.dataset.undo) {
      await attempt(() => api.transport.markChild(trip.id, { studentId: t.dataset.undo, type: 'corrected' }), 'Mark undone');
      await refresh();
    } else if (t.dataset.child) {
      await attempt(() => api.transport.markChild(trip.id, { studentId: t.dataset.child, stopId: t.dataset.stop, type: t.dataset.type }));
      await refresh();
    }
  });

  const off = runner.onState(() => { paintStatus(); paintControls(); });
  ctx.cleanup(off);
  // live feed of this route's trip: position fixes move the marker, trip changes (start, end, stop events) reload the screen
  const offTrip = api.transport.subscribeTrip?.(route.id, (ev) => {
    if (!ctx.el.isConnected) return;
    if (ev.type === 'position' && ev.fix) { liveFix = ev.fix; if (mapApi) mapApi.setBus(ev.fix.lat, ev.fix.lng, 'BUS'); }
    else if (ev.type === 'trip') refresh();
  });
  if (offTrip) ctx.cleanup(offTrip);
  ctx.onChange(() => { if (!ctx.el.isConnected) return; refresh(); });
  // "last position N s ago" every 5 s (not every second: the screen stays on for the whole trip); the Undo buttons go after two minutes
  const tick = setInterval(() => {
    if (!ctx.el.isConnected) return;
    paintStatus();
    if (kids.filter((k) => undoable(check?.last?.[k.id])).map((k) => k.id).join(',') !== undoKey) paintStops();
  }, 5000);
  ctx.cleanup(() => clearInterval(tick));
  await refresh();

  // A reloaded or killed page leaves the trip running with nothing sending positions. Resume by itself when location is
  // already allowed (no prompt can appear); otherwise the red banner above stays, and the phone vibrates once.
  if (trip && !trip.simulated && geo.ok && runner.snapshot().mode === 'idle') {
    let permission = null;
    try { permission = (await navigator.permissions?.query({ name: 'geolocation' }))?.state ?? null; } catch { permission = null; }
    if (permission === 'granted' && ctx.el.isConnected && runner.snapshot().mode === 'idle') await resumeGps();
    else { try { navigator.vibrate?.([300, 150, 300]); } catch { /* not supported */ } }
  }
}
