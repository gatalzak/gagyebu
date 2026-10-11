// 가계부 데이터 저장소: 브라우저 안(IndexedDB)에 전체 상태를 한 덩어리로 저장한다.
// 기기 간 합치기를 위해 모든 기록은 고유 id와 updatedAt을 갖고, 삭제도 deleted 표시로 남긴다.

const DB_NAME = "claude-gagyebu";
const STORE = "kv";
const KEY = "state";

/** 기기 간에 합치는 기록 묶음 */
export const COLLECTIONS = ["transactions", "assets", "debts", "subcats", "cats", "favorites", "budgets", "recurring"];

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function emptyState() {
  return { version: 1, transactions: {}, assets: {}, debts: {}, subcats: {}, cats: {}, favorites: {}, budgets: {}, recurring: {}, meta: {} };
}

export async function loadState() {
  const db = await openDB();
  const state = await new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return { ...emptyState(), ...(state || {}) };
}

export async function saveState(state) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(state, KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

export const nowISO = () => new Date().toISOString();

/** incoming의 기록을 state에 합친다. 같은 id면 updatedAt이 더 최근인 쪽이 이긴다. 바뀐 개수를 돌려준다. */
export function mergeInto(state, incoming) {
  let changed = 0;
  for (const col of COLLECTIONS) {
    for (const [id, rec] of Object.entries(incoming?.[col] || {})) {
      const cur = state[col][id];
      if (!cur || (rec.updatedAt || "") > (cur.updatedAt || "")) {
        state[col][id] = rec;
        changed++;
      }
    }
  }
  return changed;
}
