// Entry guard for the real app. The app code (and so the database client) is only loaded when app/config.js
// holds a usable configuration; otherwise a plain "not configured" page is shown. This entry page never
// falls back to the demo: demo and real app are separate entry points by design.
import { esc } from '../src/ui/components.js';

const cfg = window.__APP_CONFIG__ || {};
const root = document.getElementById('app');

// the anon key is public by design; the service_role / secret key must never reach a browser
function keyRole(key) {
  const k = String(key || '').trim();
  if (!k) return 'missing';
  if (k.startsWith('sb_secret_')) return 'secret';
  if (k.startsWith('sb_publishable_')) return 'public';
  const parts = k.split('.');
  if (parts.length !== 3) return 'unknown';
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(parts[1].length / 4) * 4, '='));
    const role = JSON.parse(json).role;
    return role === 'anon' ? 'public' : role === 'service_role' ? 'secret' : 'unknown';
  } catch { return 'unknown'; }
}

function problems() {
  const out = [];
  const url = String(cfg.supabaseUrl || '').trim();
  if (!url) out.push('supabaseUrl is empty');
  else if (!/^https?:\/\/[^\s/]+/i.test(url)) out.push('supabaseUrl is not a web address (it should look like https://xxxx.supabase.co)');
  const role = keyRole(cfg.supabaseAnonKey);
  if (role === 'missing') out.push('supabaseAnonKey is empty');
  else if (role === 'secret') out.push('supabaseAnonKey holds the SECRET (service_role) key. Remove it from this file, and rotate it in the Supabase dashboard because it has now been exposed on this device.');
  else if (role === 'unknown') out.push('supabaseAnonKey does not look like the "anon public" key');
  return out;
}

function notConfigured(list) {
  document.title = 'School app - not configured';
  root.innerHTML = `<div class="main" style="max-width:640px"><div class="stack">
    <h1>This app is not connected yet</h1>
    <div class="banner warn" role="alert"><strong>Setup is not finished.</strong> The school database details have not been added to <code>app/config.js</code>, so nothing can be shown here.</div>
    <div class="card stack">
      <h3 style="margin:0">What is missing</h3>
      <ul style="margin:0;padding-left:18px">${list.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
    </div>
    <p>Whoever sets up the school: follow <code>docs/GO-LIVE.md</code> (steps 1 and 2) and paste the two public values into <code>app/config.js</code>.</p>
    <p class="muted">Parents and staff: nothing is wrong with your phone or your login. Please ask the school office.</p>
    <p><a class="btn" href="../">Open the public demo instead (fake data)</a></p>
  </div></div>`;
}

const list = problems();
if (list.length) {
  notConfigured(list);
} else {
  if (cfg.gatewayMode === 'live') {
    document.body.classList.add('no-ribbon');
  } else {
    document.getElementById('ribbon-host').innerHTML = '<div class="ribbon no-print" role="note">Test mode &mdash; no real money moves</div>';
  }
  try {
    await import('../src/ui/app.js');
  } catch (e) {
    console.error(e);
    root.innerHTML = `<div class="main" style="max-width:640px"><div class="banner bad" role="alert"><strong>The app could not start.</strong> ${esc(e?.message || String(e))}</div></div>`;
  }
}
