// ================================================================
// 冒烟测试用内存版 IndexedDB 桩（scripts/smoke/idb.mjs）
//
// 为什么需要：
//   shell/executor.js 的 execute() 在事务提交后会调 saveData → indexedDB。
//   Node 里没有 indexedDB，会抛 ReferenceError，进而触发事务回滚，
//   使任何"通过 execute 改状态"的冒烟断言都失败。
//
// 覆盖面：
//   只实现项目实际用到的 API（见 persistence/indexeddb.js）：
//   open / objectStoreNames.contains / createObjectStore /
//   transaction / objectStore / put / delete / get / getAll / clear
//
// 行为约定尽量贴近真实 IndexedDB：请求回调与事务完成都是**异步**的，
//   因此调用方必须依赖 onsuccess / oncomplete，而不能假设同步返回。
// ================================================================

function makeRequest() {
    return { onsuccess: null, onerror: null, result: undefined, error: null };
}

function fireSuccess(req, result) {
    req.result = result;
    queueMicrotask(() => { if (req.onsuccess) req.onsuccess({ target: req }); });
}

class FakeStore {
    constructor(name, keyPath) {
        this.name = name;
        this.keyPath = keyPath;
        this.data = new Map();
    }
    _keyOf(value) { return value[this.keyPath]; }
    put(value) {
        const req = makeRequest();
        this.data.set(this._keyOf(value), value);
        fireSuccess(req, undefined);
        return req;
    }
    delete(key) {
        const req = makeRequest();
        this.data.delete(key);
        fireSuccess(req, undefined);
        return req;
    }
    get(key) {
        const req = makeRequest();
        fireSuccess(req, this.data.get(key));
        return req;
    }
    getAll() {
        const req = makeRequest();
        fireSuccess(req, [...this.data.values()]);
        return req;
    }
    clear() {
        const req = makeRequest();
        this.data.clear();
        fireSuccess(req, undefined);
        return req;
    }
}

class FakeTransaction {
    constructor(db, storeNames) {
        this.db = db;
        this.storeNames = [].concat(storeNames);
        this.oncomplete = null;
        this.onerror = null;
        this.error = null;
        // 构造函数里排队完成：此时同步的 put/delete 与 oncomplete 赋值都已完成
        setTimeout(() => { if (this.oncomplete) this.oncomplete(); }, 0);
    }
    objectStore(name) {
        const store = this.db.stores.get(name);
        if (!store) throw new Error(`FakeIDB: 没有 object store "${name}"`);
        return store;
    }
}

class FakeDatabase {
    constructor(name, version) {
        this.name = name;
        this.version = version;
        this.stores = new Map();
        const self = this;
        this.objectStoreNames = { contains: n => self.stores.has(n) };
    }
    createObjectStore(name, options = {}) {
        const store = new FakeStore(name, options.keyPath);
        this.stores.set(name, store);
        return store;
    }
    transaction(storeNames, _mode) {
        return new FakeTransaction(this, storeNames);
    }
}

/** 安装全局 indexedDB 桩；重复调用会清空数据 */
export function installIndexedDb() {
    const databases = new Map();

    globalThis.indexedDB = {
        open(name, version) {
            const req = makeRequest();
            let db = databases.get(name);
            const isNew = !db;
            if (!db) {
                db = new FakeDatabase(name, version);
                databases.set(name, db);
            }
            req.result = db;
            setTimeout(() => {
                if (isNew && req.onupgradeneeded) req.onupgradeneeded({ target: req });
                if (req.onsuccess) req.onsuccess({ target: req });
            }, 0);
            return req;
        }
    };

    return globalThis.indexedDB;
}
