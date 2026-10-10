import { loadState, saveState, mergeInto, uid, nowISO } from "./store.js";
import { CURRENCIES, CURRENCY_NAMES, parseMoney, formatInput, toInput, formatMoney, toKRW, rateKRW, refreshRates, ratesDate, decimals } from "./fx.js";
import { sync, isConfigured, isConnected, connect, disconnect, handleRedirect, refreshIfNeeded, syncNow } from "./sync.js";

// ---------------- 기본 목록 ----------------
const KINDS = ["수입", "지출", "자산이동"];
const EXPENSE_TYPES = ["고정", "변동"]; // 화면 표시 순서(고정지출이 앞)
const CATEGORIES = {
  수입: ["월급", "부수입", "용돈", "이자/배당", "환급", "기타"],
  지출: ["식비", "카페/간식", "교통", "주거/통신", "생활용품", "쇼핑", "의료/건강", "문화/여가", "교육", "경조사", "보험", "기타"],
  자산이동: ["계좌이체", "ATM입금", "ATM출금"],
};
// 처음에 넣어 두는 하위 카테고리 (이용자가 더하거나 지울 수 있음)
const DEFAULT_SUBCATS = {
  지출: {
    식비: ["외식", "배달", "장보기"],
    "카페/간식": ["커피", "간식"],
    교통: ["대중교통", "택시", "주유", "주차"],
    "주거/통신": ["월세", "관리비", "통신비", "공과금"],
    쇼핑: ["의류", "전자기기", "온라인쇼핑"],
    "의료/건강": ["병원", "약국", "운동"],
    "문화/여가": ["영화/공연", "여행", "구독서비스"],
    교육: ["학원", "도서"],
    경조사: ["축의금", "부의금", "선물"],
  },
  수입: { 월급: ["기본급", "상여금"], 부수입: ["중고거래", "프리랜스"] },
};
const ASSET_TYPES = ["현금", "은행", "증권", "부동산", "가상자산", "상품권", "기타"];
const DEBT_TYPES = ["신용카드", "대출", "마이너스통장", "할부", "미납금", "개인(지인)", "기타"];
const KIND_CLASS = { 수입: "inc", 지출: "exp", 자산이동: "mov" };
const KIND_SIGN = { 수입: "+", 지출: "-", 자산이동: "" };

