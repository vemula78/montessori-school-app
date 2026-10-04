// POST /admin-accounts {action, ...} → {result}. The principal's account desk: the auth server's admin API wrapped
// around the registry commands. Caller: role admin, status active, and two-step done in THIS session (JWT aal2) — always,
// whatever the school policy says: these powers need the second step from day one.
// Actions:
//   directory                     every staff member and guardian with their sign-in: status, last sign-in, two-step
//   block {userId}                admin.blockUser first (data cut at once), then the auth ban, then every session ended
//   unblock {userId}              the auth ban lifted first, then admin.unblockUser
//   sign_out_everywhere {userId}  every session ended and a session cutoff written (public.end_sessions): old access
//                                 tokens read nothing from that moment
//   change_email {userId, email}  refused at once if another staff member or guardian has the address; then the auth
//                                 server (identity), then admin.changeSignInEmail (refused → the auth email is put back;
//                                 if that fails too: an auth_db_mismatch audit row and an error), then every session ended
//   resend_invite {guardianId}    a new invite code (admin.inviteCode; shown once)   | {staffId} an auth invite email,
//                                 refused when the address is also recorded for a guardian or another staff member
//   reset_two_step {userId}       the person's authenticators removed and every session ended (they sign in again and
//                                 set up a new authenticator)
//   two_step_policy               {required, privileged:[{userId, name, role, enrolled}]}
//   set_two_step_policy {required}  turning it on needs every active principal/accountant enrolled
// Every action is audited: DB changes by their commands, auth-server-only ones by admin.noteAccountAction (codes only).
// requestId (from the browser, one per action) makes the DB commands replay-safe.

import { body as readBody, coded, serve } from '../_shared/http.ts';
import { caller, system, type Caller } from '../_shared/authz.ts';
import { runCommand } from '../_shared/persist.ts';
import { rest, rpc } from '../_shared/db.ts';
import { listAuthUsers, getAuthUser, updateAuthUser, inviteAuthUser, deleteAuthFactor, BAN_FOR, verifiedTotp } from '../_shared/auth-admin.ts';
import { fullName } from '../_shared/domain/people.js';
import { tsToMs } from '../_shared/domain/dates.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ROLE_ORDER: Record<string, number> = { admin: 0, accountant: 1, teacher: 2, driver: 3, parent: 4 };
const PRIVILEGED = ['admin', 'accountant'];

