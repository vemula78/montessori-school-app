// Fee structures per programme + invoice generation per instalment (idempotent); the principal starts the next
// academic year (copying structures forward) and sets the late-fee rule here.
import { rupeesToPaise, formatPaise } from '../../domain/money.js';
import { addDays } from '../../domain/dates.js';
import { esc, money, fdate, empty, pageHead, options, formModal, confirmDialog, attempt, toast, indexBy, DASH } from '../components.js';

export async function render(ctx) {
  const { api, db, query } = ctx;
  const admin = ctx.persona.role === 'admin';
  const years = await api.calendar.academicYears();
  const ay = years.find((y) => y.id === query.ay) || years.find((y) => y.id === db.school.currentAcademicYearId) || years[0];
  if (!ay) { ctx.el.innerHTML = `${pageHead('Fee structures')}${empty('No academic year set up')}`; return; }
  const [structures, heads, invoices] = await Promise.all([
    api.fees.structures({ academicYearId: ay.id }),
    api.fees.heads(),
    api.fees.invoices({ academicYearId: ay.id }),
  ]);
  const hmap = indexBy(heads);
  const pmap = indexBy(db.programs);
  const eligible = (pid) => db.students.filter((s) => s.status === 'active' && s.programId === pid).length;
  const existing = (pid, inst) => invoices.filter((i) => i.programId === pid && i.installmentName === inst && i.status !== 'cancelled').length;

  const cards = db.programs.map((p) => {
    const st = structures.find((s) => s.programId === p.id);
    if (!st) return `<div class="card stack"><h3 style="margin:0">${esc(p.name)}</h3>${empty('No fee structure for this year')}<div><button class="btn sm primary" data-create="${esc(p.id)}">Create structure</button></div></div>`;
    return `<div class="card stack">
      <div class="row between"><h3 style="margin:0">${esc(p.name)}</h3><button class="btn sm" data-edit="${esc(st.id)}">Edit structure</button></div>
      <small>Sibling discount ${esc(st.siblingDiscountBp / 100)}% of tuition (younger siblings) &middot; staff-ward discount ${st.staffWardDiscountBp == null ? DASH : esc(st.staffWardDiscountBp / 100) + '%'} &middot; ${eligible(p.id)} active children. Bus fare is added from the child's route.</small>
      <div class="tablewrap"><table><thead><tr><th>Instalment</th><th>Due</th><th>Fee lines</th><th class="r">Per child</th><th class="r">Invoices</th><th></th></tr></thead><tbody>
      ${st.installments.map((ins) => {
        const total = ins.lines.reduce((s, l) => s + l.amountPaise, 0);
        const n = existing(p.id, ins.name);
        return `<tr><td><strong>${esc(ins.name)}</strong></td><td class="nowrap">${fdate(ins.dueDate)}</td>
          <td>${ins.lines.map((l) => `${esc(hmap.get(l.headId)?.name || l.headId)} ${money(l.amountPaise)}`).join('<br>')}</td>
          <td class="r num">${money(total)}</td><td class="r num">${n} / ${eligible(p.id)}</td>
          <td><button class="btn sm primary" data-gen="${esc(p.id)}" data-inst="${esc(ins.name)}">Generate invoices</button></td></tr>`;
      }).join('')}
      </tbody></table></div></div>`;
  });

  ctx.el.innerHTML = `${pageHead('Fee structures', ay.label || ay.id)}
    ${years.length > 1 ? `<div class="row" style="margin-bottom:12px"><select id="fs-ay" style="width:auto" aria-label="Academic year">${options(years.map((y) => ({ value: y.id, label: `${y.label || y.id}${y.current ? ' (current)' : ''}` })), ay.id)}</select></div>` : ''}
    ${yearCard(years, ay, db, admin)}
    <div id="fs-result"></div>
    <div class="stack">${cards.join('')}</div>`;

  ctx.el.querySelector('#fs-ay')?.addEventListener('change', (e) => ctx.setQuery({ ay: e.target.value }));
  ctx.el.addEventListener('click', async (e) => {
    const g = e.target.closest('[data-gen]');
    const ed = e.target.closest('[data-edit]');
    const cr = e.target.closest('[data-create]');
    const yr = e.target.closest('[data-year]');
    if (g) {
      const prog = pmap.get(g.dataset.gen);
      const ok = await confirmDialog('Generate invoices', `Generate "${g.dataset.inst}" invoices for ${prog.name}? Children who already have one are skipped, so this is safe to repeat.`, { okLabel: 'Generate' });
      if (!ok) return;
      const res = await attempt(() => api.fees.generateInvoices({ academicYearId: ay.id, programId: g.dataset.gen, installmentName: g.dataset.inst }));
      if (res.ok) {
        const r = res.value;
        toast(`Created ${r.created}, skipped ${r.skippedExisting}`);
        await ctx.rerender();
        const host = document.getElementById('fs-result'); // ctx.el was replaced by the re-render
        if (host) host.innerHTML = `<div class="banner ok"><strong>${esc(prog.name)} - ${esc(g.dataset.inst)}:</strong> ${esc(r.created)} invoice${r.created === 1 ? '' : 's'} created, ${esc(r.skippedExisting)} already existed (${esc(r.eligibleStudents ?? r.created + r.skippedExisting)} eligible children). <a href="#/fees">View invoices</a></div>`;
      }
    } else if (ed) {
      const st = structures.find((s) => s.id === ed.dataset.edit);
      if (st && await editStructure(ctx, st, heads, pmap.get(st.programId)?.name || st.programId)) ctx.rerender();
    } else if (cr) {
      const tuition = heads.find((h) => h.kind === 'tuition');
      const blank = { academicYearId: ay.id, programId: cr.dataset.create, siblingDiscountBp: 0, staffWardDiscountBp: null,
        installments: [{ name: 'Term 1', dueDate: ay.startDate, lines: [{ headId: tuition?.id, amountPaise: 0 }] }] };
      if (await editStructure(ctx, blank, heads, pmap.get(cr.dataset.create)?.name || cr.dataset.create)) ctx.rerender();
    } else if (yr?.dataset.year === 'start') {
      await startYear(ctx, years);
    } else if (yr?.dataset.year === 'current') {
      if (!(await confirmDialog('Change the current year', `Make ${ay.label || ay.id} the current year? The Fees list, the reports and the home pages then show this year. Payments are always filed under the year their date falls in.`, { okLabel: 'Make current' }))) return;
      if ((await attempt(() => api.fees.setCurrentAcademicYear(ay.id), `${ay.label || ay.id} is now the current year`)).ok) ctx.rerender();
    } else if (yr?.dataset.year === 'late') {
      if (await editLateFeeRule(ctx)) ctx.rerender();
    }
  });
}