// ---------------- 유틸 ----------------
const $ = (sel, root = document) => root.querySelector(sel);
const pad = (n) => String(n).padStart(2, "0");
const ym = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const todayStr = () => { const d = new Date(); return `${ym(d)}-${pad(d.getDate())}`; };
const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
/** 최신이 위로: 날짜 → 시각(없으면 맨 아래) → 등록 순 */
const txNewestFirst = (a, b) => (b.date + (b.time || "") + b.createdAt).localeCompare(a.date + (a.time || "") + a.createdAt);
const won = (n) => `${Math.round(n).toLocaleString("ko-KR")}원`;
const signed = (n, sign) => `${sign}${won(n)}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/** 내역의 원화 금액 (외화 내역은 입력 당시 원화로 저장한 krw) */
const txKRW = (t) => (t.currency && t.currency !== "KRW" ? t.krw || 0 : t.amount);
const sum = (arr) => arr.reduce((a, t) => a + txKRW(t), 0);
const parseAmount = (s) => Number(String(s).replace(/[^\d]/g, "")) || 0;
const fmtAmount = (n) => (n ? n.toLocaleString("ko-KR") : "");

function shiftMonth(month, step) {
  const [y, m] = month.split("-").map(Number);
  return ym(new Date(y, m - 1 + step, 1));
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2000);
}

// ---------------- 상태 ----------------
let S;
const ui = { month: ym(new Date()), tab: "home", seg: "수입", day: null, openCat: null }; // day: 달력에서 고른 날짜, openCat: 현황(상세)에서 펼친 카테고리

const liveTx = () => Object.values(S.transactions).filter((t) => !t.deleted);
const monthTx = () => liveTx().filter((t) => t.date.startsWith(ui.month));

// ---------------- 하위 카테고리 ----------------
// 기기 간 동기화되는 subcats 묶음에 { kind, category, name } 으로 저장한다.
// 기본 하위 카테고리는 모든 기기에서 같은 id(def:…)로 만들어 동기화 때 겹치지 않고, 지운 것은 다시 생기지 않는다.
const SEED_TIME = "2026-01-01T00:00:00.000Z";
function seedSubcats() {
  let added = 0;
  for (const [kind, cats] of Object.entries(DEFAULT_SUBCATS)) {
    for (const [category, names] of Object.entries(cats)) {
      names.forEach((name, i) => {
        const id = `def:${kind}:${category}:${name}`;
        if (S.subcats[id]) return;
        S.subcats[id] = { id, kind, category, name, order: i, createdAt: SEED_TIME, updatedAt: SEED_TIME, deleted: false };
        added++;
      });
    }
  }
  return added;
}
/** 그 카테고리의 하위 카테고리 이름들 (정한 순서 → 만든 순서) */
function subcatsFor(kind, category) {
  return Object.values(S.subcats || {})
    .filter((s) => !s.deleted && s.kind === kind && s.category === category)
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.createdAt.localeCompare(b.createdAt))
    .map((s) => s.name);
}
function addSubcat(kind, category, name) {
  const now = nowISO();
  const id = uid();
  S.subcats[id] = { id, kind, category, name, order: 999, createdAt: now, updatedAt: now, deleted: false };
}
// ---------------- 카테고리 ----------------
// 카테고리도 기기 간 동기화되는 cats 묶음에 { kind, name, order } 로 저장한다(기본값은 고정 id defcat:…).
// 내역·하위 카테고리는 카테고리를 '이름'으로 가리키므로, 이름을 바꾸면 그 이름을 쓰는 기록도 함께 바꾼다.
// 지출 카테고리는 고정지출/변동지출 중 하나에 속한다(etype). 예전 기본 카테고리는 이 목록으로 판단.
const DEFAULT_FIXED = new Set(["주거/통신", "보험", "교육"]);
const catEtype = (c) => c.etype || (DEFAULT_FIXED.has(c.name) ? "고정" : "변동");

// 예전 기본 자산이동 카테고리: 이용자가 손대지 않았으면(만든 그대로) 정리한다.
// 모든 기기에서 같은 시각으로 지워 동기화 때 다시 살아나지 않게 한다. 이미 입력한 내역의 카테고리 이름은 그대로 남는다.
const RETIRED_CATS = { 자산이동: ["저축", "투자", "카드대금", "부채상환", "현금인출", "기타"] };
const RETIRE_TIME = "2026-10-10T12:00:00.000Z";
function retireOldCats() {
  let n = 0;
  for (const [kind, names] of Object.entries(RETIRED_CATS)) {
    for (const name of names) {
      const c = S.cats[`defcat:${kind}:${name}`];
      if (c && !c.deleted && c.updatedAt === SEED_TIME) {
        S.cats[c.id] = { ...c, deleted: true, updatedAt: RETIRE_TIME };
        n++;
      }
    }
  }
  return n;
}

function seedCats() {
  let added = 0;
  for (const [kind, names] of Object.entries(CATEGORIES)) {
    names.forEach((name, i) => {
      const id = `defcat:${kind}:${name}`;
      if (S.cats[id]) return;
      S.cats[id] = { id, kind, name, order: i, ...(kind === "지출" ? { etype: DEFAULT_FIXED.has(name) ? "고정" : "변동" } : {}), createdAt: SEED_TIME, updatedAt: SEED_TIME, deleted: false };
      added++;
    });
  }
  return added;
}
const catRecords = (kind) => Object.values(S.cats || {})
  .filter((c) => !c.deleted && c.kind === kind)
  .sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.createdAt.localeCompare(b.createdAt));
/** 그 구분(수입/지출/자산이동)의 카테고리 이름들. 지출은 etype(고정/변동)으로 거를 수 있다. */
const catsFor = (kind, etype = null) => catRecords(kind).filter((c) => !etype || catEtype(c) === etype).map((c) => c.name);
const subcatRecords = (kind, category) => Object.values(S.subcats || {})
  .filter((s) => !s.deleted && s.kind === kind && s.category === category)
  .sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.createdAt.localeCompare(b.createdAt));

/** 카테고리 이름 바꾸기: 하위 카테고리와 내역의 카테고리 이름도 같이 바꾼다 */
function renameCategory(kind, from, to, now) {
  for (const c of Object.values(S.cats)) if (!c.deleted && c.kind === kind && c.name === from) S.cats[c.id] = { ...c, name: to, updatedAt: now };
  for (const s of Object.values(S.subcats)) if (s.kind === kind && s.category === from) S.subcats[s.id] = { ...s, category: to, updatedAt: now };
  for (const t of Object.values(S.transactions)) if (!t.deleted && t.kind === kind && t.category === from) S.transactions[t.id] = { ...t, category: to, updatedAt: now };
}
/** 하위 카테고리 이름 바꾸기: 내역의 하위 카테고리 이름도 같이 바꾼다 */
function renameSubcat(id, to, now) {
  const s = S.subcats[id];
  for (const t of Object.values(S.transactions)) {
    if (!t.deleted && t.kind === s.kind && t.category === s.category && t.subcategory === s.name) S.transactions[t.id] = { ...t, subcategory: to, updatedAt: now };
  }
  S.subcats[id] = { ...s, name: to, updatedAt: now };
}

/**
 * 카테고리 편집 창: 구분별 카테고리 목록 → 카테고리를 누르면 이름·하위 카테고리 편집.
 * 다 끝나면 onClose()로 원래 창(내역 추가)으로 돌아간다.
 */
function openCategoryEditor({ kind: startKind = "지출", etype: startEtype = "고정", onClose = closeModal } = {}) {
  let kind = startKind;
  let etab = startEtype; // 지출일 때 보고 있는 탭: 고정 | 변동

  const drawList = () => {
    const cats = catRecords(kind);
    const panel = openModal({
      title: "카테고리 편집",
      body: `
        <div class="seg" data-role="kind">${KINDS.map((k) => `<button data-v="${k}" class="${k === kind ? "on" : ""}">${k}</button>`).join("")}</div>
        ${kind === "지출" ? `<div class="tabs sub-tabs" data-role="etab">${["고정", "변동"].map((k) => `<button data-v="${k}" class="${k === etab ? "active" : ""}">${k}지출</button>`).join("")}</div>` : ""}
        ${[kind === "지출" ? etab : null].map((et) => {
          const list = cats.filter((c) => !et || catEtype(c) === et);
          return `<section class="asset-group">
          ${list.map((c) => {
            const subs = subcatRecords(kind, c.name).map((s) => s.name);
            return `<button class="asset-row cat-row" data-cat="${c.id}">
              <span class="name">${esc(c.name)}</span>
              <span class="muted cat-subs">${subs.length ? esc(subs.join(", ")) : "하위 없음"}</span>
              <span class="chev">›</span>
            </button>`;
          }).join("") || `<div class="asset-row asset-none">카테고리가 없습니다</div>`}
          </section>`;
        }).join("")}
        <div class="money-line subcat-add" style="margin-top:12px">
          <input class="input" name="newCat" placeholder="새 카테고리 이름">
          <button class="btn subcat-add-btn" data-act="add-cat">추가</button>
        </div>
        <button class="btn primary" data-act="done" style="margin-top:16px">완료</button>`,
    });
    panel.querySelectorAll("[data-role=kind] button").forEach((b) => (b.onclick = () => { kind = b.dataset.v; drawList(); }));
    panel.querySelectorAll("[data-role=etab] button").forEach((b) => (b.onclick = () => { etab = b.dataset.v; drawList(); }));
    panel.querySelectorAll("[data-cat]").forEach((b) => (b.onclick = () => drawCat(b.dataset.cat)));
    panel.querySelector("[data-act=done]").onclick = () => onClose();
    panel.querySelector("[data-act=add-cat]").onclick = async () => {
      const name = panel.querySelector("[name=newCat]").value.trim();
      if (!name) return toast("카테고리 이름을 입력해 주세요.");
      if (catsFor(kind).includes(name)) return toast("이미 있는 카테고리예요.");
      const now = nowISO();
      const id = uid();
      const etype = kind === "지출" ? etab : null; // 지금 보고 있는 탭(고정/변동)에 추가
      S.cats[id] = { id, kind, name, order: 999, ...(etype ? { etype } : {}), createdAt: now, updatedAt: now, deleted: false };
      await saveState(S);
      scheduleSync();
      drawList();
      toast(`'${name}' 카테고리를 ${etype ? etype + "지출에 " : ""}추가했어요`);
    };
  };

  // 한 카테고리: 이름 바꾸기, 하위 카테고리 추가·이름 바꾸기·삭제, 카테고리 삭제
  const drawCat = (catId, state = null) => {
    const cat = S.cats[catId];
    const s = state || {
      name: cat.name,
      etype: kind === "지출" ? catEtype(cat) : null,
      subs: subcatRecords(kind, cat.name).map((x) => ({ id: x.id, name: x.name, del: false })),
      confirmDelete: false,
    };
    const panel = openModal({
      title: "카테고리 편집",
      body: `
        <button class="back-link" data-act="back">‹ ${kind} 카테고리 목록</button>
        <div class="field"><label>카테고리 이름</label><input class="input" name="catName" value="${esc(s.name)}"></div>
        ${s.etype ? `<div class="field"><label>지출 종류</label>
          <div class="seg" data-role="cat-etype">${EXPENSE_TYPES.map((k) => `<button data-v="${k}" class="${k === s.etype ? "on" : ""}">${k}지출</button>`).join("")}</div>
        </div>` : ""}
        <div class="field"><label>하위 카테고리</label>
          <section class="asset-group" style="margin-top:0">
            ${s.subs.map((x, i) => `
              <div class="edit-item${x.del ? " removed" : ""}" data-i="${i}">
                <div class="edit-body"><div class="edit-line">
                  <input class="input sm" name="sub" value="${esc(x.name)}" ${x.del ? "disabled" : ""}>
                  <button class="edit-del" data-toggle-del>${x.del ? "되돌리기" : "삭제"}</button>
                </div></div>
              </div>`).join("") || `<div class="asset-row asset-none">하위 카테고리가 없습니다</div>`}
          </section>
          <div class="money-line subcat-add">
            <input class="input" name="newSub" placeholder="새 하위 카테고리 이름">
            <button class="btn subcat-add-btn" data-act="add-sub">추가</button>
          </div>
        </div>
        <div class="btn-row"><button class="btn" data-act="back2">취소</button><button class="btn primary" data-act="save">저장</button></div>
        <button class="btn danger" data-act="delete" style="margin-top:8px">${s.confirmDelete ? "한 번 더 누르면 카테고리 삭제" : "이 카테고리 삭제"}</button>
        <p class="note">이름이나 지출 종류(고정/변동)를 바꾸면 이미 입력한 내역도 함께 바뀌어요. 카테고리나 하위 카테고리를 삭제해도 이미 입력한 내역은 그대로 남아요.</p>`,
    });
    const $p = (q) => panel.querySelector(q);
    const read = () => {
      s.name = $p("[name=catName]").value;
      panel.querySelectorAll(".edit-item").forEach((el) => {
        const x = s.subs[Number(el.dataset.i)];
        if (!x.del) x.name = el.querySelector("[name=sub]").value;
      });
    };
    $p("[data-act=back]").onclick = drawList;
    panel.querySelectorAll("[data-role=cat-etype] button").forEach((b) => (b.onclick = () => { read(); s.etype = b.dataset.v; drawCat(catId, s); }));
    $p("[data-act=back2]").onclick = drawList;
    panel.querySelectorAll("[data-toggle-del]").forEach((b) => (b.onclick = () => {
      read();
      const x = s.subs[Number(b.closest(".edit-item").dataset.i)];
      x.del = !x.del;
      drawCat(catId, s);
    }));
    $p("[data-act=add-sub]").onclick = () => {
      read();
      const name = $p("[name=newSub]").value.trim();
      if (!name) return toast("하위 카테고리 이름을 입력해 주세요.");
      if (s.subs.some((x) => !x.del && x.name.trim() === name)) return toast("이미 있는 하위 카테고리예요.");
      s.subs.push({ id: null, name, del: false });
      drawCat(catId, s);
    };
    $p("[data-act=save]").onclick = async () => {
      read();
      const newName = s.name.trim();
      if (!newName) return toast("카테고리 이름을 입력해 주세요.");
      if (newName !== cat.name && catsFor(kind).includes(newName)) return toast("이미 있는 카테고리 이름이에요.");
      const live = s.subs.filter((x) => !x.del).map((x) => x.name.trim());
      if (live.some((n) => !n)) return toast("이름이 빈 하위 카테고리가 있어요.");
      if (new Set(live).size !== live.length) return toast("하위 카테고리 이름이 겹쳐요.");
      const now = nowISO();
      if (newName !== cat.name) renameCategory(kind, cat.name, newName, now);
      if (s.etype && s.etype !== catEtype(cat)) {
        // 고정/변동을 바꾸면 이 카테고리로 입력한 지출도 같은 종류로 맞춘다(현황 합계가 일치하도록)
        S.cats[catId] = { ...S.cats[catId], etype: s.etype, updatedAt: now };
        for (const t of Object.values(S.transactions)) {
          if (!t.deleted && t.kind === "지출" && t.category === newName && t.expenseType !== s.etype) S.transactions[t.id] = { ...t, expenseType: s.etype, updatedAt: now };
        }
      }
      s.subs.forEach((x, i) => {
        if (x.id && x.del) S.subcats[x.id] = { ...S.subcats[x.id], deleted: true, updatedAt: now };
        else if (x.id && S.subcats[x.id].name !== x.name.trim()) renameSubcat(x.id, x.name.trim(), now);
        else if (!x.id && !x.del) {
          const id = uid();
          S.subcats[id] = { id, kind, category: newName, name: x.name.trim(), order: 999 + i, createdAt: now, updatedAt: now, deleted: false };
        }
      });
      await saveState(S);
      scheduleSync();
      if (s.etype) etab = s.etype;
      drawList();
      toast("카테고리를 저장했어요");
    };
    $p("[data-act=delete]").onclick = async () => {
      if (catRecords(kind).length <= 1) return toast("카테고리는 하나 이상 있어야 해요.");
      if (!s.confirmDelete) { read(); s.confirmDelete = true; return drawCat(catId, s); }
      const now = nowISO();
      S.cats[catId] = { ...cat, deleted: true, updatedAt: now };
      for (const x of subcatRecords(kind, cat.name)) S.subcats[x.id] = { ...x, deleted: true, updatedAt: now };
      await saveState(S);
      scheduleSync();
      drawList();
      toast(`'${cat.name}' 카테고리를 삭제했어요`);
    };
  };
  drawList();
}

/** 화면 표시용 '식비 › 외식' */
const catLabel = (t) => (t.subcategory ? `${t.category} › ${t.subcategory}` : t.category);

async function commit() {
  await saveState(S);
  render();
  scheduleSync();
}

// 데이터가 바뀌면 잠시 뒤 드라이브와 합친다(연속 입력은 한 번에).
let syncTimer;
function scheduleSync(delay = 1500) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, delay);
}
async function runSync() {
  const pulled = await syncNow(S);
  if (pulled && !$("#modal-root").children.length) render();
}

// ---------------- 화면 그리기 ----------------
const SYNC_TEXT = {
  syncing: "동기화 중…",
  ok: "동기화됨",
  offline: "오프라인 · 연결되면 동기화돼요",
  "need-login": "구글 드라이브 연결이 끊겼어요 · 눌러서 다시 연결",
  error: "동기화 실패 · 눌러서 다시 시도",
};
function renderSyncBar() {
  const bar = $("#sync-bar");
  const show = isConfigured() && isConnected() && ["need-login", "error", "offline"].includes(sync.status);
  bar.hidden = !show;
  if (show) bar.textContent = SYNC_TEXT[sync.status];
}

function render() {
  renderSyncBar();
  const [y, m] = ui.month.split("-");
  $("#month-title").textContent = `${y}년 ${Number(m)}월`;
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === ui.tab));
  const view = $("#view");
  if (ui.tab === "home") view.innerHTML = homeView("summary");
  else if (ui.tab === "detail") view.innerHTML = homeView("detail");
  else if (ui.tab === "list") view.innerHTML = listView();
  else if (ui.tab === "calendar") view.innerHTML = calendarView();
  else view.innerHTML = monthlyView();
}

/** 단기부채로 잡는 결제 수단(부채 종류)과 화면 표시 글자 */
const SHORT_DEBT = { 신용카드: { short: "신용", title: "신용카드 사용" }, 마이너스통장: { short: "마통", title: "마이너스통장 사용" } };

/** 신용카드·마이너스통장으로 결제한 지출이면 그 부채 종류, 아니면 null.
 *  부채가 나중에 지워져도 기록(삭제 표시)은 남아 있어 종류로 계속 구분된다. */
function shortDebtType(t) {
  if (t.kind !== "지출") return null;
  const d = deltaRef(t.assetDelta);
  const type = d?.col === "debts" ? S.debts[d.id]?.type : null;
  return SHORT_DEBT[type] ? type : null;
}
const isShortDebt = (t) => !!shortDebtType(t);

/** 지출(신용카드·마이너스통장 사용 제외) */
const isPlainExpense = (t) => t.kind === "지출" && !isShortDebt(t);

/** 단기부채 종류별 합계를 '신용 -1,000원 마통 -2,000원' 형태로 */
function shortDebtTotals(items) {
  return Object.keys(SHORT_DEBT).map((type) => {
    const v = sum(items.filter((t) => shortDebtType(t) === type));
    return v ? `<span class="cred">${SHORT_DEBT[type].short} ${signed(v, "-")}</span>` : "";
  }).filter(Boolean).join(" ");
}

/** part: "summary" = 현황(이번달 현재·부채(단기)), "detail" = 현황(상세) */
function homeView(part = "summary") {
  const tx = monthTx();
  const inc = tx.filter((t) => t.kind === "수입");
  const exp = tx.filter((t) => t.kind === "지출");
  const mov = tx.filter((t) => t.kind === "자산이동");
  // 신용카드·마이너스통장으로 결제한 지출은 단기부채로 따로 묶고, 지출(고정·변동)에서는 뺀다
  const shortDebt = exp.filter(isShortDebt);
  const fixed = exp.filter((t) => isPlainExpense(t) && t.expenseType === "고정");
  const variable = exp.filter((t) => isPlainExpense(t) && t.expenseType !== "고정");

  // 부채(단기) 섹션: 종류별 줄 + 그 아래 항목(카드·통장)별 사용액
  const shortDebtRows = Object.entries(SHORT_DEBT).map(([type, info]) => {
    const items = shortDebt.filter((t) => shortDebtType(t) === type);
    const byDebt = {};
    items.forEach((t) => { const id = deltaRef(t.assetDelta).id; byDebt[id] = (byDebt[id] || 0) + txKRW(t); });
    const subs = Object.entries(byDebt)
      .sort((a, b) => b[1] - a[1])
      .map(([id, v]) => `<div class="row-sub"><span>└ ${esc(S.debts[id]?.name || type)}</span><span>${signed(v, "-")}</span></div>`)
      .join("");
    return `
    <div class="row">
      <div class="row-main"><span>${info.title}</span><span class="cred">${signed(sum(items), "-")}</span></div>
      ${subs}
    </div>`;
  }).join("");

  const segs = {
    수입: [inc, "inc", "+"],
    고정지출: [fixed, "exp", "-"],
    변동지출: [variable, "exp", "-"],
    단기부채: [shortDebt, "cred", "-"],
    자산이동: [mov, "mov", ""],
  };
  if (!segs[ui.seg]) ui.seg = "수입"; // 이전 버전의 구분 이름이 남아 있을 때
  const [selTx, cls, sign] = segs[ui.seg];
  // 카테고리마다 섹션 하나: 머리줄(카테고리·합계, 색 유지) → 구분선 → 하위 카테고리별 금액(회색)
  const buildCatSections = (list, group = "") => {
    const byCat = {};
    list.forEach((t) => {
      const c = (byCat[t.category] ||= { total: 0, subs: {} });
      const v = txKRW(t);
      c.total += v;
      const sub = t.subcategory || "";
      c.subs[sub] = (c.subs[sub] || 0) + v;
    });
    return Object.entries(byCat)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([c, { total, subs }]) => {
        const named = Object.entries(subs).filter(([s]) => s).sort((a, b) => b[1] - a[1]);
        const rest = subs[""] || 0;
        // 하위 카테고리가 하나도 없으면 하위 줄을 생략, 섞여 있으면 하위 없는 금액을 '미분류'로
        const rows = named.length ? named.concat(rest ? [["미분류", rest]] : []) : [];
        // 섹션을 누르면 그 카테고리 내역을 펼친다(다시 누르면 접힘)
        const key = `${ui.seg}|${group}|${c}`;
        const open = ui.openCat === key;
        const items = open ? list.filter((t) => t.category === c).sort(txNewestFirst) : [];
        return `
      <section class="asset-group detail-cat${open ? " open" : ""}" data-detail-cat="${esc(key)}">
        <div class="asset-group-head"><span>${esc(c)} <span class="cat-chev">${open ? "⌄" : "›"}</span></span><span class="${cls}">${signed(total, sign)}</span></div>
        ${rows.map(([s, v]) => `<div class="asset-row detail-sub"><span class="name">${esc(s)}</span><span class="amt">${signed(v, sign)}</span></div>`).join("")}
        ${open ? `<div class="detail-items">${items.map((t) => txRow(t, { withDate: true })).join("")}</div>` : ""}
      </section>`;
      })
      .join("");
  };
  // 단기부채는 신용카드 / 마이너스통장으로 나눠서, 각 묶음 제목(뱃지·소계) 아래에 카테고리 섹션
  const catSections = ui.seg === "단기부채"
    ? Object.entries(SHORT_DEBT).map(([type, info]) => {
        const list = selTx.filter((t) => shortDebtType(t) === type);
        if (!list.length) return "";
        return `
      <div class="group-title"><span class="cat-badge b-cred">${info.title.replace(" 사용", "")}</span></div>
      ${buildCatSections(list, type)}`;
      }).join("")
    : buildCatSections(selTx);

  // 자산이동의 하위 항목: 내역의 카테고리별 합계(큰 순서)
  const movByCat = {};
  mov.forEach((t) => (movByCat[t.category] = (movByCat[t.category] || 0) + txKRW(t)));
  const movRows = Object.entries(movByCat)
    .sort((a, b) => b[1] - a[1])
    .map(([c, v]) => `<div class="row-sub"><span>└ ${esc(c)}</span><span>${won(v)}</span></div>`)
    .join("");

  const summary = `
  <section class="card">
    <div class="card-head"><span>이번달 현재</span><span>${won(sum(inc) - sum(fixed) - sum(variable))}</span></div>
    <div class="row"><div class="row-main"><span>수입</span><span class="inc">${signed(sum(inc), "+")}</span></div></div>
    <div class="row">
      <div class="row-main"><span>지출</span><span class="exp">${signed(sum(fixed) + sum(variable), "-")}</span></div>
      <div class="row-sub"><span>└ 고정지출</span><span>${signed(sum(fixed), "-")}</span></div>
      <div class="row-sub"><span>└ 변동지출</span><span>${signed(sum(variable), "-")}</span></div>
    </div>
    <div class="row">
      <div class="row-main"><span>자산이동</span><span class="mov">${won(sum(mov))}</span></div>
      ${movRows}
    </div>
  </section>
  <section class="card">
    <div class="card-head"><span>부채(단기)</span><span class="cred">${signed(sum(shortDebt), "-")}</span></div>
    ${shortDebtRows}
  </section>`;
  if (part === "summary") return summary;
  return `
  <section class="card">
    <div class="card-head plain"><span>현황(상세)</span></div>
    <div class="seg seg-5" data-role="detail-seg">
      ${Object.keys(segs).map((s) => `<button data-seg="${s}" class="${s === ui.seg ? "on" : ""}">${s}</button>`).join("")}
    </div>
    <div class="total-bar">
      <div class="tb-main"><span>${ui.seg} 합계</span><span class="${cls}">${signed(sum(selTx), sign)}</span></div>
      ${ui.seg === "단기부채" ? Object.entries(SHORT_DEBT).map(([type, info]) => {
        const v = sum(selTx.filter((t) => shortDebtType(t) === type));
        return `<div class="tb-sub"><span>└ ${info.title.replace(" 사용", "")}</span><span>${signed(v, "-")}</span></div>`;
      }).join("") : ""}
    </div>
    ${catSections || `<div class="empty" style="padding:16px 0">이번 달 내역이 없어요.</div>`}
  </section>`;
}

/** 내역 한 줄 (누르면 수정 창) */
/** withDate: 여러 날짜가 섞인 목록(현황(상세) 펼치기)에서는 날짜도 함께 표시 */
function txRow(t, { withDate = false } = {}) {
  // 뱃지: 카테고리(수입=연한 레드, 지출=연한 블루, 자산이동=연한 옐로우) + 부채로 결제했으면 그 부채 종류(하늘색, 이름은 아래 결제 줄에)
  const kindBadge = t.kind === "수입" ? "b-inc" : t.kind === "지출" ? "b-exp" : "b-mov";
  const d = deltaRef(t.assetDelta);
  const debt = d?.col === "debts" ? S.debts[d.id] : null;
  const from = t.deltas && S.assets[t.deltas.find((x) => x.col === "assets")?.id];
  const isRepay = t.deltas?.some((x) => x.col === "debts");
  const outA = !isRepay && t.deltas && S.assets[t.deltas.find((x) => x.amount < 0)?.id];
  const inA = !isRepay && t.deltas && S.assets[t.deltas.find((x) => x.amount > 0)?.id];
  const route = isRepay ? (from ? `${esc(from.name)}에서 상환` : "")
    : outA || inA ? `${outA ? esc(outA.name) : "?"} → ${inA ? esc(inA.name) : "?"}` : "";
  const when = withDate ? `${Number(t.date.slice(5, 7))}/${Number(t.date.slice(8, 10))} ${t.time || ""}`.trim() : t.time;
  const sub = [when, t.party ? esc(t.party) : ""].filter(Boolean).join(" · ");
  // 시간 아래 줄: 수입=입금 자산, 지출=결제 수단, 자산이동=출금 → 입금
  const linked = d && (d.col === "debts" ? S.debts[d.id] : S.assets[d.id]);
  const via = linked ? `${t.kind === "수입" ? "입금" : "결제"} ${esc(linked.name)}` : route;
  return `
          <button class="tx" data-tx="${t.id}">
            <div class="left">
              <div class="badges">${t.kind === "자산이동" ? `<span class="cat-badge b-mov">자산이동</span>` : ""}${debt ? `<span class="cat-badge b-cred">${esc(debt.type || debt.name)}</span>` : ""}<span class="cat-badge ${kindBadge}">${esc(catLabel(t))}</span></div>
              ${t.content ? `<div class="tx-content">${esc(t.content)}</div>` : ""}
              ${sub ? `<div class="memo">${sub}</div>` : ""}
              ${via ? `<div class="memo">${via}</div>` : ""}
            </div>
            <span class="amt ${isShortDebt(t) ? "cred" : KIND_CLASS[t.kind]}">${isShortDebt(t) ? SHORT_DEBT[shortDebtType(t)].short + " " : isRepay ? "상환 " : ""}${t.currency && t.currency !== "KRW"
              ? `${KIND_SIGN[t.kind]}${formatMoney(t.amount, t.currency)}<span class="fx-sub">≈ ${won(t.krw || 0)}</span>`
              : signed(t.amount, KIND_SIGN[t.kind])}</span>
          </button>`;
}

/** 날짜 머리줄: 왼쪽 [일] [요일] [년-월], 오른쪽 1줄 수입·지출 / 2줄 신용·마통 */
function dayHead(date, items) {
  const dt = new Date(date + "T00:00:00");
  const dow = "일월화수목금토"[dt.getDay()];
  const inc = sum(items.filter((t) => t.kind === "수입"));
  const exp = sum(items.filter(isPlainExpense));
  const line1 = [inc && `<span class="inc">${signed(inc, "+")}</span>`, exp && `<span class="exp">${signed(exp, "-")}</span>`].filter(Boolean).join(" ");
  const line2 = shortDebtTotals(items);
  return `
        <div class="day-head2">
          <div class="dh-left">
            <span class="dh-day">${dt.getDate()}</span>
            <span class="dh-dow${dt.getDay() === 0 ? " sun" : dt.getDay() === 6 ? " sat" : ""}">${dow}요일</span>
            <span class="dh-ym">${date.slice(0, 7)}</span>
          </div>
          <div class="dh-right">${line1 ? `<div>${line1}</div>` : ""}${line2 ? `<div>${line2}</div>` : ""}</div>
        </div>`;
}


// 달력 칸 안의 금액은 좁아서 '12.5만'처럼 줄여 쓴다
const compact = (n) => new Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 1 }).format(Math.round(n));

function calendarView() {
  const [y, m] = ui.month.split("-").map(Number);
  const first = new Date(y, m - 1, 1).getDay(); // 1일의 요일 (0=일)
  const days = new Date(y, m, 0).getDate();
  const today = todayStr();
  if (!ui.day || !ui.day.startsWith(ui.month)) ui.day = today.startsWith(ui.month) ? today : null;

  const byDay = {};
  monthTx().forEach((t) => (byDay[t.date] ||= []).push(t));
  const tx = monthTx();
  const monthInc = sum(tx.filter((t) => t.kind === "수입"));
  const monthExp = sum(tx.filter(isPlainExpense));

  const cells = [];
  for (let i = 0; i < first; i++) cells.push(`<div class="cal-cell blank"></div>`);
  for (let d = 1; d <= days; d++) {
    const date = `${ui.month}-${pad(d)}`;
    const items = byDay[date] || [];
    const inc = sum(items.filter((t) => t.kind === "수입"));
    const exp = sum(items.filter(isPlainExpense));
    const cred = sum(items.filter(isShortDebt));
    const dow = (first + d - 1) % 7;
    cells.push(`
      <button class="cal-cell${date === ui.day ? " sel" : ""}${date === today ? " today" : ""}${dow === 0 ? " sun" : dow === 6 ? " sat" : ""}" data-day="${date}">
        <span class="cal-num">${d}</span>
        ${inc ? `<span class="cal-amt inc">+${compact(inc)}</span>` : ""}
        ${exp ? `<span class="cal-amt exp">-${compact(exp)}</span>` : ""}
        ${cred ? `<span class="cal-amt cred">-${compact(cred)}</span>` : ""}
        ${!inc && !exp && !cred && items.length ? `<span class="cal-dot"></span>` : ""}
      </button>`);
  }

  const sel = ui.day ? (byDay[ui.day] || []).sort(txNewestFirst) : [];
  return `
  <section class="card">
    <div class="card-head cal-head"><span class="month-badge">${m}월</span><div class="cal-sum">
      <div><span class="inc">${signed(monthInc, "+")}</span> <span class="exp">${signed(monthExp, "-")}</span></div>
      ${shortDebtTotals(tx) ? `<div>${shortDebtTotals(tx)}</div>` : ""}
    </div></div>
    <div class="cal-grid cal-week">${"일월화수목금토".split("").map((w, i) => `<span class="${i === 0 ? "sun" : i === 6 ? "sat" : ""}">${w}</span>`).join("")}</div>
    <div class="cal-grid">${cells.join("")}</div>
  </section>
  ${ui.day ? `
  <section class="card day">
    ${dayHead(ui.day, sel)}
    ${sel.length ? sel.map(txRow).join("") : `<div class="empty" style="padding:16px 0">이 날의 내역이 없어요.<br>+ 버튼을 누르면 이 날짜로 추가돼요.</div>`}
  </section>` : ""}`;
}

/** 합계 두 줄: 1줄 수입·지출, 2줄 신용·마통 (없는 것은 생략) */
function totalsTwoLines(items) {
  const inc = sum(items.filter((t) => t.kind === "수입"));
  const exp = sum(items.filter(isPlainExpense));
  const line1 = [inc && `<span class="inc">${signed(inc, "+")}</span>`, exp && `<span class="exp">${signed(exp, "-")}</span>`].filter(Boolean).join(" ");
  const line2 = shortDebtTotals(items);
  return `${line1 ? `<div>${line1}</div>` : ""}${line2 ? `<div>${line2}</div>` : ""}`;
}

// 월별: 상단 연도 합계, 아래 달마다 합계와 수입·지출 비교 막대. 달을 누르면 그 달 현황으로 이동.
function monthlyView() {
  const year = Number(ui.month.slice(0, 4));
  const now = new Date();
  const lastMonth = year === now.getFullYear() ? now.getMonth() + 1 : 12; // 올해는 이번 달까지만
  const yearTx = liveTx().filter((t) => t.date.startsWith(`${year}-`));
  const months = [];
  for (let m = lastMonth; m >= 1; m--) {
    const key = `${year}-${pad(m)}`;
    const items = yearTx.filter((t) => t.date.startsWith(key));
    months.push({ m, key, items, inc: sum(items.filter((t) => t.kind === "수입")), exp: sum(items.filter(isPlainExpense)) + sum(items.filter(isShortDebt)) });
  }
  const max = Math.max(1, ...months.map((x) => Math.max(x.inc, x.exp)));
  const yearTotals = totalsTwoLines(yearTx);
  return `
  <section class="card">
    <div class="card-head cal-head"><span class="month-badge">${year}년</span><div class="cal-sum">${yearTotals || `<div class="muted">내역 없음</div>`}</div></div>
    ${months.map((x) => {
      const totals = totalsTwoLines(x.items);
      return `
      <button class="month-row${x.key === ui.month ? " sel" : ""}" data-month-go="${x.key}">
        <div class="mr-top">
          <span class="mr-label">${x.m}월</span>
          <div class="mr-sum">${totals || `<span class="muted">내역 없음</span>`}</div>
        </div>
        ${x.items.length ? `<div class="mr-bars">
          ${x.inc ? `<span class="bar inc-bar" style="width:${(x.inc / max) * 100}%"></span>` : ""}
          ${x.exp ? `<span class="bar exp-bar" style="width:${(x.exp / max) * 100}%"></span>` : ""}
        </div>` : ""}
      </button>`;
    }).join("")}
    <p class="note mr-note">막대: 위 수입, 아래 지출(신용·마통 포함). 달을 누르면 그 달 현황으로 이동해요.</p>
  </section>`;
}

function listView() {
  const tx = monthTx().sort(txNewestFirst);
  if (!tx.length) return `<div class="card"><div class="empty">이번 달 내역이 없어요.<br>아래 + 버튼으로 추가해 보세요.</div></div>`;
  const days = {};
  tx.forEach((t) => (days[t.date] ||= []).push(t));
  return Object.entries(days)
    .map(([date, items]) => {
      return `
      <section class="card day">
        ${dayHead(date, items)}
        ${items.map(txRow).join("")}
      </section>`;
    })
    .join("");
}

// ---------------- 팝업 창 ----------------
function openModal({ title, headExtra = "", body, cls = "" }) {
  $("#modal-root").innerHTML = `
    <div class="overlay" data-overlay>
      <div class="panel ${cls}" role="dialog" aria-label="${esc(title)}">
        <div class="panel-head">
          <h2>${esc(title)}</h2>
          <div class="head-actions">${headExtra}<button class="x-btn" data-close aria-label="닫기">✕</button></div>
        </div>
        <div class="panel-body">${body}</div>
      </div>
    </div>`;
  const root = $("#modal-root");
  root.querySelector("[data-close]").onclick = closeModal; // 창 밖 여백을 눌러도 닫히지 않고, ✕(또는 창 안의 닫기·취소)로만 닫힌다
  return root.querySelector(".panel");
}
function closeModal() {
  $("#modal-root").innerHTML = "";
}

function bindAmount(input) {
  input.addEventListener("input", () => {
    input.value = fmtAmount(parseAmount(input.value));
  });
}

/** 금액칸 단위 표시: 원화는 '원', 외화는 통화 코드 */
const unitLabel = (cur) => (cur === "KRW" ? "원" : cur);

// ---------------- 수입 → 자산 입금 / 지출 → 자산 출금 또는 부채(신용카드 등) 증가 ----------------
// 저장하면 고른 자산·부채 잔액을 바꾸고, 실제로 바꾼 값(그 항목 통화 기준)을 내역의 assetDelta {col, id, amount}에 기록한다.
// 내역을 고치거나 지우면 그 값을 그대로 빼서 되돌린다(그사이 환율이 바뀌어도 정확히 되돌아감).
// 예전 기록은 {assetId, amount} 형태라 col이 없으면 자산으로 본다.
const ASSET_LINK = {
  수입: { label: "입금 자산", cols: ["assets"] },
  지출: { label: "결제 수단", cols: ["assets", "debts"] }, // 자산에서 출금하거나 신용카드 등 부채로 결제
};
/** 잔액 변화 방향: 수입→자산 +, 지출→자산 -, 지출→부채 + */
const linkSign = (kind, col) => (kind === "수입" ? 1 : col === "debts" ? 1 : -1);
const deltaRef = (d) => d && { col: d.col || "assets", id: d.id || d.assetId, amount: d.amount };
const linkKey = (col, id) => `${col}:${id}`;
const parseLinkKey = (key) => { const [col, id] = (key || "").split(":"); return id ? { col, id } : null; };

/** 내역 금액을 자산·부채 통화로 바꾼다. 환율을 몰라 바꿀 수 없으면 null. */
function amountInCurrency(rec, cur) {
  if (cur === rec.currency) return rec.amount;
  const krw = rec.currency === "KRW" ? rec.amount : rec.krw;
  if (cur === "KRW") return krw;
  const r = rateKRW(cur);
  return r ? krw / r : null;
}
const roundFor = (n, cur) => { const f = 10 ** decimals(cur); return Math.round(n * f) / f; };

/** 자산·부채 잔액을 amount만큼 더한다(빼려면 음수). 지워진 항목이면 아무것도 하지 않는다. */
function adjustHolding(col, id, amount, now) {
  const a = S[col]?.[id];
  if (!a || a.deleted) return;
  const cur = a.currency || "KRW";
  S[col][id] = { ...a, amount: roundFor(a.amount + amount, cur), updatedAt: now };
}

/** 선택 목록: 자산(종류별) → 부채(종류별), 현재 잔액을 함께 보여 준다 */
function holdingOptions(cols, selectedKey, { balance = true } = {}) {
  const html = cols.map((col) => {
    const types = HOLDINGS[col].types;
    const items = Object.values(S[col]).filter((a) => !a.deleted).sort(makeOrder(types));
    return types.filter((t) => items.some((a) => a.type === t)).map((t) => `
    <optgroup label="${col === "debts" ? `부채 · ${t}` : t}">${items.filter((a) => a.type === t).map((a) => {
      const key = linkKey(col, a.id);
      return `<option value="${key}" ${key === selectedKey ? "selected" : ""}>${esc(a.name)}${balance ? ` · ${formatMoney(a.amount, a.currency || "KRW")}` : ""}</option>`;
    }).join("")}
    </optgroup>`).join("");
  }).join("");
  return `<option value="">선택 안 함</option>` + html;
}

// ---------------- 부채 상환 ----------------
// 나의 부채 → 부채 상환: 고른 부채를 줄이고, 고른 자산(통장 등)에서 같은 금액을 뺀다.
// 자산이동 내역으로 기록하고, 실제로 바꾼 값들을 내역의 deltas에 남겨 수정·삭제 때 정확히 되돌린다.
// 지출이 아니므로(이미 부채로 잡힌 돈을 갚는 것) 지출·이번달 현재에는 영향을 주지 않는다.

/** 내역에 기록된 잔액 변화(상환은 여러 개)를 모두 되돌린다 */
function revertDeltas(t, now) {
  (t?.deltas || []).forEach((d) => adjustHolding(d.col, d.id, -d.amount, now));
}

/**
 * existing: 수정할 상환 내역(없으면 새로)
 * presetDebt: 미리 고를 부채 id
 * onDone: 닫은 뒤 할 일(나의 부채 창으로 돌아가기 등)
 */
function openRepayDialog({ existing = null, presetDebt = "", onDone = closeModal } = {}) {
  const prevDebt = existing?.deltas?.find((d) => d.col === "debts");
  const prevAsset = existing?.deltas?.find((d) => d.col === "assets");
  const draft = {
    debt: existing ? linkKey("debts", prevDebt?.id) : presetDebt ? linkKey("debts", presetDebt) : "",
    asset: prevAsset ? linkKey("assets", prevAsset.id) : "",
    amount: existing?.amount || 0,
    date: existing?.date || todayStr(),
    time: existing ? existing.time || "" : nowTime(),
    memo: existing?.memo || "",
  };
  let confirmDelete = false;
  let amountTouched = !!existing;

  /** 부채 잔액(이 내역이 이미 갚은 만큼은 되돌린 상태로 계산) */
  const debtBalance = (ref) => {
    const d = ref && S.debts[ref.id];
    if (!d) return null;
    const already = prevDebt && prevDebt.id === ref.id ? -prevDebt.amount : 0;
    return d.amount + already;
  };

  const draw = () => {
    const debtRef = parseLinkKey(draft.debt);
    const debt = debtRef && S.debts[debtRef.id];
    const cur = debt ? curOf(debt) : "KRW";
    const panel = openModal({
      cls: "theme-debts",
      title: existing ? "부채 상환 수정" : "부채 상환",
      body: `
        <div class="field" style="margin-top:4px"><label>상환할 부채</label>
          <select class="input" name="debt">${holdingOptions(["debts"], draft.debt).replace("선택 안 함", "부채를 골라 주세요")}</select>
          <div class="fx-hint" data-debt-hint></div>
        </div>
        <div class="field"><label>출금 자산</label>
          <select class="input" name="asset">${holdingOptions(["assets"], draft.asset)}</select>
          <div class="fx-hint" data-asset-hint></div>
        </div>
        <div class="field"><label>날짜 · 시간</label>
          <div class="money-line">
            <input class="input" type="date" name="date" value="${draft.date}">
            <input class="input time-input" type="time" name="time" value="${draft.time}">
          </div>
        </div>
        <div class="field"><label>상환 금액</label>
          <div class="amount-wrap" data-long="${cur !== "KRW"}">
            <input class="input amount-input" name="amount" inputmode="decimal" autocomplete="off" placeholder="0" value="${toInput(draft.amount, cur)}">
            <span class="amount-unit">${unitLabel(cur)}</span>
          </div>
        </div>
        <div class="field"><label>메모</label><input class="input" name="memo" placeholder="예: 10월 카드값" value="${esc(draft.memo)}"></div>
        <div class="btn-row">
          ${existing ? `<button class="btn danger" data-act="delete">${confirmDelete ? "한 번 더 누르면 삭제" : "삭제"}</button>` : `<button class="btn" data-act="cancel">취소</button>`}
          <button class="btn primary" data-act="save">상환하기</button>
        </div>`,
    });
    const $p = (s) => panel.querySelector(s);
    const read = () => {
      draft.debt = $p("[name=debt]").value;
      draft.asset = $p("[name=asset]").value;
      draft.amount = parseMoney($p("[name=amount]").value, cur);
      draft.date = $p("[name=date]").value;
      draft.time = $p("[name=time]").value;
      draft.memo = $p("[name=memo]").value;
    };
    const amt = $p("[name=amount]");
    const hints = () => {
      const bal = debtBalance(debtRef);
      const pay = parseMoney(amt.value, cur);
      $p("[data-debt-hint]").textContent = debt
        ? `현재 ${formatMoney(bal, cur)} → 상환 후 ${formatMoney(roundFor(bal - pay, cur), cur)}${pay > bal ? " (잔액보다 많아요)" : ""}`
        : "";
      const aRef = parseLinkKey($p("[name=asset]").value);
      const a = aRef && S.assets[aRef.id];
      if (!a || !debt) { $p("[data-asset-hint]").textContent = ""; return; }
      const out = amountInCurrency({ currency: cur, amount: pay, krw: toKRW(pay, cur) }, curOf(a));
      $p("[data-asset-hint]").textContent = out === null ? "환율 정보가 없어 반영할 수 없어요" : pay ? `${a.name}에서 -${formatMoney(roundFor(out, curOf(a)), curOf(a))} 빠져나가요${out > a.amount ? " (잔액보다 많아요)" : ""}` : "";
    };
    amt.addEventListener("input", () => { amt.value = formatInput(amt.value, cur); amountTouched = true; hints(); });
    $p("[name=asset]").onchange = hints;
    $p("[name=debt]").onchange = () => {
      read();
      const ref = parseLinkKey(draft.debt);
      if (ref && !amountTouched) draft.amount = Math.max(0, debtBalance(ref)); // 처음엔 남은 부채 전액으로 채움
      draw();
    };
    hints();

    const cancel = $p("[data-act=cancel]");
    if (cancel) cancel.onclick = () => onDone();
    $p("[data-act=save]").onclick = async () => {
      read();
      const ref = parseLinkKey(draft.debt);
      const d = ref && S.debts[ref.id];
      if (!d || d.deleted) return toast("상환할 부채를 골라 주세요.");
      if (draft.amount <= 0) return toast("상환 금액을 입력해 주세요.");
      if (!draft.date) return toast("날짜를 입력해 주세요.");
      const now = nowISO();
      const dcur = curOf(d);
      const krw = dcur === "KRW" ? draft.amount : toKRW(draft.amount, dcur);
      if (krw === null) return toast("환율 정보가 없어 반영할 수 없어요.");
      const deltas = [{ col: "debts", id: d.id, amount: -draft.amount }];
      const aRef = parseLinkKey(draft.asset);
      if (aRef) {
        const a = S.assets[aRef.id];
        if (!a || a.deleted) return toast("출금 자산을 찾을 수 없어요.");
        const out = amountInCurrency({ currency: dcur, amount: draft.amount, krw }, curOf(a));
        if (out === null) return toast("환율 정보가 없어 반영할 수 없어요.");
        deltas.push({ col: "assets", id: a.id, amount: -roundFor(out, curOf(a)) });
      }
      revertDeltas(existing, now);
      deltas.forEach((x) => adjustHolding(x.col, x.id, x.amount, now));
      const rec = {
        id: existing?.id || uid(),
        date: draft.date,
        time: draft.time || "",
        kind: "자산이동",
        expenseType: "",
        category: d.type === "신용카드" ? "카드대금" : "부채상환",
        currency: dcur,
        amount: draft.amount,
        ...(dcur !== "KRW" ? { krw: Math.round(krw) } : {}),
        content: `${d.name} 상환`,
        party: "",
        memo: draft.memo.trim(),
        deltas,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        deleted: false,
      };
      S.transactions[rec.id] = rec;
      await saveState(S);
      scheduleSync();
      onDone();
      toast(`${d.name} ${formatMoney(draft.amount, dcur)} 상환했어요`);
    };
    const del = $p("[data-act=delete]");
    if (del) del.onclick = async () => {
      if (!confirmDelete) { read(); confirmDelete = true; return draw(); }
      const now = nowISO();
      revertDeltas(existing, now);
      S.transactions[existing.id] = { ...existing, deleted: true, updatedAt: now };
      await saveState(S);
      scheduleSync();
      onDone();
      toast("상환 기록을 삭제했어요 · 잔액도 되돌렸어요");
    };
  };
  draw();
}

// 내역 추가/수정
// 외화 내역은 원래 금액(amount, currency)과 입력 당시 원화 금액(krw)을 함께 저장한다.
// 원화 금액은 환율로 자동 계산되지만, 실제 입금·결제된 원화로 직접 고칠 수 있다.
function openTxDialog(existing, presetDate) {
  if (existing?.deltas?.some((d) => d.col === "debts")) return openRepayDialog({ existing }); // 상환 기록은 상환 창에서 고친다
  const draft = existing
    ? { currency: "KRW", ...existing }
    : { kind: "지출", expenseType: "고정", date: presetDate || todayStr(), time: nowTime(), category: catsFor("지출", "고정")[0] || "", currency: "KRW", amount: 0, krw: 0, content: "", party: "", memo: "" };
  let confirmDelete = false;
  let krwTouched = !!existing?.krw; // 원화 금액을 직접 고쳤으면 자동 계산으로 덮어쓰지 않음
  if (existing) { const d = deltaRef(existing.assetDelta); draft.link = d ? linkKey(d.col, d.id) : ""; }
  // 자산이동: 출금 자산 → 입금 자산
  const prevOut = existing?.deltas?.find((d) => d.col === "assets" && d.amount < 0);
  const prevIn = existing?.deltas?.find((d) => d.col === "assets" && d.amount > 0);
  draft.fromAsset = prevOut ? linkKey("assets", prevOut.id) : "";
  draft.toAsset = prevIn ? linkKey("assets", prevIn.id) : "";

  refreshRates(); // 외화를 고를 때를 대비해 환율 준비

  const draw = () => {
    const catList = catsFor(draft.kind, draft.kind === "지출" ? draft.expenseType : null);
    if (!catList.includes(draft.category) && !(existing && existing.kind === draft.kind && existing.category === draft.category)) draft.category = catList[0] || "";
    if (draft.category && !catList.includes(draft.category)) catList.push(draft.category); // 지워진 카테고리를 쓰던 내역
    const foreign = draft.currency !== "KRW";
    const panel = openModal({
      title: existing ? "내역 수정" : "내역 추가",
      body: `
        <div class="seg" data-role="kind">${KINDS.map((k) => `<button data-v="${k}" class="${k === draft.kind ? "on" : ""}">${k}</button>`).join("")}</div>
        ${draft.kind === "지출" ? `
        <div class="field"><label>지출 종류</label>
          <div class="seg" data-role="etype">${EXPENSE_TYPES.map((k) => `<button data-v="${k}" class="${k === draft.expenseType ? "on" : ""}">${k}지출</button>`).join("")}</div>
        </div>` : ""}
        <div class="field"><label>날짜 · 시간</label>
          <div class="money-line">
            <input class="input" type="date" name="date" value="${draft.date}">
            <input class="input time-input" type="time" name="time" value="${draft.time || ""}">
          </div>
        </div>
        <div class="field"><label>금액</label>
          <div class="money-line">
            <div class="amount-wrap">
              <input class="input amount-input" name="amount" inputmode="decimal" autocomplete="off" placeholder="0" value="${toInput(draft.amount, draft.currency)}">
              <span class="amount-unit" data-unit>${unitLabel(draft.currency)}</span>
            </div>
            <select class="input cur-select" name="currency">${CURRENCIES.map((c) => `<option value="${c}" ${c === draft.currency ? "selected" : ""}>${c}</option>`).join("")}</select>
          </div>
        </div>
        <div class="field" data-krw-field ${foreign ? "" : "hidden"}><label>원화 금액 <span class="muted" data-rate></span></label>
          <div class="amount-wrap">
            <input class="input amount-input" name="krw" inputmode="numeric" autocomplete="off" placeholder="0" value="${fmtAmount(Math.round(draft.krw || 0))}">
            <span class="amount-unit">원</span>
          </div>
        </div>
        ${ASSET_LINK[draft.kind] ? `
        <div class="field"><label>${ASSET_LINK[draft.kind].label}</label>
          <select class="input" name="asset">${holdingOptions(ASSET_LINK[draft.kind].cols, draft.link, { balance: false })}</select>
          <div class="fx-hint" data-asset-hint></div>
        </div>` : ""}
        ${draft.kind === "자산이동" ? `
        <div class="field"><label>출금 자산</label>
          <select class="input" name="fromAsset">${holdingOptions(["assets"], draft.fromAsset, { balance: false })}</select>
          <div class="fx-hint" data-from-hint></div>
        </div>
        <div class="field"><label>입금 자산</label>
          <select class="input" name="toAsset">${holdingOptions(["assets"], draft.toAsset, { balance: false })}</select>
          <div class="fx-hint" data-to-hint></div>
        </div>` : ""}
        <div class="field"><label>내용</label><input class="input" name="content" placeholder="${draft.kind === "수입" ? "예: 10월 급여" : draft.kind === "자산이동" ? "예: 비상금 통장으로 이체" : "예: 점심 식사"}" value="${esc(draft.content || "")}"></div>
        ${draft.kind !== "자산이동" ? `<div class="field"><label>거래처/출처</label><input class="input" name="party" placeholder="${draft.kind === "수입" ? "예: (주)회사명" : "예: 김밥천국 강남점"}" value="${esc(draft.party || "")}"></div>
        ` : ""}
        <div class="field"><label>카테고리 · 하위 카테고리</label>
          <div class="money-line">
            <select class="input half" name="category">${catList.map((c) => `<option ${c === draft.category ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
            <select class="input half" name="subcategory">
              <option value="">선택 안 함</option>
              ${subcatsFor(draft.kind, draft.category).concat(draft.subcategory && !subcatsFor(draft.kind, draft.category).includes(draft.subcategory) ? [draft.subcategory] : [])
                .map((s) => `<option ${s === draft.subcategory ? "selected" : ""}>${esc(s)}</option>`).join("")}
              <option value="__add__">+ 직접 추가</option>
            </select>
            <button class="icon-only cat-edit" data-act="edit-cats" aria-label="카테고리 편집">${PENCIL}</button>
          </div>
          <div class="money-line subcat-add" data-subcat-add hidden>
            <input class="input" name="newSubcat" placeholder="새 하위 카테고리 이름">
            <button class="btn subcat-add-btn" data-act="add-subcat">추가</button>
          </div>
        </div>
        ${draft.kind !== "자산이동" ? `<div class="field"><label>메모</label><input class="input" name="memo" placeholder="자유롭게 메모" value="${esc(draft.memo)}"></div>` : ""}
        <div class="btn-row">
          ${existing ? `<button class="btn danger" data-act="delete">${confirmDelete ? "한 번 더 누르면 삭제" : "삭제"}</button>` : ""}
          <button class="btn primary" data-act="save">저장</button>
        </div>`,
    });
    const $p = (sel) => panel.querySelector(sel);
    const curSel = $p("[name=currency]"), amt = $p("[name=amount]"), krwIn = $p("[name=krw]");

    // 외화면 원화 금액 칸을 보여 주고, 직접 고치지 않았으면 환율로 채운다
    const refreshKRW = () => {
      const cur = curSel.value;
      $p("[data-unit]").textContent = unitLabel(cur);
      $p("[data-unit]").parentElement.dataset.long = cur !== "KRW";
      $p("[data-krw-field]").hidden = cur === "KRW";
      if (cur === "KRW") return;
      const r = rateKRW(cur);
      $p("[data-rate]").textContent = r === null ? "(환율 정보 없음 · 직접 입력)" : `(1 ${cur} ≈ ${r < 100 ? r.toFixed(2) : Math.round(r).toLocaleString("ko-KR")}원)`;
      if (!krwTouched) {
        const v = toKRW(parseMoney(amt.value, cur), cur);
        krwIn.value = v ? fmtAmount(Math.round(v)) : "";
      }
    };
    const read = () => {
      draft.currency = curSel.value;
      draft.amount = parseMoney(amt.value, draft.currency);
      draft.krw = parseAmount(krwIn.value);
      draft.date = $p("[name=date]").value;
      draft.time = $p("[name=time]").value;
      if ($p("[name=category]")) draft.category = $p("[name=category]").value;
      const sc = $p("[name=subcategory]")?.value;
      if (sc !== undefined) draft.subcategory = sc === "__add__" ? draft.subcategory || "" : sc;
      draft.content = $p("[name=content]").value;
      if ($p("[name=party]")) draft.party = $p("[name=party]").value;
      if ($p("[name=memo]")) draft.memo = $p("[name=memo]").value;
      if ($p("[name=fromAsset]")) { draft.fromAsset = $p("[name=fromAsset]").value; draft.toAsset = $p("[name=toAsset]").value; }
      if ($p("[name=asset]")) draft.link = $p("[name=asset]").value;
    };
    amt.addEventListener("input", () => { amt.value = formatInput(amt.value, curSel.value); krwTouched = false; refreshKRW(); });
    curSel.onchange = () => { amt.value = formatInput(amt.value, curSel.value); krwTouched = false; refreshKRW(); };
    bindAmount(krwIn);
    krwIn.addEventListener("input", () => (krwTouched = true));
    refreshKRW();
    const assetSel = $p("[name=asset]");
    const refreshAssetHint = () => {
      if (!assetSel) return;
      const ref = parseLinkKey(assetSel.value);
      const a = ref && S[ref.col][ref.id];
      const hint = $p("[data-asset-hint]");
      if (!a) { hint.textContent = ""; return; }
      const cur = curOf(a);
      const add = amountInCurrency({ currency: curSel.value, amount: parseMoney(amt.value, curSel.value), krw: parseAmount(krwIn.value) }, cur);
      const what = ref.col === "debts" ? "부채가" : "잔액이";
      hint.textContent = add === null ? "환율 정보가 없어 반영할 수 없어요" : !add ? "" : linkSign(draft.kind, ref.col) > 0
        ? `저장하면 ${a.name} ${what} +${formatMoney(roundFor(add, cur), cur)} 늘어나요`
        : `저장하면 ${a.name} ${what} -${formatMoney(roundFor(add, cur), cur)} 줄어들어요`;
    };
    if (assetSel) {
      assetSel.onchange = refreshAssetHint;
      [amt, krwIn].forEach((el) => el.addEventListener("input", refreshAssetHint));
      curSel.addEventListener("change", refreshAssetHint);
      refreshAssetHint();
    }

    panel.querySelectorAll("[data-role=kind] button").forEach((b) => (b.onclick = () => { read(); draft.kind = b.dataset.v; draft.subcategory = ""; draw(); }));
    if ($p("[name=category]")) {
    $p("[name=category]").onchange = () => { read(); draft.subcategory = ""; draw(); };
    $p("[data-act=edit-cats]").onclick = () => {
      read();
      openCategoryEditor({ kind: draft.kind, etype: draft.expenseType || "고정", onClose: () => draw() });
    };
    $p("[name=subcategory]").onchange = (e) => {
      const adding = e.target.value === "__add__";
      $p("[data-subcat-add]").hidden = !adding;
      if (adding) $p("[name=newSubcat]").focus();
    };
    $p("[data-act=add-subcat]").onclick = async () => {
      const name = $p("[name=newSubcat]").value.trim();
      if (!name) return toast("하위 카테고리 이름을 입력해 주세요.");
      read();
      if (!subcatsFor(draft.kind, draft.category).includes(name)) {
        addSubcat(draft.kind, draft.category, name);
        await saveState(S);
        scheduleSync();
      }
      draft.subcategory = name;
      draw();
      toast(`'${draft.category} › ${name}' 추가했어요`);
    };
    }
    // 자산이동: 출금·입금 안내
    const fromSel = $p("[name=fromAsset]"), toSel = $p("[name=toAsset]");
    const refreshTransferHint = () => {
      if (!fromSel) return;
      const amtNow = { currency: curSel.value, amount: parseMoney(amt.value, curSel.value), krw: parseAmount(krwIn.value) };
      [[fromSel, "[data-from-hint]", "에서", "-", "빠져나가요"], [toSel, "[data-to-hint]", "에", "+", "들어가요"]].forEach(([sel, hintSel, josa, sign, verb]) => {
        const ref = parseLinkKey(sel.value);
        const a = ref && S.assets[ref.id];
        const v = a && amountInCurrency(amtNow, curOf(a));
        $p(hintSel).textContent = !a || !amtNow.amount ? "" : v === null ? "환율 정보가 없어 반영할 수 없어요" : `${a.name}${josa} ${sign}${formatMoney(roundFor(v, curOf(a)), curOf(a))} ${verb}`;
      });
    };
    if (fromSel) {
      [fromSel, toSel, curSel].forEach((el) => el.addEventListener("change", refreshTransferHint));
      [amt, krwIn].forEach((el) => el.addEventListener("input", refreshTransferHint));
      refreshTransferHint();
    }
    panel.querySelectorAll("[data-role=etype] button").forEach((b) => (b.onclick = () => { read(); draft.expenseType = b.dataset.v; draft.subcategory = ""; draw(); }));
    $p("[data-act=save]").onclick = async () => {
      read();
      const foreignNow = draft.currency !== "KRW";
      if (draft.amount <= 0) return toast("금액을 입력해 주세요.");
      if (foreignNow && draft.krw <= 0) return toast("원화 금액을 입력해 주세요.");
      if (!draft.date) return toast("날짜를 입력해 주세요.");
      const now = nowISO();
      const isMove = draft.kind === "자산이동";
      let deltas = null;
      if (isMove) {
        const fromRef = parseLinkKey(draft.fromAsset), toRef = parseLinkKey(draft.toAsset);
        if (fromRef && toRef && fromRef.id === toRef.id) return toast("출금 자산과 입금 자산이 같아요.");
        deltas = [];
        const amtRec = { currency: draft.currency, amount: draft.amount, krw: draft.currency === "KRW" ? draft.amount : draft.krw };
        for (const [ref, sign] of [[fromRef, -1], [toRef, 1]]) {
          if (!ref) continue;
          const a = S.assets[ref.id];
          if (!a || a.deleted) return toast("선택한 자산을 찾을 수 없어요.");
          const v = amountInCurrency(amtRec, curOf(a));
          if (v === null) return toast("환율 정보가 없어 반영할 수 없어요.");
          deltas.push({ col: "assets", id: a.id, amount: sign * roundFor(v, curOf(a)) });
        }
        draft.party = "";
        draft.memo = "";
      }
      const rec = {
        id: existing?.id || uid(),
        date: draft.date,
        time: draft.time || "",
        kind: draft.kind,
        expenseType: draft.kind === "지출" ? draft.expenseType : "",
        category: draft.category,
        subcategory: draft.subcategory || "",
        currency: draft.currency,
        amount: draft.amount,
        ...(foreignNow ? { krw: draft.krw } : {}),
        content: (draft.content || "").trim(),
        party: (draft.party || "").trim(),
        memo: draft.memo.trim(),
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        deleted: false,
      };
      let delta = null;
      const ref = ASSET_LINK[rec.kind] && parseLinkKey(draft.link);
      if (ref && ASSET_LINK[rec.kind].cols.includes(ref.col)) {
        const a = S[ref.col][ref.id];
        if (!a || a.deleted) return toast("선택한 항목을 찾을 수 없어요.");
        const add = amountInCurrency(rec, curOf(a));
        if (add === null) return toast("환율 정보가 없어 반영할 수 없어요.");
        delta = { col: ref.col, id: a.id, amount: linkSign(rec.kind, ref.col) * roundFor(add, curOf(a)) };
      }
      const prev = deltaRef(existing?.assetDelta);
      if (prev) adjustHolding(prev.col, prev.id, -prev.amount, now);
      revertDeltas(existing, now); // 이전 자산이동 반영 되돌리기
      if (delta) { adjustHolding(delta.col, delta.id, delta.amount, now); rec.assetDelta = delta; }
      if (deltas?.length) { deltas.forEach((x) => adjustHolding(x.col, x.id, x.amount, now)); rec.deltas = deltas; }
      S.transactions[rec.id] = rec;
      closeModal();
      ui.month = rec.date.slice(0, 7);
      await commit();
      const target = delta && S[delta.col][delta.id];
      toast(`${rec.kind} ${formatMoney(rec.amount, rec.currency)} ${existing ? "수정" : "추가"}했어요` +
        (target ? ` · ${target.name} ${delta.amount >= 0 ? "+" : "-"}${formatMoney(Math.abs(delta.amount), curOf(target))}` : ""));
    };
    const del = $p("[data-act=delete]");
    if (del) del.onclick = async () => {
      if (!confirmDelete) { read(); confirmDelete = true; return draw(); }
      const now = nowISO();
      const prev = deltaRef(existing.assetDelta);
      if (prev) adjustHolding(prev.col, prev.id, -prev.amount, now);
      revertDeltas(existing, now);
      S.transactions[existing.id] = { ...existing, deleted: true, updatedAt: now };
      closeModal();
      await commit();
      toast(prev ? `삭제했어요 · ${prev.col === "debts" ? "부채" : "자산 잔액"}도 되돌렸어요` : existing.deltas?.length ? "삭제했어요 · 자산 잔액도 되돌렸어요" : "삭제했어요");
    };
    if (!existing && !draft.amount) amt.focus();
  };
  draw();
}

