// Showing photos: bytes come from api.photos.blob(id) and are shown through URL.createObjectURL(blob) ONLY.
// No signed URL (or any server URL) ever reaches the DOM. Every object URL is revoked when the screen is left
// (ctx.cleanup runs before the next render), and a photo that arrives after that is dropped without making a URL.
import { esc, openModal } from './components.js';

/** The <img> markup for one photo; loadPhotos() fills in the src. */
export const photoImg = (id, alt = 'Photo of a classroom activity') =>
  `<button type="button" class="photo-thumb" data-open-photo="${esc(id)}" aria-label="Enlarge photo"><img data-photo="${esc(id)}" alt="${esc(alt)}" width="96" height="96"></button>`;

const wired = new WeakSet(); // one enlarge handler per container, however often it is redrawn

// Photos already downloaded in this session, kept in memory only (never on disk), so coming back to a screen does not
// download them again on a parent's prepaid data. Emptied on sign-out; the oldest entries go first beyond the cap.
const CACHE_MAX = 120;
const cache = new Map();
export function clearPhotoCache() { cache.clear(); }
function fetchBlob(api, id) {
  if (cache.has(id)) return Promise.resolve(cache.get(id));
  return Promise.resolve().then(() => api.photos.blob(id)).then(blob => {
    cache.set(id, blob);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return blob;
  });
}

/**
 * Load the img[data-photo] under root as they come into view (all at once where the browser cannot tell).
 * Returns {revokeAll} for tests; cleanup is also registered on ctx.
 * @param {{api:any, cleanup:(f:()=>void)=>void}} ctx
 */
export function loadPhotos(ctx, root) {
  const urls = [];
  let closed = false;
  let io = null;
  const revokeAll = () => { closed = true; io?.disconnect(); for (const u of urls.splice(0)) URL.revokeObjectURL(u); };
  ctx.cleanup(revokeAll);
  const load = (img) => {
    fetchBlob(ctx.api, img.dataset.photo).then(blob => {
      if (closed) return;
      const url = URL.createObjectURL(blob);
      urls.push(url);
      img.src = url;
      img.classList.add('loaded');
    }).catch(() => {
      if (closed) return;
      img.alt = 'This photo could not be loaded';
      img.parentElement?.classList.add('photo-missing');
    });
  };
  const imgs = [...root.querySelectorAll('img[data-photo]')];
  if (typeof IntersectionObserver === 'function') {
    io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); load(e.target); }
    }, { rootMargin: '200px' });
    imgs.forEach((img) => io.observe(img));
  } else imgs.forEach(load);
  if (!wired.has(root)) {
    wired.add(root);
    root.addEventListener('click', e => {
      const b = e.target.closest?.('[data-open-photo]');
      const img = b && b.querySelector('img[data-photo]');
      if (!img || !img.src) return;
      openModal({ title: 'Photo', body: `<img class="photo-big" src="${esc(img.src)}" alt="${esc(img.alt)}">` });
    });
  }
  return { revokeAll };
}
