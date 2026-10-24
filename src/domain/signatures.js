// Signature images printed on the annual Progress Report: one per staff member (class teachers, the principal as
// "Center Head") and the school's director. A signature is sensitive: the bytes live in the PRIVATE Storage bucket
// `signatures` (no storage policies; the command function signs a 60-second download for the print view only) or, in the
// demo, in the browser's IndexedDB / a drawn fake SVG. These rows are metadata only.
// The current signature of an owner is its one 'ready' row (currentSignature); uploading a new one marks the previous
// one 'removed', and the command function deletes its object at once (objectDeletedAt; cron retries a failure).
// Who may upload: the principal, for any staff member and the director; a teacher, their own. Checked by the registry.
// Audit rows carry ids, never images or names.

import { fail, newId } from './ids.js';
import { byId, fullName } from './people.js';
import { appendAudit } from './audit.js';

export const SIGNATURE_BUCKET = 'signatures';
export const SIGNATURE_MAX_BYTES = 200 * 1024;
export const SIGNATURE_MAX_EDGE = 2000;
export const SIGNATURE_MIMES = ['image/png', 'image/jpeg'];
export const SIGNATURE_VIEW_TTL_S = 60;

/** {kind:'staff', staffId} | {kind:'director'} → a clean owner (the staff member must exist). */
export function cleanOwner(db, owner) {
  if (!owner || typeof owner !== 'object') fail('VALIDATION', 'Say whose signature this is');
  if (owner.kind === 'director') return { kind: 'director', staffId: null };
  if (owner.kind === 'staff') {
    const s = byId(db.staff, owner.staffId);
    if (!s) fail('NOT_FOUND', 'Staff member not found');
    return { kind: 'staff', staffId: s.id };
  }
  return fail('VALIDATION', `Unknown signature owner: ${owner.kind}`);
}
const sameOwner = (sig, o) => sig.ownerKind === o.kind && (sig.staffId ?? null) === (o.staffId ?? null);

/** The owner's current (ready) signature row, or null. */
export function currentSignature(db, owner) {
  return (db.signatures || []).find(x => x.status === 'ready' && sameOwner(x, owner)) || null;
}

/**
 * save({owner}) with the server's verdict on the bytes in fileInfo ({path, mime, bytes, sha256, width?, height?}; the
 * demo passes its own). The previous ready signature of the owner is marked removed (its object is deleted after).
 */
export function saveSignature(db, { owner } = {}, fileInfo, ctx) {
  const o = cleanOwner(db, owner);
  if (!fileInfo || !fileInfo.path || !SIGNATURE_MIMES.includes(fileInfo.mime)) fail('VALIDATION', 'The signature image did not arrive; choose the file again');
  const prev = currentSignature(db, o);
  if (prev) Object.assign(prev, { status: 'removed', removedBy: ctx.actor.id, removedAt: ctx.now });
  const sig = { id: newId('sig'), ownerKind: o.kind, staffId: o.staffId, path: String(fileInfo.path), mime: fileInfo.mime, bytes: fileInfo.bytes ?? null,
    sha256: fileInfo.sha256 ?? null, width: fileInfo.width ?? null, height: fileInfo.height ?? null, status: 'ready', uploadedBy: ctx.actor.id, uploadedAt: ctx.now,
    removedBy: null, removedAt: null, objectDeletedAt: null, ...(fileInfo.demo ? { demo: fileInfo.demo } : {}) };
  db.signatures.push(sig);
  appendAudit(db, ctx, { entity: 'signature', entityId: sig.id, action: 'upload', summary: `signature for ${o.kind === 'director' ? 'the director' : `staff ${o.staffId}`} uploaded${prev ? ` (replaces ${prev.id})` : ''}` });
  return { signature: signatureView(db, sig), replaced: prev ? prev.id : null };
}

/** remove({owner}) — the owner's current signature is removed (its object is deleted after). */
export function removeSignature(db, { owner } = {}, ctx) {
  const o = cleanOwner(db, owner);
  const cur = currentSignature(db, o);
  if (!cur) fail('NOT_FOUND', 'There is no signature to remove');
  Object.assign(cur, { status: 'removed', removedBy: ctx.actor.id, removedAt: ctx.now });
  appendAudit(db, ctx, { entity: 'signature', entityId: cur.id, action: 'remove', summary: `signature for ${o.kind === 'director' ? 'the director' : `staff ${o.staffId}`} removed` });
  return { removed: cur.id };
}

/** System: the objects of these removed rows are gone. */
export function finishSignatureDelete(db, ids = [], ctx) {
  let finished = 0;
  for (const id of new Set(ids)) {
    const x = byId(db.signatures || [], id);
    if (x && x.status === 'removed' && !x.objectDeletedAt) { x.objectDeletedAt = ctx.now; finished++; }
  }
  return { finished };
}

/** A row as the screens see it (no path). */
export function signatureView(db, x) {
  const s = x.staffId ? byId(db.staff, x.staffId) : null;
  return { id: x.id, ownerKind: x.ownerKind, staffId: x.staffId, ownerName: x.ownerKind === 'director' ? (db.school?.directorName || 'Director') : fullName(s),
    mime: x.mime, bytes: x.bytes, width: x.width, height: x.height, status: x.status, uploadedBy: x.uploadedBy, uploadedAt: x.uploadedAt };
}

/**
 * The signature desk: one row per person who signs reports (teachers, principals; the director), with whether a
 * signature is on file. The principal sees everyone; a teacher only themself.
 */
export function signatureList(db, p) {
  if (!p || !['admin', 'teacher'].includes(p.role)) fail('NOT_ALLOWED', 'Not available to you');
  const staff = db.staff.filter(s => ['admin', 'teacher'].includes(s.role) && s.active !== false && (p.role === 'admin' || s.id === p.staffId));
  const rows = staff.map(s => {
    const cur = currentSignature(db, { kind: 'staff', staffId: s.id });
    return { owner: { kind: 'staff', staffId: s.id }, name: fullName(s), role: s.role, signs: s.role === 'admin' ? 'Center Head' : 'Teacher', signature: cur ? signatureView(db, cur) : null };
  }).sort((a, b) => a.name.localeCompare(b.name));
  if (p.role === 'admin') {
    const cur = currentSignature(db, { kind: 'director' });
    rows.push({ owner: { kind: 'director' }, name: db.school?.directorName || '', role: 'director', signs: 'Director', signature: cur ? signatureView(db, cur) : null });
  }
  return rows;
}

/** May persona p upload or remove this owner's signature? The principal: anyone; a teacher: their own. */
export function mayManageSignature(p, owner) {
  if (p && p.role === 'admin') return true;
  return Boolean(p && p.role === 'teacher' && owner && owner.kind === 'staff' && owner.staffId === p.staffId);
}
