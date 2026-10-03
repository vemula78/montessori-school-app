// Razorpay helpers (plain JS: runs in Deno and under node tests). WebCrypto only, no SDK.
//   Checkout signature  = HMAC-SHA256(`${order_id}|${payment_id}`, key_secret)   (hex)
//   Webhook signature   = HMAC-SHA256(raw request body bytes, webhook_secret)     (hex)
// Comparison is constant-time over the full length. API base is configurable so local tests use the mock.

const enc = new TextEncoder();

async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes));
  return Array.from(sig, b => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string compare (length leak only, which is public: hex SHA-256 is always 64). */
export function timingSafeEqual(a, b) {
  const x = String(a ?? ''), y = String(b ?? '');
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

export async function signPayment(orderId, paymentId, keySecret) { return hmacHex(keySecret, `${orderId}|${paymentId}`); }
export async function signWebhook(rawBody, webhookSecret) { return hmacHex(webhookSecret, rawBody); }

export async function verifyPaymentSignature({ orderId, paymentId, signature }, keySecret) {
  if (!orderId || !paymentId || !signature || !keySecret) return false;
  return timingSafeEqual(await signPayment(orderId, paymentId, keySecret), String(signature).toLowerCase());
}
export async function verifyWebhookSignature(rawBody, signature, webhookSecret) {
  if (!signature || !webhookSecret) return false;
  return timingSafeEqual(await signWebhook(rawBody, webhookSecret), String(signature).toLowerCase());
}

/** Refuse to run with a live key in test mode or a test key in live mode (failure mode 11). */
export function checkKeyMode(keyId, mode) {
  if (!['test', 'live'].includes(mode)) throw new Error(`APP_GATEWAY_MODE must be test or live, not "${mode}"`);
  const prefix = `rzp_${mode}_`;
  if (!String(keyId || '').startsWith(prefix)) throw new Error(`RAZORPAY_KEY_ID does not start with ${prefix}: key and APP_GATEWAY_MODE disagree`);
  return mode;
}

export function razorpayClient({ keyId, keySecret, apiBase = 'https://api.razorpay.com', fetchImpl = fetch }) {
  const auth = `Basic ${btoa(`${keyId}:${keySecret}`)}`;
  async function call(method, path, body) {
    const res = await fetchImpl(`${apiBase}${path}`, { method, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    if (!res.ok) {
      const err = new Error(`Payment gateway ${method} ${path.replace(/\/[a-z]+_[A-Za-z0-9]+/g, '/…')} failed (${res.status}): ${data?.error?.description || 'no detail'}`);
      err.code = 'GATEWAY';
      throw err;
    }
    return data;
  }
  return {
    createOrder: ({ amountPaise, receipt, notes }) => call('POST', '/v1/orders', { amount: amountPaise, currency: 'INR', receipt, notes, partial_payment: false }),
    fetchPayment: id => call('GET', `/v1/payments/${encodeURIComponent(id)}`),
    orderPayments: async orderId => (await call('GET', `/v1/orders/${encodeURIComponent(orderId)}/payments`))?.items || [],
  };
}