// Heads a structure may carry: transport comes from the child's route, late fees and opening balances never from a structure.
const STRUCTURE_KINDS = (h) => !['transport', 'lateFee', 'openingBalance'].includes(h.kind);
const plainRupees = (p) => (p == null ? '' : formatPaise(p, { symbol: false }).replace(/,/g, ''));
let seq = 0;

function lineHtml(heads, l = {}) {
  const k = ++seq;
  return `<div class="row" data-line style="margin-top:6px;flex-wrap:nowrap">
    <select data-f="head" aria-label="Fee head" style="flex:1;min-width:0">${options(heads.map((h) => ({ value: h.id, label: h.name })), l.headId || heads[0]?.id)}</select>
    <input data-f="amt" name="amt_${k}" inputmode="decimal" placeholder="&#8377;" aria-label="Amount in rupees" style="width:120px" value="${esc(l.amountPaise ? plainRupees(l.amountPaise) : '')}">
    <button type="button" class="btn sm ghost" data-rm-line aria-label="Remove this line">&times;</button></div>`;
}

function insHtml(heads, ins = {}) {
  const k = ++seq;
  return `<fieldset class="card flat" data-ins style="margin-bottom:10px">
    <div class="grid cols-2"><label class="field"><span class="lbl">Instalment name</span><input data-f="name" name="name_${k}" value="${esc(ins.name || '')}" placeholder="e.g. Term 1" required></label>
    <label class="field"><span class="lbl">Due date</span><input type="date" data-f="due" name="due_${k}" value="${esc(ins.dueDate || '')}" required></label></div>
    <div data-lines>${(ins.lines?.length ? ins.lines : [{}]).map((l) => lineHtml(heads, l)).join('')}</div>
    <div class="row" style="margin-top:8px"><button type="button" class="btn sm" data-add-line>Add line</button><button type="button" class="btn sm ghost" data-rm-ins>Remove instalment</button></div></fieldset>`;
}

/**
 * The structure to save from what the editor holds: rows = [{name, dueDate, lines:[{headId, amount (rupees text)}]}].
 * A line with no amount is dropped (a blank row added by mistake); every other rule is the domain's (saveStructure).
 */
