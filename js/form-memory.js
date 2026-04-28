import { openDB } from './storage.js';

export class FormMemory {
  async _getHistoryEntry(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction('formHistory', 'readonly');
      const req = tx.objectStore('formHistory').get(key);
      req.onsuccess = e => resolve(e.target.result || null);
      req.onerror   = e => reject(e.target.error);
    });
  }

  // Returns [{value, source:'history', score}] sorted by frequency
  async getSuggestions(canonicalKey) {
    const history = await this._getHistoryEntry(canonicalKey);
    if (!history?.entries) return [];
    return [...history.entries]
      .sort((a, b) => b.usedCount - a.usedCount)
      .slice(0, 5)
      .map(e => ({ value: e.value, source: 'history', score: e.usedCount }));
  }

  async recordUsage(canonicalKey, label, value) {
    if (!value) return;
    const existing = await this._getHistoryEntry(canonicalKey)
      || { key: canonicalKey, label, entries: [] };
    const entry = existing.entries.find(e => e.value === value);
    if (entry) {
      entry.usedCount++;
      entry.lastUsed = Date.now();
    } else {
      existing.entries.push({ value, usedCount: 1, lastUsed: Date.now() });
    }
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction('formHistory', 'readwrite');
      const req = tx.objectStore('formHistory').put(existing);
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    });
  }

  async exportMemory() {
    const db = await openDB();
    const history = await new Promise((resolve, reject) => {
      const tx  = db.transaction('formHistory', 'readonly');
      const req = tx.objectStore('formHistory').getAll();
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
    return { history };
  }

  async importMemory(data) {
    if (!data.history) return;
    const db = await openDB();
    for (const entry of data.history) {
      await new Promise((resolve, reject) => {
        const tx  = db.transaction('formHistory', 'readwrite');
        const req = tx.objectStore('formHistory').put(entry);
        req.onsuccess = () => resolve();
        req.onerror   = e => reject(e.target.error);
      });
    }
  }
}
