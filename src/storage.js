(() => {
  'use strict';
  // Device-local database. Legacy localStorage is read only, never deleted or rewritten.
  const DB_NAME = 'storeflow-device-v1';
  const STORE = 'workspace';
  const STATE_KEY = 'storeflow-state-v1';
  const UNDO_KEY = 'storeflow-undo-v1';
  const failure = name => Object.assign(new Error(name), { name });

  function validateState(raw) {
    if (raw === null) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.projects) || !Array.isArray(parsed.parts)) throw failure('InvalidBackupError');
  }

  function createStorage(indexedDB = globalThis.indexedDB, legacy = () => globalThis.localStorage) {
    let db;
    let revision = 0;
    let ready = false;
    let queue = Promise.resolve();

    function transaction(mode) {
      if (mode === 'readonly') return db.transaction(STORE, mode);
      try { return db.transaction(STORE, mode, { durability: 'strict' }); }
      catch (error) { if (error.name !== 'TypeError') throw error; return db.transaction(STORE, mode); }
    }

    function read() {
      return new Promise((resolve, reject) => {
        const tx = transaction('readonly');
        let value;
        const request = tx.objectStore(STORE).get('current');
        request.onsuccess = () => { value = request.result; };
        tx.oncomplete = () => resolve(value);
        tx.onabort = () => reject(tx.error || failure('AbortError'));
        tx.onerror = () => {};
      });
    }

    function write(state, undo, migration = false) {
      validateState(state);
      if (!Array.isArray(JSON.parse(undo))) throw failure('InvalidBackupError');
      return new Promise((resolve, reject) => {
        const tx = transaction('readwrite');
        const store = tx.objectStore(STORE);
        let problem;
        let next;
        const abort = error => { problem = error; tx.abort(); };
        const current = store.get('current');
        current.onsuccess = () => {
          if ((current.result?.revision || 0) !== revision) return abort(failure('ConflictError'));
          next = { state, undo, revision: revision + 1 };
          // Keep the original exact migration bundle in the database too.
          if (migration) store.put({ state, undo }, 'legacy-copy');
          const put = store.put(next, 'current');
          put.onsuccess = () => {
            const check = store.get('current');
            check.onsuccess = () => {
              if (check.result?.state !== state || check.result?.undo !== undo || check.result?.revision !== next.revision) abort(failure('VerificationError'));
            };
          };
        };
        tx.oncomplete = () => { revision = next.revision; resolve(next); };
        tx.onabort = () => reject(problem || tx.error || failure('AbortError'));
        tx.onerror = () => {};
      });
    }

    async function init() {
      if (!indexedDB) throw failure('NotSupportedError');
      db = await new Promise((resolve, reject) => {
        let settled = false;
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
        request.onblocked = () => { settled = true; reject(failure('BlockedError')); };
        request.onerror = () => { settled = true; reject(request.error); };
        request.onsuccess = () => { if (settled) { request.result.close(); return; } resolve(request.result); };
      });
      db.onversionchange = () => { ready = false; db.close(); };
      const existing = await read();
      if (existing) {
        validateState(existing.state);
        if (!Array.isArray(JSON.parse(existing.undo))) throw failure('InvalidBackupError');
        revision = existing.revision;
        ready = true;
        return existing;
      }
      // An unreadable/corrupt legacy source must never be treated as an empty app.
      const old = legacy();
      const state = old.getItem(STATE_KEY);
      const undo = old.getItem(UNDO_KEY) || '[]';
      validateState(state);
      await write(state, undo, true);
      // Independent read after the commit confirms the migration before use.
      const verified = await read();
      if (verified.state !== state || verified.undo !== undo) throw failure('VerificationError');
      ready = true;
      return verified;
    }

    function save(state, undo) {
      // Capture strings at the call site; queue operations so older saves cannot win.
      const result = queue.then(() => {
        if (!ready) throw failure('InvalidStateError');
        return write(state, undo);
      });
      queue = result.catch(() => {});
      return result;
    }
    return { init, save, flush: () => queue, close: () => { ready = false; db?.close(); } };
  }
  globalThis.StoreFlowStorage = { create: createStorage, validateState };
})();
