// Realtime for the real app: postgres_changes (authorized by RLS for each subscriber, so a parent of another
// route — or one who withdrew bus_live consent — receives nothing).
//   trip feed  channel `trip-<routeId>`: INSERT trip_positions (trip_id=eq.<tripId>) → {type:'position', fix}
//                                       INSERT trip_child_events (trip_id=eq.<tripId>) → {type:'trip', trip}
//                                       trips changes (route_id=eq.<routeId>)       → {type:'trip', trip}
//   nudges     channel `app-changes`: messages, notices, invoices, payments, trips, trip_child_events → snapshot refetch
// Children's boarding/drop-off events live in trip_child_events (RLS: a parent receives only their own children's).

const NUDGE_TABLES = ['messages', 'notices', 'invoices', 'payments', 'trips', 'trip_child_events', 'observations', 'reports'];
const toFix = r => ({ lat: r.lat, lng: r.lng, accuracy: r.accuracy, ts: new Date(r.ts).toISOString() });

export function subscribeNudges(sb, onNudge, debounceMs = 500) {
  let timer = null;
  const fire = () => { clearTimeout(timer); timer = setTimeout(onNudge, debounceMs); };
  let ch = sb.channel('app-changes');
  for (const table of NUDGE_TABLES) ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, fire);
  ch.subscribe();
  return () => { clearTimeout(timer); sb.removeChannel(ch); };
}

/**
 * @param {() => string|null} currentTripId  the route's trip known from the snapshot (active or today's), if any
 * @param {(doc) => object} scopeTrip          trip doc → what this persona may see (positions omitted)
 */
export function subscribeTripFeed(sb, routeId, currentTripId, scopeTrip, fn) {
  let tripId = currentTripId();
  let lastDoc = null;
  let posCh = null;
  const deliver = ev => { try { fn(ev); } catch (e) { console.error(e); } };
  const tripEvent = doc => { const trip = scopeTrip(doc); delete trip.positions; deliver({ type: 'trip', trip }); };
  const watchPositions = id => {
    if (posCh) sb.removeChannel(posCh);
    posCh = null;
    if (!id) return;
    posCh = sb.channel(`trip-${routeId}-pos-${id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'trip_positions', filter: `trip_id=eq.${id}` }, p => deliver({ type: 'position', fix: toFix(p.new) }))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'trip_child_events', filter: `trip_id=eq.${id}` }, () => tripEvent(lastDoc && lastDoc.id === id ? lastDoc : { id }))
      .subscribe();
  };
  const tripCh = sb.channel(`trip-${routeId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'trips', filter: `route_id=eq.${routeId}` }, p => {
      const doc = p.new && p.new.doc;
      if (!doc) return;
      if (doc.id !== tripId && doc.status === 'active') { tripId = doc.id; watchPositions(tripId); }
      if (doc.id !== tripId) return;
      lastDoc = doc;
      const trip = scopeTrip(doc);
      delete trip.positions;
      deliver({ type: 'trip', trip });
    })
    .subscribe();
  watchPositions(tripId);
  return () => { sb.removeChannel(tripCh); if (posCh) sb.removeChannel(posCh); };
}
