// The command executor: load slice → authorize → run the shared domain command → persist with an optimistic
// revision check. On CONFLICT (another writer committed this slice since we loaded it) the whole command is
// re-run on fresh data — so receipt/invoice/voucher numbers are always taken from the latest counters and
// are contiguous and never reused (closes deferred #1). A SEQUENCE is deliberately not used: it leaves gaps.
//
// Every attempt re-reads, in the same snapshot as the data: the caller's app_users link and consents (a retry after
// a conflict never reuses a stale "unlinked" or "active"), and any request already committed under the caller's
// request id (a repeated request returns the stored result instead of writing twice). A change is guarded by the
// revision of every slice that writes the collections it touches, not only the command's own.

import { COMMANDS, SLICES, execute, personaFor, revKey, guardSlices, consentScopedPersona } from './domain/commands.js';
import { COLLECTIONS } from './store/schema.js';
import { dateInZone, IST_OFFSET_MIN } from './domain/dates.js';
import { diffChanges, isEmptyChange } from './slices.js';
import { rpc } from './db.ts';
import { coded } from './http.ts';
import type { Caller } from './authz.ts';

// Phase 1 commit() never retried; under 20 truly simultaneous writers a 3-retry cap loses writes, so the cap is
// higher with jittered exponential backoff. Each retry re-reads the counters, so numbering stays contiguous.
const MAX_ATTEMPTS = 25;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const backoff = (attempt: number) => Math.random() * Math.min(1000, 20 * 2 ** Math.min(attempt, 6));
const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;

export type RunOutput = { result: any; before: any; after: any; ctx: any; attempts: number; rev: number | null; replayed?: boolean };
type Extra = { ctx?: Record<string, unknown>; hints?: Record<string, unknown>; requestId?: unknown };

export async function runCommand(name: string, args: unknown[], who: Caller, extra: Extra = {}): Promise<RunOutput> {
  const cmd = (COMMANDS as any)[name];
  if (!cmd) throw coded('NOT_FOUND', `Unknown command: ${name}`);
  if (!Array.isArray(args)) throw coded('VALIDATION', 'args must be an array');
  if (cmd.demoOnly) throw coded('NOT_ALLOWED', 'This action exists only in the demo');
  const requestId = who.kind === 'user' && !cmd.readOnly && extra.requestId != null ? String(extra.requestId) : null;
  if (requestId !== null && !REQUEST_ID.test(requestId)) throw coded('VALIDATION', 'requestId must be 8–100 letters, digits, - or _');
  const slice = (SLICES as any)[cmd.slice];
  const hints = {
    ...(cmd.load ? cmd.load(args) : {}), ...(extra.hints || {}),
    ...(who.kind === 'user' ? { callerUserId: who.user.id } : {}), ...(requestId ? { requestId } : {}),
  };
  for (let attempt = 1; ; attempt++) {
    const loaded = await rpc('load_slice', { p_collections: slice.reads, p_hints: hints });
    const db = loaded.db;
    const { callerLink: link = null, callerConsents: consents = [], priorRequest = null } = db;
    delete db.callerLink; delete db.callerConsents; delete db.priorRequest;
    if (requestId && priorRequest) return replay(priorRequest, name, who, attempt);
    if (who.kind === 'user' && link && link.status !== 'active' && !cmd.allowUnlinked) {
      throw coded('NOT_ALLOWED', `Your access to the app is ${link.status}`);
    }
    for (const c of [...COLLECTIONS, ...slice.writes]) if (c !== 'school' && c !== 'counters' && !Array.isArray(db[c])) db[c] = [];
    let persona: any = null;
    if (who.kind === 'system') persona = { role: 'system', id: who.label, staffId: null, guardianId: null, studentIds: [], programIds: [], routeIds: [] };
    else if (link && link.status === 'active') {
      persona = personaFor(db, link);
      // a parent acts only for children with current app_account consent (consent itself and data access excepted)
      if (persona && persona.role === 'parent' && !cmd.beforeConsent) {
        persona = consentScopedPersona(db, persona, consents);
        if (!persona.studentIds.length) throw coded('NOT_ALLOWED', 'Please read and accept the privacy notice first');
      }
    }
    const nowMs = Date.now();
    const ctx = {
      actor: persona && persona.role !== 'system'
        ? { role: persona.role, id: persona.staffId || persona.guardianId }
        : (who.kind === 'system' ? { role: 'system', id: who.label } : { role: 'user', id: who.user.id }),
      now: new Date(nowMs).toISOString(),
      today: dateInZone(nowMs, IST_OFFSET_MIN), // Deno runs in UTC: business dates are IST, explicitly
      userId: who.kind === 'user' ? who.user.id : null,
      userEmail: who.kind === 'user' ? who.user.email : null,
      ...(extra.ctx || {}),
    };
    const before = structuredClone(db);
    const result = execute(name, db, args, ctx, persona);
    if (cmd.readOnly) return { result, before, after: db, ctx, attempts: attempt, rev: null };
    const changes: any = diffChanges(before, db, slice.writes);
    const key = revKey(name, db, args);
    const touched = [...Object.keys(changes.upserts), ...Object.keys(changes.deletes), ...(changes.counters ? ['counters'] : []), ...(changes.school ? ['school'] : [])];
    const guards: Record<string, number> = {};
    for (const s of guardSlices(cmd.slice, touched)) guards[s] = loaded.revs[s] ?? 0;
    if (Object.keys(guards).length) changes.guards = guards;
    if (requestId && who.kind === 'user') changes.request = { id: requestId, userId: who.user.id, name, result: result ?? null };
    try {
      let rev: number | null = null;
      if (!isEmptyChange(changes)) rev = await rpc('persist', { p_rev_key: key, p_expected: loaded.revs[key] ?? 0, p_changes: changes });
      if (result && result.failure) throw coded(result.failure.code, result.failure.message);
      return { result, before, after: db, ctx, attempts: attempt, rev };
    } catch (e: any) {
      if (e && e.code === 'PT409') {
        if (attempt < MAX_ATTEMPTS) { await sleep(backoff(attempt)); continue; }
        throw coded('CONFLICT', 'Others were saving at the same moment; nothing was saved. Please try again.');
      }
      // the same request committed concurrently (a client retry racing the original): the next load replays it
      if (requestId && e && e.code === '23505' && /command_requests/.test(String(e.message)) && attempt < MAX_ATTEMPTS) continue;
      throw e;
    }
  }
}

/** A request id already committed: return what it returned then (or its refusal), never run it again. */
function replay(prior: any, name: string, who: Caller, attempt: number): RunOutput {
  if (who.kind !== 'user' || prior.userId !== who.user.id || prior.name !== name) throw coded('VALIDATION', 'This request id was already used for a different request');
  const r = prior.result;
  if (r && r.failure) throw coded(r.failure.code, r.failure.message);
  return { result: r, before: null, after: null, ctx: null, attempts: attempt, rev: null, replayed: true };
}
