// Real-app (Supabase) side of the administration module, wired into remote.js:
//   passwords   the optional password (email code stays the default): set/change, sign in, reset by emailed code
//   twoStep     the authenticator app (TOTP) for the principal and the accountant, through the vendored supabase-js MFA api
//   accounts    the principal's account desk: the admin-accounts Edge Function (needs two-step done this session)
//   signInActivity / appUsers  the oversight reads that the snapshot does not carry
// Same signatures and ApiError codes as the demo (src/api/index.js). The principal never sees or sets anyone's password.

import { allow } from '../domain/commands.js';
import { PRIVILEGED_ROLES } from '../domain/admin.js';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const MIN_PASSWORD = 8;

/**
 * @param {{sb:any, call:Function, ApiError:any, op:Function, me:()=>any, snap:()=>any, refresh:()=>Promise<any>,
 *   newRequestId:()=>string, statusNow:()=>object, signedOut:()=>void, command:Function}} deps
 *   statusNow() → what auth.status() answers now; signedOut() drops the local session state; command(name, args, opts)
 *   runs a registry command through the command function.
 */
export function createRemoteAdmin({ sb, call, ApiError, op, me, snap, refresh, newRequestId, statusNow, signedOut, command }) {
  const cleanEmail = address => {
    const e = String(address || '').trim().toLowerCase();
    if (!EMAIL.test(e)) throw new ApiError('VALIDATION', 'Enter a valid email address');
    return e;
  };
  const rateLimited = error => error && (error.status === 429 || /rate limit/i.test(error.message || ''));

  // ---------------------------------------------------------------- passwords (optional)
  const passwords = {
    /** signInWithPassword(email, password) → auth status. A wrong pair never says which half was wrong. */
    signInWithPassword: op(async (address, password) => {
      const email = cleanEmail(address);
      const { error } = await sb.auth.signInWithPassword({ email, password: String(password ?? '') });
      if (error) {
        if (rateLimited(error)) throw new ApiError('RATE_LIMITED', 'Too many attempts; wait a minute and try again');
        throw new ApiError('VALIDATION', 'That email and password do not match. You can always sign in with an email code instead.');
      }
      await refresh();
      return statusNow();
    }),
    /** requestPasswordReset(email) — mails a 6-digit code; never reveals whether the address has an account. */
    requestPasswordReset: op(async address => {
      const email = cleanEmail(address);
      const { error } = await sb.auth.resetPasswordForEmail(email);
      if (rateLimited(error)) throw new ApiError('RATE_LIMITED', 'Too many codes requested; wait a minute and try again');
    }),
    /** verifyRecoveryCode(email, code) — signs in with the emailed code (then choose a new password with setPassword). */
    verifyRecoveryCode: op(async (address, code) => {
      const { error } = await sb.auth.verifyOtp({ email: cleanEmail(address), token: String(code || '').trim(), type: 'recovery' });
      if (error) throw new ApiError('VALIDATION', 'That code is not right or has expired; request a new one');
      await refresh();
      return statusNow();
    }),
    /** setPassword(newPassword) — the signed-in user's own password, at least 8 characters. */
    setPassword: op(async newPassword => {
      const pw = String(newPassword ?? '');
      if (pw.length < MIN_PASSWORD) throw new ApiError('VALIDATION', `Use at least ${MIN_PASSWORD} characters`);
      const { data } = await sb.auth.getSession();
      if (!data || !data.session) throw new ApiError('UNAUTHENTICATED', 'Please sign in');
      const { error } = await sb.auth.updateUser({ password: pw });
      if (error) throw new ApiError(rateLimited(error) ? 'RATE_LIMITED' : 'VALIDATION', /different/i.test(error.message || '') ? 'Choose a password different from the current one' : (error.message || 'The password was not accepted'));
    }),
    /** signOutEverywhere() — ends every session of this sign-in (all devices), then this one. */
    signOutEverywhere: op(async () => {
      const { error } = await sb.auth.signOut({ scope: 'global' });
      signedOut();
      if (error && !/session/i.test(error.message || '')) throw new ApiError('OFFLINE', 'Signed out here; the other devices could not be reached. Try again.');
    }),
  };

  // ---------------------------------------------------------------- two-step sign-in (TOTP)
  const role = () => {
    const s = snap();
    return (s.persona && s.persona.role) || (s.me && s.me.role) || null;
  };
  const privileged = () => {
    if (snap().status === 'signedOut') throw new ApiError('UNAUTHENTICATED', 'Please sign in');
    if (!PRIVILEGED_ROLES.includes(role())) throw new ApiError('NOT_ALLOWED', 'Two-step sign-in is for the principal and the accountant');
  };
  async function factors() {
    const { data, error } = await sb.auth.mfa.listFactors();
    if (error) throw new ApiError('OFFLINE', `Could not read your authenticators (${error.message})`);
    return data || { all: [], totp: [] };
  }
  async function policyRequired() {
    const { data, error } = await sb.from('app_policy').select('value').eq('key', 'two_step');
    if (error) throw new ApiError('OFFLINE', `Could not read the two-step policy (${error.message})`);
    return Boolean(data && data[0] && data[0].value && data[0].value.required);
  }
  async function twoStepState() {
    const f = await factors();
    const v = (f.totp || []).find(x => x.status === 'verified') || null;
    const { data } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    return { enrolled: Boolean(v), verified: Boolean(v) && Boolean(data && data.currentLevel === 'aal2'), required: await policyRequired(), factorId: v ? v.id : null };
  }
  const twoStep = {
    /** {enrolled, verified (this session did the second step), required (the school's policy), factorId|null} */
    status: op(async () => { privileged(); return twoStepState(); }),
    /** enroll() → {factorId, secret, uri}: an unfinished earlier set-up is replaced. */
    enroll: op(async () => {
      privileged();
      const f = await factors();
      if ((f.all || []).some(x => x.factor_type === 'totp' && x.status === 'verified')) throw new ApiError('VALIDATION', 'Two-step sign-in is already set up; turn it off first to set it up again');
      for (const x of (f.all || []).filter(y => y.factor_type === 'totp' && y.status !== 'verified')) await sb.auth.mfa.unenroll({ factorId: x.id });
      const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}` });
      if (error) throw new ApiError(rateLimited(error) ? 'RATE_LIMITED' : 'VALIDATION', `The authenticator could not be set up (${error.message})`);
      return { factorId: data.id, secret: data.totp.secret, uri: data.totp.uri };
    }),
    /** verify(factorId, code) → {verified:true}; this session is now aal2 and the snapshot is reloaded. */
    verify: op(async (factorId, code) => {
      privileged();
      const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: String(factorId || ''), code: String(code || '').replace(/\s+/g, '') });
      if (error) throw new ApiError(rateLimited(error) ? 'RATE_LIMITED' : 'VALIDATION', 'That code was not accepted. Codes change every 30 seconds; try the current one.');
      await refresh();
      return { verified: true };
    }),
    /** disable(factorId) — turn two-step off (needs the second step done in this session). */
    disable: op(async factorId => {
      privileged();
      const { error } = await sb.auth.mfa.unenroll({ factorId: String(factorId || '') });
      if (error) {
        if (/aal2|AAL2|assurance/i.test(error.message || '')) throw new ApiError('TWO_STEP_REQUIRED', 'Enter a code from your authenticator first, then turn it off');
        throw new ApiError('VALIDATION', `Two-step sign-in could not be turned off (${error.message})`);
      }
      await sb.auth.refreshSession();
      await refresh();
    }),
    demoCode: op(() => { throw new ApiError('NOT_ALLOWED', 'The demo authenticator exists only in the demo; use your authenticator app'); }),
  };

  // ---------------------------------------------------------------- the account desk (admin-accounts function)
  const desk = async (action, extra = {}, { reload = false } = {}) => {
    const body = { action, requestId: newRequestId(), ...extra };
    let r;
    try { r = await call('admin-accounts', body); } catch (e) {
      // no answer: the same request id makes the retry safe for the DB step; the auth-server steps are idempotent
      if (!e || e.code !== 'OFFLINE') throw e;
      r = await call('admin-accounts', body);
    }
    if (reload) { try { await refresh(); } catch (e) { console.error('saved, but the refetch failed:', e); } }
    return r.result;
  };
  const principal = () => allow(me(), 'admin');
  const accounts = {
    /** list() → [{userId|null, personKind, personId, name, role, email, status, lastSignInAt, confirmedAt, twoStep, bannedUntil}] */
    list: op(() => { principal(); return desk('directory'); }),
    block: op(userId => { principal(); return desk('block', { userId }); }),
    unblock: op(userId => { principal(); return desk('unblock', { userId }); }),
    signOutEverywhere: op(userId => { principal(); return desk('sign_out_everywhere', { userId }); }),
    changeEmail: op((userId, email) => { principal(); return desk('change_email', { userId, email }, { reload: true }); }),
    /** resendInvite({guardianId}) → {code, expiresAt} (shown once) | resendInvite({staffId}) → {sent:true} */
    resendInvite: op(target => {
      principal();
      const t = target || {};
      return desk('resend_invite', t.guardianId ? { guardianId: t.guardianId } : { staffId: t.staffId });
    }),
    resetTwoStep: op(userId => { principal(); return desk('reset_two_step', { userId }); }),
    twoStepPolicy: op(() => { principal(); return desk('two_step_policy'); }),
    setTwoStepPolicy: op(({ required } = {}) => { principal(); return desk('set_two_step_policy', { required }); }),
  };

  /** The sign-in links for "who can see this child" (directory rows that are real links). */
  const appUsers = async () => (await desk('directory'))
    .filter(r => r.userId && ['active', 'blocked', 'revoked', 'withdrawn', 'pending'].includes(r.status))
    .map(r => ({ id: r.userId, staffId: r.personKind === 'staff' ? r.personId : null, guardianId: r.personKind === 'guardian' ? r.personId : null, status: r.status }));

  /** signInActivity({limit}) → [{at, userId, name, role, aal}] newest first (sign_in_events: RLS principal only). */
  const signInActivity = op(async ({ limit = 200 } = {}) => {
    principal();
    const n = Math.max(1, Math.min(Number(limit) || 200, 1000));
    const { data, error } = await sb.from('sign_in_events').select('user_id,at,aal').order('at', { ascending: false }).limit(n);
    if (error) throw new ApiError('OFFLINE', `Could not load the sign-in activity (${error.message})`);
    const users = await command('admin.users', [], { reload: false });
    const byUser = new Map((users || []).map(u => [u.id, u]));
    return (data || []).map(r => ({ at: r.at, userId: r.user_id, name: byUser.get(r.user_id)?.name ?? null, role: byUser.get(r.user_id)?.role ?? null, aal: r.aal || null }));
  });

  return { passwords, twoStep, accounts, appUsers, signInActivity, twoStepState };
}
