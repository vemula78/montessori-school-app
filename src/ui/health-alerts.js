// Allergies and medical alerts (#78): the badge on the teacher's register, diary and going-home lists, the details behind
// it, and the card where the principal or a parent changes them. Reads and writes go through api.health only.
import { esc, banner, openModal, formModal, fdatetime, toast } from './components.js';

const MAX = 500; // as the domain allows (HEALTH_TEXT_MAX)

/** {map: studentId → row, error} for one programme. A failed read is said on screen: no badge must never look like "no allergy". */
export async function loadAlerts(api, programId) {
  try { return { map: new Map((await api.health.alerts(programId)).map((r) => [r.studentId, r])), error: null }; } catch (e) { return { map: new Map(), error: e }; }
}

export const alertsUnavailable = (res) => (res.error ? banner('warn', '<strong>Allergy and medical alerts could not be loaded.</strong> Check the children’s health details before meals and medicines.') : '');

export const alertLabel = (r) => (r.allergies ? 'Allergy' : r.medical ? 'Medical alert' : 'Health note');

/** The tappable badge next to a child's name ('' when the child has nothing recorded). */
export function healthBadge(r) {
  if (!r) return '';
  return `<button type="button" class="chip health-flag${r.allergies || r.medical ? '' : ' note'}" data-health="${esc(r.studentId)}" aria-label="${esc(alertLabel(r))} for ${esc(r.name)}: show details">${esc(alertLabel(r))}</button>`;
}

export function healthDetailsHtml(r) {
  const part = (label, text) => (text ? `<div><strong>${esc(label)}</strong><div style="white-space:pre-wrap">${esc(text)}</div></div>` : '');
  const all = `${part('Allergies', r.allergies)}${part('Medical alerts', r.medical)}${part('Health note', r.notes)}`;
  return `<div class="stack">${all || '<p class="muted" style="margin:0">Nothing recorded.</p>'}
    ${r.updatedAt ? `<small class="muted">Allergies and alerts last changed ${fdatetime(r.updatedAt)} by ${r.updatedByRole === 'parent' ? 'a parent' : 'the school'}.</small>` : ''}</div>`;
}

/** One tap on a badge under root shows that child's details. */
export function wireHealthBadges(root, map) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-health]');
    const r = b && map.get(b.dataset.health);
    if (r) openModal({ title: `${r.name}: health`, body: healthDetailsHtml(r) });
  });
}

/** The card on the principal's child page and the parent's page: what is recorded, and a button to change it. */
export function healthCardHtml(r, { canEdit, forParent = false } = {}) {
  return `<div class="card stack" id="health-card"><div class="row between"><h2 style="margin:0">Allergies and health</h2>${canEdit && r ? '<button class="btn sm" id="health-edit">Change</button>' : ''}</div>
    ${r ? healthDetailsHtml(r) : '<p class="muted" style="margin:0">Health details could not be loaded.</p>'}
    ${forParent ? '<small>The class teacher sees these at meals, on the register and at going-home time. Tell the school in person about anything urgent.</small>' : '<small>The child’s teachers see these as a badge on the register, the diary and the going-home list. The driver and the accountant do not.</small>'}</div>`;
}

/** Change allergies, medical alerts and the health note; resolves true when saved. */
export function editHealth(ctx, r) {
  const area = (name, label, value, hint) => `<label class="field"><span class="lbl">${esc(label)}</span><textarea name="${name}" maxlength="${MAX}" style="min-height:60px">${esc(value || '')}</textarea>${hint ? `<small>${esc(hint)}</small>` : ''}</label>`;
  return formModal({
    title: `Allergies and health - ${r.name}`, submitLabel: 'Save',
    fieldsHtml: `${area('allergies', 'Allergies', r.allergies, 'Foods, medicines or anything else, and what happens. Leave empty if none.')}
      ${area('medical', 'Medical alerts', r.medical, 'For example asthma and where the inhaler is kept.')}
      ${area('notes', 'Other health note', r.notes, '')}
      <small>Each box takes up to ${MAX} characters. The audit log records which boxes changed, never what they say.</small>`,
    onSubmit: async (v) => {
      const patch = {};
      for (const k of ['allergies', 'medical', 'notes']) if (String(v[k] ?? '').trim() !== String(r[k] ?? '')) patch[k] = String(v[k] ?? '').trim();
      if (!Object.keys(patch).length) return;
      await ctx.api.health.set({ studentId: r.studentId, ...patch });
      toast('Health details saved');
    },
  });
}
