// 구글 드라이브 동기화.
// 내 드라이브에 '클로드가계부_동기화.json' 파일 하나를 두고, 기기마다 [받기 → 내역 단위로 합치기 → 올리기]를 한다.
// 같은 내역은 updatedAt이 최신인 쪽이 이기고, 서로 다른 내역은 모두 남는다(통째로 덮어쓰지 않음).
// 권한은 drive.file: 이 앱이 만든 파일만 볼 수 있고 드라이브의 다른 파일에는 접근하지 못한다.
import { mergeInto, saveState, COLLECTIONS } from "./store.js";
import { GOOGLE_CLIENT_ID } from "./config.js";

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FILE_NAME = "클로드가계부_동기화.json";
const TOKEN_KEY = "gdrive_token";        // { token, exp }
const CONNECTED_KEY = "gdrive_connected"; // '1'이면 자동 동기화
const SILENT_KEY = "gdrive_silent_at";    // 조용한 재로그인 시도 시각 (반복 방지)

/** status: off | syncing | ok | offline | need-login | error */
export const sync = { status: "off", error: null, onChange: () => {} };

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    return null;
  }
}
function set(status) {
  sync.status = status;
  sync.onChange();
}

export const isConfigured = () => !!GOOGLE_CLIENT_ID;
export const isConnected = () => store(CONNECTED_KEY) === "1";

function token() {
  try {
    const t = JSON.parse(store(TOKEN_KEY));
    if (t && t.exp > Date.now() + 60_000) return t.token;
  } catch {}
  return null;
}

function authorize(prompt) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: location.origin + location.pathname.replace(/index\.html$/, ""), // 구글에 등록한 주소와 정확히 같아야 함
    response_type: "token",
    scope: SCOPE,
    include_granted_scopes: "true",
    prompt,
    state: "gdrive",
  });
  location.assign("https://accounts.google.com/o/oauth2/v2/auth?" + params);
}

export const connect = () => authorize("select_account consent");
export function disconnect() {
  store(TOKEN_KEY, null);
  store(CONNECTED_KEY, null);
  set("off");
}

/** 구글 로그인 후 돌아왔을 때 주소의 토큰을 저장한다. 새 토큰을 받았으면 true. */
export function handleRedirect() {
  if (!location.hash.includes("state=gdrive")) return false;
  const h = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, "", location.pathname + location.search);
  if (h.get("access_token")) {
    const exp = Date.now() + Number(h.get("expires_in") || 3600) * 1000;
    store(TOKEN_KEY, JSON.stringify({ token: h.get("access_token"), exp }));
    store(CONNECTED_KEY, "1");
    return true;
  }
  if (h.get("error")) {
    sync.error = h.get("error");
    if (isConnected()) set("need-login");
  }
  return false;
}

/** 연결돼 있는데 토큰(1시간짜리)이 만료됐으면 화면 전환으로 조용히 새 토큰을 받는다. 10분에 한 번만 시도. */
export function refreshIfNeeded() {
  if (!isConfigured() || !isConnected() || token() || !navigator.onLine) return false;
  const last = Number(store(SILENT_KEY) || 0);
  if (Date.now() - last < 10 * 60_000) {
    set("need-login");
    return false;
  }
  store(SILENT_KEY, String(Date.now()));
  authorize("none");
  return true;
}

// ---------------- 드라이브 API ----------------
async function api(path, opts = {}) {
  const t = token();
  if (!t) throw new Error("NO_TOKEN");
  const res = await fetch("https://www.googleapis.com" + path, {
    ...opts,
    headers: { Authorization: "Bearer " + t, ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    store(TOKEN_KEY, null);
    throw new Error("NO_TOKEN");
  }
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res;
}

async function findFile() {
  const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
  const r = await (await api(`/drive/v3/files?q=${q}&spaces=drive&orderBy=modifiedTime%20desc&fields=files(id)`)).json();
  return r.files?.[0]?.id || null;
}

const download = async (id) => (await api(`/drive/v3/files/${id}?alt=media`)).json();

async function upload(id, data) {
  const body = JSON.stringify(data);
  if (id) {
    await api(`/upload/drive/v3/files/${id}?uploadType=media`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return id;
  }
  const boundary = "gagyebu" + Math.random().toString(36).slice(2);
  const meta = { name: FILE_NAME, mimeType: "application/json" };
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  const r = await (await api("/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: { "Content-Type": "multipart/related; boundary=" + boundary },
    body: multipart,
  })).json();
  return r.id;
}

function hasLocalNewer(state, remote) {
  for (const col of COLLECTIONS) {
    for (const [id, rec] of Object.entries(state[col] || {})) {
      const r = remote?.[col]?.[id];
      if (!r || (rec.updatedAt || "") > (r.updatedAt || "")) return true;
    }
  }
  return false;
}

// ---------------- 동기화 ----------------
let running = null;

/** 드라이브와 합친다. 드라이브에서 받아 바뀐 기록 수를 돌려준다(화면 갱신 판단용). */
export function syncNow(state) {
  if (!isConfigured() || !isConnected()) return Promise.resolve(0);
  if (!navigator.onLine) { set("offline"); return Promise.resolve(0); }
  if (!token()) { set("need-login"); return Promise.resolve(0); }
  if (running) return running;

  running = (async () => {
    set("syncing");
    try {
      let id = state.meta.driveFileId || (await findFile());
      let remote = null;
      if (id) {
        try {
          remote = await download(id);
        } catch (e) {
          if (!String(e.message).includes("404")) throw e;
          id = await findFile(); // 파일이 지워졌으면 다시 찾고, 없으면 새로 만든다
          remote = id ? await download(id) : null;
        }
      }
      const pulled = remote ? mergeInto(state, remote) : 0;
      if (!remote || hasLocalNewer(state, remote)) {
        const { meta, ...data } = state; // 기기별 정보(meta)는 올리지 않음
        id = await upload(id, data);
      }
      state.meta.driveFileId = id;
      state.meta.lastSync = new Date().toISOString();
      await saveState(state);
      sync.error = null;
      set("ok");
      return pulled;
    } catch (e) {
      if (e.message === "NO_TOKEN") set("need-login");
      else { sync.error = e.message; set("error"); }
      return 0;
    } finally {
      running = null;
    }
  })();
  return running;
}
