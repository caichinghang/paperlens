// Keeps the most recent local PDF in IndexedDB so a reload reopens it. Web PDFs don't need this:
// their address is in the URL. Only one file is kept; opening another replaces it.

const DB_NAME = "paperlens-local";
const STORE = "files";
const RECORD = "last";

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run(mode, action) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

// Storage can be unavailable (private windows) or full; the viewer works without it.
export async function saveLocalFile({ name, key, bytes, page = 1 }) {
  try {
    await run("readwrite", store => store.put({ name, key, bytes, page, savedAt: Date.now() }, RECORD));
    return true;
  } catch {
    return false;
  }
}

export async function loadLocalFile() {
  try {
    const record = await run("readonly", store => store.get(RECORD));
    return record?.bytes ? record : null;
  } catch {
    return null;
  }
}

export async function saveLocalPage(key, page) {
  try {
    const db = await open();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, "readwrite");
        const store = transaction.objectStore(STORE);
        const request = store.get(RECORD);
        request.onsuccess = () => {
          if (request.result?.key === key) {
            store.put({ ...request.result, page }, RECORD);
          }
        };
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
  } catch {
    // The page number is a convenience; losing it just reopens at the top.
  }
}
