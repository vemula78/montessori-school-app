// PUBLIC settings for the real app. Nothing secret belongs in this file - it is downloaded by every visitor.
//
// Paste these four values after you create the school's database (docs/GO-LIVE.md, steps 2, 7 and 12):
//   supabaseUrl      Supabase dashboard > Project Settings > API > "Project URL"
//   supabaseAnonKey  the same page > "anon public" key (a long string starting with eyJ..., or sb_publishable_...)
//                    NEVER paste the "service_role" key (or one starting sb_secret_) here - the app refuses to start if you do.
//   vapidPublicKey   the PUBLIC key printed by `node scripts/vapid-keys.mjs` (leave '' until push alerts are set up)
//   gatewayMode      'test' while using the payment provider's test keys, 'live' only after its KYC is approved
//
// While supabaseUrl / supabaseAnonKey are empty the app shows a "not configured" page instead of starting.
// For local development put overrides in app/config.local.js (gitignored; loaded only on localhost).
window.__APP_CONFIG__ = {
  supabaseUrl: 'https://gwwgbzhyslzavwexpkkv.supabase.co',
  supabaseAnonKey: 'sb_publishable_jq8oG8q3POGdOJ67uh67JQ_S_cUThzZ',
  vapidPublicKey: '',
  gatewayMode: 'test',
  appVersion: '2.0.0-pilot',
};
