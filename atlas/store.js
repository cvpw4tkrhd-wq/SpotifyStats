// Tiny IndexedDB key-value store, shared by the page and the import worker.
// Everything the app knows about a person lives here, on their own device.
const DB = 'listening-atlas';
const STORE = 'kv';
let dbp = null;

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('Storage is blocked by another tab of this app.'));
  });
}
const db = () => (dbp ||= open());

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    let req;
    try { req = fn(t.objectStore(STORE)); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage write was aborted.'));
  });
}

export const get = (k) => tx('readonly', (s) => s.get(k));
export const put = (k, v) => tx('readwrite', (s) => s.put(v, k));
export const del = (k) => tx('readwrite', (s) => s.delete(k));
export const keys = () => tx('readonly', (s) => s.getAllKeys());
export const clearAll = () => tx('readwrite', (s) => s.clear());
export const putMany = (o) => tx('readwrite', (s) => { for (const [k, v] of Object.entries(o)) s.put(v, k); });
export async function delPrefix(prefix) {
  for (const k of await keys()) if (String(k).startsWith(prefix)) await del(k);
}
