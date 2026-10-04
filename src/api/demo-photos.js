// Demo photo bytes. A teacher's own photo (after the canvas prep in src/ui/photo-prep.js) is kept as a Blob in the
// browser's IndexedDB (database montessori.photos.v1, key = photo id) and nowhere else: never localStorage, never the
// seed, never git. Reset-to-seed clears it. Where IndexedDB is missing or blocked (and in Node tests) a memory map
// stands in and the note says so. The seed's own photos are SVG illustrations (src/seed/illustrations.js), not stored.

export const PHOTO_DB = 'montessori.photos.v1';
const STORE = 'blobs';

/** In-memory store with the same shape (tests, and the fallback when IndexedDB cannot be used). */
export function memoryPhotoStore() {
  const m = new Map();
  return {
    persistent: false,
    note: 'photos are kept in memory only and are lost on reload',
    put: async (id, blob) => { m.set(id, blob); },
    get: async id => m.get(id) ?? null,
    remove: async id => { m.delete(id); },
    clear: async () => { m.clear(); },
    size: async () => m.size,
  };
}

const wrap = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

/** IndexedDB-backed store; rejects at open time when IndexedDB is unavailable (the caller falls back to memory). */
export async function indexedDbPhotoStore(idb = globalThis.indexedDB) {
  if (!idb) throw new Error('IndexedDB is not available in this browser');
  const db = await new Promise((resolve, reject) => {
    const open = idb.open(PHOTO_DB, 1);
    open.onupgradeneeded = () => { open.result.createObjectStore(STORE); };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error('IndexedDB is blocked'));
  });
  const run = (mode, fn) => { const tx = db.transaction(STORE, mode); return wrap(fn(tx.objectStore(STORE))); };
  return {
    persistent: true,
    note: null,
    put: (id, blob) => run('readwrite', s => s.put(blob, id)).then(() => undefined),
    get: id => run('readonly', s => s.get(id)).then(b => b ?? null),
    remove: id => run('readwrite', s => s.delete(id)).then(() => undefined),
    clear: () => run('readwrite', s => s.clear()).then(() => undefined),
    size: () => run('readonly', s => s.count()),
  };
}

/**
 * Lazy photo bytes holder for the demo api. `open` picks the store on first use (default: IndexedDB, else memory).
 * @param {() => Promise<ReturnType<typeof memoryPhotoStore>>} [open]
 */
export function createDemoPhotos(open = async () => { try { return await indexedDbPhotoStore(); } catch { return memoryPhotoStore(); } }) {
  let storeP = null;
  const store = () => (storeP ??= open());
  return {
    put: async (id, blob) => (await store()).put(id, blob),
    get: async id => (await store()).get(id),
    remove: async id => (await store()).remove(id),
    clear: async () => (await store()).clear(),
    info: async () => { const s = await store(); return { persistent: s.persistent, note: s.note, count: await s.size() }; },
  };
}
