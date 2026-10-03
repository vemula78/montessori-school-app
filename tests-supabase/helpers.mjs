// Shared helpers for the local Supabase tests (node, no dependencies). Reads keys from `supabase status`;
// signs fake users in with an admin-generated email OTP (no inbox needed); calls functions and PostgREST.
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from '../scripts/mock-razorpay.mjs';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let cached = null;
export function local() {
  if (cached) return cached;
  const out = execFileSync('supabase', ['status', '-o', 'json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const s = JSON.parse(out.slice(out.indexOf('{')));
  cached = { url: s.API_URL, anon: s.ANON_KEY, service: s.SERVICE_ROLE_KEY, fns: `${s.API_URL}/functions/v1`, env: readEnvFile() };
  return cached;
}

export async function http(method, url, { body, headers = {}, raw = false } = {}) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

const svc = () => ({ apikey: local().service, Authorization: `Bearer ${local().service}` });
export const rest = (method, path, body, prefer) => http(method, `${local().url}/rest/v1/${path}`, { body, headers: { ...svc(), ...(prefer ? { Prefer: prefer } : {}) } });

/** Create (if needed) and sign in a fake user; returns {token, userId, email}. */
export async function signIn(email) {
  const L = local();
  const link = await http('POST', `${L.url}/auth/v1/admin/generate_link`, { body: { type: 'magiclink', email }, headers: svc() });
  let otp = link.data?.email_otp ?? link.data?.properties?.email_otp;
  if (link.status === 404 || link.status === 422 || !otp) {
    await http('POST', `${L.url}/auth/v1/admin/users`, { body: { email, email_confirm: true }, headers: svc() });
    const again = await http('POST', `${L.url}/auth/v1/admin/generate_link`, { body: { type: 'magiclink', email }, headers: svc() });
    otp = again.data?.email_otp ?? again.data?.properties?.email_otp;
  }
  if (!otp) throw new Error(`could not get an OTP for ${email}`);
  const v = await http('POST', `${L.url}/auth/v1/verify`, { body: { type: 'email', email, token: otp }, headers: { apikey: L.anon } });
  if (v.status !== 200) throw new Error(`verify failed for ${email}: ${v.status} ${JSON.stringify(v.data)}`);
  return { token: v.data.access_token, refresh: v.data.refresh_token, userId: v.data.user.id, email };
}

export const fn = (name, body, token, extraHeaders = {}) => http('POST', `${local().fns}/${name}`, { body, headers: { apikey: local().anon, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders } });
export const command = (token, name, ...args) => fn('command', { name, args }, token);
export const rpcAs = (token, name, args = {}) => http('POST', `${local().url}/rest/v1/rpc/${name}`, { body: args, headers: { apikey: local().anon, Authorization: `Bearer ${token}` } });
export const restAs = (token, path) => http('GET', `${local().url}/rest/v1/${path}`, { headers: { apikey: local().anon, Authorization: `Bearer ${token}` } });

export function psql(sql) {
  return execFileSync('docker', ['exec', '-i', 'supabase_db_montessori-school-app', 'psql', '-U', 'postgres', '-tAq', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8' }).trim();
}

export const MOCK = `http://127.0.0.1:${process.env.MOCK_RAZORPAY_PORT || 54399}`;