// the invite code format of the command function (command/index.ts): same alphabet, same normalisation, same hash
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const normaliseCode = (c: unknown) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
async function sha256Hex(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
}
function newInviteCode() {
  const raw = Array.from(crypto.getRandomValues(new Uint8Array(10)), b => ALPHABET[b % ALPHABET.length]).join('');
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

type Who = Extract<Caller, { kind: 'user' }>;
const userIdOf = (p: any) => {
  const id = String(p?.userId ?? '');
  if (!UUID.test(id)) throw coded('VALIDATION', 'Unknown account');
  return id;
};
const people = async () => (await rpc('load_slice', { p_collections: ['staff', 'guardians', 'appUsers', 'invites'], p_hints: {} })).db;
async function linkOf(userId: string) {
  const rows = await rest(`app_users?user_id=eq.${encodeURIComponent(userId)}&select=user_id,role,staff_id,guardian_id,status`);
  if (!rows || !rows[0]) throw coded('NOT_FOUND', 'Account not found');
  return rows[0];
}
const note = (who: Who, userId: string | null, action: string, outcome: 'ok' | 'failed', detail: string | null = null) =>
  runCommand('admin.noteAccountAction', [{ userId, action, outcome, detail, by: who.link!.staffId }], system('admin-accounts'));
/** Does a staff member or guardian other than this one already have the address (school records, service role)? */
async function emailTakenByOther(email: string, { staffId = null, guardianId = null }: { staffId?: string | null; guardianId?: string | null }) {
  const e = encodeURIComponent(email);
  const staff = (await rest(`staff_contacts?email=eq.${e}&select=staff_id`)).filter((x: any) => x.staff_id !== staffId);
  const guardians = (await rest(`guardians?email=eq.${e}&select=id`)).filter((x: any) => x.id !== guardianId);
  return staff.length + guardians.length > 0;
}
const endSessions = async (userId: string) => Number(await rpc('end_sessions', { p_user: userId })) || 0;
const policyRequired = async () => Boolean((await rest('app_policy?key=eq.two_step&select=value'))?.[0]?.value?.required);

async function directory() {
  const db = await people();
  const auth = await listAuthUsers();
  const byId = new Map(auth.map((u: any) => [u.id, u]));
  const byEmail = new Map(auth.filter((u: any) => u.email).map((u: any) => [String(u.email).toLowerCase(), u]));
  const enrolled = new Set((await rest('two_step_enrolled?select=user_id')).map((r: any) => r.user_id));
  const nowMs = Date.now();
  const row = (personKind: string, person: any, role: string, u: any, status: string) => ({
    userId: u ? u.id : null, personKind, personId: person.id, name: fullName(person), role, email: person.email || (u && u.email) || null, status,
    lastSignInAt: u?.last_sign_in_at ?? null, confirmedAt: u?.email_confirmed_at ?? null,
    twoStep: u && enrolled.has(u.id) ? 'verified' : 'none', bannedUntil: u?.banned_until ?? null,
  });
  const out: any[] = [];
  for (const s of db.staff) {
    const links = db.appUsers.filter((l: any) => l.staffId === s.id);
    for (const l of links) out.push(row('staff', s, l.role, byId.get(l.id) || { id: l.id }, l.status));
    if (!links.length) {
      const u = s.email ? byEmail.get(String(s.email).toLowerCase()) : null;
      out.push(row('staff', s, s.role, u || null, u ? 'invited' : 'none'));
    }
  }
  for (const g of db.guardians) {
    const links = db.appUsers.filter((l: any) => l.guardianId === g.id);
    for (const l of links) out.push(row('guardian', g, 'parent', byId.get(l.id) || { id: l.id }, l.status));
    if (!links.length) {
      const open = db.invites.some((i: any) => i.guardianId === g.id && !i.redeemedAt && !i.revokedAt && tsToMs(i.expiresAt) >= nowMs);
      out.push(row('guardian', g, 'parent', null, open ? 'invited' : 'none'));
    }
  }
  return out.sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) || a.name.localeCompare(b.name));
}

async function block(who: Who, p: any, requestId: unknown) {
  const userId = userIdOf(p);
  const r = await runCommand('admin.blockUser', [userId], who, { requestId });
  const ban = await updateAuthUser(userId, { ban_duration: BAN_FOR });
  if (!ban.ok) {
    await note(who, userId, 'block', 'failed', `status blocked; auth ban ${ban.status}`);
    throw coded('GATEWAY', 'Their data access is cut off, but the sign-in block did not reach the sign-in server. Try again.');
  }
  const sessionsEnded = await endSessions(userId);
  return { ...r.result, sessionsEnded };
}

async function unblock(who: Who, p: any, requestId: unknown) {
  const userId = userIdOf(p);
  const link = await linkOf(userId);
  if (link.status !== 'blocked' && link.status !== 'active') throw coded('VALIDATION', `This account is ${link.status}, not blocked`);
  const lift = await updateAuthUser(userId, { ban_duration: 'none' });
  if (!lift.ok) {
    await note(who, userId, 'unblock', 'failed', `auth unban ${lift.status}`);
    throw coded('GATEWAY', 'The sign-in block could not be lifted. Nothing was changed; try again.');
  }
  return (await runCommand('admin.unblockUser', [userId], who, { requestId })).result;
}

async function signOutEverywhere(who: Who, p: any) {
  const userId = userIdOf(p);
  await linkOf(userId);
  const sessionsEnded = await endSessions(userId);
  await note(who, userId, 'signOutEverywhere', 'ok', `sessions ${sessionsEnded}`);
  return { userId, sessionsEnded };
}