// 나의 자산
const PENCIL = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>`;

const curOf = (a) => a.currency || "KRW"; // 예전 자산은 통화 정보가 없으면 원화
const currencyOptions = (sel) =>
  CURRENCIES.map((c) => `<option value="${c}" ${c === sel ? "selected" : ""}>${c === "KRW" ? "원 (KRW)" : `${c} · ${CURRENCY_NAMES[c]}`}</option>`).join("");

/** 원화 환산 합계. 환율을 모르는 외화가 있으면 missing에 개수를 센다. */
function krwTotal(assets) {
  let total = 0, missing = 0;
  for (const a of assets) {
    const v = toKRW(a.amount, curOf(a));
    if (v === null) missing++;
    else total += v;
  }
  return { total, missing };
}

/** 금액 입력칸: 통화에 맞게 쉼표/소수점 정리, 원화 환산 안내 갱신 */
function bindMoney(input, getCur, hint) {
  const update = () => {
    const cur = getCur();
    if (hint) {
      const v = toKRW(parseMoney(input.value, cur), cur);
      const r = rateKRW(cur);
      const rate = r === null ? "" : r < 100 ? r.toFixed(2) : Math.round(r).toLocaleString("ko-KR"); // 엔·동처럼 작은 환율은 소수점까지
      hint.textContent = cur === "KRW" ? "" : v === null ? "환율 정보를 아직 받지 못했어요" : `≈ ${won(v)} (1 ${cur} = ${rate}원)`;
    }
  };
  input.addEventListener("input", () => { input.value = formatInput(input.value, getCur()); update(); });
  return update;
}

const GRIP = `<svg width="14" height="18" viewBox="0 0 14 18" fill="currentColor" aria-hidden="true"><circle cx="4" cy="4" r="1.4"/><circle cx="10" cy="4" r="1.4"/><circle cx="4" cy="9" r="1.4"/><circle cx="10" cy="9" r="1.4"/><circle cx="4" cy="14" r="1.4"/><circle cx="10" cy="14" r="1.4"/></svg>`;
const NO_ORDER = 1e9; // 순서를 정한 적 없는 자산은 뒤로(등록 순)

/** 정렬: 종류 순 → 사용자가 드래그로 정한 순서 → 등록 순 */
const makeOrder = (types) => (a, b) =>
  types.indexOf(a.type) - types.indexOf(b.type) ||
  (a.order ?? NO_ORDER) - (b.order ?? NO_ORDER) ||
  a.createdAt.localeCompare(b.createdAt);

/** 나의 자산 / 나의 부채는 같은 창을 쓰고 이름·종류만 다르다. */
const HOLDINGS = {
  assets: { title: "나의 자산", unit: "자산", subj: "자산이", obj: "자산을", total: "총 자산", types: ASSET_TYPES, placeholder: "예: 국민은행 통장" },
  debts: { title: "나의 부채", unit: "부채", subj: "부채가", obj: "부채를", total: "총 부채", types: DEBT_TYPES, placeholder: "예: 신한카드 10월 결제분" },
};

/**
 * 손잡이(⋮⋮)를 잡고 끌면 같은 섹션 안에서 위치를 바꾼다.
 * 터치(안드로이드)에서도 되도록 브라우저 드래그앤드롭 대신 포인터 이벤트로 직접 구현.
 */
function enableReorder(panel, onDrop) {
  const overlay = panel.closest(".overlay");
  panel.querySelectorAll("[data-handle]").forEach((handle) => {
    handle.addEventListener("pointerdown", (e) => {
      const item = handle.closest(".edit-item");
      const section = item.parentElement;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      item.classList.add("dragging");

      const onMove = (ev) => {
        // 화면 끝 근처에서는 자동으로 스크롤
        if (ev.clientY < 70) overlay.scrollTop -= 10;
        else if (ev.clientY > window.innerHeight - 70) overlay.scrollTop += 10;
        const others = [...section.querySelectorAll(".edit-item")].filter((x) => x !== item);
        const before = others.find((x) => {
          const r = x.getBoundingClientRect();
          return ev.clientY < r.top + r.height / 2;
        });
        if (before) { if (item.nextElementSibling !== before) section.insertBefore(item, before); }
        else if (others.length && section.lastElementChild !== item) section.appendChild(item);
      };
      const onUp = () => {
        item.classList.remove("dragging");
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        onDrop();
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    });
  });
}

function openHoldingsDialog(col) {
  const cfg = HOLDINGS[col];
  const order = makeOrder(cfg.types);
  const liveList = () => Object.values(S[col]).filter((a) => !a.deleted);
  let mode = null;   // null: 목록 | "add": 등록 | "edit": 전체 편집
  let drafts = null; // 전체 편집 중인 값 [{ id, type, name, currency, amount, del }]

  const sortedAssets = () => liveList().sort(order);

  // 환율을 새로 받으면 목록의 원화 환산을 다시 그린다
  refreshRates().then((updated) => { if (updated && mode === null && $("#modal-root").children.length) draw(); });

  // 목록(보기 전용): 종류별 한 덩어리, 안쪽은 줄로만 구분
  const draw = () => {
    if (mode === "add") return drawAdd();
    if (mode === "edit") return drawEdit();
    const assets = sortedAssets();
    const groups = cfg.types; // 등록된 항목이 없어도 모든 종류 섹션을 보여 준다
    const all = krwTotal(assets);
    const hasForeign = assets.some((a) => curOf(a) !== "KRW");
    const body =
      `<div class="asset-total"><span class="muted">${cfg.total}</span><span>${all.missing ? "약 " : ""}${won(all.total)}</span></div>` +
        groups.map((t) => {
          const items = assets.filter((a) => a.type === t);
          const g = krwTotal(items);
          return `
          <section class="asset-group">
            <div class="asset-group-head"><span class="sector-badge">${t}</span><span class="sector-total">${won(g.total)}</span></div>
            ${items.length ? items.map((a) => {
              const cur = curOf(a);
              const krw = cur === "KRW" ? null : toKRW(a.amount, cur);
              return `<div class="asset-row"><span class="name">${esc(a.name)}</span>
                <span class="amt">${formatMoney(a.amount, cur)}${cur !== "KRW" ? `<span class="fx-sub">${krw === null ? "환율 없음" : `≈ ${won(krw)}`}</span>` : ""}</span></div>`;
            }).join("") : `<div class="asset-row asset-none">등록된 ${cfg.subj} 없습니다</div>`}
          </section>`;
        }).join("") +
        (hasForeign ? `<p class="note fx-note">외화는 ${ratesDate() ? `${ratesDate()} 환율` : "환율"}로 원화 환산해 합계에 넣었어요.${all.missing ? ` 환율을 받지 못한 ${all.missing}개는 합계에서 빠졌어요.` : ""}</p>` : "");
    const panel = openModal({
      cls: `theme-${col}`,
      title: cfg.title,
      headExtra: `<button class="${col === "debts" ? "red-btn" : "green-btn"}" data-add>${cfg.unit} 등록</button>` +
        (col === "debts" ? `<button class="green-btn" data-repay>부채 상환</button>` : "") +
        (assets.length ? `<button class="icon-only" data-edit aria-label="${cfg.unit} 편집">${PENCIL}</button>` : ""),
      body: body + `<button class="btn" data-close-btn style="margin-top:18px">닫기</button>`,
    });
    panel.querySelector("[data-add]").onclick = () => { mode = "add"; draw(); };
    const repay = panel.querySelector("[data-repay]");
    if (repay) repay.onclick = () => openRepayDialog({ onDone: () => openHoldingsDialog("debts") });
    panel.querySelector("[data-close-btn]").onclick = closeModal;
    const edit = panel.querySelector("[data-edit]");
    if (edit) edit.onclick = () => {
      drafts = sortedAssets().map((a) => ({ id: a.id, type: a.type, name: a.name, currency: curOf(a), amount: a.amount, del: false }));
      mode = "edit";
      draw();
    };
  };

  // 전체 편집: 모든 자산의 종류·이름·통화·금액을 한 번에 고치고, 삭제는 표시해 두었다가 저장할 때 반영
  const drawEdit = () => {
    const groups = cfg.types.filter((t) => drafts.some((d) => S[col][d.id].type === t));
    const panel = openModal({
      cls: `theme-${col}`,
      title: `${cfg.unit} 편집`,
      body: groups.map((t) => `
        <section class="asset-group">
          <div class="asset-group-head"><span class="sector-badge">${t}</span></div>
          ${drafts.filter((d) => S[col][d.id].type === t).map((d) => `
          <div class="edit-item${d.del ? " removed" : ""}" data-id="${d.id}">
            <button class="grip" data-handle aria-label="끌어서 순서 바꾸기">${GRIP}</button>
            <div class="edit-body">
            <div class="edit-line">
              <input class="input sm" name="name" value="${esc(d.name)}" placeholder="이름" ${d.del ? "disabled" : ""}>
              <button class="edit-del" data-toggle-del>${d.del ? "되돌리기" : "삭제"}</button>
            </div>
            <div class="edit-line">
              <select class="input sm type" name="type" ${d.del ? "disabled" : ""}>${cfg.types.map((x) => `<option ${x === d.type ? "selected" : ""}>${x}</option>`).join("")}</select>
              <select class="input sm cur" name="currency" ${d.del ? "disabled" : ""}>${CURRENCIES.map((c) => `<option ${c === d.currency ? "selected" : ""}>${c}</option>`).join("")}</select>
              <input class="input sm amount-input" name="amount" inputmode="decimal" value="${toInput(d.amount, d.currency)}" placeholder="0" ${d.del ? "disabled" : ""}>
            </div>
            </div>
          </div>`).join("")}
        </section>`).join("") +
        `<div class="btn-row"><button class="btn" data-cancel>취소</button><button class="btn primary" data-save>저장</button></div>`,
    });
    const read = () => panel.querySelectorAll(".edit-item").forEach((el) => {
      const d = drafts.find((x) => x.id === el.dataset.id);
      if (d.del) return;
      d.name = el.querySelector("[name=name]").value;
      d.type = el.querySelector("[name=type]").value;
      d.currency = el.querySelector("[name=currency]").value;
      d.amount = parseMoney(el.querySelector("[name=amount]").value, d.currency);
    });
    const syncOrder = () => {
      const ids = [...panel.querySelectorAll(".edit-item")].map((el) => el.dataset.id);
      drafts.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    };
    enableReorder(panel, syncOrder);
    panel.querySelectorAll(".edit-item").forEach((el) => {
      const cur = el.querySelector("[name=currency]");
      const amt = el.querySelector("[name=amount]");
      bindMoney(amt, () => cur.value);
      cur.onchange = () => { amt.value = formatInput(amt.value, cur.value); };
    });
    panel.querySelectorAll("[data-toggle-del]").forEach((b) => (b.onclick = () => {
      read();
      syncOrder();
      const d = drafts.find((x) => x.id === b.closest(".edit-item").dataset.id);
      d.del = !d.del;
      drawEdit();
    }));
    panel.querySelector("[data-cancel]").onclick = () => { mode = null; drafts = null; draw(); };
    panel.querySelector("[data-save]").onclick = async () => {
      read();
      syncOrder();
      if (drafts.some((d) => !d.del && !d.name.trim())) return toast(`이름이 빈 ${cfg.subj} 있어요.`);
      const now = nowISO();
      let changed = 0;
      const pos = {}; // 섹션(원래 종류)별 순번
      for (const d of drafts) {
        const a = S[col][d.id];
        if (d.del) {
          S[col][d.id] = { ...a, deleted: true, updatedAt: now };
          changed++;
          continue;
        }
        const i = (pos[a.type] = (pos[a.type] ?? -1) + 1);
        const order = d.type === a.type ? i : 10000 + i; // 종류를 옮긴 자산은 새 섹션의 맨 뒤로
        if (a.type !== d.type || a.name !== d.name.trim() || curOf(a) !== d.currency || a.amount !== d.amount || a.order !== order) {
          S[col][d.id] = { ...a, type: d.type, name: d.name.trim(), currency: d.currency, amount: d.amount, order, updatedAt: now };
          changed++;
        }
      }
      if (changed) {
        await saveState(S);
        scheduleSync();
      }
      mode = null;
      drafts = null;
      draw();
      toast(changed ? `${changed}개 ${cfg.obj} 저장했어요` : "바뀐 내용이 없어요");
    };
  };

  // 새로 등록 (기본 원화, 외화 선택 가능)
  const drawAdd = () => {
    const panel = openModal({
      cls: `theme-${col}`,
      title: `${cfg.unit} 등록`,
      body: `
        <div class="field" style="margin-top:4px"><label>종류</label>
          <select class="input" name="type">${cfg.types.map((t) => `<option>${t}</option>`).join("")}</select>
        </div>
        <div class="field"><label>이름</label><input class="input" name="name" placeholder="${cfg.placeholder}"></div>
        <div class="field"><label>통화</label><select class="input" name="currency">${currencyOptions("KRW")}</select></div>
        <div class="field"><label>금액</label><input class="input amount-input" name="amount" inputmode="decimal" placeholder="0">
          <div class="fx-hint" data-hint></div></div>
        <div class="btn-row"><button class="btn" data-cancel>취소</button><button class="btn primary" data-save>저장</button></div>`,
    });
    const cur = panel.querySelector("[name=currency]");
    const amt = panel.querySelector("[name=amount]");
    const updateHint = bindMoney(amt, () => cur.value, panel.querySelector("[data-hint]"));
    cur.onchange = () => { amt.value = formatInput(amt.value, cur.value); updateHint(); };
    panel.querySelector("[data-cancel]").onclick = () => { mode = null; draw(); };
    panel.querySelector("[data-save]").onclick = async () => {
      const name = panel.querySelector("[name=name]").value.trim();
      if (!name) return toast("이름을 입력해 주세요.");
      const now = nowISO();
      const type = panel.querySelector("[name=type]").value;
      const last = Math.max(-1, ...liveList().filter((a) => a.type === type && a.order != null && a.order < NO_ORDER).map((a) => a.order));
      const rec = {
        id: uid(),
        type,
        order: last + 1,
        name,
        currency: cur.value,
        amount: parseMoney(amt.value, cur.value),
        createdAt: now,
        updatedAt: now,
        deleted: false,
      };
      S[col][rec.id] = rec;
      await saveState(S);
      scheduleSync();
      mode = null;
      draw();
      toast("등록했어요");
    };
  };
  draw();
}

// 백업/복원 (파일로 내보내기·가져오기)
function syncSection() {
  if (!isConfigured()) return `<p class="note">구글 드라이브 동기화 설정 전이에요. 지금은 이 기기에만 저장되고, 아래처럼 파일로 옮길 수 있어요.</p>`;
  if (!isConnected()) return `
    <p class="note">구글 드라이브에 연결하면 폰과 PC의 내역이 자동으로 합쳐져요. 이 앱이 만든 파일 하나에만 접근해요.</p>
    <button class="btn primary" data-connect style="margin-top:10px">구글 드라이브 연결</button>`;
  const last = S.meta.lastSync ? new Date(S.meta.lastSync).toLocaleString("ko-KR") : "아직 없음";
  return `
    <div class="asset-total"><span class="muted">상태</span><span>${SYNC_TEXT[sync.status] || "연결됨"}</span></div>
    <div class="asset-total"><span class="muted">마지막 동기화</span><span>${last}</span></div>
    ${sync.status === "error" && sync.error ? `<p class="note">오류: ${esc(sync.error)}</p>` : ""}
    <div class="btn-row">
      <button class="btn" data-disconnect>연결 해제</button>
      <button class="btn primary" data-sync>${sync.status === "need-login" ? "다시 연결" : "지금 동기화"}</button>
    </div>`;
}

function openBackupDialog() {
  const panel = openModal({
    title: "백업/복원",
    body: `
      <div class="section-title" style="margin-top:4px">구글 드라이브 동기화</div>
      ${syncSection()}
      <div class="section-title">내보내기</div>
      <button class="btn primary" data-export>백업 파일 저장</button>
      <div class="section-title">가져오기</div>
      <p class="note">백업 파일의 내역을 지금 데이터에 <b style="font-weight:400;color:#fff">합쳐요</b>. 같은 내역은 최신 것으로 바뀌고, 지금 데이터는 지워지지 않아요.</p>
      <input type="file" accept=".json,application/json" data-file hidden>
      <button class="btn" data-import style="margin-top:10px">백업 파일 불러오기</button>`,
  });
  panel.querySelector("[data-connect]")?.addEventListener("click", connect);
  panel.querySelector("[data-disconnect]")?.addEventListener("click", () => { disconnect(); openBackupDialog(); });
  panel.querySelector("[data-sync]")?.addEventListener("click", async () => {
    if (sync.status === "need-login") return connect();
    await runSync();
    openBackupDialog();
    toast(sync.status === "ok" ? "동기화했어요" : SYNC_TEXT[sync.status]);
  });
  panel.querySelector("[data-export]").onclick = () => {
    const blob = new Blob([JSON.stringify(S, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `클로드가계부_${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const file = panel.querySelector("[data-file]");
  panel.querySelector("[data-import]").onclick = () => file.click();
  file.onchange = async () => {
    try {
      const data = JSON.parse(await file.files[0].text());
      const n = mergeInto(S, data);
      await commit();
      closeModal();
      toast(`${n}건을 합쳤어요`);
    } catch (e) {
      toast("백업 파일을 읽지 못했어요");
    }
  };
}

