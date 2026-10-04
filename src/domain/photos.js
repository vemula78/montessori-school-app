// Photos of an observation: metadata rows only. The bytes live in the private Storage bucket (real app, reached only
// through signed URLs the `command` function mints after the registry authorized the caller) or in the browser's
// IndexedDB / an SVG illustration (demo). One photo ↔ one observation ↔ one child (a single studentId, no group field;
// the teacher confirms only this child is in the frame).
// Lifecycle: pending (registered, upload grant issued) → ready (server checked the bytes) | rejected (checks failed,
// object deleted) ; ready/pending → deleting (removed, consent withdrawn, retention) → deleted | expired (retention).
// Rows are never removed by these functions: a deleted photo's row is the evidence that it was deleted and when.
// Who may do what is checked by the registry (commands.js); these functions check state.

import { fail, newId } from './ids.js';
import { mustGet } from './people.js';
import { appendAudit } from './audit.js';

export const PHOTO_BUCKET = 'child-photos';
export const PHOTO_CAP = 100;                 // pending + ready photos per child; the teacher deletes to add more
export const PHOTO_MAX_BYTES = 400 * 1024;    // also the bucket's file_size_limit
export const PHOTO_MAX_EDGE = 1600;           // px; the client scales to a 1280 px long edge
export const UPLOAD_TTL_S = 7200;             // signed upload URL (fixed by Storage)
export const VIEW_TTL_S = 120;                // signed download URL, fetched at once by remote.js
export const PENDING_GRACE_MS = 2 * 3600_000; // a pending row (or an object without a ready row) older than this is swept
export const LIVE_STATUSES = ['pending', 'ready'];
export const TERMINAL_STATUSES = ['rejected', 'deleted', 'expired'];
export const RETENTION_REASON = 'retention';

const isInt = n => Number.isSafeInteger(n);

/**
 * Why the stored object is not acceptable, or null. info = what the server read from the object (jpeg.js):
 * {bytes, width, height, mime, hasExif, hasXmp}. Second line behind the client's canvas re-encode.
 */
export function objectProblem(info) {
  if (!info || typeof info !== 'object') return 'the upload was not checked';
  if (info.reason) return String(info.reason);
  if (info.mime !== 'image/jpeg') return 'not a JPEG image';
  if (info.hasExif || info.hasXmp) return 'the file carries camera/location metadata (EXIF/XMP)';
  if (!isInt(info.bytes) || info.bytes <= 0) return 'the file is empty';
  if (info.bytes > PHOTO_MAX_BYTES) return `the file is larger than ${PHOTO_MAX_BYTES / 1024} KiB`;
  if (!isInt(info.width) || !isInt(info.height) || info.width < 1 || info.height < 1) return 'the image size could not be read';
  if (info.width > PHOTO_MAX_EDGE || info.height > PHOTO_MAX_EDGE) return `the image is larger than ${PHOTO_MAX_EDGE} px on a side`;
  return null;
}

/** Live (pending + ready) photos of a child: what the per-child cap counts. */
export const livePhotoCount = (db, studentId) => (db.photos || []).filter(x => x.studentId === studentId && LIVE_STATUSES.includes(x.status)).length;

/**
 * A pending row for one photo of an observation. The caller (registry) has checked: staff role, child visible,
 * child active, photo consent, solo confirmation, cap. Path is chosen here, never by the client.
 */
export function registerPhoto(db, { observationId }, ctx) {
  const o = mustGet(db, 'observations', observationId, 'Observation');
  const id = newId('pho');
  const photo = {
    id, observationId: o.id, studentId: o.studentId, path: `${o.studentId}/${id}.jpg`, status: 'pending',
    bytes: null, width: null, height: null, sha256: null, takenBy: ctx.actor.id, createdAt: ctx.now, readyAt: null,
    soloConfirmedBy: ctx.actor.id, deleteReason: null, rejectReason: null, objectDeletedAt: null,
  };
  db.photos.push(photo);
  appendAudit(db, ctx, { entity: 'photo', entityId: id, action: 'register', summary: `photo for observation ${o.id} (student ${o.studentId}) registered` });
  return photo;
}

/**
 * Upload verified by the server (ctx.objectInfo) → ready, or rejected with the reason (the server deleted the object
 * first). Returns {photo} or {photo, failure} — a failure is committed (the row is rejected) and then reported.
 * An object that is not there yet changes nothing (the client may retry the upload with the same grant).
 * consentOk: photo consent for the child still holds (photoConsentFor); when it does not, the upload is rejected
 * whatever the file — consent can change between register and complete.
 */
