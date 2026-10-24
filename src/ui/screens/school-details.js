// School details (principal, Settings): the Progress Report footer, the director's name, the privacy contact, office
// hours and the school's UPI ID, saved through api.school.setDetails (the registry validates and its messages are
// shown as they are). An empty group is cleared (null): nothing is ever filled in for the school.
import { esc, pageHead, attempt, errMessage } from '../components.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const t = (v) => String(v ?? '').trim();

/** Form values → the patch for setDetails: only the groups that changed; an all-empty group → null. */
export function detailsPatch(cur, v) {
  const next = {};
  const phones = [v.phone1, v.phone2, v.phone3].map(t).filter(Boolean);
  next.reportFooter = [v.address, v.footerEmail, v.website].some((x) => t(x)) || phones.length
    ? { address: t(v.address), phones, email: t(v.footerEmail), website: t(v.website) } : null;
  next.directorName = t(v.directorName) || null;
  next.privacyContact = [v.pcName, v.pcRole, v.pcEmail].some((x) => t(x)) ? { name: t(v.pcName), role: t(v.pcRole), email: t(v.pcEmail) } : null;
  const days = [].concat(v.days ?? []).map(Number).filter((d) => Number.isInteger(d)).sort();
  next.officeHours = t(v.ohStart) || t(v.ohEnd) || days.length ? { start: t(v.ohStart), end: t(v.ohEnd), days } : null;
  next.upi = t(v.vpa) || t(v.payeeName) ? { vpa: t(v.vpa), payeeName: t(v.payeeName) } : null;
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return Object.fromEntries(Object.entries(next).filter(([k, x]) => !same(x, cur[k])));
}

export async function render(ctx) {
  const { api } = ctx;
  const d = await api.school.details();
  const f = d.reportFooter || {};
  const pc = d.privacyContact || {};
  const oh = d.officeHours || {};
  const upi = d.upi || {};
  const ph = f.phones || [];
  const input = (name, label, value, attrs = '') => `<label class="field"><span class="lbl">${esc(label)}</span><input name="${esc(name)}" value="${esc(value ?? '')}" ${attrs}></label>`;
  ctx.el.innerHTML = `${pageHead('School details', 'Printed on reports and shown to families', `<a class="btn" href="${esc(ctx.href('/settings'))}">&larr; Settings</a>`)}
    <form id="sd-form" class="stack" novalidate style="max-width:720px">
      <section class="card stack"><h2>Progress Report footer</h2>
        <small>Printed at the foot of every annual Progress Report. Leave everything empty to print no footer.</small>
        <label class="field"><span class="lbl">Address</span><textarea name="address" rows="2" maxlength="200">${esc(f.address || '')}</textarea></label>
        <div class="row">${[0, 1, 2].map((i) => `<label class="field grow"><span class="lbl">Phone ${i + 1}</span><input name="phone${i + 1}" type="tel" maxlength="20" value="${esc(ph[i] || '')}"></label>`).join('')}</div>
        <div class="row"><label class="field grow"><span class="lbl">Email</span><input name="footerEmail" type="email" maxlength="120" value="${esc(f.email || '')}"></label>
          <label class="field grow"><span class="lbl">Website</span><input name="website" maxlength="100" value="${esc(f.website || '')}" placeholder="www.example.com"></label></div>
      </section>
      <section class="card stack"><h2>Director</h2>
        ${input('directorName', 'Director’s name', d.directorName, 'maxlength="80" autocomplete="off"')}
        <small>The director signs every Progress Report (the signature itself is uploaded on Progress Reports &gt; Signatures).</small>
      </section>
      <section class="card stack"><h2>Privacy contact</h2>
        <small><strong>The privacy notice names this person</strong> as the contact for questions and requests about children’s and families’ data. If it is empty, the notice tells families to contact the school office.</small>
        ${input('pcName', 'Name', pc.name, 'maxlength="80"')}
        ${input('pcRole', 'Role', pc.role, 'maxlength="80" placeholder="For example: Principal"')}
        ${input('pcEmail', 'Email', pc.email, 'type="email" maxlength="120"')}
      </section>
      <section class="card stack"><h2>Office hours</h2>
        <small>Parents writing to the school outside these hours are told when the school will reply. School time (IST).</small>
        <div class="row"><label class="field"><span class="lbl">Opens</span><input name="ohStart" type="time" value="${esc(oh.start || '')}"></label>
          <label class="field"><span class="lbl">Closes</span><input name="ohEnd" type="time" value="${esc(oh.end || '')}"></label></div>
        <div class="row" role="group" aria-label="Days the office is open">${DAYS.map((n, i) => `<label class="chip"><input type="checkbox" name="days" value="${esc(i)}"${(oh.days || []).includes(i) ? ' checked' : ''}> ${esc(n)}</label>`).join('')}</div>
      </section>
      <section class="card stack"><h2>UPI for fees</h2>
        <small><strong>Parents will pay fees straight to this UPI ID</strong> from their UPI app; the accountant then confirms each payment. Check it letter by letter: a wrong ID sends families’ money to someone else.</small>
        ${input('vpa', 'School UPI ID', upi.vpa, 'maxlength="120" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="schoolname@bank"')}
        ${input('payeeName', 'Payee name (as the bank shows it)', upi.payeeName, 'maxlength="80"')}
      </section>
      <div class="err" id="sd-err" role="alert"></div>
      <div class="sticky-actions"><button class="btn primary" type="submit">Save school details</button></div>
    </form>`;
  const form = ctx.el.querySelector('#sd-form');
  const err = ctx.el.querySelector('#sd-err');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const fd = new FormData(form);
    const v = Object.fromEntries(fd.entries());
    v.days = fd.getAll('days');
    const patch = detailsPatch(d, v);
    if (!Object.keys(patch).length) { ctx.toast('Nothing changed'); return; }
    const r = await attempt(() => api.school.setDetails(patch), 'School details saved');
    if (r.ok) ctx.rerender(); else err.textContent = errMessage(r.error);
  });
}
