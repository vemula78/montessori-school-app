#!/usr/bin/env node
// Local stand-in for the Razorpay API (stdlib http only) so payments can be tested with no account and no
// network. Also a Web Push endpoint recorder for push tests. NEVER used outside local development.
//
//   node scripts/mock-razorpay.mjs                 serve on 127.0.0.1-and-LAN port 54399
//   node scripts/mock-razorpay.mjs --write-env     create supabase/.env.local with freshly invented local secrets
//                                                  (only if it does not exist; --force overwrites)
//
// Razorpay-shaped API (Basic auth key_id:key_secret from supabase/.env.local):
//   POST /v1/orders                     → order {id: order_…, amount, currency, receipt, status:'created'}
//   GET  /v1/orders/:id/payments        → {items:[payment…]}
//   GET  /v1/payments/:id               → payment
// Test controls (no auth; local only):
//   POST /__mock/pay {orderId, amount?, status?:'captured'|'failed', createdAt?}
//        → {payment, signature}  (signature = HMAC(order|payment, key secret), as Checkout returns it)
//   POST /__mock/refund {paymentId, amount, createdAt?} → refund entity
//   GET  /__mock/push-log               → recorded push deliveries [{path, headers, bytes}]
//   POST /push/<anything>               → 201 and recorded;  POST /push/gone/<…> → 410 (subscription expired)
// Edge functions reach this server from Docker (Colima) at http://host.lima.internal:<port>
// (fallback http://host.docker.internal:<port>), set as RAZORPAY_API_BASE in supabase/.env.local.

import { createServer } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vapidKeys } from './vapid-keys.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ENV_FILE = join(root, 'supabase/.env.local');
export const MOCK_PORT = Number(process.env.MOCK_RAZORPAY_PORT || 54399);

const alnum = n => { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; return Array.from(randomBytes(n), b => A[b % A.length]).join(''); };

export function readEnvFile(file = ENV_FILE) {
  if (!existsSync(file)) return null;
  const env = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  return env;
}

export function writeEnvFile({ force = false, host = 'host.lima.internal' } = {}) {
  if (existsSync(ENV_FILE) && !force) return { written: false, file: ENV_FILE };
  const v = vapidKeys();
  const lines = [
    '# LOCAL ONLY — invented test secrets for the mock gateway; gitignored. Never put real keys here.',
    `RAZORPAY_KEY_ID=rzp_test_${alnum(14)}`,
    `RAZORPAY_KEY_SECRET=${alnum(24)}`,
    `RAZORPAY_WEBHOOK_SECRET=${alnum(32)}`,
    'APP_GATEWAY_MODE=test',
    `RAZORPAY_API_BASE=http://${host}:${MOCK_PORT}`,
    `CRON_SECRET=${alnum(32)}`,
    `VAPID_PUBLIC_KEY=${v.publicKey}`,
    `VAPID_PRIVATE_KEY=${v.privateKey}`,
    'VAPID_SUBJECT=mailto:office@example.com',
  ];
  writeFileSync(ENV_FILE, `${lines.join('\n')}\n`, { mode: 0o600 });
  return { written: true, file: ENV_FILE };
}

export function startMock({ port = MOCK_PORT, env = readEnvFile() } = {}) {
  if (!env) throw new Error('supabase/.env.local is missing: run node scripts/mock-razorpay.mjs --write-env');
  const orders = new Map(), payments = new Map(), refunds = new Map();
  const pushLog = [];
  const auth = `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}`;
  const now = () => Math.floor(Date.now() / 1000);
  const send = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
  const rzpError = (res, status, description) => send(res, status, { error: { code: 'BAD_REQUEST_ERROR', description } });

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let body = {};
      try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { /* push bodies are binary */ }
      const url = new URL(req.url, 'http://mock');
      const path = url.pathname;
      if (path.startsWith('/push/')) {
        pushLog.push({ path, headers: { ...req.headers }, bytes: raw.length });
        return send(res, path.startsWith('/push/gone/') ? 410 : 201, {});
      }
      if (path === '/__mock/push-log') return send(res, 200, pushLog);
      if (path === '/__mock/pay' && req.method === 'POST') {
        const o = orders.get(body.orderId);
        if (!o) return rzpError(res, 404, 'order not found');
        const p = { id: `pay_${alnum(14)}`, entity: 'payment', amount: body.amount ?? o.amount, currency: 'INR', status: body.status || 'captured',
          order_id: o.id, method: 'upi', captured: (body.status || 'captured') === 'captured', created_at: body.createdAt ?? now(),
          error_description: body.status === 'failed' ? 'Payment declined (mock)' : null };
        payments.set(p.id, p);
        if (p.status === 'captured') { o.status = 'paid'; o.amount_paid = p.amount; }
        o.attempts++;
        const signature = createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(`${o.id}|${p.id}`).digest('hex');
        return send(res, 200, { payment: p, signature });
      }
      if (path === '/__mock/refund' && req.method === 'POST') {
        const p = payments.get(body.paymentId);
        if (!p) return rzpError(res, 404, 'payment not found');
        const r = { id: `rfnd_${alnum(14)}`, entity: 'refund', amount: body.amount, currency: 'INR', payment_id: p.id, status: 'processed', created_at: body.createdAt ?? now() };
        refunds.set(r.id, r);
        return send(res, 200, r);
      }
      if (req.headers.authorization !== auth) return rzpError(res, 401, 'The api key provided is invalid');
      if (path === '/v1/orders' && req.method === 'POST') {
        if (!Number.isSafeInteger(body.amount) || body.amount < 100) return rzpError(res, 400, 'amount must be an integer ≥ 100 paise');
        if (body.currency !== 'INR') return rzpError(res, 400, 'currency must be INR');
        const o = { id: `order_${alnum(14)}`, entity: 'order', amount: body.amount, amount_paid: 0, currency: 'INR', receipt: body.receipt ?? null,
          status: 'created', attempts: 0, notes: body.notes || {}, created_at: now() };
        orders.set(o.id, o);
        return send(res, 200, o);
      }
      let m;
      if ((m = /^\/v1\/orders\/([^/]+)\/payments$/.exec(path)) && req.method === 'GET') {
        if (!orders.has(m[1])) return rzpError(res, 404, 'order not found');
        return send(res, 200, { entity: 'collection', items: [...payments.values()].filter(p => p.order_id === m[1]) });
      }
      if ((m = /^\/v1\/payments\/([^/]+)$/.exec(path)) && req.method === 'GET') {
        const p = payments.get(m[1]);
        return p ? send(res, 200, p) : rzpError(res, 404, 'payment not found');
      }
      return rzpError(res, 404, `no mock route for ${req.method} ${path}`);
    });
  });
  return new Promise((resolve, reject) => server.once('error', reject).listen(port, '0.0.0.0', () => resolve({ server, port, orders, payments, refunds, pushLog, close: () => new Promise(r => { server.close(r); server.closeAllConnections(); }) })));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--write-env')) {
    const r = writeEnvFile({ force: process.argv.includes('--force') });
    console.log(r.written ? `wrote ${r.file} (local test secrets, gitignored)` : `${r.file} exists; left unchanged (use --force to replace)`);
  } else {
    const m = await startMock();
    console.log(`mock Razorpay listening on 0.0.0.0:${m.port} (functions reach it at the RAZORPAY_API_BASE in supabase/.env.local)`);
  }
}
