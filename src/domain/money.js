// Money is always integer paise. No floats, no Intl (deterministic in Node tests).

import { fail } from './ids.js';

/** Returns n if it is a safe integer, else throws INVALID_AMOUNT. */
export function assertPaise(n) {
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) fail('INVALID_AMOUNT', `Not an integer paise amount: ${n}`);
  return n;
}

/** Parse a rupee string like "1,234.50", "₹ 1234", "50" into paise. Returns null if not a valid amount. */
export function rupeesToPaise(str) {
  if (str === null || str === undefined) return null;
  const s = String(str).replace(/[₹,\s]/g, '').replace(/^Rs\.?/i, '');
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const paise = Number(m[2]) * 100 + Number((m[3] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(paise)) return null;
  return m[1] ? -paise : paise;
}

/** Indian digit grouping of a non-negative integer string: 1234567 → '12,34,567'. */
function groupIndian(digits) {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const parts = [];
  while (rest.length > 2) { parts.unshift(rest.slice(-2)); rest = rest.slice(0, -2); }
  if (rest) parts.unshift(rest);
  return `${parts.join(',')},${last3}`;
}

/** 123456789 → '₹12,34,567.89'; negative → '−₹…' (U+2212). null/undefined → '—' (missing, never 0). */
export function formatPaise(paise, { symbol = true } = {}) {
  if (paise === null || paise === undefined) return '—';
  assertPaise(paise);
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  const body = `${groupIndian(String(rupees))}.${String(p).padStart(2, '0')}`;
  return `${neg ? '−' : ''}${symbol ? '₹' : ''}${body}`;
}

const ONES = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven',
  'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function under100(n) {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : '');
}

/** Words for a positive integer in the Indian system (crore/lakh/thousand/hundred). */
function intWords(n) {
  const parts = [];
  const crore = Math.floor(n / 10000000);
  n %= 10000000;
  if (crore) parts.push(`${intWords(crore)} Crore`);
  const lakh = Math.floor(n / 100000); n %= 100000;
  if (lakh) parts.push(`${under100(lakh)} Lakh`);
  const thousand = Math.floor(n / 1000); n %= 1000;
  if (thousand) parts.push(`${under100(thousand)} Thousand`);
  const hundred = Math.floor(n / 100); n %= 100;
  if (hundred) parts.push(`${ONES[hundred]} Hundred`);
  if (n) parts.push(under100(n));
  return parts.join(' ');
}

/** 1000100100 → 'Rupees One Crore One Thousand One Only'; 50 → 'Rupees Zero and Paise Fifty Only'. */
export function amountInWords(paise) {
  assertPaise(paise);
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  const r = rupees === 0 ? 'Zero' : intWords(rupees);
  return `${neg ? 'Minus ' : ''}Rupees ${r}${p ? ` and Paise ${under100(p)}` : ''} Only`;
}

/** paise × basisPoints / 10000, rounded half-up (away from zero), integer arithmetic only. */
export function percentOf(paise, bp) {
  assertPaise(paise);
  assertPaise(bp);
  const prod = paise * bp;
  assertPaise(prod);
  const sign = prod < 0 ? -1 : 1;
  const a = Math.abs(prod);
  const q = Math.floor(a / 10000);
  const r = a - q * 10000;
  return sign * (r * 2 >= 10000 ? q + 1 : q);
}

/** Sum of paise amounts; every element must be an integer. */
export function sumPaise(arr) {
  let s = 0;
  for (const x of arr) s += assertPaise(x);
  return assertPaise(s);
}
