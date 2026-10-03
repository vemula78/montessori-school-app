// Settings in the real app: who I am, notifications on this device, my privacy choices (withdraw consent),
// download my data, and for the principal the data-request queue and school details.
import { todayISO } from '../../domain/dates.js';
import { esc, money, fdate, badge, banner, pageHead, downloadText, confirmDialog, attempt, toast, errMessage, fullName, DASH } from '../components.js';
import { PURPOSES, PRIVACY_VERSION, noticeHash } from '../privacy.js';
import * as push from '../push.js';

// The server records consent as a set that must include the required account purpose, so adding one optional
// purpose re-sends everything already agreed to plus the new one.
const withGiven = (cs, extra) => [...new Set([...Object.entries(cs?.purposes || {}).filter(([, v]) => v?.given).map(([k]) => k), 'app_account', extra])];

const ROLE = { admin: 'Principal', teacher: 'Teacher', accountant: 'Accountant', driver: 'Driver', parent: 'Parent' };

export async function render(ctx) {
  const { api, persona } = ctx;
  const isParent = persona.role === 'parent';
  const [auth, consent, ps, vapidKey] = await Promise.all([
    attempt(() => api.auth.status()),
    isParent ? attempt(() => api.consent.status()) : Promise.resolve({ ok: true, value: null }),
    push.state(),
    Promise.resolve().then(() => api.push.vapidPublicKey()).catch(() => null),
  ]);
  const cs = consent.ok ? consent.value : null;

  ctx.el.innerHTML = `${pageHead('Settings')}
    <div class="stack">
      <div class="card stack"><h2>My account</h2>
        <dl style="display:grid;grid-template-columns:130px 1fr;gap:4px 10px;margin:0">
          <dt class="muted">Name</dt><dd style="margin:0">${esc(String(persona.label || '').replace(/^[^—]*—\s*/, '').replace(/\s*\(.*$/, '') || DASH)}</dd>
          <dt class="muted">Role</dt><dd style="margin:0">${esc(ROLE[persona.role] || persona.role)}</dd>
          <dt class="muted">Signed in as</dt><dd style="margin:0">${esc(auth.ok ? auth.value.email || DASH : DASH)}</dd>
        </dl>
        <div><button class="btn" id="st-out">Sign out</button></div></div>

      <div class="card stack" id="st-push"><h2>Notifications on this device</h2><div id="st-push-body"></div></div>

      ${isParent ? `<div class="card stack"><h2>My privacy choices</h2>
        ${consent.ok ? '' : banner('bad', `<strong>Your choices could not be loaded.</strong> ${esc(errMessage(consent.error))}`)}
        ${cs ? `<ul class="list card-list">${PURPOSES.map((p) => {
          const st = cs.purposes?.[p.key];
          return `<li><div class="row between"><div class="grow-text"><div class="item-title">${esc(p.title)}</div><small>${esc(p.detail)}</small><br><small>${st?.given ? `Agreed on ${st.at ? fdate(String(st.at).slice(0, 10)) : DASH}` : 'Not agreed'}</small></div>
            <div>${st?.given ? `<button class="btn sm ${p.required ? 'danger' : ''}" data-withdraw="${esc(p.key)}">${p.required ? 'Withdraw and close my access' : 'Turn off'}</button>` : (p.required ? '' : `<button class="btn sm" data-give="${esc(p.key)}">Turn on</button>`)}</div></div></li>`;
        }).join('')}</ul>` : ''}
        <small>Notice ${esc(PRIVACY_VERSION)}. <a href="#/privacy">Read the privacy notice</a>.</small></div>

      <div class="card stack"><h2>Download my data</h2>
        <p style="margin:0">A file with everything the school holds about you and your children in this app: records, fees, notices, messages and diary entries.</p>
        <div><button class="btn primary" id="st-export">Download my data</button></div></div>` : ''}

      ${persona.role === 'admin' ? '<div id="st-admin"></div>' : ''}
    </div>`;

  // ---- sign out
  ctx.el.querySelector('#st-out').addEventListener('click', () => document.getElementById('signout')?.click());

  // ---- notifications
  const pushHost = ctx.el.querySelector('#st-push-body');
  async function drawPush() {
    const s = await push.state();
    if (!s.support.ok) {
      pushHost.innerHTML = `${banner(s.support.code === 'ios-install' ? 'warn' : 'info', esc(s.support.message))}
        ${s.support.code === 'ios-install' ? `<ol style="margin:0;padding-left:20px">${push.IOS_STEPS.map((t) => `<li>${esc(t)}</li>`).join('')}</ol>` : ''}
        <small>You will still see everything inside the app; notifications just add a nudge on your phone.</small>`;
      return;
    }
    if (!vapidKey) { pushHost.innerHTML = banner('info', 'Notifications have not been set up for this school yet. Everything still appears inside the app.'); return; }
    if (s.permission === 'denied') {
      pushHost.innerHTML = `${banner('warn', 'Notifications are blocked for this site. To allow them, open the browser or phone settings for this site, allow notifications, then come back.')}`;
      return;
    }
    pushHost.innerHTML = s.subscribed
      ? `<div class="row between"><span>${badge('On', 'ok')} This device gets fee reminders, important notices${isParent ? ', receipts and bus alerts' : ''}.</span><button class="btn sm" id="st-push-off">Turn off</button></div>`
      : `<div class="row between"><span class="muted">Get fee reminders and important notices on this phone${isParent ? ', and bus alerts if you opted in' : ''}.</span><button class="btn primary" id="st-push-on">Turn on notifications</button></div>
         ${isParent ? '<small>Turning on also records your consent to notifications (privacy notice ' + esc(PRIVACY_VERSION) + ').</small>' : ''}`;
    pushHost.querySelector('#st-push-on')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await push.enable({
          vapidKey,
          giveConsent: async () => {
            if (!isParent || cs?.purposes?.push?.given) return;
            const hash = await noticeHash();
            await api.consent.give({ purposes: withGiven(cs, 'push'), version: PRIVACY_VERSION, ...(hash ? { textHash: hash } : {}) });
          },
          send: (json) => api.push.subscribe(json),
        });
        toast('Notifications are on');
      } catch (ex) { toast(errMessage(ex), 'bad'); }
      drawPush();
    });
    pushHost.querySelector('#st-push-off')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try { await push.disable({ remove: (endpoint) => api.push.unsubscribe(endpoint) }); toast('Notifications are off'); } catch (ex) { toast(errMessage(ex), 'bad'); }
      drawPush();
    });
  }
  await drawPush();

  // ---- privacy choices
  ctx.el.addEventListener('click', async (e) => {
    const w = e.target.closest('[data-withdraw]');
    const g = e.target.closest('[data-give]');
    if (w) {
      const key = w.dataset.withdraw;
      const required = PURPOSES.find((p) => p.key === key)?.required;
      const ok = await confirmDialog(required ? 'Withdraw and close access' : 'Turn off', required
        ? 'This withdraws your consent for the account. You will be signed out and will no longer see your children’s information in the app. Records the school must keep by law (fee records) are retained, and a request to erase your personal details is passed to the principal. Continue?'
        : 'Turn this off? It takes effect straight away.', { okLabel: required ? 'Withdraw and sign out' : 'Turn off', kind: 'danger' });
      if (!ok) return;
      const r = await attempt(() => api.consent.withdraw(key), required ? 'Consent withdrawn' : 'Turned off');
      if (!r.ok) return;
      if (key === 'push') { try { await push.disable({ remove: (ep) => api.push.unsubscribe(ep) }); } catch { /* the server already stopped sending */ } }
      if (required) { await attempt(() => api.auth.signOut()); location.hash = ''; location.reload(); return; }
      ctx.rerender();
    } else if (g) {
      const hash = await noticeHash();
      if ((await attempt(() => api.consent.give({ purposes: withGiven(cs, g.dataset.give), version: PRIVACY_VERSION, ...(hash ? { textHash: hash } : {}) }), 'Turned on')).ok) ctx.rerender();
    }
  });

  // ---- download my data
  ctx.el.querySelector('#st-export')?.addEventListener('click', async () => {
    const r = await attempt(() => api.admin.dataExport(persona.guardianId));
    if (r.ok) { downloadText(`my-data_${todayISO()}.json`, r.value, 'application/json'); toast('Downloaded'); }
  });

  // ---- principal
  if (persona.role === 'admin') await drawAdmin(ctx, ctx.el.querySelector('#st-admin'));
}