export function completePhoto(db, photoId, info, ctx, consentOk = true) {
  const ph = mustGet(db, 'photos', photoId, 'Photo');
  if (ph.status === 'ready') return { photo: ph };
  if (ph.status !== 'pending') fail('VALIDATION', `This photo is ${ph.status}; add it again`);
  if (!consentOk) {
    const problem = 'photo consent no longer holds';
    Object.assign(ph, { status: 'rejected', rejectReason: problem, objectDeletedAt: info && info.objectDeleted ? ctx.now : null });
    appendAudit(db, ctx, { entity: 'photo', entityId: ph.id, action: 'reject', summary: `photo rejected: ${problem}` });
    return { photo: ph, failure: { code: 'VALIDATION', message: `Photo refused: ${problem}` } };
  }
  if (!info) fail('VALIDATION', 'The upload was not verified by the server');
  if (info.missing) fail('VALIDATION', 'No uploaded file was found for this photo; upload it again');
  const problem = objectProblem(info);
  if (problem) {
    Object.assign(ph, { status: 'rejected', rejectReason: problem, objectDeletedAt: info.objectDeleted ? ctx.now : null });
    appendAudit(db, ctx, { entity: 'photo', entityId: ph.id, action: 'reject', summary: `photo rejected: ${problem}` });
    return { photo: ph, failure: { code: 'VALIDATION', message: `Photo refused: ${problem}` } };
  }
  Object.assign(ph, { status: 'ready', bytes: info.bytes, width: info.width, height: info.height, sha256: info.sha256 ?? null, readyAt: ctx.now });
  appendAudit(db, ctx, { entity: 'photo', entityId: ph.id, action: 'ready', summary: `photo ready (${info.bytes} bytes, ${info.width}x${info.height})` });
  return { photo: ph };
}

/** pending/ready/rejected → deleting (the server then deletes the object). Already deleting/deleted: unchanged. */
export function markDeleting(db, photoId, reason, ctx) {
  const ph = mustGet(db, 'photos', photoId, 'Photo');
  if (['deleting', 'deleted', 'expired'].includes(ph.status)) return ph;
  Object.assign(ph, { status: 'deleting', deleteReason: String(reason || 'removed') });
  appendAudit(db, ctx, { entity: 'photo', entityId: ph.id, action: 'delete', summary: `photo marked for deletion (${ph.deleteReason})` });
  return ph;
}

/** The objects of these deleting rows are gone (or were never there): → deleted, or expired for retention. */
export function finishDelete(db, photoIds, ctx) {
  let finished = 0, skipped = 0;
  for (const id of [...new Set(photoIds || [])]) {
    const ph = (db.photos || []).find(x => x.id === id);
    if (!ph || ph.status !== 'deleting') { skipped++; continue; }
    Object.assign(ph, { status: ph.deleteReason === RETENTION_REASON ? 'expired' : 'deleted', objectDeletedAt: ctx.now });
    finished++;
  }
  if (finished) appendAudit(db, ctx, { entity: 'photo', entityId: '-', action: 'finishDelete', summary: `${finished} photo object(s) deleted, ${skipped} skipped` });
  return { finished, skipped };
}

/** Pending rows whose upload never completed (the sweep): → rejected with the reason. */
export function markRejected(db, photoIds, reason, ctx) {
  let rejected = 0, skipped = 0;
  for (const id of [...new Set(photoIds || [])]) {
    const ph = (db.photos || []).find(x => x.id === id);
    if (!ph || ph.status !== 'pending') { skipped++; continue; }
    Object.assign(ph, { status: 'rejected', rejectReason: String(reason || 'abandoned') });
    rejected++;
  }
  if (rejected) appendAudit(db, ctx, { entity: 'photo', entityId: '-', action: 'reject', summary: `${rejected} pending photo(s) rejected (${reason}), ${skipped} skipped` });
  return { rejected, skipped };
}

/**
 * Every live photo of a child whose photo consent no longer holds → deleting. consentOk(studentId) is
 * photoConsentFor bound to the db (commands.js). studentIds: the children to check (default: every child with photos).
 */
export function sweepConsent(db, consentOk, ctx, studentIds = null) {
  const ids = studentIds ? [...new Set(studentIds)] : [...new Set((db.photos || []).filter(x => LIVE_STATUSES.includes(x.status)).map(x => x.studentId))];
  let children = 0, photos = 0;
  for (const sid of ids) {
    const live = (db.photos || []).filter(x => x.studentId === sid && LIVE_STATUSES.includes(x.status));
    if (!live.length || consentOk(sid)) continue;
    children++;
    for (const ph of live) { Object.assign(ph, { status: 'deleting', deleteReason: 'photo consent withdrawn' }); photos++; }
  }
  if (photos) appendAudit(db, ctx, { entity: 'photo', entityId: '-', action: 'consentSweep', summary: `${photos} photo(s) of ${children} child(ren) without photo consent marked for deletion` });
  return { checked: ids.length, children, photos };
}

/** Photo metadata as a persona may see it (who may see the observation is checked by the caller). */
export const photoView = ph => ({ id: ph.id, observationId: ph.observationId, studentId: ph.studentId, status: ph.status, bytes: ph.bytes,
  width: ph.width, height: ph.height, createdAt: ph.createdAt, readyAt: ph.readyAt, takenBy: ph.takenBy, rejectReason: ph.rejectReason ?? null,
  deleteReason: ph.deleteReason ?? null, ...(ph.demo ? { demo: { ...ph.demo } } : {}) });
