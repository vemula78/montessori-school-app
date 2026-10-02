// Ids, document numbers and the coded error type shared by all domain modules.

export class DomainError extends Error {
  /** @param {string} code  @param {string} message  @param {any} [details] */
  constructor(code, message, details) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** Throw a coded error. */
export function fail(code, message, details) {
  throw new DomainError(code, message, details);
}

let seq = 0;
/** Unique id with a readable prefix, e.g. newId('pay') → 'pay-lx2k9f-0001-a3f9'. */
export function newId(prefix) {
  seq = (seq + 1) % 1679616; // 36^4
  const bytes = new Uint8Array(3);
  globalThis.crypto.getRandomValues(bytes);
  const rnd = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36).padStart(4, '0')}-${rnd}`;
}

/** 'AY2026-27' → '26-27'. Throws on any other shape. */
export function ayShort(academicYearId) {
  const m = /^AY\d{2}(\d{2})-(\d{2})$/.exec(academicYearId || '');
  if (!m) fail('VALIDATION', `Unrecognised academic year id: ${academicYearId}`);
  return `${m[1]}-${m[2]}`;
}

/** 'RCP', 'AY2026-27', 7 → 'RCP/26-27/0007' */
export function formatDocNumber(prefix, academicYearId, n) {
  return `${prefix}/${ayShort(academicYearId)}/${String(n).padStart(4, '0')}`;
}

/** 'RCP/26-27/0007' → {prefix:'RCP', ay:'26-27', n:7} or null. */
export function parseDocNumber(str) {
  const m = /^([A-Z]+)\/(\d{2}-\d{2})\/(\d{4,})$/.exec(str || '');
  return m ? { prefix: m[1], ay: m[2], n: Number(m[3]) } : null;
}

/**
 * Take the next number for kind ('invoice'|'receipt'|'refund') in an academic year.
 * Mutates db.counters; call only inside storage.commit so the counter is freshly read.
 */
export function nextNumber(db, kind, academicYearId) {
  const prefix = { invoice: db.school.invoicePrefix, receipt: db.school.receiptPrefix, refund: db.school.refundPrefix || 'RFD' }[kind];
  if (!prefix) fail('VALIDATION', `Unknown counter kind: ${kind}`);
  const bucket = db.counters[kind] || (db.counters[kind] = {});
  const n = (bucket[academicYearId] || 0) + 1;
  bucket[academicYearId] = n;
  return formatDocNumber(prefix, academicYearId, n);
}
