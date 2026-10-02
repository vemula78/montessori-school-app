// Storage adapter: the whole Db as one JSON document under one key.
// Every write goes through commit(fn): re-read the stored blob, apply fn to that fresh copy
// (so another tab's newer rev is never overwritten), bump rev, write, notify. A write that the
// browser refuses (quota) is NOT applied: memory stays equal to storage and the caller gets
// STORAGE_QUOTA, so a retry cannot record the same thing twice.
// A corrupt or unknown-version blob is copied aside before anything else and never silently wiped.
// Subscribers are called as fn(db, info); when info.status !== 'ok' db is null and the UI must
// show recovery (reset to demo data / import a backup).
// Known limit: two tabs committing at the same instant are not serialised (no lock in Web Storage);
// the backend replaces this with a database transaction and sequence.
// The backend is injected ({getItem, setItem}) so tests use a Map; the browser passes localStorage.

import { SCHEMA_VERSION } from './schema.js';
import { DomainError } from '../domain/ids.js';
import { appendAudit } from '../domain/audit.js';
import { validateDb, checkStructure } from '../domain/validate.js';

export const DB_KEY = 'montessori.db.v1';
export const CORRUPT_PREFIX = 'montessori.db.corrupt.';
export const APPROX_QUOTA_BYTES = 5 * 1024 * 1024;

/** In-memory backend with the localStorage shape (tests, and fallback when localStorage is unavailable). */
export function memoryBackend(map = new Map()) {
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); },
    keys: () => [...map.keys()],
    map,
  };
}

/** Versioned migration hook. Today only v1 exists; older/newer versions are refused by load(). */
export function migrate(db) {
  if (db.schemaVersion === SCHEMA_VERSION) return db;
  throw new DomainError('STORAGE_CORRUPT', `No migration from schemaVersion ${db.schemaVersion}`);
}