async function drawAdmin(ctx, host) {
  const { api, db } = ctx;
  const rule = db.school.lateFeeRule;
  const ay = db.academicYears.find((a) => a.id === db.school.currentAcademicYearId);
  let reqs = null, reqErr = null;
  try { reqs = await api.admin.erasureRequests(); } catch (e) { reqErr = e; }
  const guardians = indexById(db.guardians);
  host.innerHTML = `<div class="stack">
    <div class="card stack"><h2>Data requests (erasure)</h2>
      ${reqErr ? banner('bad', `<strong>The request list could not be loaded.</strong> ${esc(errMessage(reqErr))}`)
        : reqs.length ? `<div class="tablewrap"><table><thead><tr><th>Requested</th><th>Parent</th><th>Status</th><th></th></tr></thead><tbody>${reqs.map((r) => `<tr><td class="nowrap">${r.requestedAt ? fdate(String(r.requestedAt).slice(0, 10)) : DASH}</td><td>${esc(fullName(guardians.get(r.guardianId)))}</td><td>${r.status === 'open' ? badge('Open', 'warn') : badge(r.status, 'ok')}</td>
          <td class="nowrap"><button class="btn sm" data-export-g="${esc(r.guardianId)}">Export data</button>${r.status === 'open' && api.admin.anonymiseGuardian ? ` <button class="btn sm danger" data-erase="${esc(r.guardianId)}">Erase personal details</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
          <small>Erasing replaces the parent’s name, phone and email; fee numbers and amounts are kept because the law requires the school to keep them.</small>`
        : '<p class="muted" style="margin:0">No open requests.</p>'}</div>
    <div class="card stack"><h2>School</h2>
      <dl style="display:grid;grid-template-columns:150px 1fr;gap:4px 10px;margin:0">
        <dt class="muted">Name</dt><dd style="margin:0">${esc(db.school.name)}</dd>
        <dt class="muted">Address</dt><dd style="margin:0">${esc(db.school.address)}</dd>
        <dt class="muted">Phone</dt><dd style="margin:0">${esc(db.school.phone)}</dd>
        <dt class="muted">Academic year</dt><dd style="margin:0">${esc(ay?.label || DASH)} ${ay ? `(${fdate(ay.startDate)} to ${fdate(ay.endDate)})` : ''}</dd>
        <dt class="muted">Late fee rule</dt><dd style="margin:0">${rule ? `${esc(rule.graceDays)} grace days, ${rule.mode === 'perDay' ? `${money(rule.amountPaise)} per day${rule.capPaise != null ? `, capped at ${money(rule.capPaise)}` : ''}` : `${money(rule.amountPaise)} flat`}` : DASH}</dd>
      </dl>
      <div class="row"><a class="btn" href="#/invites">Invite codes</a><a class="btn" href="#/import">Import data</a><a class="btn" href="#/reports/settlements">Online settlements</a></div></div></div>`;
  host.addEventListener('click', async (e) => {
    const x = e.target.closest('[data-export-g]');
    const er = e.target.closest('[data-erase]');
    if (x) {
      const r = await attempt(() => api.admin.dataExport(x.dataset.exportG));
      if (r.ok) { downloadText(`family-data_${todayISO()}.json`, r.value, 'application/json'); toast('Downloaded'); }
    } else if (er) {
      if (!(await confirmDialog('Erase personal details', 'Replace this parent’s name, phone and email with placeholders? This cannot be undone. Fee numbers and amounts are kept.', { okLabel: 'Erase', kind: 'danger' }))) return;
      if ((await attempt(() => api.admin.anonymiseGuardian(er.dataset.erase), 'Personal details erased')).ok) ctx.rerender();
    }
  });
}

const indexById = (arr) => new Map((arr || []).map((x) => [x.id, x]));