// 날짜 고르기: 상단 '2026년 10월'을 누르면 열리는 달력. 날짜를 고르면 그 달·그 날로 이동한다.
// 제목(연·월)을 누르면 12개월 보기로 바뀌어 먼 달로 빨리 갈 수 있다.
function openDatePicker() {
  let view = ui.month;   // 팝업에서 보고 있는 달
  let monthMode = false; // true: 12개월 보기
  const today = todayStr();
  const hasTx = new Set(liveTx().map((t) => t.date));

  const draw = () => {
    const [y, m] = view.split("-").map(Number);
    let grid;
    if (monthMode) {
      grid = `<div class="pick-months">${Array.from({ length: 12 }, (_, i) => {
        const v = `${y}-${pad(i + 1)}`;
        return `<button data-month="${v}" class="${v === ui.month ? "on" : ""}">${i + 1}월</button>`;
      }).join("")}</div>`;
    } else {
      const first = new Date(y, m - 1, 1).getDay();
      const days = new Date(y, m, 0).getDate();
      const cells = Array.from({ length: first }, () => `<span></span>`);
      for (let d = 1; d <= days; d++) {
        const date = `${view}-${pad(d)}`;
        const dow = (first + d - 1) % 7;
        cells.push(`<button data-date="${date}" class="pick-day${date === today ? " today" : ""}${date === ui.day ? " on" : ""}${dow === 0 ? " sun" : dow === 6 ? " sat" : ""}">
          ${d}${hasTx.has(date) ? `<i></i>` : ""}</button>`);
      }
      grid = `
        <div class="cal-grid cal-week">${"일월화수목금토".split("").map((w, i) => `<span class="${i === 0 ? "sun" : i === 6 ? "sat" : ""}">${w}</span>`).join("")}</div>
        <div class="cal-grid">${cells.join("")}</div>`;
    }
    const panel = openModal({
      title: "날짜 선택",
      body: `
        <div class="pick-nav">
          <button class="icon-btn" data-step="-1" aria-label="이전">‹</button>
          <button class="pick-title" data-toggle>${monthMode ? `${y}년` : `${y}년 ${m}월`}</button>
          <button class="icon-btn" data-step="1" aria-label="다음">›</button>
        </div>
        ${grid}
        <div class="btn-row"><button class="btn" data-today>오늘</button></div>`,
    });
    panel.querySelectorAll("[data-step]").forEach((b) => (b.onclick = () => {
      view = shiftMonth(view, Number(b.dataset.step) * (monthMode ? 12 : 1));
      draw();
    }));
    panel.querySelector("[data-toggle]").onclick = () => { monthMode = !monthMode; draw(); };
    panel.querySelectorAll("[data-month]").forEach((b) => (b.onclick = () => { view = b.dataset.month; monthMode = false; draw(); }));
    const go = (date) => {
      ui.month = date.slice(0, 7);
      ui.day = date;
      closeModal(); // 창이 닫히면 화면이 새 달로 다시 그려진다
    };
    panel.querySelectorAll("[data-date]").forEach((b) => (b.onclick = () => go(b.dataset.date)));
    panel.querySelector("[data-today]").onclick = () => go(today);
  };
  draw();
}

