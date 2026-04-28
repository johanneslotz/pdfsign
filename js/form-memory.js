import { openDB } from './storage.js';

export const PROFILE_FIELDS = [
  { key: 'salutation',    label: 'Salutation',       type: 'select', options: ['', 'Mr.', 'Ms.', 'Dr.', 'Prof.', 'Mx.'] },
  { key: 'first_name',    label: 'First Name',        type: 'text' },
  { key: 'last_name',     label: 'Last Name',         type: 'text' },
  { key: 'full_name',     label: 'Full Name',         type: 'text' },
  { key: 'date_of_birth', label: 'Date of Birth',     type: 'date' },
  { key: 'email',         label: 'Email',             type: 'email' },
  { key: 'phone',         label: 'Phone',             type: 'tel' },
  { key: 'mobile',        label: 'Mobile',            type: 'tel' },
  { key: 'address',       label: 'Street & Number',   type: 'text' },
  { key: 'city',          label: 'City',              type: 'text' },
  { key: 'state',         label: 'State / Region',    type: 'text' },
  { key: 'zip',           label: 'ZIP / Postal Code', type: 'text' },
  { key: 'country',       label: 'Country',           type: 'text' },
  { key: 'company',       label: 'Company',           type: 'text' },
  { key: 'job_title',     label: 'Job Title',         type: 'text' },
  { key: 'iban',          label: 'IBAN',              type: 'text' },
  { key: 'tax_id',        label: 'Tax ID / VAT',      type: 'text' },
];

export class FormMemory {
  async getUserProfile() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction('userProfile', 'readonly');
      const req = tx.objectStore('userProfile').getAll();
      req.onsuccess = e => {
        const map = {};
        for (const item of e.target.result) map[item.key] = item;
        resolve(map);
      };
      req.onerror = e => reject(e.target.error);
    });
  }

  async saveUserProfile(fields) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction('userProfile', 'readwrite');
      const store = tx.objectStore('userProfile');
      for (const f of fields) {
        store.put({ key: f.key, label: f.label, value: f.value ?? '', updatedAt: Date.now() });
      }
      tx.oncomplete = resolve;
      tx.onerror    = e => reject(e.target.error);
    });
  }

  async _getHistoryEntry(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction('formHistory', 'readonly');
      const req = tx.objectStore('formHistory').get(key);
      req.onsuccess = e => resolve(e.target.result || null);
      req.onerror   = e => reject(e.target.error);
    });
  }

  // Returns [{value, source:'profile'|'history', score}] sorted best-first
  async getSuggestions(canonicalKey) {
    const [profile, history] = await Promise.all([
      this.getUserProfile(),
      this._getHistoryEntry(canonicalKey),
    ]);

    const suggestions = [];

    if (profile[canonicalKey]?.value) {
      suggestions.push({ value: profile[canonicalKey].value, source: 'profile', score: 100 });
    }

    if (history?.entries) {
      for (const e of [...history.entries].sort((a, b) => b.usedCount - a.usedCount)) {
        if (!suggestions.some(s => s.value === e.value)) {
          suggestions.push({ value: e.value, source: 'history', score: e.usedCount });
        }
      }
    }

    return suggestions.slice(0, 5);
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
    const [profileMap, db] = await Promise.all([this.getUserProfile(), openDB()]);
    const history = await new Promise((resolve, reject) => {
      const tx  = db.transaction('formHistory', 'readonly');
      const req = tx.objectStore('formHistory').getAll();
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
    return { profile: Object.values(profileMap), history };
  }

  async importMemory(data) {
    if (data.profile) await this.saveUserProfile(data.profile);
    if (data.history) {
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
}