async function changeEmail(who: Who, p: any, requestId: unknown) {
  const userId = userIdOf(p);
  const email = String(p?.email ?? '').trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) throw coded('VALIDATION', 'Enter a valid email address');
  const link = await linkOf(userId);
  // the school records first (read only): another staff member or guardian with this address → refused before the auth
  // server is touched, so the two can never be left disagreeing over a clash
  if (await emailTakenByOther(email, { staffId: link.staff_id, guardianId: link.guardian_id })) {
    throw coded('VALIDATION', 'Another person in the school already uses this email');
  }
  const before = await getAuthUser(userId);
  if (!before.ok || !before.body?.id) throw coded('NOT_FOUND', 'This sign-in no longer exists');
  const oldEmail = before.body.email;
  // the identity first: the auth server refuses an address another sign-in already has
  const put = await updateAuthUser(userId, { email, email_confirm: true });
  if (!put.ok) {
    await note(who, userId, 'changeEmail', 'failed', `auth ${put.status}`);
    if (put.status === 422 || /exist|registered/i.test(JSON.stringify(put.body || {}))) throw coded('VALIDATION', 'Another sign-in already uses this email');
    throw coded('GATEWAY', 'The sign-in server did not take the new email; nothing was changed.');
  }
  let r;
  try {
    r = await runCommand('admin.changeSignInEmail', [{ userId, email }], who, { requestId });
  } catch (e) {
    const back = await updateAuthUser(userId, { email: oldEmail, email_confirm: true });
    if (back.ok) {
      await note(who, userId, 'changeEmail', 'failed', 'refused by the school records; auth email put back');
      throw e;
    }
    // the sign-in has the new address, the school records the old one: say so loudly (ids only in the audit row)
    await note(who, userId, 'changeEmail', 'auth_db_mismatch', `auth ${back.status}`);
    throw coded('GATEWAY', 'The sign-in email changed but the school records did not, and it could not be put back. Fix it in the Supabase dashboard (Authentication → Users): set this person\'s email back to the old address.');
  }
  let sessionsEnded;
  try { sessionsEnded = await endSessions(userId); } catch {
    await note(who, userId, 'changeEmail', 'failed', 'email changed; sessions NOT ended');
    throw coded('GATEWAY', 'The email was changed, but the old sessions could not be ended. Press Sign out everywhere for this person.');
  }
  return { ...r.result, sessionsEnded };
}

async function resendInvite(who: Who, p: any, requestId: unknown) {
  const db = await people();
  if (p?.guardianId) {
    const gid = String(p.guardianId);
    const links = db.appUsers.filter((l: any) => l.guardianId === gid);
    if (links.some((l: any) => l.status === 'blocked')) throw coded('VALIDATION', 'This family\'s sign-in is blocked; unblock it instead');
    if (links.some((l: any) => l.status === 'active')) throw coded('VALIDATION', 'This guardian has already signed in');
    const code = newInviteCode();
    const r = await runCommand('admin.inviteCode', [gid], who, { requestId, ctx: { inviteCode: code, inviteCodeHash: await sha256Hex(normaliseCode(code)) } });
    return { code: r.result.code, expiresAt: r.result.expiresAt, ...(r.replayed ? { codeWithheld: true } : {}) };
  }
  if (!p?.staffId) throw coded('VALIDATION', 'Give a guardianId or a staffId');
  const s = db.staff.find((x: any) => x.id === String(p.staffId));
  if (!s) throw coded('NOT_FOUND', 'Staff member not found');
  const links = db.appUsers.filter((l: any) => l.staffId === s.id);
  if (links.some((l: any) => l.status === 'blocked')) throw coded('VALIDATION', 'This sign-in is blocked; unblock it instead');
  if (links.length) throw coded('VALIDATION', 'This staff member has already signed in');
  if (!s.email) throw coded('VALIDATION', 'This staff member has no sign-in email; add one first');
  // a guardian (or another staff member) with the same address would be given this staff role by the sign-up link
  if (await emailTakenByOther(String(s.email).toLowerCase(), { staffId: s.id })) {
    await note(who, null, 'resendInvite', 'failed', `staff ${s.id}: email also recorded for another person`);
    throw coded('VALIDATION', 'This email is also recorded for a guardian or another staff member; correct the email before inviting');
  }
  const existing = (await listAuthUsers()).find((u: any) => String(u.email || '').toLowerCase() === String(s.email).toLowerCase());
  if (existing && (existing.last_sign_in_at || existing.email_confirmed_at)) throw coded('VALIDATION', 'This staff member has already signed in');
  if (existing && existing.banned_until && tsToMs(existing.banned_until) > Date.now()) throw coded('VALIDATION', 'This sign-in is blocked');
  const inv = await inviteAuthUser(String(s.email).toLowerCase());
  await note(who, inv.body?.id ?? existing?.id ?? null, 'resendInvite', inv.ok ? 'ok' : 'failed', inv.ok ? 'staff invite email' : `auth ${inv.status}`);
  if (!inv.ok) throw coded(inv.status === 429 ? 'RATE_LIMITED' : 'GATEWAY', 'The invitation could not be sent. Try again shortly.');
  return { sent: true };
}

