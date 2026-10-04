// POST /command {name, args, requestId} → {result}. Every write of the app (and the server-side reads that need
// data the caller's RLS cannot see, e.g. import previews) runs here: load slice → authorize → domain → persist
// (rev check). requestId (required; client-made, one per user action): a repeat of a committed request returns the
// stored result.
// Photos (Phase 3): register → a 2-hour upload grant for the one server-chosen path (never in the stored replay copy);
// complete → the object is read and checked here first (a refused file, or any file once photo consent no longer
// holds, is deleted), the verdict goes in as ctx.objectInfo; remove → the object is deleted at once (cron retries a failure); viewUrl → a 120-second download
// path, readOnly so it is never stored.

import { body, coded, serve } from '../_shared/http.ts';
import { caller } from '../_shared/authz.ts';
import { runCommand } from '../_shared/persist.ts';
import { fanOut } from '../_shared/push.ts';
import { finishErasure } from '../_shared/erasure.ts';
import { signUpload, signView, verifyUpload, cleanupDeleting, deleteObjects, deleteIfRejected } from '../_shared/photos.ts';
import { COMMANDS } from '../_shared/domain/commands.js';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const normaliseCode = (c: unknown) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
async function sha256Hex(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
}
function newInviteCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const raw = Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join(''); // 31^10 ≈ 8·10^14
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

serve(async (req) => {
  const who = await caller(req);
  const { name, args = [], requestId } = await body(req);
  if (typeof name !== 'string' || !(COMMANDS as any)[name]) throw coded('NOT_FOUND', `Unknown command: ${name}`);
  // every call names its request (one id per user action; the browser retries with the same id), so a repeated
  // request can never write twice
  if (requestId == null || requestId === '') throw coded('BAD_REQUEST', 'requestId is required');
  // demo-only commands (the mock online payment) never run on the server: money moves only through the gateway
  if ((COMMANDS as any)[name].demoOnly) throw coded('NOT_ALLOWED', 'This action exists only in the demo; online payments go through the payment gateway');
  const extra: { ctx?: Record<string, unknown>; hints?: Record<string, unknown>; requestId?: unknown } = { requestId };
  if (name === 'admin.inviteCode') {
    const code = newInviteCode();
    extra.ctx = { inviteCode: code, inviteCodeHash: await sha256Hex(normaliseCode(code)) };
  }
  if (name === 'auth.redeemInvite') {
    if (who.kind !== 'user' || !who.user.email) throw coded('UNAUTHENTICATED', 'Sign in with your email first');
    extra.ctx = { inviteCodeHash: await sha256Hex(normaliseCode(args[0])) };
    extra.hints = { auditRedeemFailedBy: who.user.id };
  }
  let completing: { photoId: string; path: string } | null = null;
  if (name === 'photos.complete') {
    // authorize first (the same check as complete), and only then touch the object
    const t = (await runCommand('photos.uploadTarget', args, who)).result;
    completing = { photoId: t.photoId, path: t.path };
    if (t.status !== 'pending') extra.ctx = { objectInfo: null };
    else if (!t.consentOk) { await deleteObjects([t.path]); extra.ctx = { objectInfo: { objectDeleted: true } }; } // complete rejects the row
    else extra.ctx = { objectInfo: await verifyUpload(t.path) };
  }
  let run;
  try {
    run = await runCommand(name, args, who, extra);
  } finally {
    // whatever made complete reject the row (the file check, or consent withdrawn after that check: audit R2), its
    // object is deleted before the caller gets the answer; the 15-minute photosCleanup retries a failure
    if (completing) await deleteIfRejected(completing.photoId, completing.path);
  }
  if (!run.replayed) await fanOut(name, run);
  if (name === 'photos.register' && !run.replayed && run.result && run.result.path) {
    try { return { result: { ...run.result, upload: await signUpload(run.result.path) } }; } catch (e: any) {
      console.error('photos.register: upload grant failed:', e?.message);
      return { result: { ...run.result, upload: null, uploadError: 'The upload could not be prepared; add the photo again.' } };
    }
  }
  if (name === 'photos.remove' && run.result && run.result.photo) {
    let cleanup: any;
    try { cleanup = await cleanupDeleting([run.result.photo.id]); } catch (e: any) { cleanup = { errors: [String(e?.message || e)] }; }
    if (cleanup.errors?.length) console.error('photos.remove: object deletion failed; cron retries:', cleanup.errors.join('; '));
    return { result: { ...run.result, objectDeleted: !cleanup.errors?.length && cleanup.finished > 0 } };
  }
  if (name === 'photos.viewUrl') return { result: { photoId: run.result.photoId, ...(await signView(run.result.path)) } };
  if (name === 'people.anonymiseGuardian' && run.result) {
    return { result: { ...run.result, server: await finishErasure(run.result.guardianId, run.result.revokedUserIds || []) } };
  }
  return { result: run.result };
});
