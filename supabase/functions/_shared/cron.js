// Pure rules of the cron-daily function (node-testable; the function itself is Deno TypeScript).

export const PRIVACY_STEPS = ['photosConsentSweep', 'retention', 'photosCleanup', 'erasureCleanup', 'filesCleanup'];

/**
 * The steps of this run that failed: a step that threw; a privacy step that reports errors[] or failed > 0 (audit R3);
 * gateway events that reached the retry cap (a payment or refund nobody will retry again needs a person).
 */
export function failedStepsOf(report, steps) {
  return steps.filter(k => {
    const r = report[k];
    if (!r) return false;
    if (r.error !== undefined) return true;
    if (PRIVACY_STEPS.includes(k) && ((Array.isArray(r.errors) && r.errors.length > 0) || Number(r.failed) > 0)) return true;
    return k === 'gatewayRetries' && Number(r.gaveUp) > 0;
  });
}

/**
 * How a claimed fee reminder is finished. one = this message's {sent, failed}; skipped = the push report's reason for
 * sending nothing at all (VAPID keys not configured). Without keys the reminder stays 'failed', so the next run claims
 * it again and pushes it once keys exist (within the catch-up window); 'sent' would settle it for good, never pushed.
 * No subscribed device (sent 0, failed 0, not skipped) is 'sent': the in-app list is then the reminder.
 */
export function reminderStatus(one, skipped) {
  if (skipped) return { status: 'failed', error: `not pushed: ${skipped}` };
  return one.failed ? { status: 'failed', error: `${one.failed} device(s) failed` } : { status: 'sent', error: null };
}

/**
 * The dead-man check address (function secret HEALTHCHECK_URL, e.g. a healthchecks.io ping URL) for this run, or null:
 * https only, no credentials; a failed run pings `<url>/fail`. A run that never happens pings nothing, and the
 * service emails its owner when the expected ping does not arrive.
 */
export function healthcheckUrl(base, ok) {
  let u;
  try { u = new URL(String(base || '')); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const s = u.href;
  return ok ? s : `${s.replace(/\/+$/, '')}/fail`;
}
