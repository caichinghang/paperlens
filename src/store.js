const hasChromeStorage = typeof chrome !== "undefined" && !!chrome.storage?.local;

export async function getItem(key, fallback = null) {
  try {
    if (hasChromeStorage) {
      const result = await chrome.storage.local.get(key);
      return result[key] ?? fallback;
    }
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function setItem(key, value) {
  try {
    if (hasChromeStorage) {
      await chrome.storage.local.set({ [key]: value });
      return;
    }
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private mode, quota); the viewer keeps working in memory.
  }
}

export async function removeItem(key) {
  try {
    if (hasChromeStorage) {
      await chrome.storage.local.remove(key);
      return;
    }
    localStorage.removeItem(key);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}
