// 영수증 사진: 내역 기록(동기화 JSON)에는 사진 id만 두고, 사진 자체는 따로 저장한다.
// - 기기 안: 별도 IndexedDB(claude-gagyebu-photos)에 줄인 JPEG Blob으로 보관
// - 드라이브: 사진마다 파일 하나(클로드가계부_사진_<id>.jpg). 동기화 JSON이 커지지 않게 분리한다.

const DB_NAME = "claude-gagyebu-photos";
const STORE = "p"; // { id, blob, uploaded }
export const PHOTO_PREFIX = "클로드가계부_사진_";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  });
}

export const getPhoto = (id) => tx("readonly", (s) => s.get(id));
export const putPhoto = (rec) => tx("readwrite", (s) => { s.put(rec); });
export const deletePhoto = (id) => tx("readwrite", (s) => { s.delete(id); });
export const allPhotos = () => tx("readonly", (s) => s.getAll());

/** 사진을 긴 변 maxSide px 이하 JPEG로 줄인다(영수증 글자가 읽힐 정도, 보통 200~400KB). */
export async function shrinkImage(file, maxSide = 1600, quality = 0.78) {
  const img = await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error("사진을 읽지 못했어요")); };
    im.src = url;
  });
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // 투명 PNG도 흰 바탕으로
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

/**
 * 드라이브와 사진 맞추기. api(path, opts)는 sync.js의 인증된 fetch.
 * neededIds: 지금 살아 있는 내역이 가리키는 사진 id들.
 * - 이 기기에만 있는 사진은 올리고, 드라이브에만 있는 사진은 받아 온다.
 * 바뀐(받아 온) 사진 수를 돌려준다.
 */
export async function syncPhotos(api, neededIds) {
  const local = new Map((await allPhotos()).map((p) => [p.id, p]));
  let pulled = 0;
  for (const id of neededIds) {
    const p = local.get(id);
    if (p && p.uploaded) continue;
    const name = `${PHOTO_PREFIX}${id}.jpg`;
    const q = encodeURIComponent(`name='${name}' and trashed=false`);
    const found = (await (await api(`/drive/v3/files?q=${q}&spaces=drive&fields=files(id)`)).json()).files?.[0];
    if (p) {
      // 올리기 (이미 있으면 표시만)
      if (!found) {
        const boundary = "gagyebu" + Math.random().toString(36).slice(2);
        const meta = JSON.stringify({ name, mimeType: "image/jpeg" });
        const body = new Blob([
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`,
          p.blob,
          `\r\n--${boundary}--`,
        ]);
        await api("/upload/drive/v3/files?uploadType=multipart&fields=id", {
          method: "POST",
          headers: { "Content-Type": "multipart/related; boundary=" + boundary },
          body,
        });
      }
      await putPhoto({ ...p, uploaded: true });
    } else if (found) {
      // 받아 오기
      const blob = await (await api(`/drive/v3/files/${found.id}?alt=media`)).blob();
      await putPhoto({ id, blob, uploaded: true });
      pulled++;
    }
  }
  return pulled;
}

/**
 * 쓰지 않는 사진 정리. neededIds: 살아 있는 내역이 가리키는 사진 id들(동기화로 모든 기기 내역을 합친 뒤).
 * - 이 기기: 필요 없는 사진을 지운다.
 * - 드라이브: 필요 없는 사진 파일을 휴지통으로 옮긴다(30일 동안 되살릴 수 있음).
 *   다른 기기가 막 올리는 중일 수 있어서, 만든 지 minAgeMs(기본 2일)가 안 된 파일은 건드리지 않는다.
 * 휴지통으로 옮긴 드라이브 파일 수와 지운 기기 사진 수를 돌려준다.
 */
export async function cleanPhotos(api, neededIds, { minAgeMs = 2 * 86400000, list = allPhotos, remove = deletePhoto, now = Date.now() } = {}) {
  const need = new Set(neededIds);
  let local = 0, drive = 0;
  for (const p of await list()) {
    if (!need.has(p.id)) { await remove(p.id); local++; }
  }
  const q = encodeURIComponent(`name contains '${PHOTO_PREFIX}' and trashed=false`);
  let page = "";
  do {
    const r = await (await api(`/drive/v3/files?q=${q}&spaces=drive&pageSize=200&fields=nextPageToken,files(id,name,createdTime)${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`)).json();
    for (const f of r.files || []) {
      if (!f.name.startsWith(PHOTO_PREFIX)) continue;
      const id = f.name.slice(PHOTO_PREFIX.length).replace(/\.jpg$/, "");
      if (need.has(id) || now - new Date(f.createdTime).getTime() < minAgeMs) continue;
      await api(`/drive/v3/files/${f.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) });
      drive++;
    }
    page = r.nextPageToken || "";
  } while (page);
  return { drive, local };
}
