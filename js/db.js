// IndexedDB 저장소 — 풀이 기록·자기평가·AI 채점·동기화 상태·생성문제·설정
// 앱 업데이트(서비스 워커 교체) 시에도 이 DB는 지우지 않는다.
// 스키마를 바꿀 때는 DB_VERSION을 올리고 onupgradeneeded에서 "추가"만 한다.

const DB_NAME = 'firequiz';
const DB_VERSION = 1;
let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (e.oldVersion < 1) {
        const at = db.createObjectStore('attempts', { keyPath: 'attempt_id' });
        at.createIndex('question_id', 'question_id', { unique: false });
        db.createObjectStore('generated', { keyPath: 'id' });
        db.createObjectStore('kv', { keyPath: 'key' });
      }
      // 이후 버전: if (e.oldVersion < 2) { ...추가만... }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('다른 탭에서 앱이 열려 있어 저장소를 열 수 없습니다.'));
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('저장 취소됨'));
  }));
}

function reqP(r) {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}

export const db = {
  getAll(store) { return tx(store, 'readonly', (s) => reqP(s.getAll())); },
  get(store, key) { return tx(store, 'readonly', (s) => reqP(s.get(key))); },
  put(store, value) { return tx(store, 'readwrite', (s) => { s.put(value); }); },
  putMany(store, values) { return tx(store, 'readwrite', (s) => { values.forEach((v) => s.put(v)); }); },
  del(store, key) { return tx(store, 'readwrite', (s) => { s.delete(key); }); },
  async kvGet(key, fallback = null) {
    const r = await this.get('kv', key);
    return r ? r.value : fallback;
  },
  kvSet(key, value) { return this.put('kv', { key, value }); }
};
