// Signatures printed on the annual Progress Report: each class teacher, the principal ("Center Head") and the director.
// The principal manages everyone's; a teacher only their own. A signature is sensitive: the image is shown only through
// an object URL made from the api's Blob (revoked when the page is left), never a URL from the server.
// Before upload the image is redrawn on a canvas and saved as PNG (JPEG if that is far smaller): that drops any camera
// or location data and keeps it under the server's limit (200 KB, 2000 px). The server checks the bytes again.
import { esc, banner, empty, pageHead, badge, openModal, confirmDialog, attempt, fdatetime } from '../components.js';
import { browserEnv } from '../photo-prep.js';

export const SIG_MAX_BYTES = 200 * 1024; // equals SIGNATURE_MAX_BYTES (src/domain/signatures.js; a test checks it)
export const SIG_EDGES = [1000, 700, 500];
const SOURCE_MAX = 15 * 1024 * 1024;

export class SignaturePrepError extends Error {
  constructor(message) { super(message); this.name = 'SignaturePrepError'; this.code = 'SIGNATURE_REFUSED'; }
}

const canvasEnv = {
  decode: (f) => browserEnv.decode(f),
  async encode(decoded, width, height, type, quality) {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const g = canvas.getContext('2d');
    if (type === 'image/jpeg') { g.fillStyle = '#ffffff'; g.fillRect(0, 0, width, height); } // JPEG has no transparency: white paper
    g.drawImage(decoded.source, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    if (!blob || blob.type !== type) throw new SignaturePrepError('This browser could not prepare the image');
    return blob;
  },
};

/** PNG or JPEG file → {blob, width, height}: PNG at the largest size that fits, else JPEG; never enlarged. */
export async function prepareSignature(file, env = canvasEnv) {
  if (!file || !(file.size > 0)) throw new SignaturePrepError('Choose an image first');
  if (!['image/png', 'image/jpeg'].includes(file.type)) throw new SignaturePrepError('Choose a PNG or JPEG image of the signature');
  if (file.size > SOURCE_MAX) throw new SignaturePrepError('That image is too large; crop it to the signature and try again');
  let decoded;
  try { decoded = await env.decode(file); } catch { throw new SignaturePrepError('This browser could not open that image. Nothing was uploaded.'); }
  try {
    for (const edge of SIG_EDGES) {
      const k = Math.min(1, edge / Math.max(decoded.width, decoded.height));
      const width = Math.max(1, Math.round(decoded.width * k)), height = Math.max(1, Math.round(decoded.height * k));
      for (const [type, q] of [['image/png', undefined], ['image/jpeg', 0.85]]) {
        const blob = await env.encode(decoded, width, height, type, q);
        if (blob.size <= SIG_MAX_BYTES) return { blob, width, height };
      }
    }
    throw new SignaturePrepError('The image is still larger than 200 KB; crop it closer to the signature');
  } finally { decoded.close?.(); }
}

export async function render(ctx) {
  const { api, persona } = ctx;
  const isAdmin = persona.role === 'admin';
  const rows = await api.signatures.list();
  const urls = [];
  ctx.cleanup(() => urls.splice(0).forEach((u) => URL.revokeObjectURL(u)));
  const previews = await Promise.all(rows.map((r) => (r.signature
    ? Promise.resolve().then(() => api.signatures.blob(r.signature.id)).then((b) => { const u = URL.createObjectURL(b); urls.push(u); return u; }).catch((e) => { console.error(e); return 'failed'; })
    : null)));
  const missing = rows.filter((r) => !r.signature).map((r) => (r.owner.kind === 'director' ? `the director${r.name ? ` (${r.name})` : ''}` : r.name));
  const noDirector = isAdmin && rows.some((r) => r.owner.kind === 'director' && !r.name);
  ctx.el.innerHTML = `${pageHead('Signatures', isAdmin ? 'Printed on the annual Progress Report' : 'Your signature on the annual Progress Report', `<a class="btn" href="${esc(ctx.href('/evaluations'))}">&larr; Progress Reports</a>`)}
    ${missing.length ? banner('warn', `<strong>No signature yet:</strong> ${esc(missing.join(', '))}. Reports print without a missing signature.`) : banner('ok', 'Every signature is on file.')}
    ${noDirector ? banner('info', `The director’s name is not set. <a href="${esc(ctx.href('/settings/school'))}">Set it in School details</a>.`) : ''}
    <p class="muted">Sign in dark ink on white paper, photograph or scan it, and crop it to the signature. PNG or JPEG. The image is shown only inside the app and on printed reports.</p>
    ${rows.length ? `<ul class="list card-list">${rows.map((r, i) => {
      const s = r.signature;
      const pv = previews[i];
      return `<li><div class="row between">
        <div><div class="item-title">${esc(r.owner.kind === 'director' ? (r.name || 'Director (name not set)') : r.name)}</div>
          <small>Signs as ${esc(r.signs)}${s ? ` &middot; added ${fdatetime(s.uploadedAt)}` : ''}</small>
          <div class="sig-preview">${s ? (pv && pv !== 'failed' ? `<img src="${esc(pv)}" alt="Signature of ${esc(r.name || r.signs)}">` : '<small class="err">The image could not be loaded</small>') : badge('No signature', 'warn')}</div></div>
        <div class="row">
          <label class="btn${s ? '' : ' primary'}" style="cursor:pointer">${s ? 'Replace' : 'Upload'}<input type="file" accept="image/png,image/jpeg" data-up="${esc(i)}" style="display:none"></label>
          ${s ? `<button class="btn ghost" data-rm="${esc(i)}">Remove</button>` : ''}
        </div></div></li>`;
    }).join('')}</ul>` : empty('Nobody to sign', 'Teachers and the principal appear here once they are set up as staff.')}`;

  ctx.el.addEventListener('change', async (e) => {
    const inp = e.target.closest?.('[data-up]');
    if (!inp) return;
    const r = rows[Number(inp.dataset.up)];
    const file = inp.files && inp.files[0];
    inp.value = '';
    if (!r || !file) return;
    await uploadFlow(ctx, r, file);
  });
  ctx.el.addEventListener('click', async (e) => {
    const b = e.target.closest?.('[data-rm]');
    if (!b) return;
    const r = rows[Number(b.dataset.rm)];
    if (!r) return;
    if (!(await confirmDialog('Remove signature', `Remove the signature of ${r.name || r.signs}? It is deleted at once and no longer printed on reports (published reports print without it too).`, { okLabel: 'Remove', kind: 'danger' }))) return;
    if ((await attempt(() => api.signatures.remove(r.owner), 'Signature removed')).ok) ctx.rerender();
  });
}

/** Prepare → preview (object URL) → confirm → upload. Exported for tests. */
export async function uploadFlow(ctx, row, file, env) {
  let prepared;
  try { prepared = await prepareSignature(file, env); } catch (e) { ctx.toast(e.message, 'bad'); return false; }
  const url = URL.createObjectURL(prepared.blob);
  try {
    const ok = await openModal({
      title: 'Use this signature?',
      body: `<div class="sig-preview big"><img src="${esc(url)}" alt="The signature to upload"></div><p>For ${esc(row.name || row.signs)}, printed as “${esc(row.signs)}”. ${esc(Math.round(prepared.blob.size / 1024))} KB.</p>`,
      actions: [{ label: 'Cancel', value: false }, { label: 'Upload', kind: 'primary', value: true }],
    });
    if (ok !== true) return false;
  } finally { URL.revokeObjectURL(url); }
  const r = await attempt(() => ctx.api.signatures.upload(row.owner, prepared.blob), 'Signature saved');
  if (r.ok) ctx.rerender();
  return r.ok;
}
