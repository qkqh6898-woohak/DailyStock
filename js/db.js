// db.js — IndexedDB 래퍼 (DB 이름 'stockstudy', 버전 1)
//
// 저장소(store)
//   terms        키 id            내 용어장 { id, ko, en, short, long, formula, example, track, firstLesson, firstDate, card, custom, createdAt, updatedAt }
//   reviewLogs   키 자동 증가      복습 기록 { termId, rating, state, due, reviewedAt }
//   quizResults  키 key            퀴즈 결과 `${date}#${i}` / `weekly#${weekId}#${i}`
//   progress     키 lesson_no      진도 { lesson_no, date, readAt, quizDoneAt, updatedAt }
//   journal      키 id(UUID)       투자 일지 — 이 기기에만 저장되고 네트워크로 나가지 않는다
//   settings     키 key            설정 { key, value, updatedAt }
//   lessonCache  키 date           강의 JSON 사본(오프라인용)
//   cache        키 key            목록·사전·커리큘럼 사본(오프라인용, 백업에는 넣지 않음)
//
// IndexedDB 를 쓸 수 없는 환경(일부 사생활 보호 모드)에서는 메모리에만 저장하고 memoryOnly 를 true 로 둔다.

export const DB_NAME = 'stockstudy';
export const DB_VERSION = 1;

/** 백업·전체 삭제 대상(사용자 데이터). */
export const USER_STORES = ['terms', 'reviewLogs', 'quizResults', 'progress', 'journal', 'settings'];
const ALL_STORES = [...USER_STORES, 'lessonCache', 'cache'];

export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'system',          // system | light | dark
  fontScale: 1,             // 0.9 | 1 | 1.12 | 1.25
  ttsRate: 1,               // 0.7 ~ 1.3
  ttsVoiceEn: '',           // voiceURI (비어 있으면 자동)
  ttsVoiceKo: '',
  newPerDay: 15,            // 하루 새 용어 수
  retention: 0.9,           // 목표 기억률
  reviewMode: 'term',       // term(용어→뜻) | meaning(뜻→용어) | english(영어→한국어)
  dividendTaxRate: 15.4,    // 배당 세율 기본값(%)
  lastBackupAt: null,       // 마지막 백업 시각(ISO)
  firstUseAt: null,         // 처음 쓴 날(백업 안내 기준)
});

let dbPromise = null;
let memory = null;          // IndexedDB 를 못 쓸 때의 대체 저장소
export let memoryOnly = false;

function createStores(db) {
  if (!db.objectStoreNames.contains('terms')) db.createObjectStore('terms', { keyPath: 'id' });
  if (!db.objectStoreNames.contains('reviewLogs')) {
    const s = db.createObjectStore('reviewLogs', { keyPath: 'id', autoIncrement: true });
    s.createIndex('termId', 'termId', { unique: false });
  }
  if (!db.objectStoreNames.contains('quizResults')) db.createObjectStore('quizResults', { keyPath: 'key' });
  if (!db.objectStoreNames.contains('progress')) db.createObjectStore('progress', { keyPath: 'lesson_no' });
  if (!db.objectStoreNames.contains('journal')) db.createObjectStore('journal', { keyPath: 'id' });
  if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
  if (!db.objectStoreNames.contains('lessonCache')) db.createObjectStore('lessonCache', { keyPath: 'date' });
  if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache', { keyPath: 'key' });
}

const KEY_PATHS = {
  terms: 'id', reviewLogs: 'id', quizResults: 'key', progress: 'lesson_no',
  journal: 'id', settings: 'key', lessonCache: 'date', cache: 'key',
};

function useMemory() {
  memoryOnly = true;
  memory = Object.fromEntries(ALL_STORES.map((name) => [name, new Map()]));
  memory.autoId = 0;
  return null;
}

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(useMemory()); return; }
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(useMemory());
      return;
    }
    request.onupgradeneeded = () => createStores(request.result);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => resolve(useMemory());
    request.onblocked = () => resolve(useMemory());
  });
  return dbPromise;
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('저장이 취소됐습니다'));
  });
}

