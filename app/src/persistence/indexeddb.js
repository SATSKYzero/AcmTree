// ================================================================
// IndexedDB 底层读写（persistence/indexeddb.js）
// 职责：raw get/put/delete/getAll
// 依赖：无
// 说明：使用独立 DB 名，与其他数据隔离
// ================================================================

const DB_NAME = 'AcmTreeDB_v7';
const DB_VERSION = 1;

const STORES = ['nodes', 'childOrder', 'pages', 'meta'];

let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (ev) => {
            const db = ev.target.result;
            if (!db.objectStoreNames.contains('nodes')) {
                db.createObjectStore('nodes', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('childOrder')) {
                db.createObjectStore('childOrder', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('pages')) {
                db.createObjectStore('pages', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('meta')) {
                db.createObjectStore('meta', { keyPath: 'key' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}

// ---- 单条读 ----
export async function idbGet(store, key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// ---- 批量读（整表） ----
export async function idbGetAll(store) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

// ---- 批量写（同一事务内） ----
export async function idbBatch(ops) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const storesUsed = [...new Set(ops.map(o => o.store))];
        const tx = db.transaction(storesUsed, 'readwrite');
        for (const o of ops) {
            const s = tx.objectStore(o.store);
            if (o.op === 'put') s.put(o.value);
            else if (o.op === 'delete') s.delete(o.key);
        }
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
    });
}

// ---- 清空所有 store ----
export async function idbClearAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES, 'readwrite');
        for (const s of STORES) tx.objectStore(s).clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
    });
}

// ---- 估算存储大小 ----
export async function idbEstimateSize() {
    if (navigator.storage && navigator.storage.estimate) {
        const { usage, quota } = await navigator.storage.estimate();
        return { usage: usage || 0, quota: quota || 0 };
    }
    return { usage: 0, quota: 0 };
}