export function structureFromRows(base, rows, { sib, sw }) {
  const bp = (s, label, optional) => {
    if (optional && String(s ?? '').trim() === '') return null;
    const n = Number(s);
    if (String(s ?? '').trim() === '' || !Number.isFinite(n) || n < 0 || n > 100) throw new Error(`${label} must be between 0 and 100`);
    return Math.round(n * 100);
  };
  return {
    ...base, siblingDiscountBp: bp(sib, 'Sibling discount'), staffWardDiscountBp: bp(sw, 'Staff-ward discount', true),
    installments: rows.map((r) => ({
      name: String(r.name || '').trim(), dueDate: r.dueDate,
      lines: r.lines.filter((l) => String(l.amount ?? '').trim() !== '').map((l) => {
        const p = rupeesToPaise(l.amount);
        if (p === null || p < 0) throw new Error(`Invalid amount for ${String(r.name || '').trim() || 'an instalment'}`);
        return { headId: l.headId, amountPaise: p };
      }),
    })),
  };
}

async function editStructure(ctx, st, heads, programName) {
  const usable = heads.filter(STRUCTURE_KINDS);
  const pct = (bp) => (bp == null ? '' : String(bp / 100));
  const fields = `
    <div class="grid cols-2"><label class="field"><span class="lbl">Sibling discount % (tuition)</span><input name="sib" inputmode="decimal" value="${esc(pct(st.siblingDiscountBp))}" required></label>
    <label class="field"><span class="lbl">Staff-ward discount % (optional)</span><input name="sw" inputmode="decimal" value="${esc(pct(st.staffWardDiscountBp))}"></label></div>
    <p class="help">Changes apply to invoices generated from now on. Existing invoices are never re-priced. Bus fares come from each child's route; late fees are added separately.</p>
    <div data-inss>${st.installments.map((ins) => insHtml(usable, ins)).join('')}</div>
    <button type="button" class="btn sm" data-add-ins>Add instalment</button>`;
  return formModal({
    title: `${st.id ? 'Edit' : 'New'} fee structure: ${programName}`, fieldsHtml: fields, submitLabel: st.id ? 'Save' : 'Create structure',
    onOpen: (d) => d.addEventListener('click', (e) => {
      const t = e.target;
      if (t.closest('[data-add-line]')) t.closest('[data-ins]').querySelector('[data-lines]').insertAdjacentHTML('beforeend', lineHtml(usable));
      else if (t.closest('[data-rm-line]')) t.closest('[data-line]').remove();
      else if (t.closest('[data-add-ins]')) d.querySelector('[data-inss]').insertAdjacentHTML('beforeend', insHtml(usable));
      else if (t.closest('[data-rm-ins]')) t.closest('[data-ins]').remove();
    }),
    onSubmit: async (v, form) => {
      const rows = [...form.querySelectorAll('[data-ins]')].map((fs) => ({
        name: fs.querySelector('[data-f="name"]').value, dueDate: fs.querySelector('[data-f="due"]').value,
        lines: [...fs.querySelectorAll('[data-line]')].map((ln) => ({ headId: ln.querySelector('[data-f="head"]').value, amount: ln.querySelector('[data-f="amt"]').value })),
      }));
      await ctx.api.fees.saveStructure(structureFromRows(st, rows, { sib: v.sib, sw: v.sw }));
    },
  });
}

// ---------------- academic year and late-fee rule (principal) ----------------

export const lateFeeRuleText = (rule) => (rule
  ? `${rule.graceDays} grace day${rule.graceDays === 1 ? '' : 's'}, then ${rule.mode === 'perDay' ? `${formatPaise(rule.amountPaise)} a day${rule.capPaise != null ? `, at most ${formatPaise(rule.capPaise)}` : ''}` : `${formatPaise(rule.amountPaise)} once`}${rule.shiftDueToWorkingDay ? '; a due date on a holiday moves to the next working day' : ''}`
  : 'none (no rule set)');

