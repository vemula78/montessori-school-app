// POST /rzp-webhook (no user JWT; verify_jwt=false in config.toml). Authenticated by X-Razorpay-Signature =
// HMAC-SHA256(raw body, webhook secret). Each x-razorpay-event-id is stored once: a replay is a 200 no-op.
// Processing errors still answer 200 (result 'error'); cron-daily retries them (we own retries).

import { CORS, errorResponse, json, coded } from '../_shared/http.ts';
import { rest } from '../_shared/db.ts';
import { gateway, settleEvent } from '../_shared/gateway.ts';
import { verifyWebhookSignature } from '../_shared/razorpay.js';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  try {
    if (req.method !== 'POST') throw coded('NOT_FOUND', 'POST only');
    const g = gateway();
    const raw = new Uint8Array(await req.arrayBuffer());
    if (!(await verifyWebhookSignature(raw, req.headers.get('x-razorpay-signature'), g.webhookSecret))) {
      throw coded('UNAUTHENTICATED', 'Invalid webhook signature');
    }
    const eventId = req.headers.get('x-razorpay-event-id');
    if (!eventId) throw coded('VALIDATION', 'x-razorpay-event-id header is missing');
    let payload: any;
    try { payload = JSON.parse(new TextDecoder().decode(raw)); } catch { throw coded('VALIDATION', 'Body is not JSON'); }
    const inserted = await rest('gateway_events?on_conflict=event_id', { method: 'POST', prefer: 'resolution=ignore-duplicates,return=representation',
      body: { event_id: eventId, event: String(payload.event || ''), payload } });
    if (!inserted || !inserted.length) return json({ ok: true, duplicate: true });
    const r = await settleEvent(inserted[0]);
    return json({ ok: true, result: r.result });
  } catch (e) {
    return errorResponse(e);
  }
});
