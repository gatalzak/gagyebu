// 앱 잠금(PIN·지문)과 금액 가리기. 설정은 이 기기에만 저장한다(localStorage, 동기화 안 함).
// 웹앱 잠금은 폰을 잠깐 빌린 사람이 화면을 못 보게 하는 정도의 보호이고, 데이터 자체를 암호화하지는 않는다.

const LOCK_KEY = "gagyebu-lock";   // { hash, salt, timing, bio }
const HIDE_KEY = "gagyebu-hide";   // "1"이면 금액 가리기
const SEEN_KEY = "gagyebu-last-seen";
const TIMEOUTS = { open: 0, 1: 60_000, 5: 300_000, 30: 1_800_000 };
const TIMING_LABEL = { open: "앱을 다시 열 때마다", 1: "1분 동안 안 쓰면", 5: "5분 동안 안 쓰면", 30: "30분 동안 안 쓰면" };
const TIMING_ORDER = ["open", "1", "5", "30"]; // 숫자 키는 객체에서 앞으로 정렬되므로 순서를 따로 둔다

let cfg = load();
let locked = false;
let lastActive = Date.now();
let hiddenAt = null;
let bioOk = false; // 이 기기에서 지문·얼굴 인증을 쓸 수 있는지
let fails = 0, waitUntil = 0;
let hooks = { toast: () => {}, status: () => ({ connected: false, lastSync: null, lastBackup: null }) };
const RESET_FLAG = "gagyebu-after-reset";
const when = (iso) => (iso ? new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

/** 지금 데이터를 되살릴 수 있는 상태(드라이브·백업 파일) 요약 */
function safetyBox(warn = true) {
  const st = hooks.status();
  const line = (ok, label, detail) => `<div class="sf-row ${ok ? "ok" : "no"}"><span class="sf-mark">${ok ? "✓" : "✕"}</span><span>${label}${detail ? ` <span class="muted">· ${detail}</span>` : ""}</span></div>`;
  const risky = !st.connected && !st.lastBackup;
  return `<div class="safety">
    ${line(st.connected, st.connected ? "구글 드라이브 연결됨" : "구글 드라이브 연결 안 됨", st.connected && st.lastSync ? `마지막 동기화 ${when(st.lastSync)}` : "")}
    ${line(!!st.lastBackup, st.lastBackup ? "백업 파일 저장한 적 있음" : "백업 파일 저장한 적 없음", st.lastBackup ? when(st.lastBackup) : "")}
    ${risky && warn ? `<p class="sf-warn">지금 PIN을 잊으면 데이터를 되살릴 방법이 없어요. 먼저 '백업/복원'에서 드라이브를 연결하거나 백업 파일을 저장해 두세요.</p>` : ""}
  </div>`;
}
const FORGOT_HELP = `
  <ul class="lock-help">
    <li><span>지문을 등록해 두면</span> PIN이 생각나지 않아도 지문으로 열 수 있어요.</li>
    <li><span>그래도 못 열면</span> 잠금 화면의 'PIN을 잊었어요'에서 이 기기의 데이터를 지우고 다시 시작해요. 드라이브에 연결돼 있으면 내역은 드라이브에서 다시 받아와요.</li>
    <li><span>드라이브도 백업도 없으면</span> 이 기기의 데이터는 되살릴 수 없어요.</li>
  </ul>`;

function load() {
  try { return JSON.parse(localStorage.getItem(LOCK_KEY)) || null; } catch { return null; }
}
function save() {
  try { cfg ? localStorage.setItem(LOCK_KEY, JSON.stringify(cfg)) : localStorage.removeItem(LOCK_KEY); } catch {}
}
export const lockEnabled = () => !!cfg?.hash;
export function hideAmounts() {
  try { return localStorage.getItem(HIDE_KEY) === "1"; } catch { return false; }
}

const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function hashPin(pin, salt) {
  const data = new TextEncoder().encode(`${salt}:${pin}`);
  return b64(await crypto.subtle.digest("SHA-256", data));
}

// ---------- 지문·얼굴 인증 (WebAuthn, 기기 안에서만 확인) ----------
async function bioRegister() {
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: rnd(32),
      rp: { name: "가탈작 가계부" },
      user: { id: rnd(16), name: "gagyebu", displayName: "가탈작 가계부" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "discouraged" },
      attestation: "none",
      timeout: 60_000,
    },
  });
  return b64(cred.rawId);
}
async function bioCheck() {
  await navigator.credentials.get({
    publicKey: {
      challenge: rnd(32),
      allowCredentials: [{ type: "public-key", id: unb64(cfg.bio), transports: ["internal"] }],
      userVerification: "required",
      timeout: 60_000,
    },
  });
}