function yearCard(years, ay, db, admin) {
  const cur = years.find((y) => y.current);
  return `<div class="card stack" style="margin-bottom:14px"><h3 style="margin:0">Academic year and late fees</h3>
    <small>Current year: <strong>${esc(cur?.label || cur?.id || DASH)}</strong>${cur ? ` (${fdate(cur.startDate)} to ${fdate(cur.endDate)})` : ''}. Payments can be recorded only on dates inside a year listed here. Late fee: ${esc(lateFeeRuleText(db.school.lateFeeRule))}.</small>
    ${admin ? `<div class="row"><button class="btn sm primary" data-year="start">Start next academic year</button>${ay.id !== cur?.id ? `<button class="btn sm" data-year="current">Make ${esc(ay.label || ay.id)} the current year</button>` : ''}<button class="btn sm" data-year="late">Late-fee rule</button></div>` : '<small class="muted">The principal starts the next year and sets the late-fee rule.</small>'}</div>`;
}

async function startYear(ctx, years) {
  const last = [...years].sort((a, b) => (a.startDate < b.startDate ? -1 : 1)).at(-1);
  const start = last ? addDays(last.endDate, 1) : '';
  let end = '';
  try { end = start ? addDays(`${Number(start.slice(0, 4)) + 1}${start.slice(4)}`, -1) : ''; } catch { /* 29-Feb start: the principal types the last day */ }
  let res = null;
  const ok = await formModal({
    title: 'Start next academic year', submitLabel: 'Start the year',
    fieldsHtml: `<div class="grid cols-2"><label class="field"><span class="lbl">First day</span><input type="date" name="start" value="${esc(start)}" required></label>
      <label class="field"><span class="lbl">Last day</span><input type="date" name="end" value="${esc(end)}" required></label></div>
      ${last ? `<label class="check"><input type="checkbox" name="copy" checked> Copy the fee structures of ${esc(last.label || last.id)} (due dates move one year; check the amounts before generating invoices)</label>` : ''}
      <p class="help">Safe to repeat: a year that already exists is not created again, and a programme that already has a structure for the new year keeps it. Holidays are not copied; import the new year's list on the Calendar. The current year stays as it is until you change it.</p>`,
    onSubmit: async (v) => { res = await ctx.api.fees.startAcademicYear({ startDate: v.start, endDate: v.end, copyFrom: v.copy && last ? last.id : null }); },
  });
  if (!ok || !res) return;
  toast(`${res.academicYear.label}: ${res.yearCreated ? 'year created' : 'year already existed'}; ${res.structuresCopied} structure(s) copied, ${res.structuresSkippedExisting} already there`);
  ctx.setQuery({ ay: res.academicYear.id });
}

async function editLateFeeRule(ctx) {
  const r = ctx.db.school.lateFeeRule;
  return formModal({
    title: 'Late-fee rule', submitLabel: 'Save rule',
    fieldsHtml: `<label class="check"><input type="checkbox" name="off"${r ? '' : ' checked'}> No late fees</label>
      <div class="grid cols-2"><label class="field"><span class="lbl">Grace days after the due date</span><input name="grace" type="number" min="0" max="365" step="1" inputmode="numeric" value="${esc(r?.graceDays ?? 7)}"></label>
      <label class="field"><span class="lbl">Charged</span><select name="mode">${options([{ value: 'perDay', label: 'Per day late' }, { value: 'flat', label: 'Once (flat)' }], r?.mode || 'perDay')}</select></label>
      <label class="field"><span class="lbl">Amount (&#8377;)</span><input name="amount" inputmode="decimal" value="${esc(plainRupees(r?.amountPaise))}"></label>
      <label class="field"><span class="lbl">At most (&#8377;, optional)</span><input name="cap" inputmode="decimal" value="${esc(plainRupees(r?.capPaise))}"></label></div>
      <label class="check"><input type="checkbox" name="shift"${r?.shiftDueToWorkingDay ? ' checked' : ''}> A due date on a holiday or weekly off moves to the next working day</label>
      <p class="help">Late fees are never added by themselves: the office applies them from the Late fees due list.</p>`,
    onSubmit: (v) => {
      if (v.off) return ctx.api.fees.setLateFeeRule(null);
      const amountPaise = rupeesToPaise(v.amount);
      if (amountPaise === null || amountPaise <= 0) throw new Error('Enter the late-fee amount');
      const capText = String(v.cap || '').trim();
      const capPaise = capText === '' ? null : rupeesToPaise(capText);
      if (capText !== '' && (capPaise === null || capPaise <= 0)) throw new Error('Enter a valid maximum, or leave it empty');
      return ctx.api.fees.setLateFeeRule({ graceDays: Number(v.grace), mode: v.mode, amountPaise, capPaise, shiftDueToWorkingDay: !!v.shift });
    },
  });
}
