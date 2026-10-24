// Notice attachments (#12/#84): up to three PDF, JPEG or PNG files per notice, at most 2 MB each. School documents, not
// child images, so photo consent does not apply. The bytes are in the PRIVATE bucket `notice-files` (no storage
// policies; the command function signs a 60-second download for someone who may read the notice) or, in the demo, in
// the browser's IndexedDB. These rows are metadata only.
// Lifecycle: a file is uploaded first ('staged', visible to its uploader only), then bound to the notice when it is sent
// or corrected ('attached'); a staged file not used within 24 hours, a discarded one and one dropped by a correction
// become 'removed' and their object is deleted (objectDeletedAt). A parent never gets the file of a withdrawn notice.

import { fail, newId } from './ids.js';
import { mustGet } from './people.js';
import { tsToMs } from './dates.js';
import { cleanFileName } from './files.js';

export const NOTICE_FILE_BUCKET = 'notice-files';
export const NOTICE_FILE_MAX_BYTES = 2 * 1024 * 1024;
export const NOTICE_FILE_MIMES = ['application/pdf', 'image/jpeg', 'image/png'];
export const NOTICE_FILES_MAX = 3;
export const NOTICE_FILE_VIEW_TTL_S = 60;
export const STAGED_TTL_MS = 24 * 3600_000;

/** A file as screens see it (no storage path). */
export const noticeFileView = f => ({ id: f.id, noticeId: f.noticeId, name: f.name, mime: f.mime, bytes: f.bytes, width: f.width ?? null, height: f.height ?? null,
  status: f.status, uploadedBy: f.uploadedBy, uploadedAt: f.uploadedAt });

/** upload({name}) with the server's verdict on the bytes (fileInfo) → a staged file of the uploader. */
export function stageNoticeFile(db, { name } = {}, fileInfo, ctx) {
  if (!fileInfo || !fileInfo.path || !NOTICE_FILE_MIMES.includes(fileInfo.mime)) fail('VALIDATION', 'The file did not arrive; choose it again');
  const f = { id: newId('nfl'), noticeId: null, name: cleanFileName(name, fileInfo.mime), mime: fileInfo.mime, bytes: fileInfo.bytes ?? null, sha256: fileInfo.sha256 ?? null,
    width: fileInfo.width ?? null, height: fileInfo.height ?? null, path: String(fileInfo.path), status: 'staged', uploadedBy: ctx.actor.id, uploadedAt: ctx.now,
    attachedAt: null, removedAt: null, objectDeletedAt: null };
  db.noticeFiles.push(f);
  return noticeFileView(f);
}

/** Bind these staged files of the actor to the notice (at most three attached in all). Returns the attached rows. */
export function attachNoticeFiles(db, notice, ids, ctx) {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids)) fail('VALIDATION', 'attachmentIds must be a list');
  const unique = [...new Set(ids.map(String))];
  const already = db.noticeFiles.filter(f => f.noticeId === notice.id && f.status === 'attached');
  const fresh = unique.filter(id => !already.some(f => f.id === id));
  if (already.length + fresh.length > NOTICE_FILES_MAX) fail('VALIDATION', `A notice can carry at most ${NOTICE_FILES_MAX} files`);
  return fresh.map(id => {
    const f = mustGet(db, 'noticeFiles', id, 'File');
    if (f.status !== 'staged') fail('VALIDATION', 'That file is already used or was removed; add it again');
    if (f.uploadedBy !== ctx.actor.id) fail('NOT_ALLOWED', 'You can attach only files you uploaded');
    Object.assign(f, { noticeId: notice.id, status: 'attached', attachedAt: ctx.now });
    return f;
  });
}

/** The notice's attached files become exactly `ids` (a correction): dropped ones are removed, new staged ones attached. */
export function setNoticeFiles(db, notice, ids, ctx) {
  if (!Array.isArray(ids)) fail('VALIDATION', 'attachmentIds must be a list');
  const keep = new Set(ids.map(String));
  const removed = [];
  for (const f of db.noticeFiles.filter(x => x.noticeId === notice.id && x.status === 'attached' && !keep.has(x.id))) {
    Object.assign(f, { status: 'removed', removedAt: ctx.now });
    removed.push(f.id);
  }
  const added = attachNoticeFiles(db, notice, [...keep], ctx).map(f => f.id);
  return { added, removed };
}

/** discard(fileId) — a staged file its uploader (or the principal) no longer wants. */
export function discardNoticeFile(db, id, ctx) {
  const f = mustGet(db, 'noticeFiles', id, 'File');
  if (f.status !== 'staged') fail('VALIDATION', 'Only a file not yet sent can be discarded; correct the notice instead');
  Object.assign(f, { status: 'removed', removedAt: ctx.now });
  return { removed: f.id };
}

/** System: staged files older than 24 hours are removed (their objects are deleted after). */
export function expireStagedFiles(db, ctx) {
  const now = tsToMs(ctx.now);
  const ids = [];
  for (const f of db.noticeFiles) {
    if (f.status === 'staged' && now - tsToMs(f.uploadedAt) > STAGED_TTL_MS) { Object.assign(f, { status: 'removed', removedAt: ctx.now }); ids.push(f.id); }
  }
  return { expired: ids.length, ids };
}

/** System: the objects of these removed files are gone. */
export function finishNoticeFileDelete(db, ids = [], ctx) {
  let finished = 0;
  for (const id of new Set(ids)) {
    const f = db.noticeFiles.find(x => x.id === id);
    if (f && f.status === 'removed' && !f.objectDeletedAt) { f.objectDeletedAt = ctx.now; finished++; }
  }
  return { finished };
}

/** The files of a notice, in the order they were attached. */
export const filesOfNotice = (db, noticeId) => (db.noticeFiles || []).filter(f => f.noticeId === noticeId && f.status === 'attached')
  .sort((a, b) => (a.attachedAt < b.attachedAt ? -1 : a.attachedAt > b.attachedAt ? 1 : a.id < b.id ? -1 : 1)).map(noticeFileView);