export class Storage {
  /**
   * @param {{backend:{getItem:Function,setItem:Function}, seedFn:()=>any, key?:string, clock?:()=>Date}} opts
   */
  constructor({ backend, seedFn, key = DB_KEY, clock = () => new Date(), persistent = true, persistenceNote = null }) {
    this.backend = backend;
    this.seedFn = seedFn;
    this.key = key;
    this.clock = clock;
    this.persistent = persistent;           // false = in-memory fallback: nothing survives a reload
    this.persistenceNote = persistenceNote; // why browser storage could not be used
    this.db = null;
    this.status = 'empty'; // 'ok' | 'corrupt' | 'unsupportedVersion' | 'missing'
    this.writeFailed = false; // last write was refused (that change was not applied)
    this.corruptKey = null;
    this.lastError = null;
    this.listeners = new Set();
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  notify() { const info = this.info(); for (const fn of this.listeners) fn(this.db, info); }

  /** Parse and check a raw blob. Returns {db} or {status, error}. */
  parse(raw) {
    let obj;
    try { obj = JSON.parse(raw); } catch (e) { return { status: 'corrupt', error: `Stored data is not valid JSON (${e.message})` }; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { status: 'corrupt', error: 'Stored data is not an object' };
    if (obj.schemaVersion !== SCHEMA_VERSION) {
      if (Number.isInteger(obj.schemaVersion) && obj.schemaVersion > 0 && obj.schemaVersion < SCHEMA_VERSION) {
        try { return { db: migrate(obj) }; } catch (e) { return { status: 'unsupportedVersion', error: e.message }; }
      }
      return { status: 'unsupportedVersion', error: `Unknown schemaVersion ${obj.schemaVersion} (this app reads ${SCHEMA_VERSION})` };
    }
    const bad = checkStructure(obj).violations;
    if (bad.length) return { status: 'corrupt', error: `Stored data is structurally invalid: ${bad.slice(0, 3).map(x => `${x.entity} ${x.message}`).join('; ')}${bad.length > 3 ? ` (+${bad.length - 3} more)` : ''}` };
    return { db: obj };
  }

  /** Copy a bad blob aside before anything else touches it. */
  preserve(raw, status, error) {
    const base = `${CORRUPT_PREFIX}${this.clock().toISOString()}`;
    let k = base;
    for (let n = 2; this.backend.getItem(k) !== null && this.backend.getItem(k) !== raw; n++) k = `${base}-${n}`;
    try { this.backend.setItem(k, raw); this.corruptKey = k; } catch (e) {
      this.corruptKey = null;
      error = `${error}; could not save a copy (${e.name || e.message}) — the original is left untouched under ${this.key}`;
    }
    this.status = status;
    this.lastError = error;
    this.db = null;
  }

  /** @returns {{status:'seeded'|'ok'|'corrupt'|'unsupportedVersion', error?:string, corruptKey?:string|null}} */
  load() {
    const raw = this.backend.getItem(this.key);
    if (raw === null || raw === undefined) {
      const db = this.seedFn();
      db.rev = 0;
      this.write(db);
      this.db = db;
      this.status = 'ok';
      return { status: 'seeded' };
    }
    const p = this.parse(raw);
    if (!p.db) {
      this.preserve(raw, p.status, p.error);
      return { status: p.status, error: this.lastError, corruptKey: this.corruptKey };
    }
    this.db = p.db;
    this.status = 'ok';
    this.lastError = null;
    return { status: 'ok' };
  }

  /** Write db or throw STORAGE_QUOTA. The caller installs db in memory only after this succeeds. */
  write(db) {
    try {
      this.backend.setItem(this.key, JSON.stringify(db));
      this.writeFailed = false;
    } catch (e) {
      this.writeFailed = true;
      this.lastError = `Browser storage refused the write (${e.name || e.message}). That change was NOT saved. Export a backup (Settings) and free space before continuing.`;
      throw new DomainError('STORAGE_QUOTA', this.lastError);
    }
  }

  /** Highest rev known (stored blob or memory), for writes that replace the whole document. */
  latestRev() {
    let stored = -1;
    try { const r = JSON.parse(this.backend.getItem(this.key)).rev; if (Number.isInteger(r)) stored = r; } catch { /* unreadable: ignore */ }
    return Math.max(stored, this.db ? this.db.rev : -1);
  }

  markMissing() {
    this.db = null;
    this.status = 'missing';
    this.lastError = 'Stored data was removed (another tab or browser settings). Reset to demo data or import a backup.';
  }

  /** Write a replacement document; install and notify only if the write succeeds. */
  replaceWith(db) {
    db.rev = this.latestRev() + 1;
    this.write(db);
    this.db = db;
    this.status = 'ok';
    this.lastError = null;
    this.notify();
  }

  /**
   * Apply fn to a fresh copy of the stored document and persist it. If fn throws, nothing changes.
   * Returns fn's result.
   */
  commit(fn) {
    if (this.status !== 'ok' || !this.db) throw new DomainError('STORAGE_CORRUPT', this.lastError || 'Data is not loaded');
    const raw = this.backend.getItem(this.key);
    if (raw === null || raw === undefined) {
      // Cleared elsewhere: never resurrect it from this tab's memory.
      this.markMissing();
      this.notify();
      throw new DomainError('STORAGE_CORRUPT', this.lastError);
    }
    const p = this.parse(raw);
    if (!p.db) {
      this.preserve(raw, p.status, p.error);
      this.notify();
      throw new DomainError('STORAGE_CORRUPT', this.lastError);
    }
    const base = p.db; // includes any newer rev written by another tab
    const result = fn(base);
    base.rev = (base.rev || 0) + 1;
    this.write(base); // throws STORAGE_QUOTA → nothing installed, nothing applied
    this.db = base;
    this.notify();
    return result;
  }

  /**
   * Called for the browser `storage` event on our key (another tab wrote). The event's value may be
   * stale (events can arrive late), so the current blob is re-read and only a newer rev is accepted.
   */
  handleExternalChange() {
    const raw = this.backend.getItem(this.key);
    if (raw === null || raw === undefined) { this.markMissing(); this.notify(); return; }
    const p = this.parse(raw);
    if (!p.db) { this.preserve(raw, p.status, p.error); this.notify(); return; }
    if (!this.db || this.status !== 'ok' || p.db.rev > this.db.rev) {
      this.db = p.db;
      this.status = 'ok';
      this.lastError = null;
      this.notify();
    }
  }

  /** Replace everything with fresh seed data. Idempotent apart from rev and the audit row. */
  resetToSeed(ctx) {
    const fresh = this.seedFn();
    appendAudit(fresh, ctx, { entity: 'db', entityId: '-', action: 'resetToSeed', summary: 'all data replaced with demo seed' });
    this.replaceWith(fresh);
    return { status: 'ok' };
  }

  exportJson() {
    if (!this.db) throw new DomainError('STORAGE_CORRUPT', 'Nothing loaded to export');
    return JSON.stringify(this.db, null, 2);
  }

  /**
   * Import a previously exported document. Refused (VALIDATION, details = violations) if it is
   * unreadable, the wrong version, or has any integrity error; warnings are returned.
   */
  importJson(text, ctx) {
    const p = this.parse(text);
    if (!p.db) throw new DomainError('VALIDATION', `Import refused: ${p.error}`);
    const violations = validateDb(p.db);
    const errors = violations.filter(x => x.severity !== 'warning');
    if (errors.length) {
      throw new DomainError('VALIDATION', `Import refused: ${errors.length} integrity error(s), e.g. ${errors.slice(0, 3).map(x => `${x.code} ${x.entity} ${x.id}`).join('; ')}`, errors);
    }
    const db = p.db;
    appendAudit(db, ctx, { entity: 'db', entityId: '-', action: 'importJson', summary: `imported document, ${violations.length} warnings` });
    this.replaceWith(db);
    return { violations };
  }

  info() {
    const raw = this.backend.getItem(this.key);
    return {
      bytesUsed: raw ? raw.length : 0, // characters of the stored JSON (≈ bytes for ASCII)
      approxQuotaBytes: APPROX_QUOTA_BYTES,
      status: this.status,
      unsaved: false, // failed writes are never applied, so memory never holds unsaved changes
      writeFailed: this.writeFailed,
      persistent: this.persistent,
      persistenceNote: this.persistenceNote,
      corruptKey: this.corruptKey,
      lastError: this.lastError,
      rev: this.db ? this.db.rev : null,
    };
  }
}