async function resetTwoStep(who: Who, p: any) {
  const userId = userIdOf(p);
  await linkOf(userId);
  const u = await getAuthUser(userId);
  if (!u.ok) throw coded('NOT_FOUND', 'This sign-in no longer exists');
  const factors = Array.isArray(u.body?.factors) ? u.body.factors : [];
  let factorsRemoved = 0;
  const failed: number[] = [];
  for (const f of factors) {
    const d = await deleteAuthFactor(userId, f.id);
    if (d.ok || d.status === 404) factorsRemoved++; else failed.push(d.status);
  }
  // the person signs in again (and sets up a new authenticator): every old session ends, old tokens read nothing
  let sessionsEnded = 0;
  let endFailed = false;
  try { sessionsEnded = await endSessions(userId); } catch { endFailed = true; }
  await note(who, userId, 'resetTwoStep', failed.length || endFailed ? 'failed' : 'ok', `removed ${factorsRemoved} of ${factors.length}; sessions ${endFailed ? 'NOT ended' : sessionsEnded}`);
  if (failed.length) throw coded('GATEWAY', `${failed.length} authenticator(s) could not be removed; try again`);
  if (endFailed) throw coded('GATEWAY', 'The authenticators were removed, but the sessions could not be ended. Press Sign out everywhere for this person.');
  return { userId, factorsRemoved, sessionsEnded };
}

async function twoStepPolicy() {
  const db = await people();
  const enrolled = new Set((await rest('two_step_enrolled?select=user_id')).map((r: any) => r.user_id));
  const privileged = db.appUsers.filter((l: any) => l.status === 'active' && PRIVILEGED.includes(l.role)).map((l: any) => {
    const s = db.staff.find((x: any) => x.id === l.staffId);
    return { userId: l.id, name: s ? fullName(s) : '—', role: l.role, enrolled: enrolled.has(l.id) };
  });
  return { required: await policyRequired(), privileged };
}

async function setTwoStepPolicy(who: Who, p: any) {
  if (typeof p?.required !== 'boolean') throw coded('VALIDATION', 'required must be true or false');
  if (p.required) {
    // re-checked on the auth server itself: every active principal and accountant has a verified authenticator
    const pol = await twoStepPolicy();
    const missing: string[] = [];
    for (const x of pol.privileged) {
      const u = await getAuthUser(x.userId);
      if (!u.ok || !verifiedTotp(u.body).length) missing.push(x.userId);
    }
    if (missing.length) {
      await note(who, null, 'twoStepPolicy', 'failed', `required=true refused; ${missing.length} without an authenticator`);
      throw coded('VALIDATION', `${missing.length} principal/accountant account(s) have no authenticator yet; each must set one up first`, { userIds: missing });
    }
  }
  await rest('app_policy?key=eq.two_step', { method: 'PATCH', body: { value: { required: p.required }, updated_at: new Date().toISOString(), updated_by: who.user.id }, prefer: 'return=minimal' });
  await note(who, null, 'twoStepPolicy', 'ok', `required=${p.required}`);
  return twoStepPolicy();
}

serve(async (req) => {
  const c = await caller(req);
  const p = await readBody(req);
  if (c.kind !== 'user' || !c.link || c.link.status !== 'active' || c.link.role !== 'admin') throw coded('NOT_ALLOWED', 'Only the principal can manage accounts');
  const who = c as Who;
  if (who.user.aal !== 'aal2') throw coded('TWO_STEP_REQUIRED', 'The account desk needs two-step sign-in: enter the code from your authenticator app first');
  const requestId = p?.requestId;
  const actions: Record<string, () => Promise<unknown>> = {
    directory: () => directory(),
    block: () => block(who, p, requestId),
    unblock: () => unblock(who, p, requestId),
    sign_out_everywhere: () => signOutEverywhere(who, p),
    change_email: () => changeEmail(who, p, requestId),
    resend_invite: () => resendInvite(who, p, requestId),
    reset_two_step: () => resetTwoStep(who, p),
    two_step_policy: () => twoStepPolicy(),
    set_two_step_policy: () => setTwoStepPolicy(who, p),
  };
  const run = actions[String(p?.action)];
  if (!run) throw coded('NOT_FOUND', `Unknown action: ${p?.action}`);
  return { result: await run() };
});
