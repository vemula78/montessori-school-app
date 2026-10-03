// Pay fees online (real app only). The amount is always decided by the server from the live invoice balances;
// this page only chooses which invoices (and optionally a smaller amount) and then opens the payment provider's
// Checkout window. Checkout's script cannot be self-hosted, so it is loaded here, lazily, and nowhere else.
import { rupeesToPaise } from '../../domain/money.js';
import { esc, money, banner, formModal, confirmDialog, toast, errMessage } from '../components.js';

const CHECKOUT_URL = 'https://checkout.razorpay.com/v1/checkout.js';
const PENDING_KEY = 'school.pay.pending.v1';
const MIN_PAISE = 10000; // Rs 100 floor for a part-payment
const isOpen = (i) => i.status !== 'cancelled' && i.status !== 'paid' && i.balancePaise > 0;

let checkoutPromise = null;
function loadCheckout() {
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  if (!checkoutPromise) {
    checkoutPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = window.__PAY_CHECKOUT_URL__ || CHECKOUT_URL; // the override exists only for local testing against a mock
      s.async = true;
      s.onload = () => (window.Razorpay ? resolve(window.Razorpay) : reject(new Error('The payment window did not load.')));
      s.onerror = () => { checkoutPromise = null; reject(new Error('Could not reach the payment provider. Check your connection and try again.')); };
      document.head.appendChild(s);
    });
  }
  return checkoutPromise;
}

// ---- a started-but-unconfirmed payment must survive the phone switching to a UPI app and back ----
const readPending = () => { try { return JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null'); } catch { return null; } };
const savePending = (p) => { try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(p)); } catch { /* the focus check still works for this page view */ } };
const clearPending = () => { try { sessionStorage.removeItem(PENDING_KEY); } catch { /* nothing to clear */ } };

let watch = null; // {orderId, timer, onVisible, started}
function stopWatch() {
  if (!watch) return;
  if (watch.timer) clearInterval(watch.timer);
  document.removeEventListener('visibilitychange', watch.onVisible);
  window.removeEventListener('focus', watch.onVisible);
  watch = null;
}

/** Ask the server what happened to an order; navigates to the receipt when it is paid. Returns the status string. */
async function checkOrder(ctx, orderId, { quiet = false } = {}) {
  let r;
  try { r = await ctx.api.fees.gatewayOrderStatus(orderId); } catch (e) { if (!quiet) toast(`Could not check the payment: ${errMessage(e)}`, 'bad'); return 'unknown'; }
  if ((r.status === 'paid' || r.status === 'amount_mismatch') && r.payment) {
    clearPending(); stopWatch();
    toast(r.status === 'paid' ? 'Payment received' : 'Payment received - the school office will check the amount');
    ctx.go(`/print/receipt/${r.payment.id}`);
  } else if (r.status === 'failed') {
    clearPending(); stopWatch();
    toast('The payment did not go through. Nothing was added to the fee account.', 'bad');
  }
  return r.status;
}

// Re-check when the tab regains focus (back from a UPI app / the bank page). With poll:true (a payment is known to
// have been made but not confirmed) also re-check every 8 seconds for up to 3 minutes.
function watchOrder(ctx, orderId, { poll = false } = {}) {
  stopWatch();
  const onVisible = () => { if (document.visibilityState === 'visible') checkOrder(ctx, orderId, { quiet: true }); };
  watch = { orderId, started: Date.now(), onVisible, timer: poll ? setInterval(() => {
    if (Date.now() - watch.started > 180000) { stopWatch(); return; }
    checkOrder(ctx, orderId, { quiet: true });
  }, 8000) : null };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
}

/** For the top of the parent fee page: HTML describing an earlier, unconfirmed payment (or ''). */
export async function resumePending(ctx) {
  const p = readPending();
  if (!p) return '';
  if (Date.now() - (p.at || 0) > 24 * 3600 * 1000) { clearPending(); return ''; }
  let r;
  try { r = await ctx.api.fees.gatewayOrderStatus(p.orderId); } catch (e) { return banner('warn', `<strong>Could not check an earlier payment.</strong> ${esc(errMessage(e))}`); }
  if ((r.status === 'paid' || r.status === 'amount_mismatch') && r.payment) {
    clearPending();
    return banner('ok', `<div class="row between"><span><strong>Your payment was received.</strong></span><a class="btn sm" href="#/print/receipt/${esc(r.payment.id)}">View receipt</a></div>`);
  }
  if (r.status === 'failed') { clearPending(); return banner('warn', '<strong>The last payment attempt did not go through.</strong> Nothing was added to the fee account. If your bank shows a debit, please tell the school office the time and amount.'); }
  if (Date.now() - (p.at || 0) > 15 * 60 * 1000) { clearPending(); return ''; } // abandoned long ago; a late capture still arrives by webhook
  watchOrder(ctx, p.orderId, { poll: true });
  return banner('info', '<strong>A payment is not confirmed yet.</strong> Please do not pay again for a few minutes - this page checks automatically.');
}

