// Driver trip screen: real GPS (watchPosition + wake lock) or a clearly-labelled simulated trip.
// While a trip runs it is laid out for driving: the next stop's children first with large buttons, the map behind a
// button (no tile downloads until it is opened). Ending a trip needs every child marked (drop) and a "bus checked"
// tick; a page that was reloaded or killed resumes GPS by itself when location permission is already granted, and
// otherwise shows a red "Tracking is OFF" banner. Absences parents reported for today are listed and greyed until the
// driver confirms them; a drop asks who received the child (the usual person first); "Running late" tells the families.
import { secondsSince, nowHHMM } from '../../domain/dates.js';
import { esc, badge, empty, pageHead, ftime, fullName, options, attempt, toast, ago, openModal, formModal, confirmDialog, DASH } from '../components.js';
import { createRouteMap } from '../map.js';
import * as runner from '../sim-runner.js';
import { isRealMode } from '../mode.js';

const nowISO = () => new Date().toISOString();
const UNDO_MS = 2 * 60000; // a wrong Boarded/Dropped/Absent tap can be undone this long
const LATE_LABEL = { late10: 'About 10 minutes late', late20: 'About 20 minutes late', late30: '30 minutes late or more', breakdown: 'The bus has broken down' };
const telOf = (phone) => String(phone || '').replace(/[^\d+]/g, '');

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
  // today's absences reported by parents (dates only), each child's pick-up list, and who usually takes each child at the
  // stop (the newest "received by" on this route's recent drop trips; a parent when there is none)
  let absentIds = new Set();
  const receivers = await api.transport.receivers(route.id).catch(() => ({}));
  const usual = new Map();
  for (const t of (await api.transport.trips({ routeId: route.id }).catch(() => [])).slice().reverse()) {
    for (const e of t.childEvents || []) if (e.type === 'dropped' && e.receivedBy) usual.set(e.studentId, e.receivedBy);
  }
  const contactOf = (sid, id) => (receivers[sid] || []).find((c) => c.id === id);
  const receiverText = (sid, r) => {
    if (r.kind === 'guardian') return 'a parent';
    if (r.kind === 'other') return `${r.name} (not on the list)`;
    const c = contactOf(sid, r.contactId);
    return c ? `${c.name} (${c.relation})` : 'a person on the list';
  };

  ctx.el.innerHTML = `${pageHead(route.name, `Bus ${route.busNo} - ${route.stops.length} stops`)}
    <div id="d-status"></div>
    <div id="d-controls"></div>
    <div id="d-next" style="margin-top:12px"></div>
    <div id="d-absent" style="margin-top:12px"></div>
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
    try { absentIds = new Set((await api.transport.absences(route.id)).map((a) => a.studentId)); } catch { /* unavailable: no list */ }
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
        <small>A simulated trip is clearly marked to parents. Faster speeds also shorten the ETA parents see.</small>`}
        <button class="btn block" id="d-late">Running late</button></div>`;
      return;
    }
    el.innerHTML = `<div class="row" style="margin-top:12px"><button class="btn" id="d-late">Running late</button><button class="btn danger" id="d-end">End trip</button></div>`;
  }

  // one child row: the standing mark (with Undo for two minutes) or large Boarded/Dropped and Absent buttons
  let undoKey = '';
  const undoable = (l) => l && Date.now() - Date.parse(l.ts) < UNDO_MS;
  function childRow(k, st, pickup) {
    const l = check?.last?.[k.id] ?? null;
    const state = l ? badge(`${l.type === 'boarded' ? 'Boarded' : l.type === 'dropped' ? 'Dropped' : 'Absent'} ${ftime(l.ts)}`, l.type === 'absent' ? 'bad' : 'ok') : '';
    // a reported absence: greyed with "Confirm absent" first; the usual button stays for a child who comes after all
    const reported = !l && absentIds.has(k.id);
    const btn = (type, label, cls = '') => `<button class="btn${cls}" data-child="${esc(k.id)}" data-stop="${esc(st.id)}" data-type="${type}">${label}</button>`;
    const go = pickup ? ['boarded', 'Boarded'] : ['dropped', 'Dropped'];
    const buttons = !trip || l ? '' : reported ? `${btn('absent', 'Confirm absent', ' sage')}${btn(...go)}` : `${btn(...go, ' sage')}${btn('absent', 'Absent')}`;
    const undo = trip && undoable(l) ? `<button class="btn" data-undo="${esc(k.id)}">Undo</button>` : '';
    const to = l?.type === 'dropped' && l.receivedBy ? `<br><small>Received by ${esc(receiverText(k.id, l.receivedBy))}</small>` : '';
    return `<li><div class="row between"><span${reported ? ' class="muted"' : ''}>${esc(fullName(k))}${reported ? ` ${badge('Absent today (reported by parent)', 'mute')}` : ''}${to}</span>
      <span class="row">${state}${undo}${buttons}<button class="btn ghost" data-people="${esc(k.id)}">Pick-up list</button></span></div></li>`;
  }
  function stopCard(st, pickup, title = '') {
    const se = (trip?.stopEvents || []).filter((e) => e.stopId === st.id);
    const lastEv = se[se.length - 1];
    const here = kids.filter((k) => k.stopId === st.id);
    const stBadge = lastEv ? badge(lastEv.type === 'nearing' ? 'Nearing' : lastEv.type === 'arrived' ? 'Arrived' : 'Departed', lastEv.type === 'departed' ? 'mute' : lastEv.type === 'arrived' ? 'ok' : 'warn') : '';
    return `<div class="card">${title}<div class="row between"><div><div class="item-title">${esc(st.seq)}. ${esc(st.name)}</div><small>${pickup ? `Scheduled pickup ${esc(st.scheduledPickup)}` : `Scheduled drop ${esc(st.scheduledDrop)}`}</small></div>${stBadge}</div>
      ${here.length ? `<ul class="list" style="margin-top:8px">${here.map((k) => childRow(k, st, pickup)).join('')}</ul>` : '<small class="muted">No children assigned to this stop.</small>'}
      ${geo.ok ? `<div style="margin-top:8px"><button class="btn ghost" data-setpos="${esc(st.id)}" data-name="${esc(st.name)}">Set this stop's position here</button></div>` : ''}</div>`;
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
    paintAbsent();
  }
  // "Absent today (reported by parent)": the driver confirms each one (or all at once) during the trip
  function paintAbsent() {
    const away = kids.filter((k) => absentIds.has(k.id));
    const open = away.filter((k) => !check?.last?.[k.id]);
    const state = (l) => (!l ? badge('Not confirmed', 'warn') : l.type === 'absent' ? badge('Confirmed', 'mute') : badge('Came after all', 'ok'));
    ctx.el.querySelector('#d-absent').innerHTML = away.length ? `<div class="card stack"><h2 style="margin:0">Absent today (reported by parent)</h2>
      <ul class="list">${away.map((k) => `<li><div class="row between"><span>${esc(fullName(k))} <small>(${esc(stopName(k.stopId))})</small></span>${state(check?.last?.[k.id])}</div></li>`).join('')}</ul>
      ${trip && open.length ? `<button class="btn block" data-confirm-absent>${open.length === 1 ? 'Confirm absent' : `Confirm all ${esc(open.length)} absent`}</button>` : ''}
      <small>${trip ? 'If a child is at the stop after all, tap Boarded or Dropped on their row.' : 'Confirm them once the trip has started.'}</small></div>` : '';
  }

  // Who received the child at the stop: the usual person first (one tap), then the others on the list and a parent, then
  // "Someone else" (with a name). Asked on every drop; "Not now" records the drop without it.
  // → receivedBy, null for "Not now", undefined when the driver closed the question (nothing is recorded).
  async function pickReceiver(k, stopId) {
    const people = receivers[k.id] || [];
    const u = usual.get(k.id);
    const parent = { label: 'A parent', value: { kind: 'guardian' } };
    const listed = people.map((c) => ({ label: `${c.name} (${c.relation})`, value: { kind: 'contact', id: c.id } }));
    const first = (u?.kind === 'contact' && listed.find((x) => x.value.id === u.contactId)) || parent;
    const choices = [first, ...[parent, ...listed].filter((x) => x !== first)].map((x, i) => ({ ...x, kind: i === 0 ? 'primary block' : 'block' }));
    const v = await openModal({
      title: `Who took ${k.firstName}?`,
      body: `<p style="margin:0">${esc(fullName(k))} at ${esc(stopName(stopId))}.${people.length ? '' : " No one else is on the family's pick-up list."}</p>`,
      actions: [...choices, { label: 'Someone else', kind: 'block', value: 'other' }, { label: 'Not now', kind: 'ghost block', value: 'skip' }],
    });
    if (v === null) return undefined;
    if (v === 'skip') return null;
    if (v !== 'other') return v;
    let name = '';
    const ok = await formModal({
      title: `Who took ${k.firstName}?`, submitLabel: 'Record drop',
      fieldsHtml: `<div class="banner warn"><strong>Not on the family's list.</strong> Hand the child over only after the school has confirmed it with a parent.</div>
        <label class="field"><span class="lbl">Name of the person</span><input name="name" maxlength="80" required></label>`,
      onSubmit: async (f) => {
        name = String(f.name || '').trim();
        if (name.length < 2) throw new Error('Write the name of the person who received the child');
      },
    });
    return ok ? { kind: 'other', name } : undefined;
  }
  async function showPeople(k) {
    const people = receivers[k.id] || [];
    await openModal({
      title: `Who may collect ${k.firstName}`,
      body: `${people.length ? `<ul class="list">${people.map((c) => `<li class="stack"><div><strong>${esc(c.name)}</strong> <small>${esc(c.relation)}</small></div>
        ${c.phone ? `<a class="btn block" href="tel:${esc(telOf(c.phone))}">Call ${esc(c.phone)}</a>` : ''}</li>`).join('')}</ul>` : "<p>No one else is on the family's list.</p>"}
        <small>Besides a parent, only these people may take ${esc(k.firstName)}. Anyone else only after the school has confirmed it with a parent.</small>`,
    });
  }

  // "Running late": an important notice to the families on this route (pushed to those who agreed)
  async function runningLate() {
    const kinds = await api.transport.runningLateKinds().catch(() => Object.keys(LATE_LABEL));
    const sent = await formModal({
      title: 'Tell the families', submitLabel: 'Send to the families',
      fieldsHtml: `<fieldset class="field" style="border:0;padding:0;margin:0 0 12px"><legend class="lbl" style="font-size:.82rem;font-weight:800">${esc(route.name)}</legend>
        ${kinds.map((k, i) => `<label class="check"><input type="radio" name="kind" value="${esc(k)}"${i === 0 ? ' checked' : ''}> ${esc(LATE_LABEL[k] || k)}</label>`).join('')}</fieldset>
        <label class="field"><span class="lbl">Reason (optional)</span><input name="reason" maxlength="120" placeholder="For example: heavy traffic"></label>
        <small>Every family on this route gets it as an important notice.</small>`,
      onSubmit: async (v) => {
        if (!v.kind) throw new Error('Choose how late the bus is');
        const reason = String(v.reason || '').trim();
        await api.transport.runningLate({ routeId: route.id, kind: v.kind, ...(reason ? { reason } : {}) });
      },
    });
    if (sent) toast('The families on this route were told');
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

  // the stop's pin from the bus's own GPS, standing at the stop ("arrived" fires within 60 m of the pin)
  const hereNow = () => new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
    (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
    (err) => reject(new Error(err.message || 'No position')), { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }));
  async function setStopHere(stopId, name) {
    if (!(await confirmDialog('Set the stop position', `Use where the bus is now as the position of ${name}? Do this only when the bus is standing at the stop. It needs a GPS reading accurate to 25 m or better.`, { okLabel: 'Use this position' }))) return;
    let fix;
    try { fix = await hereNow(); } catch (err) { toast(`Could not read the position: ${err.message}`, 'bad'); return; }
    await attempt(() => api.setup.setStopPosition({ routeId: route.id, stopId, ...fix }), `Position of ${name} saved (accuracy ${Math.round(fix.accuracy)} m)`);
  }

  ctx.el.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.setpos) { await setStopHere(t.dataset.setpos, t.dataset.name); return; }
    if (t.dataset.people) { await showPeople(kids.find((k) => k.id === t.dataset.people)); return; }
    if (t.id === 'd-late') { await runningLate(); return; }
    if (t.dataset.confirmAbsent != null) {
      for (const k of kids.filter((x) => absentIds.has(x.id) && !check?.last?.[x.id])) {
        const r = await attempt(() => api.transport.markChild(trip.id, { studentId: k.id, stopId: k.stopId, type: 'absent' }));
        if (!r.ok) break;
      }
      await refresh();
      return;
    }
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
      const mark = { studentId: t.dataset.child, stopId: t.dataset.stop, type: t.dataset.type };
      if (mark.type === 'dropped') {
        const by = await pickReceiver(kids.find((k) => k.id === mark.studentId), mark.stopId);
        if (by === undefined) return; // closed: nothing recorded, the buttons stay
        if (by) mark.receivedBy = by;
      }
      const r = await attempt(() => api.transport.markChild(trip.id, mark));
      if (r.ok && mark.receivedBy?.kind === 'contact') usual.set(mark.studentId, { kind: 'contact', contactId: mark.receivedBy.id });
      else if (r.ok && mark.receivedBy) usual.set(mark.studentId, mark.receivedBy);
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
