// Supabase client + Edge Function caller for the real app. The ONLY place (with remote.js and its siblings)
// allowed to make network calls; the scan enforces it. supabase-js is the vendored single-file bundle.

const FN_TIMEOUT_MS = 30000;

export async function makeClient(config) {
  const { createClient } = await import('../../../vendor/supabase/supabase-js.esm.js');
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: config.persistSession !== false, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'school-app-auth' },
    realtime: { params: { eventsPerSecond: 10 } },
  });
}

/**
 * POST a JSON body to an Edge Function with the user's access token. A 401 is retried once after refreshing
 * the session (JWT expiry mid-trip, failure mode 32). Errors become ApiError {code, message} (Phase 1 codes
 * plus CONFLICT, UNAUTHENTICATED, OFFLINE, GATEWAY, RATE_LIMITED, INTERNAL).
 */
export function functionCaller(sb, config, ApiError) {
  const base = `${String(config.supabaseUrl).replace(/\/+$/, '')}/functions/v1`;
  async function token() {
    const { data } = await sb.auth.getSession();
    return data && data.session ? data.session.access_token : null;
  }
  async function once(name, body, tok) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FN_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}/${name}`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', apikey: config.supabaseAnonKey, ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
        body: JSON.stringify(body ?? {}),
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      return { status: res.status, data };
    } catch (e) {
      throw new ApiError('OFFLINE', e && e.name === 'AbortError' ? 'The school server did not answer in time; nothing may have been saved. Check and try again.' : 'Cannot reach the school server. Check the internet connection and try again.');
    } finally { clearTimeout(timer); }
  }
  return async function call(name, body) {
    let tok = await token();
    if (!tok) throw new ApiError('UNAUTHENTICATED', 'Please sign in');
    let r = await once(name, body, tok);
    if (r.status === 401) {
      const { data } = await sb.auth.refreshSession();
      tok = data && data.session ? data.session.access_token : null;
      if (!tok) throw new ApiError('UNAUTHENTICATED', 'Your sign-in has expired; please sign in again');
      r = await once(name, body, tok);
    }
    if (r.status >= 200 && r.status < 300) return r.data;
    const err = r.data && r.data.error;
    throw new ApiError(err?.code || (r.status === 401 ? 'UNAUTHENTICATED' : 'INTERNAL'), err?.message || `Server error (${r.status})`, err?.details);
  };
}
