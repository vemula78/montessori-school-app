// Settings in the real app: who I am, notifications on this device, my privacy choices (withdraw consent),
// download my data, and for the principal the school details and retention (data requests: Administration).
import { todayISO } from '../../domain/dates.js';
import { esc, money, fdate, badge, banner, pageHead, downloadText, confirmDialog, attempt, toast, errMessage, DASH } from '../components.js';
import { PURPOSES, PRIVACY_VERSION, noticeHash } from '../privacy.js';
import * as push from '../push.js';
import { mountInstall } from '../install.js';

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
        <div class="row"><a class="btn" href="#/account">Password, two-step sign-in and sessions</a><button class="btn" id="st-out">Sign out</button></div></div>

      <div id="st-install"></div>
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

  mountInstall(ctx.el.querySelector('#st-install'), { cleanup: ctx.cleanup });

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
            const hash = await noticeHash(api.getDb()?.school || null);
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
      const ok = await confirmDialog(required ? 'Withdraw and close access' : 'Turn off', key === 'photos' ? 'Turning off photos means the school deletes the photos it holds of your children, and takes no new ones. Continue?' : required
        ? 'This withdraws your consent for the account. You will be signed out and will no longer see your children’s information in the app. Records the school must keep by law (fee records) are retained, and a request to erase your personal details is passed to the principal. Continue?'
        : 'Turn this off? It takes effect straight away.', { okLabel: required ? 'Withdraw and sign out' : 'Turn off', kind: 'danger' });
      if (!ok) return;
      const r = await attempt(() => api.consent.withdraw(key), required ? 'Consent withdrawn' : 'Turned off');
      if (!r.ok) return;
      if (key === 'push') { try { await push.disable({ remove: (ep) => api.push.unsubscribe(ep) }); } catch { /* the server already stopped sending */ } }
      if (required) { await attempt(() => api.auth.signOut()); location.hash = ''; location.reload(); return; }
      ctx.rerender();
    } else if (g) {
      const hash = await noticeHash(api.getDb()?.school || null);
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
  host.innerHTML = `<div class="stack">
    <div class="card stack"><h2>School</h2>
      <dl style="display:grid;grid-template-columns:150px 1fr;gap:4px 10px;margin:0">
        <dt class="muted">Name</dt><dd style="margin:0">${esc(db.school.name)}</dd>
        <dt class="muted">Address</dt><dd style="margin:0">${esc(db.school.address)}</dd>
        <dt class="muted">Phone</dt><dd style="margin:0">${esc(db.school.phone)}</dd>
        <dt class="muted">Academic year</dt><dd style="margin:0">${esc(ay?.label || DASH)} ${ay ? `(${fdate(ay.startDate)} to ${fdate(ay.endDate)})` : ''}</dd>
        <dt class="muted">Late fee rule</dt><dd style="margin:0">${rule ? `${esc(rule.graceDays)} grace days, ${rule.mode === 'perDay' ? `${money(rule.amountPaise)} per day${rule.capPaise != null ? `, capped at ${money(rule.capPaise)}` : ''}` : `${money(rule.amountPaise)} flat`}` : DASH}</dd>
      </dl>
      <div class="row"><a class="btn" href="#/invites">Invite codes</a><a class="btn" href="#/import">Import data</a><a class="btn" href="#/reports/settlements">Online settlements</a><a class="btn" href="#/admin?tab=requests">Data requests</a></div></div>
    <div id="st-retention"></div></div>`;
  await drawRetention(ctx, host.querySelector('#st-retention'));
}

// ---- retention (principal): how long records are kept after a child leaves ------------------------------------------
const RETENTION_FIELDS = [
  ['photosMonthsAfterLeaving', 'photos', 'Photos', 'Deleted this many months after the child leaves. Always deleted at once if a parent turns photos off.'],
  ['observationsMonthsAfterLeaving', 'observations', 'Observations and progress records', 'Also deletes their photos.'],
  ['diaryMonthsAfterLeaving', 'diary', 'Daily diary, termly reports and annual progress reports', ''],
  ['attendanceMonthsAfterLeaving', 'attendance', 'Attendance', ''],
  ['messagesMonthsAfterLeaving', 'messages', 'Messages', 'The conversation stays; its messages are deleted.'],
];

export async function drawRetention(ctx, host) {
  const { api, db } = ctx;
  const r = db.school.retention || {};
  let preview = null, previewErr = null;
  if (typeof api.admin.retentionPreview === 'function') { try { preview = await api.admin.retentionPreview(); } catch (e) { previewErr = e; } }
  const ready = (db.photos || []).filter((p) => p.status === 'ready');
  const active = db.students.filter((s) => s.status === 'active').length;
  const MB = (n) => (n / 1048576).toFixed(n >= 1048576 * 100 ? 0 : 1);
  const perYear = active * 40 * 250 * 1024;
  host.innerHTML = `<div class="card stack"><h2>How long records are kept</h2>
    <p style="margin:0">After a child leaves, each kind of record below is deleted automatically once its period (in whole months) has passed. <strong>Leave a box empty if the school has not decided</strong>: nothing is deleted for it. Fee records are never deleted by this; the law requires them. This schedule is a draft until the school confirms it with its legal adviser.</p>
    <form id="ret-form" class="stack" novalidate>${RETENTION_FIELDS.map(([key, cat, label, help]) => {
      const c = preview?.categories?.[cat];
      return `<label class="field" style="margin:0"><span class="lbl">${esc(label)} (months after leaving)</span><input type="number" name="${esc(key)}" min="1" max="240" step="1" inputmode="numeric" value="${esc(r[key] ?? '')}" placeholder="Not decided">
        <span class="help">${esc(help)}${c ? ` ${c.months ? `Due today: ${esc(c.due)} item(s) from ${esc(c.students)} child(ren).` : 'No period set, so nothing is due.'}` : ''}</span></label>`;
    }).join('')}
      <div class="err" id="ret-err" role="alert"></div>
      <div><button class="btn primary" type="submit">Save retention periods</button></div></form>
    ${previewErr ? banner('warn', `Due counts could not be loaded: ${esc(errMessage(previewErr))}`) : ''}
    ${preview?.leftWithoutDate?.length ? banner('warn', `${esc(preview.leftWithoutDate.length)} child(ren) left without a recorded leaving date, so nothing about them can be due until the date is set. <a href="#/people?status=nodate">Set the dates</a>`) : ''}
    <small>Photos stored (from the last 120 days of observations): ${esc(ready.length)}, about ${MB(ready.reduce((n, p) => n + (p.bytes || 0), 0))} MB. Estimate: ${esc(active)} children &times; 40 photos a year &times; about 250 KB &approx; ${MB(perYear)} MB a year. Each child can have up to 100 photos.</small></div>`;
  host.querySelector('#ret-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = host.querySelector('#ret-err');
    err.textContent = '';
    const out = {};
    for (const [key, , label] of RETENTION_FIELDS) {
      const raw = String(host.querySelector(`input[name="${key}"]`).value ?? '').trim();
      if (raw === '') { out[key] = null; continue; }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 240) { err.textContent = `${label}: enter whole months from 1 to 240, or leave empty.`; return; }
      out[key] = n;
    }
    if ((await attempt(() => api.admin.setRetention(out), 'Retention periods saved')).ok) ctx.rerender();
  });
}