// ---------------- 이벤트 ----------------
function bindEvents() {
  $("#prev").onclick = () => { ui.month = shiftMonth(ui.month, -1); render(); };
  $("#next").onclick = () => { ui.month = shiftMonth(ui.month, 1); render(); };
  $("#month-title").onclick = openDatePicker;
  document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => { ui.tab = b.dataset.tab; render(); }));
  $("#fab").onclick = () => openTxDialog(null, ui.tab === "calendar" && ui.day ? ui.day : undefined);
  $("#open-assets").onclick = () => openHoldingsDialog("assets");
  $("#open-debts").onclick = () => openHoldingsDialog("debts");
  $("#open-backup").onclick = openBackupDialog;
  $("#sync-bar").onclick = () => (sync.status === "need-login" ? connect() : runSync());
  // 앱으로 돌아왔을 때: 토큰이 끝났으면(창이 열려 있지 않을 때) 조용히 재로그인, 아니면 바로 동기화
  const idle = () => document.visibilityState === "visible" && !$("#modal-root").children.length;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (idle() && refreshIfNeeded()) return;
    runSync();
  });
  // 켜 둔 채로 쓰는 동안: 토큰이 5분 안에 끝나면 미리 새로 받는다(입력 창이 열려 있을 땐 기다림)
  setInterval(() => { if (idle()) refreshIfNeeded(5 * 60_000); }, 60_000);
  window.addEventListener("online", () => runSync());
  window.addEventListener("offline", () => { sync.status = "offline"; renderSyncBar(); });
  $("#view").addEventListener("click", (e) => {
    const seg = e.target.closest("[data-seg]");
    if (seg) { ui.seg = seg.dataset.seg; ui.openCat = null; render(); return; }
    const go = e.target.closest("[data-month-go]");
    if (go) { ui.month = go.dataset.monthGo; ui.tab = "home"; render(); window.scrollTo(0, 0); return; }
    const day = e.target.closest("[data-day]");
    if (day) { ui.day = day.dataset.day; render(); return; }
    const tx = e.target.closest("[data-tx]");
    if (tx) { openTxDialog(S.transactions[tx.dataset.tx]); return; }
    const cat = e.target.closest("[data-detail-cat]");
    if (cat) { ui.openCat = ui.openCat === cat.dataset.detailCat ? null : cat.dataset.detailCat; render(); }
  });
  // 자산 창은 닫힐 때 홈 화면을 다시 그릴 필요가 없지만, 다른 창이 닫히면 최신 상태로 그린다.
  new MutationObserver(() => { if (!$("#modal-root").children.length) render(); }).observe($("#modal-root"), { childList: true });
}

async function main() {
  const fresh = handleRedirect(); // 구글 로그인에서 돌아온 경우 토큰 저장
  if (!fresh && refreshIfNeeded()) return; // 토큰 만료 → 조용히 재로그인하러 이동
  S = await loadState();
  if (seedCats() + retireOldCats() + seedSubcats()) await saveState(S);
  sync.onChange = renderSyncBar;
  bindEvents();
  render();
  runSync();
  if (fresh) toast("구글 드라이브에 연결했어요");
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}
main();
