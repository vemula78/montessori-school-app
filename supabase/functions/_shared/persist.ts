// The command executor: load slice → authorize → run the shared domain command → persist with an optimistic
// revision check. On CONFLICT (another writer committed this slice since we loaded it) the whole command is
// re-run on fresh data — so receipt/invoice/voucher numbers are always taken from the latest counters and
// are contiguous and never reused (closes deferred #1). A SEQUENCE is deliberately not used: it leaves gaps.

import { COMMANDS, SLICES, execute, personaFor, revKey } from './domain/commands.js';
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

export type RunOutput = { result: any; before: any; after: any; ctx: any; attempts: number; rev: number | null };

export async function runCommand(name: string, args: unknown[], who: Caller, extra: { ctx?: Record<string, unknown>; hints?: Record<string, unknown> } = {}): Promise<RunOutput> {
  const cmd = (COMMANDS as any)[name];
  if (!cmd) throw coded('NOT_FOUND', `Unknown command: ${name}`);
  if (!Array.isArray(args)) throw coded('VALIDATION', 'args must be an array');
  if (who.kind === 'user' && who.link && who.link.status !== 'active' && !cmd.allowUnlinked) {
    throw coded('NOT_ALLOWED', `Your access to the app is ${who.link.status}`);
  }
  const slice = (SLICES as any)[cmd.slice];
  const hints = { ...(cmd.load ? cmd.load(args) : {}), ...(extra.hints || {}) };
  for (let attempt = 1; ; attempt++) {
    const loaded = await rpc('load_slice', { p_collections: slice.reads, p_hints: hints });
    const db = loaded.db;
    for (const c of [...COLLECTIONS, ...slice.writes]) if (c !== 'school' && c !== 'counters' && !Array.isArray(db[c])) db[c] = [];
    let persona: any = null;
    if (who.kind === 'system') persona = { role: 'system', id: who.label, staffId: null, guardianId: null, studentIds: [], programIds: [], routeIds: [] };
    else if (who.link && who.link.status === 'active') persona = personaFor(db, who.link);
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
    const changes = diffChanges(before, db, slice.writes);
    const key = revKey(name, db, args);
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
      throw e;
    }
  }
}
