// Erasure steps outside the domain transaction, shared by the command function (right after
// people.anonymiseGuardian) and cron-daily (retries). The links are already revoked in that transaction, so access is
// gone even if a step here fails; the erasure request stays 'cleanup' with the error until every step succeeds.

import { deleteAuthUser, rest, restAll } from './db.ts';
import { runCommand } from './persist.ts';
import { system } from './authz.ts';

// payer details Razorpay puts in payment/refund entities; scrubbed from stored webhook payloads on erasure
const PAYER_FIELDS = ['email', 'contact', 'vpa', 'card', 'bank_account', 'notes', 'customer_id', 'token_id', 'upi'];

async function eraseServerSide(guardianId: string, userIds: string[]) {
  const out = { authUsersDeleted: 0, gatewayEventsScrubbed: 0, errors: [] as string[] };
  for (const id of userIds) {
    try { await deleteAuthUser(id); out.authUsersDeleted++; } catch (e: any) { out.errors.push(String(e?.message || e)); }
  }
  try {
    const orders = new Set((await restAll(`gateway_orders?guardian_id=eq.${encodeURIComponent(guardianId)}&select=id&order=id`)).map((o: any) => o.id));
    if (orders.size) {
      const pays = new Set((await restAll('payments?gateway_payment_id=not.is.null&select=gateway_payment_id,doc->>gatewayOrderId&order=id'))
        .filter((p: any) => orders.has(p.gatewayOrderId)).map((p: any) => p.gateway_payment_id));
      for (const ev of await restAll('gateway_events?select=event_id,payload&order=event_id')) {
        const ent = ev.payload?.payload?.payment?.entity || ev.payload?.payload?.refund?.entity;
        if (!ent || !(orders.has(ent.order_id) || pays.has(ent.payment_id) || pays.has(ent.id))) continue;
        const scrub = (x: any) => { if (x && typeof x === 'object') for (const f of PAYER_FIELDS) if (f in x) x[f] = null; };
        scrub(ev.payload?.payload?.payment?.entity); scrub(ev.payload?.payload?.refund?.entity);
        await rest(`gateway_events?event_id=eq.${encodeURIComponent(ev.event_id)}`, { method: 'PATCH', body: { payload: ev.payload } });
        out.gatewayEventsScrubbed++;
      }
    }
  } catch (e: any) { out.errors.push(String(e?.message || e)); }
  return out;
}

/** Run the server steps, then record the outcome on the erasure request (done, or still cleanup with the error). */
export async function finishErasure(guardianId: string, userIds: string[]) {
  const out = await eraseServerSide(guardianId, userIds);
  const r = await runCommand('people.finishErasure', [guardianId, { errors: out.errors }], system('erasure'));
  return { ...out, requestDone: r.result.done };
}
