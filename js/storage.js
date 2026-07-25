const DB_NAME = 'pdfsign';
const DB_VERSION = 2;
const STORE = 'signatures';

// Every call site (signatures, form memory) shared a single logical database,
// but each awaited its own indexedDB.open() — opening a fresh connection per
// call. Memoized here so the app holds one connection.
let dbPromise = null;

export function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('signatures')) {
          db.createObjectStore('signatures', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('userProfile')) {
          db.createObjectStore('userProfile', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('formHistory')) {
          db.createObjectStore('formHistory', { keyPath: 'key' });
        }
      };
      req.onsuccess = e => {
        const db = e.target.result;
        // A version bump in another tab, or the browser force-closing the
        // connection, invalidates the cache so the next call reopens fresh.
        db.onversionchange = () => { db.close(); dbPromise = null; };
        db.onclose = () => { dbPromise = null; };
        resolve(db);
      };
      req.onerror = e => { dbPromise = null; reject(e.target.error); };
    });
  }
  return dbPromise;
}

export async function saveSignature(dataUrl) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).add({ dataUrl, createdAt: Date.now() });
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

export async function getSignatures() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

export async function deleteSignature(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = e => reject(e.target.error);
  });
}