// ---------- 잠금 화면 / PIN 입력 화면 ----------
const LOCK_ICO = `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>`;
const FINGER_ICO = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 5.5A7.5 7.5 0 0 1 19.5 11v1.5"/><path d="M4.5 9.5A7.5 7.5 0 0 0 4.5 15"/><path d="M8 12a4 4 0 0 1 8 0v1.5a10 10 0 0 1-1.5 5.5"/><path d="M12 12v2a12 12 0 0 1-2.5 6.5"/><path d="M5.5 18.5A10 10 0 0 0 8.5 13"/></svg>`;

/**
 * PIN 화면: mode "unlock"(잠금) / "ask"(설정 중 PIN 입력). onPin(pin) → true면 닫힘, 문자열이면 그 안내를 보여 주고 다시 입력.
 */
function pinScreen({ title, sub = "", onPin, onCancel = null, unlock = false }) {
  document.getElementById("lock-screen")?.remove();
  const el = document.createElement("div");
  el.id = "lock-screen";
  el.className = "lock-screen";
  el.innerHTML = `
    <div class="lock-box">
      <div class="lock-ico">${LOCK_ICO}</div>
      <h2 class="lock-title">${title}</h2>
      <p class="lock-sub">${sub}</p>
      <div class="pin-dots" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <p class="lock-msg" role="alert"></p>
      <div class="keypad">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-k="${n}">${n}</button>`).join("")}
        ${unlock && cfg?.bio && bioOk ? `<button class="kp-bio" data-bio aria-label="지문으로 열기">${FINGER_ICO}</button>` : `<span></span>`}
        <button data-k="0">0</button>
        <button class="kp-del" data-del aria-label="지우기">⌫</button>
      </div>
      ${unlock ? `<button class="lock-link" data-forgot>PIN을 잊었어요</button>` : `<button class="lock-link" data-cancel>취소</button>`}
    </div>`;
  document.body.appendChild(el);
  let pin = "";
  const dots = [...el.querySelectorAll(".pin-dots i")];
  const msg = el.querySelector(".lock-msg");
  const paint = () => dots.forEach((d, i) => d.classList.toggle("on", i < pin.length));
  const close = () => { el.remove(); document.removeEventListener("keydown", onKey); };
  const submit = async () => {
    const res = await onPin(pin);
    if (res === true) return close();
    pin = "";
    paint();
    msg.textContent = res || "";
    el.querySelector(".pin-dots").classList.remove("shake");
    void el.offsetWidth;
    if (res) el.querySelector(".pin-dots").classList.add("shake");
  };
  const press = (k) => {
    if (Date.now() < waitUntil) { msg.textContent = `잠시 후 다시 시도해 주세요 (${Math.ceil((waitUntil - Date.now()) / 1000)}초)`; return; }
    if (k === "del") pin = pin.slice(0, -1);
    else if (pin.length < 4) pin += k;
    paint();
    if (pin.length === 4) setTimeout(submit, 120);
  };
  el.querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => press(b.dataset.k)));
  el.querySelector("[data-del]").onclick = () => press("del");
  const onKey = (e) => {
    if (/^[0-9]$/.test(e.key)) press(e.key);
    else if (e.key === "Backspace") press("del");
  };
  document.addEventListener("keydown", onKey);
  el.querySelector("[data-cancel]")?.addEventListener("click", () => { close(); onCancel?.(); });
  el.querySelector("[data-forgot]")?.addEventListener("click", () => forgotScreen(el));
  const bioBtn = el.querySelector("[data-bio]");
  const tryBio = async () => {
    try { await bioCheck(); unlockNow(); close(); } catch { msg.textContent = "지문 인증이 취소됐어요. PIN을 입력하세요."; }
  };
  if (bioBtn) { bioBtn.onclick = tryBio; tryBio(); } // 잠금 화면이 뜨면 바로 지문 요청
  return { close };
}

/** PIN을 잊었을 때: 이 기기 데이터를 지우고(드라이브에서 다시 받음) 잠금을 푼다 */
function forgotScreen(lockEl) {
  const box = lockEl.querySelector(".lock-box");
  const st = hooks.status();
  const conn = st.connected;
  box.innerHTML = `
    <div class="lock-ico">${LOCK_ICO}</div>
    <h2 class="lock-title">PIN을 잊었어요</h2>
    <ol class="forgot-steps">
      ${cfg?.bio && bioOk ? `<li><span class="fs-h">지문으로 열어 보세요</span>'돌아가기'를 누르고 키패드 왼쪽 아래 지문 버튼을 누르면 PIN 없이 열려요. 연 뒤 설정에서 PIN을 바꾸면 돼요.</li>` : ""}
      <li><span class="fs-h">자주 쓰는 숫자를 다시 떠올려 보세요</span>생일·전화번호 끝자리처럼 평소 쓰는 4자리일 수 있어요. 5번 틀리면 30초 기다렸다가 다시 할 수 있어요.</li>
      <li><span class="fs-h">다른 기기에서 먼저 확인하세요</span>PC 등 다른 기기에서도 이 가계부를 쓰고 있다면, 그 기기에서 '백업/복원 → 지금 동기화'를 한 번 눌러 최신 내역을 드라이브에 올려 두세요. 앱 잠금은 기기마다 따로라서 다른 기기는 잠기지 않아요.</li>
      <li><span class="fs-h">그래도 안 되면 이 기기만 초기화</span>
        ${safetyBox(false)}
        <div class="fs-what">
          초기화하면
          <ul>
            <li>이 기기의 가계부 데이터와 잠금 설정이 지워지고 앱이 다시 열려요.</li>
            ${conn ? `<li>드라이브 연결은 그대로라서 <span class="fs-ok">내역을 드라이브에서 자동으로 다시 받아와요</span>(1~2분). 안 보이면 '백업/복원 → 지금 동기화'를 눌러 주세요.</li>
            <li>마지막 동기화 뒤에 이 기기에서만 입력한 내역은 사라져요.</li>` : `<li>드라이브에 연결돼 있지 않아서 <span class="lock-warn">이 기기의 내역이 모두 사라져요.</span></li>
            <li>${st.lastBackup ? `백업 파일(${when(st.lastBackup)} 저장)이 있으면 초기화 뒤 '백업/복원 → 백업 파일 불러오기'로 되살릴 수 있어요.` : "백업 파일도 없어서 되살릴 방법이 없어요."}</li>`}
            <li>다른 기기의 데이터와 드라이브의 파일은 지워지지 않아요.</li>
          </ul>
        </div>
      </li>
    </ol>
    <button class="btn danger lock-wide" data-wipe>이 기기 초기화하고 잠금 풀기</button>
    <button class="lock-link" data-back>돌아가기</button>`;
  let armed = false;
  box.querySelector("[data-wipe]").onclick = async (e) => {
    if (!armed) { armed = true; e.target.textContent = "한 번 더 누르면 초기화"; return; }
    cfg = null; save();
    try { localStorage.setItem(RESET_FLAG, conn ? "drive" : "local"); } catch {}
    await new Promise((res) => { const r = indexedDB.deleteDatabase("claude-gagyebu"); r.onsuccess = r.onerror = r.onblocked = () => res(); });
    location.reload();
  };
  box.querySelector("[data-back]").onclick = () => { lockEl.remove(); locked = false; lockNow(); };
}

function unlockNow() {
  locked = false;
  fails = 0;
  lastActive = Date.now();
  document.documentElement.classList.remove("app-locked");
}

export function lockNow() {
  if (!lockEnabled() || locked) return;
  locked = true;
  document.activeElement?.blur?.();
  document.documentElement.classList.add("app-locked");
  pinScreen({
    title: "PIN을 입력하세요",
    sub: cfg.bio && bioOk ? "또는 지문으로 열 수 있어요" : "",
    unlock: true,
    onPin: async (pin) => {
      if ((await hashPin(pin, cfg.salt)) === cfg.hash) { unlockNow(); return true; }
      fails++;
      if (fails >= 5) { waitUntil = Date.now() + 30_000; fails = 0; return "5번 틀렸어요. 30초 뒤에 다시 시도해 주세요."; }
      return `PIN이 달라요 (${fails}/5)`;
    },
  });
}

/** 새 PIN 정하기(두 번 입력). 끝나면 resolve(pin) / 취소하면 resolve(null) */
function askNewPin() {
  return new Promise((resolve) => {
    let first = null;
    const s = pinScreen({
      title: "새 PIN 4자리",
      sub: "앱을 열 때 입력할 숫자 4자리를 정해 주세요.",
      onCancel: () => resolve(null),
      onPin: async (pin) => {
        if (!first) {
          first = pin;
          document.querySelector("#lock-screen .lock-title").textContent = "한 번 더 입력하세요";
          document.querySelector("#lock-screen .lock-sub").textContent = "확인을 위해 같은 PIN을 다시 눌러 주세요.";
          return "";
        }
        if (pin !== first) { first = null; document.querySelector("#lock-screen .lock-title").textContent = "새 PIN 4자리"; return "두 번 입력한 PIN이 달라요. 처음부터 다시 입력하세요."; }
        resolve(pin);
        return true;
      },
    });
  });
}
/** 지금 PIN 확인. 맞으면 resolve(true) */
function askCurrentPin(title) {
  return new Promise((resolve) => {
    pinScreen({
      title,
      sub: "지금 PIN을 입력하세요.",
      onCancel: () => resolve(false),
      onPin: async (pin) => {
        if ((await hashPin(pin, cfg.salt)) === cfg.hash) { resolve(true); return true; }
        return "PIN이 달라요";
      },
    });
  });
}

// ---------- 설정(백업/복원 창 안) ----------
export function lockSection() {
  const on = lockEnabled();
  return `
    <div class="section-title" style="margin-top:4px">앱 잠금 <span class="muted lock-scope">이 기기에만 적용</span></div>
    ${on ? `
      <div class="field" style="margin-top:4px"><label>잠기는 시점</label>
        <select class="input" name="lockTiming">${TIMING_ORDER.map((k) => [k, TIMING_LABEL[k]]).map(([k, v]) => `<option value="${k}" ${String(cfg.timing) === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
      <label class="check-line"><input type="checkbox" data-lock-bio ${cfg.bio ? "checked" : ""} ${bioOk ? "" : "disabled"}> 지문·얼굴 인증으로 열기${bioOk ? "" : ` <span class="muted">(이 기기에서는 쓸 수 없어요)</span>`}</label>
      <div class="money-line" style="margin-top:10px">
        <button class="btn" data-lock-change>PIN 바꾸기</button>
        <button class="btn" data-lock-off>잠금 끄기</button>
      </div>
      <details class="forgot-pre">
        <summary class="fp-title">PIN을 잊으면?</summary>
        ${FORGOT_HELP}
        ${safetyBox()}
      </details>` : `
      <p class="note">켜면 앱을 열 때 4자리 PIN(또는 지문)을 물어봐요. 기본은 꺼져 있어요.</p>
      <div class="forgot-pre">
        <div class="fp-title">켜기 전에: PIN을 잊으면 어떻게 되나요?</div>
        ${FORGOT_HELP}
        ${safetyBox()}
      </div>
      <button class="btn" data-lock-on style="margin-top:10px">앱 잠금 켜기</button>`}
    <div class="section-title">금액 가리기 <span class="muted lock-scope">이 기기에만 적용</span></div>
    <label class="check-line" style="margin-top:4px"><input type="checkbox" data-hide-amt ${hideAmounts() ? "checked" : ""}> 화면의 금액을 ●●●●로 가리기</label>
    <p class="note" style="margin-top:4px">맨 위 날짜 오른쪽 눈 버튼을 누르면 15초 동안 보여요.</p>`;
}

export function bindLockSection(panel, { reopen, onHideChange }) {
  const q = (s) => panel.querySelector(s);
  q("[data-lock-on]")?.addEventListener("click", async () => {
    const pin = await askNewPin();
    if (!pin) return reopen();
    const salt = b64(rnd(16));
    cfg = { hash: await hashPin(pin, salt), salt, timing: "5", bio: null };
    save();
    reopen();
    hooks.toast(bioOk ? "앱 잠금을 켰어요 · 지문도 등록해 두면 PIN을 잊어도 열 수 있어요" : "앱 잠금을 켰어요 · 5분 동안 안 쓰면 잠겨요");
  });
  q("[name=lockTiming]")?.addEventListener("change", (e) => {
    cfg.timing = e.target.value;
    save();
    hooks.toast(`${TIMING_LABEL[cfg.timing]} 잠겨요`);
  });
  q("[data-lock-bio]")?.addEventListener("change", async (e) => {
    if (e.target.checked) {
      try { cfg.bio = await bioRegister(); save(); hooks.toast("지문으로 열 수 있어요"); }
      catch { e.target.checked = false; hooks.toast("지문 등록이 취소됐어요"); }
    } else { cfg.bio = null; save(); hooks.toast("지문 열기를 껐어요"); }
  });
  q("[data-lock-change]")?.addEventListener("click", async () => {
    if (!(await askCurrentPin("PIN 바꾸기"))) return reopen();
    const pin = await askNewPin();
    if (pin) { cfg.salt = b64(rnd(16)); cfg.hash = await hashPin(pin, cfg.salt); save(); hooks.toast("PIN을 바꿨어요"); }
    reopen();
  });
  q("[data-lock-off]")?.addEventListener("click", async () => {
    if (!(await askCurrentPin("잠금 끄기"))) return reopen();
    cfg = null;
    save();
    reopen();
    hooks.toast("앱 잠금을 껐어요");
  });
  q("[data-hide-amt]")?.addEventListener("change", (e) => {
    try { e.target.checked ? localStorage.setItem(HIDE_KEY, "1") : localStorage.removeItem(HIDE_KEY); } catch {}
    onHideChange(e.target.checked);
  });
}

// ---------- 시작 ----------
/** 앱 시작 때 한 번: 잠금 조건 확인 + 화면 전환·사용 감시 */
export async function initLock({ toast, status }) {
  hooks = { toast, status };
  // PIN 분실로 초기화한 직후: 무엇이 일어나는지 알려 줌
  try {
    const r = localStorage.getItem(RESET_FLAG);
    if (r) {
      localStorage.removeItem(RESET_FLAG);
      setTimeout(() => toast(r === "drive" ? "초기화했어요 · 드라이브에서 내역을 다시 받는 중이에요" : "초기화했어요 · 백업 파일이 있으면 '백업/복원'에서 불러오세요"), 600);
    }
  } catch {}
  try { bioOk = !!window.PublicKeyCredential && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); } catch { bioOk = false; }
  const seen = Number(localStorage.getItem(SEEN_KEY) || 0);
  const timeout = () => TIMEOUTS[cfg?.timing ?? "5"] ?? 300_000;
  const markSeen = () => { try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch {} };
  if (lockEnabled() && (cfg.timing === "open" || Date.now() - seen > timeout())) lockNow();

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { hiddenAt = Date.now(); markSeen(); return; }
    if (!lockEnabled() || locked || hiddenAt === null) return;
    const away = Date.now() - hiddenAt;
    // '다시 열 때마다'도 아주 잠깐(사진 고르기 등 3초 이내)은 봐줌
    if (cfg.timing === "open" ? away > 3000 : away > timeout()) lockNow();
  });
  let lastMark = 0;
  const active = () => {
    lastActive = Date.now();
    if (lastActive - lastMark > 10_000) { lastMark = lastActive; markSeen(); }
  };
  ["pointerdown", "keydown", "scroll"].forEach((ev) => document.addEventListener(ev, active, { passive: true, capture: true }));
  setInterval(() => {
    if (!lockEnabled() || locked || document.hidden || cfg.timing === "open") return;
    if (Date.now() - lastActive > timeout()) lockNow();
  }, 10_000);
  window.addEventListener("pagehide", markSeen);
}