/**
 * @param {object} ctx screen context  @param {{id:string, firstName:string}} student  @param {object[]} invoices invoiceView rows
 */
export async function payOnline(ctx, student, invoices) {
  const open = invoices.filter(isOpen).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
  if (!open.length) { toast('Nothing is due for this child', 'bad'); return; }
  const byId = new Map(open.map((i) => [i.id, i]));
  let order = null;
  let expected = 0;

  const ok = await formModal({
    title: `Pay fees for ${student.firstName}`, submitLabel: 'Continue to payment',
    fieldsHtml: `<p class="muted">Choose what to pay. You will pay securely with the payment provider (UPI, card or net banking). The school never sees your card or bank details.</p>
      <fieldset style="border:1px solid var(--line);border-radius:12px;padding:8px 12px;margin:0 0 12px"><legend style="font-weight:800;font-size:.82rem">Invoices</legend>
        ${open.map((i) => `<label class="check"><input type="checkbox" name="invoice" value="${esc(i.id)}" data-bal="${esc(i.balancePaise)}" checked><span>${esc(i.installmentName)} <small>${esc(i.number)} &middot; ${money(i.balancePaise)}</small></span></label>`).join('')}</fieldset>
      <div class="kpi" style="margin-bottom:12px"><div class="v" id="po-total">${money(open.reduce((s, i) => s + i.balancePaise, 0))}</div><div class="l">to pay now</div></div>
      <label class="field"><span class="lbl">Pay a smaller amount instead (optional, &#8377; 100 or more)</span><input name="amount" inputmode="decimal" placeholder="leave empty to pay the full amount"></label>
      <small>A smaller amount is applied to the oldest due invoice first.</small>`,
    onOpen: (d) => {
      const total = () => [...d.querySelectorAll('input[name=invoice]:checked')].reduce((s, c) => s + Number(c.dataset.bal), 0);
      d.addEventListener('change', () => { d.querySelector('#po-total').textContent = money(total()); });
    },
    onSubmit: async (v) => {
      const ids = [].concat(v.invoice ?? []);
      if (!ids.length) throw new Error('Tick at least one invoice.');
      const total = ids.reduce((s, id) => s + byId.get(id).balancePaise, 0);
      let amountPaise;
      if (String(v.amount || '').trim()) {
        amountPaise = rupeesToPaise(v.amount);
        if (amountPaise === null || amountPaise < MIN_PAISE) throw new Error('Enter an amount of ₹100 or more.');
        if (amountPaise > total) throw new Error(`That is more than the ${money(total)} due on the ticked invoices.`);
        if (amountPaise === total) amountPaise = undefined;
      }
      expected = amountPaise ?? total;
      order = await ctx.api.fees.createGatewayOrder({ studentId: student.id, invoiceIds: ids, ...(amountPaise !== undefined ? { amountPaise } : {}) });
    },
  });
  if (!ok || !order) return;

  // the server worked the amount out from the live balances: if it moved since this page loaded, say so before opening Checkout
  if (order.amountPaise !== expected) {
    const go = await confirmDialog('The amount has changed', `The amount payable is now ${money(order.amountPaise)} (this page showed ${money(expected)}). Another payment or a change by the school office may have happened. Continue with ${money(order.amountPaise)}?`, { okLabel: `Pay ${money(order.amountPaise)}` });
    if (!go) return;
  }

  let Razorpay;
  try { Razorpay = await loadCheckout(); } catch (e) { toast(errMessage(e), 'bad'); return; }
  savePending({ orderId: order.orderId, studentId: student.id, at: Date.now() });

  const rzp = new Razorpay({
    key: order.keyId,
    order_id: order.orderId,
    amount: order.amountPaise,
    currency: 'INR',
    name: ctx.db?.school?.name || 'School fees',
    description: `School fees - ${student.firstName}`,
    prefill: order.prefill || {},
    theme: { color: '#B3472F' },
    modal: { confirm_close: true, ondismiss: () => { checkOrder(ctx, order.orderId, { quiet: true }); } }, // closed the window: it may still have gone through
    handler: async (resp) => {
      try {
        const pay = await ctx.api.fees.verifyGatewayPayment({ orderId: resp.razorpay_order_id, razorpayPaymentId: resp.razorpay_payment_id, razorpaySignature: resp.razorpay_signature });
        clearPending(); stopWatch();
        toast('Payment received');
        ctx.go(`/print/receipt/${pay.id}`);
      } catch (e) {
        // the provider took the payment; we could not confirm it right now. Never tell the parent it failed.
        toast('Your payment was made but is not confirmed yet. Please do not pay again - checking...', 'bad');
        watchOrder(ctx, order.orderId, { poll: true });
      }
    },
  });
  rzp.on('payment.failed', (resp) => {
    clearPending(); // the provider said it failed: nothing to wait for
    toast(`Payment failed: ${resp?.error?.description || 'the bank did not accept it'}. You can try again.`, 'bad');
  });
  watchOrder(ctx, order.orderId);
  rzp.open();
}