const clone = (v) => (v === undefined ? undefined : structuredClone(v));

export async function get(store, key) {
  const db = await openDb();
  if (!db) return clone(memory[store].get(key));
  return wrap(db.transaction(store, 'readonly').objectStore(store).get(key));
}

export async function getAll(store) {
  const db = await openDb();
  if (!db) return [...memory[store].values()].map(clone);
  return wrap(db.transaction(store, 'readonly').objectStore(store).getAll());
}

export async function count(store) {
  const db = await openDb();
  if (!db) return memory[store].size;
  return wrap(db.transaction(store, 'readonly').objectStore(store).count());
}

/** 한 건 저장(같은 키가 있으면 덮어쓴다). 저장된 키를 돌려준다. */
export async function put(store, value) {
  const db = await openDb();
  if (!db) {
    const keyPath = KEY_PATHS[store];
    const copy = clone(value);
    if (copy[keyPath] === undefined) { memory.autoId += 1; copy[keyPath] = memory.autoId; }
    memory[store].set(copy[keyPath], copy);
    return copy[keyPath];
  }
  const tx = db.transaction(store, 'readwrite');
  const req = tx.objectStore(store).put(value);
  const key = await wrap(req);
  await done(tx);
  return key;
}

/** 여러 건을 한 번에 저장한다. */
export async function putMany(store, values) {
  if (!values || values.length === 0) return;
  const db = await openDb();
  if (!db) { for (const v of values) await put(store, v); return; }
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const v of values) os.put(v);
  await done(tx);
}

export async function del(store, key) {
  const db = await openDb();
  if (!db) { memory[store].delete(key); return; }
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await done(tx);
}

export async function clear(store) {
  const db = await openDb();
  if (!db) { memory[store].clear(); return; }
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  await done(tx);
}

/**
 * 여러 저장소를 한 트랜잭션으로 바꿔 쓴다(백업 가져오기용). 중간에 실패하면 모두 되돌려진다.
 * @param {Record<string, any[]>} data  저장소 이름 → 레코드 배열
 * @param {{ clearFirst?: boolean }} [opts]
 */
export async function replaceStores(data, { clearFirst = true } = {}) {
  const names = Object.keys(data).filter((n) => ALL_STORES.includes(n));
  if (names.length === 0) return;
  const db = await openDb();
  if (!db) {
    for (const name of names) {
      if (clearFirst) memory[name].clear();
      for (const v of data[name]) await put(name, v);
    }
    return;
  }
  const tx = db.transaction(names, 'readwrite');
  for (const name of names) {
    const os = tx.objectStore(name);
    if (clearFirst) os.clear();
    for (const v of data[name]) os.put(v);
  }
  await done(tx);
}

/* ───────────── 설정 ───────────── */

let settingsCache = null;

/** 모든 설정(기본값 포함)을 객체로. */
export async function getSettings() {
  if (settingsCache) return settingsCache;
  const rows = await getAll('settings');
  const out = { ...DEFAULT_SETTINGS };
  for (const row of rows) if (row && typeof row.key === 'string') out[row.key] = row.value;
  settingsCache = out;
  return out;
}

export async function getSetting(key) {
  return (await getSettings())[key];
}

export async function setSetting(key, value) {
  const settings = await getSettings();
  settings[key] = value;
  await put('settings', { key, value, updatedAt: new Date().toISOString() });
}

/** 설정 캐시를 버린다(백업 가져오기·전체 삭제 뒤). */
export function resetSettingsCache() {
  settingsCache = null;
}

/* ───────────── 기타 ───────────── */

/** 브라우저가 저장 공간을 마음대로 지우지 않도록 요청한다. */
export async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch { /* 지원하지 않는 브라우저 */ }
  return false;
}

/** 사용자 데이터를 모두 지운다(강의 사본은 남긴다). */
export async function wipeUserData() {
  await replaceStores(Object.fromEntries(USER_STORES.map((n) => [n, []])), { clearFirst: true });
  resetSettingsCache();
}
