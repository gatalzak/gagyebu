import { loadState, saveState, mergeInto, uid, nowISO } from "./store.js";
import { CURRENCIES, CURRENCY_NAMES, parseMoney, formatInput, toInput, formatMoney, toKRW, rateKRW, refreshRates, ratesDate, decimals } from "./fx.js";
import { sync, isConfigured, isConnected, connect, disconnect, handleRedirect, refreshIfNeeded, syncNow, syncDrivePhotos } from "./sync.js";
import { getPhoto, putPhoto, deletePhoto, shrinkImage } from "./photos.js";
import { makeXlsx, makeXlsxBook } from "./xlsx.js";
import { initLock, lockSection, bindLockSection, hideAmounts } from "./lock.js";

// ---------------- 기본 목록 ----------------
const KINDS = ["수입", "지출", "자산이동"];
const EXPENSE_TYPES = ["고정", "변동"]; // 화면 표시 순서(고정지출이 앞)
const CATEGORIES = {
  수입: ["월급", "부수입", "용돈", "이자/배당", "환급", "기타"],
  지출: ["식비", "카페/간식", "교통", "주거/통신", "생활용품", "쇼핑", "의료/건강", "문화/여가", "교육", "경조사", "보험", "금융/이자", "기타"],
};
// 자산이동은 카테고리를 쓰지 않는다(출금 → 입금 자산으로 구분). 예전 기록의 카테고리는 cleanMoveCategories가 비운다.
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
const DEBT_TYPES = ["신용카드", "대출", "마이너스통장", "할부", "미납금", "지인에게 빌린 돈", "기타"];
const OLD_DEBT_TYPE = { "개인(지인)": "지인에게 빌린 돈" }; // 예전 종류 이름 → 지금 이름
const debtType = (d) => OLD_DEBT_TYPE[d?.type] || d?.type;
/** 예전 종류 이름으로 저장된 부채를 지금 이름으로 바꾼다 */
function migrateDebtTypes() {
  let n = 0;
  const now = nowISO();
  for (const d of Object.values(S.debts)) {
    if (!d.deleted && OLD_DEBT_TYPE[d.type]) { S.debts[d.id] = { ...d, type: OLD_DEBT_TYPE[d.type], updatedAt: now }; n++; }
  }
  return n;
}
const KIND_CLASS = { 수입: "inc", 지출: "exp", 자산이동: "mov" };
const KIND_SIGN = { 수입: "+", 지출: "-", 자산이동: "" };

// ---------------- 유틸 ----------------
const FILE_PREFIX = "가탈작가계부"; // 내려받는 파일(백업·엑셀) 이름 앞부분
const $ = (sel, root = document) => root.querySelector(sel);
const pad = (n) => String(n).padStart(2, "0");
const ym = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const todayStr = () => { const d = new Date(); return `${ym(d)}-${pad(d.getDate())}`; };
const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
/** 최신이 위로: 날짜 → 시각(없으면 맨 아래) → 등록 순 */
const txNewestFirst = (a, b) => (b.date + (b.time || "") + b.createdAt).localeCompare(a.date + (a.time || "") + a.createdAt);
const won = (n) => (globalThis.__hideAmt ? "●●●●원" : `${Math.round(n).toLocaleString("ko-KR")}원`); // 금액 가리기 중이면 ●●●●
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
const ui = { month: ym(new Date()), tab: "home", seg: "수입", day: null, openCat: null, olderOpen: null, dayMore: {}, q: "", homePart: "summary" }; // homePart: 현황 탭 안의 종합(summary) / 상세(detail) // day: 달력에서 고른 날짜, openCat: 현황(상세)에서 펼친 카테고리, olderOpen: 내역 탭 이전 내역을 펼친 달, dayMore: 더 보기를 연 날짜

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
const DEFAULT_FIXED = new Set(["주거/통신", "보험", "교육", "금융/이자"]);
const INTEREST_CAT = "금융/이자"; // 대출 이자를 기록하는 지출 카테고리
const catEtype = (c) => c.etype || (DEFAULT_FIXED.has(c.name) ? "고정" : "변동");

// 예전 기본 자산이동 카테고리: 이용자가 손대지 않았으면(만든 그대로) 정리한다.
// 모든 기기에서 같은 시각으로 지워 동기화 때 다시 살아나지 않게 한다. 이미 입력한 내역의 카테고리 이름은 그대로 남는다.
const RETIRED_CATS = { 자산이동: ["저축", "투자", "카드대금", "부채상환", "현금인출", "기타", "계좌이체", "ATM입금", "ATM출금"] };
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

/** 자산이동의 예전 카테고리 정리: 내역·자주 쓰는 내역의 카테고리를 비우고, 자산이동 카테고리·하위 카테고리는 지운다 */
function cleanMoveCategories() {
  let n = 0;
  const now = nowISO();
  for (const col of ["transactions", "favorites"]) {
    for (const t of Object.values(S[col] || {})) {
      if (!t.deleted && t.kind === "자산이동" && (t.category || t.subcategory)) { S[col][t.id] = { ...t, category: "", subcategory: "", updatedAt: now }; n++; }
    }
  }
  for (const col of ["cats", "subcats"]) {
    for (const c of Object.values(S[col] || {})) {
      if (!c.deleted && c.kind === "자산이동") { S[col][c.id] = { ...c, deleted: true, updatedAt: now }; n++; }
    }
  }
  return n;
}

/** 지출 카테고리에 고정/변동 값을 박아 둔다(예전엔 이름으로 짐작). 기본 카테고리는 처음 이름(id)으로 판단해
 *  이미 이름을 바꿔 다른 탭으로 옮겨진 것도 원래 자리로 돌린다. */
function freezeCatEtypes() {
  let n = 0;
  const now = nowISO();
  for (const c of Object.values(S.cats)) {
    if (c.deleted || c.kind !== "지출" || c.etype !== undefined) continue;
    const origName = c.id.startsWith("defcat:지출:") ? c.id.slice("defcat:지출:".length) : c.name;
    S.cats[c.id] = { ...c, etype: DEFAULT_FIXED.has(origName) ? "고정" : "변동", updatedAt: now };
    n++;
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
  for (const f of Object.values(S.favorites || {})) if (!f.deleted && f.kind === kind && f.category === from) S.favorites[f.id] = { ...f, category: to, updatedAt: now };
  const b = kind === "지출" && S.budgets?.[budgetId(from)];
  if (b && !b.deleted) {
    S.budgets[b.id] = { ...b, deleted: true, updatedAt: now };
    S.budgets[budgetId(to)] = { ...b, id: budgetId(to), category: to, updatedAt: now };
  }
}
/** 하위 카테고리 이름 바꾸기: 내역의 하위 카테고리 이름도 같이 바꾼다 */
function renameSubcat(id, to, now) {
  const s = S.subcats[id];
  for (const t of Object.values(S.transactions)) {
    if (!t.deleted && t.kind === s.kind && t.category === s.category && t.subcategory === s.name) S.transactions[t.id] = { ...t, subcategory: to, updatedAt: now };
  }
  for (const f of Object.values(S.favorites || {})) {
    if (!f.deleted && f.kind === s.kind && f.category === s.category && f.subcategory === s.name) S.favorites[f.id] = { ...f, subcategory: to, updatedAt: now };
  }
  S.subcats[id] = { ...s, name: to, updatedAt: now };
}

/**
 * 카테고리 편집 창: 구분별 카테고리 목록 → 카테고리를 누르면 이름·하위 카테고리 편집.
 * 다 끝나면 onClose()로 원래 창(내역 추가)으로 돌아간다.
 */
function openCategoryEditor({ kind: startKind = "지출", etype: startEtype = "고정", onClose = closeModal } = {}) {
  const CAT_KINDS = ["수입", "지출"]; // 자산이동은 카테고리 없이 출금 → 입금 자산으로 구분하므로 편집 대상에서 뺀다
  let kind = CAT_KINDS.includes(startKind) ? startKind : "지출";
  let etab = startEtype; // 지출일 때 보고 있는 탭: 고정 | 변동

  const drawList = () => {
    const cats = catRecords(kind);
    const panel = openModal({
      title: "카테고리 편집",
      body: `
        <div class="seg" data-role="kind">${CAT_KINDS.map((k) => `<button data-v="${k}" class="${k === kind ? "on" : ""}">${k}</button>`).join("")}</div>
        ${kind === "지출" ? `<div class="tabs sub-tabs" data-role="etab">${["고정", "변동"].map((k) => `<button data-v="${k}" class="${k === etab ? "active" : ""}">${k}지출</button>`).join("")}</div>` : ""}
        ${[kind === "지출" ? etab : null].map((et) => {
          const list = cats.filter((c) => !et || catEtype(c) === et);
          return `<section class="asset-group">
          ${list.map((c) => {
            const subs = subcatRecords(kind, c.name).map((s) => s.name);
            return `<div class="edit-item cat-item" data-id="${c.id}">
              <button class="grip" data-handle aria-label="끌어서 순서 바꾸기">${GRIP}</button>
              <button class="asset-row cat-row" data-cat="${c.id}">
                <span class="name">${esc(c.name)}</span>
                <span class="muted cat-subs">${subs.length ? esc(subs.join(", ")) : "하위 없음"}</span>
                <span class="chev">›</span>
              </button>
            </div>`;
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
    panel.querySelector("[data-close]").onclick = () => onClose(); // ✕도 원래 창(내역 추가·수정)으로
    // 끌어서 순서 바꾸기: 놓으면 지금 보이는 목록 순서대로 order를 다시 매긴다
    enableReorder(panel, async () => {
      const ids = [...panel.querySelectorAll(".cat-item")].map((el) => el.dataset.id);
      const now = nowISO();
      let changed = 0;
      ids.forEach((id, i) => {
        const c = S.cats[id];
        if (c && c.order !== i) { S.cats[id] = { ...c, order: i, updatedAt: now }; changed++; }
      });
      if (changed) { await saveState(S); scheduleSync(); }
    });
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
    $p("[data-close]").onclick = () => onClose(); // ✕는 원래 창(내역 추가·수정)으로
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
      // 고정/변동을 이름으로 짐작하던 예전 카테고리는 이름을 바꾸면 탭이 바뀌어 사라진 것처럼 보였다 → 항상 값으로 저장
      if (kind === "지출" && S.cats[catId].etype === undefined) S.cats[catId] = { ...S.cats[catId], etype: catEtype(cat), updatedAt: now };
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
/** 자산이동 경로 '출금 자산 → 입금 자산'(상환은 '출금 자산 → 부채', 대출 실행은 '부채 → 입금 자산'). 연결된 자산이 없으면 "" (이스케이프 전 글자) */
function moveRoute(t) {
  const ds = t.deltas || [];
  const out = ds.find((x) => x.col === "assets" && x.amount < 0) || ds.find((x) => x.col === "debts" && x.amount > 0);
  const into = ds.find((x) => x.col === "assets" && x.amount > 0) || ds.find((x) => x.col === "debts" && x.amount < 0);
  if (!out && !into) return "";
  const name = (x) => (x && S[x.col]?.[x.id]?.name) || "?";
  return `${name(out)} → ${name(into)}`;
}
const MOVE_NONE = "자산 미지정";
/** 부채 상환 내역을 갚은 부채별로 묶어 ['KB신용카드 대금 상환', 합계] (큰 순서) */
function repayTotals(list) {
  const by = {};
  list.forEach((t) => {
    const d = t.deltas?.find((x) => x.col === "debts");
    const label = `${S.debts[d?.id]?.name || "부채"} 대금 상환`;
    by[label] = (by[label] || 0) + txKRW(t);
  });
  return Object.entries(by).sort((a, b) => b[1] - a[1]);
}
/** 대출 실행 내역을 부채(대출) 이름별로 묶어 ['주택담보대출', 합계] (큰 순서) */
function loanTotals(list) {
  const by = {};
  list.forEach((t) => {
    const d = t.deltas?.find((x) => x.col === "debts");
    const label = S.debts[d?.id]?.name || "대출";
    by[label] = (by[label] || 0) + txKRW(t);
  });
  return Object.entries(by).sort((a, b) => b[1] - a[1]);
}
/** 자산이동 내역을 경로별로 묶어 [경로, 합계] (큰 순서) */
function routeTotals(list) {
  const by = {};
  list.forEach((t) => { const r = moveRoute(t) || MOVE_NONE; by[r] = (by[r] || 0) + txKRW(t); });
  return Object.entries(by).sort((a, b) => b[1] - a[1]);
}

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
  if (pulled && migrateBalances()) { await saveState(S); scheduleSync(); } // 예전 버전 기기에서 온 자산·부채
  if (pulled && autoRecur()) { await saveState(S); scheduleSync(); } // 다른 기기에서 켠 자동 기록
  if (pulled && !$("#modal-root").children.length) render();
  if (sync.status === "ok") await syncDrivePhotos(liveTx().flatMap((t) => t.photos || [])); // 영수증 사진은 따로
}

// ---------------- 영수증 사진 ----------------
const CAMERA = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l1.6-2.2h6.8L17 8h3v11H4z"/><circle cx="12" cy="13.3" r="3.4"/></svg>`;
const pendingPhotos = new Map(); // 저장 전(내역 창에서 막 고른) 사진 id → Blob
/** 썸네일·크게 보기에 쓸 Blob (저장 전 사진 → 기기에 저장된 사진 순) */
async function photoBlob(id) {
  return pendingPhotos.get(id) || (await getPhoto(id).catch(() => null))?.blob || null;
}
/** 사진 크게 보기: 화면 위에 덮어 띄우고, 누르면 닫힌다(내역 창은 그대로) */
async function openPhotoViewer(id) {
  const blob = await photoBlob(id);
  if (!blob) return toast("아직 이 기기에 사진이 없어요. 동기화되면 보여요.");
  const url = URL.createObjectURL(blob);
  const el = document.createElement("div");
  el.className = "photo-viewer";
  el.innerHTML = `<img src="${url}" alt="영수증 사진"><span class="pv-close">✕</span>`;
  el.onclick = () => { URL.revokeObjectURL(url); el.remove(); };
  document.body.appendChild(el);
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

// 백업 알림: 마지막 백업 파일 저장 후 BACKUP_DAYS일이 지나면(한 번도 안 했으면 바로) 위에 알림줄.
// '나중에'를 누르면 BACKUP_SNOOZE_DAYS일 뒤에 다시. 기록은 기기별(meta)이다.
const BACKUP_DAYS = 30, BACKUP_SNOOZE_DAYS = 7, DAY_MS = 86400000;
function renderBackupBar() {
  const bar = $("#backup-bar");
  const now = Date.now();
  const last = S.meta.lastBackup ? Date.parse(S.meta.lastBackup) : null;
  const snoozed = S.meta.backupSnooze && Date.parse(S.meta.backupSnooze) > now;
  const due = liveTx().length > 0 && !snoozed && (!last || now - last >= BACKUP_DAYS * DAY_MS);
  bar.hidden = !due;
  if (!due) return;
  bar.innerHTML = `
    <span>${last ? `백업한 지 ${Math.floor((now - last) / DAY_MS)}일 지났어요.` : "아직 백업한 적이 없어요."}</span>
    <span class="bb-actions"><button data-backup-later>나중에</button><button class="bb-save" data-backup-now>지금 저장</button></span>`;
  bar.querySelector("[data-backup-now]").onclick = () => exportBackup();
  bar.querySelector("[data-backup-later]").onclick = async () => {
    S.meta.backupSnooze = new Date(now + BACKUP_SNOOZE_DAYS * DAY_MS).toISOString();
    await saveState(S);
    renderBackupBar();
    toast(`${BACKUP_SNOOZE_DAYS}일 뒤에 다시 알려 드릴게요`);
  };
}

/** 지금 데이터를 json 파일로 내려받고, 마지막 백업 시각을 기록한다 */
async function exportBackup() {
  const blob = new Blob([JSON.stringify(S, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${FILE_PREFIX}_${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  S.meta.lastBackup = nowISO();
  delete S.meta.backupSnooze;
  await saveState(S);
  renderBackupBar();
  toast("백업 파일을 저장했어요");
}

/** 내역을 엑셀(.xlsx)로 내려받는다. range: "month"(보고 있는 달) | "year"(그 해) | "all" */
function exportExcel(range) {
  const [y, m] = ui.month.split("-");
  const list = liveTx()
    .filter((t) => range === "all" || t.date.startsWith(range === "year" ? `${y}-` : ui.month))
    .sort((a, b) => (a.date + (a.time || "") + a.createdAt).localeCompare(b.date + (b.time || "") + b.createdAt));
  if (!list.length) return toast("내보낼 내역이 없어요");
  const label = range === "all" ? "전체" : range === "year" ? `${y}년` : `${y}년${Number(m)}월`;
  downloadBlob(makeXlsx("내역", txSheetRows(list), TX_SHEET_WIDTHS), `${FILE_PREFIX}_${label}_${todayStr()}.xlsx`);
  toast(`엑셀 파일을 저장했어요 · ${list.length}건`);
}

/** 내역 시트 줄들 (첫 줄은 제목) */
const TX_SHEET_WIDTHS = [11, 7, 8, 9, 12, 12, 22, 16, 12, 6, 12, 24, 12, 20];
function txSheetRows(list) {
  const holdingName = (t) => {
    if (t.kind === "자산이동") return moveRoute(t);
    const d = deltaRef(t.assetDelta);
    const h = d && S[d.col]?.[d.id];
    return h ? `${t.kind === "수입" ? "입금" : d.col === "debts" ? "결제" : "출금"} ${h.name}${t.card ? ` (${t.card})` : t.transfer ? " (계좌이체)" : ""}` : "";
  };
  const rows = [["날짜", "시간", "구분", "지출 종류", "카테고리", "하위 카테고리", "내용", "거래처", "금액", "통화", "원화 금액", "입금·출금·결제", "단기 부채", "메모"]];
  for (const t of list) {
    const sd = shortDebtType(t);
    rows.push([
      t.date, t.time || "", isRepayTx(t) ? "부채상환" : isLoanTx(t) ? "대출실행" : t.kind, t.kind === "지출" ? `${t.expenseType || ""}지출` : "",
      t.category || "", t.subcategory || "", t.content || "", t.party || "",
      t.amount, t.currency || "KRW", txKRW(t), holdingName(t), sd ? SHORT_DEBT[sd].label : "", t.memo || "",
    ]);
  }
  return rows;
}

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function render() {
  renderSyncBar();
  renderBackupBar();
  const [y, m] = ui.month.split("-");
  $("#month-title").textContent = `${y}년 ${Number(m)}월`;
  document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === ui.tab));
  const view = $("#view");
  if (ui.tab === "home") view.innerHTML = homeTabs() + homeView(ui.homePart);
  else if (ui.tab === "settle") view.innerHTML = settleView();
  else if (ui.tab === "list") { view.innerHTML = listView(); bindSearch(); }
  else if (ui.tab === "calendar") view.innerHTML = calendarView();
  else view.innerHTML = monthlyView();
  view.insertAdjacentHTML("beforeend", footerHTML());
  fillVersion();
}

// ---------------- 푸터 · 설정 ----------------
// 모든 탭 맨 아래: 가끔 들어가는 관리 창 지름길 + 앱 버전
const GEAR = `<svg class="ft-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`;
function footerHTML() {
  const links = [["settings", `${GEAR}설정`], ["budget", "예산"], ["recur", "반복 내역"], ["cats", "카테고리"], ["backup", "백업/복원"]];
  return `
  <footer class="app-footer">
    <nav class="ft-links">${links.map(([k, t]) => `<button class="ft-link${k === "settings" ? " ft-main" : ""}" data-ft="${k}">${t}</button>`).join('<span class="ft-dot">·</span>')}</nav>
    <div class="ft-meta">가탈작 가계부 <span data-app-ver></span> · <a href="privacy.html">개인정보처리방침</a> · <a href="terms.html">이용약관</a></div>
  </footer>`;
}
/** 버전: 설치된 화면 파일 캐시 이름(gagyebu-vNNN)에서 읽는다 — sw.js만 올리면 자동으로 맞음 */
let appVersion = "";
function fillVersion() {
  const put = () => document.querySelectorAll("[data-app-ver]").forEach((el) => (el.textContent = appVersion));
  if (appVersion || !("caches" in window)) return put();
  caches.keys().then((keys) => {
    const v = keys.map((k) => /^gagyebu-(v\d+)$/.exec(k)?.[1]).filter(Boolean).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))[0];
    if (v) { appVersion = v; put(); }
  }).catch(() => {});
}
function openFooterLink(k) {
  if (k === "settings") return openSettingsDialog();
  if (k === "budget") return openBudgetDialog();
  if (k === "recur") return openRecurringDialog();
  if (k === "cats") return openCategoryEditor({ onClose: () => { closeModal(); render(); } });
  if (k === "backup") return openBackupDialog();
}
/** 설정: 앱 잠금 · 금액 가리기 (이 기기에만) */
function openSettingsDialog() {
  const panel = openModal({
    title: "설정",
    body: `${lockSection()}
      <p class="note" style="margin-top:18px">백업·동기화는 '백업/복원', 예산·반복 내역·카테고리는 아래 메뉴에서 바꿀 수 있어요.</p>`,
  });
  bindLockSection(panel, { reopen: openSettingsDialog, onHideChange: (on) => { globalThis.__hideAmt = on; updateEye(); render(); } });
}

/** 단기부채로 잡는 결제 수단(부채 종류)과 화면 표시 글자 */
const SHORT_DEBT = {
  신용카드: { short: "신용", title: "신용카드 사용", label: "신용카드" },
  마이너스통장: { short: "마통", title: "마이너스통장 사용", label: "마이너스통장" },
  미납금: { short: "미납", title: "미납금", label: "미납금" },
  "지인에게 빌린 돈": { short: "지인", title: "지인에게 빌린 돈", label: "지인에게 빌린 돈" },
  기타: { short: "기타부채", title: "기타", label: "기타 부채" },
};

/** 단기부채(신용카드·마이너스통장·미납금·지인에게 빌린 돈·기타)로 결제한 지출이면 그 부채 종류, 아니면 null.
 *  부채가 나중에 지워져도 기록(삭제 표시)은 남아 있어 종류로 계속 구분된다. */
function shortDebtType(t) {
  if (t.kind !== "지출" || t.interest) return null; // 이자(마통에서 자동 차감 등)는 비용이라 지출로 센다
  const d = deltaRef(t.assetDelta);
  const type = d?.col === "debts" ? debtType(S.debts[d.id]) : null;
  return SHORT_DEBT[type] ? type : null;
}
const isShortDebt = (t) => !!shortDebtType(t);

/** 부채 상환(내 자산 → 부채): 자산이동과 따로 집계한다 */
const isRepayTx = (t) => !!t.deltas?.some((x) => x.col === "debts" && x.amount < 0);
/** 대출 실행(부채 + , 받은 돈은 자산 +): 수입이 아니라 빌린 돈 */
const isLoanTx = (t) => !!t.deltas?.some((x) => x.col === "debts" && x.amount > 0);
/** 순수 자산이동(내 자산끼리) */
const isMoveTx = (t) => t.kind === "자산이동" && !isRepayTx(t) && !isLoanTx(t);

/** 금액 앞 부호: 수입 +, 지출 -, 자산이동·단기 부채(신용·마통 등)는 없음 */
const txSign = (t) => (isShortDebt(t) ? "" : KIND_SIGN[t.kind]);

/** 지출(신용카드·마이너스통장 사용 제외) */
const isPlainExpense = (t) => t.kind === "지출" && !isShortDebt(t);

/** 단기부채 종류별 합계를 한 줄씩: '<div>신용 -1,000원</div><div>마통 -2,000원</div>' (없는 종류는 생략) */
function shortDebtTotals(items) {
  return Object.keys(SHORT_DEBT).map((type) => {
    const v = sum(items.filter((t) => shortDebtType(t) === type));
    return v ? `<div><span class="cred">${SHORT_DEBT[type].short} ${won(v)}</span></div>` : "";
  }).join("");
}

/** 현황 섹션 제목 앞 아이콘 (글자색은 구분색을 따른다) */
const ICO = (paths) => `<svg class="home-ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const HOME_ICONS = {
  수입: ICO('<path d="M12 4v11"/><path d="M7.5 10.5 12 15l4.5-4.5"/><path d="M5 19h14"/>'),      // 들어오는 돈
  지출: ICO('<path d="M12 15V4"/><path d="M7.5 8.5 12 4l4.5 4.5"/><path d="M5 19h14"/>'),        // 나가는 돈
  자산이동: ICO('<path d="M4 8h14"/><path d="M14.5 4.5 18 8l-3.5 3.5"/><path d="M20 16H6"/><path d="M9.5 12.5 6 16l3.5 3.5"/>'), // 옮기기
  대출실행: ICO('<path d="M4 9.5 12 5l8 4.5"/><path d="M6 10v7M10 10v7M14 10v7M18 10v7"/><path d="M4 19.5h16"/>'), // 은행
  부채상환: ICO('<circle cx="12" cy="12" r="8.5"/><path d="M8.3 12.2l2.5 2.5 5-5"/>'), // 갚음(체크)
  단기부채: ICO('<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M7 15h4"/>'), // 카드
  반복: ICO('<path d="M4.5 11a7.5 7.5 0 0 1 13-4.5L19.5 8.5"/><path d="M19.5 4v4.5H15"/><path d="M19.5 13a7.5 7.5 0 0 1-13 4.5L4.5 15.5"/><path d="M4.5 20v-4.5H9"/>'), // 반복
  예산: ICO('<path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5H12z"/><path d="M15 3.8a8.5 8.5 0 0 1 5.2 5.2H15z"/>'), // 나눠 쓰기(원그래프)
};
const SUM_ICON = ICO('<path d="M17 5H7l6 7-6 7h10"/>'); // 합계(Σ)
const homeLabel = (key, text, cls) => `<span class="home-label"><span class="${cls}">${HOME_ICONS[key]}</span>${text}</span>`;

// ---------------- 예산 ----------------
// 지출 카테고리별 월 예산(매달 같은 금액). 신용카드·마통으로 쓴 지출도 그 카테고리 사용액에 들어간다.
// 기기마다 따로 만들어도 겹치지 않게 id는 'budget:카테고리'(전체 예산은 'budget:*').
const BUDGET_TOTAL = "*";
const budgetId = (cat) => `budget:${cat}`;
/** {카테고리: 금액} (전체 예산은 '*') */
function liveBudgets() {
  const out = {};
  for (const b of Object.values(S.budgets || {})) if (!b.deleted && b.amount > 0) out[b.category] = b.amount;
  return out;
}
const expenseCats = () => EXPENSE_TYPES.flatMap((et) => catsFor("지출", et));
const budgetBar = (spent, budget) => {
  const pct = budget ? spent / budget : 0;
  const cls = pct > 1 ? "over" : pct >= 0.8 ? "warn" : "ok";
  return { cls, pct, html: `<div class="bud-bar"><i class="${cls}" style="width:${Math.min(100, pct * 100).toFixed(1)}%"></i></div>` };
};
/** 현황: 예산 섹션 (exp: 이번 달 지출 내역 전부) */
function budgetSection(exp) {
  const B = liveBudgets();
  const catB = expenseCats().filter((c) => B[c] > 0);
  const hasTotal = B[BUDGET_TOTAL] > 0;
  const total = hasTotal ? B[BUDGET_TOTAL] : catB.reduce((a, c) => a + B[c], 0);
  const head = (right) => `<div class="card-head">${homeLabel("예산", "예산 (이번 달)", "bud")}${right}</div>`;
  if (!total) return `
  <section class="card home-sec">
    ${head("<span></span>")}
    <p class="note bud-empty">예산을 정해 두면 카테고리별로 얼마 남았는지 바로 볼 수 있어요.</p>
    <div class="bud-foot"><button class="reg-link bud-link" data-budget-edit>예산 설정하기 ›</button></div>
  </section>`;
  const spentBy = {};
  exp.forEach((t) => (spentBy[t.category] = (spentBy[t.category] || 0) + txKRW(t)));
  const spent = hasTotal ? sum(exp) : catB.reduce((a, c) => a + (spentBy[c] || 0), 0);
  const left = total - spent;
  const tb = budgetBar(spent, total);
  // 이번 달이면: 남은 날 동안 하루에 쓸 수 있는 금액
  let pace = "";
  if (ui.month === todayStr().slice(0, 7) && left > 0) {
    const now = new Date();
    const daysLeft = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate() + 1;
    pace = ` · ${daysLeft}일 남음 · 하루 ${won(Math.floor(left / daysLeft))}`;
  }
  const row = (name, sp, bud) => {
    const b = budgetBar(sp, bud);
    const l = bud - sp;
    return `
    <div class="bud-row">
      <div class="row-main"><span>${esc(name)}</span><span class="bud-num">${won(sp)} <span class="muted">/ ${won(bud)}</span></span></div>
      ${b.html}
      <div class="bud-left ${b.cls}">${l >= 0 ? `${won(l)} 남음` : `${won(-l)} 초과`} · ${Math.round(b.pct * 100)}%</div>
    </div>`;
  };
  const all = catB.map((c) => [c, spentBy[c] || 0, B[c]]).sort((a, b) => b[1] / b[2] - a[1] / a[2]);
  // 현황에는 80% 넘은(주의·초과) 카테고리만 펼치고, 나머지는 개수 한 줄 + 전체 보기
  const hot = all.filter(([, sp, bud]) => sp / bud >= 0.8);
  const calm = all.filter((e) => !hot.includes(e));
  const rows = hot.map(([c, sp, bud]) => row(c, sp, bud)).join("") + (calm.length ? `
    <button class="fold-line" data-fold="budOpen"><span>${hot.length ? `예산 안쪽 카테고리 ${calm.length}개` : `모든 카테고리 예산 안쪽 (${calm.length}개)`}</span><span class="fold-go">${ui.budOpen ? "접기 ⌃" : "전체 보기 ⌄"}</span></button>
    ${ui.budOpen ? calm.map(([c, sp, bud]) => row(c, sp, bud)).join("") : ""}` : "");
  return `
  <section class="card home-sec">
    ${head(`<span class="bud-left ${tb.cls}">${left >= 0 ? `${won(left)} 남음` : `${won(-left)} 초과`}</span>`)}
    <div class="bud-row bud-total">
      <div class="row-main"><span>${hasTotal ? "전체 지출" : "예산 잡은 카테고리"}</span><span class="bud-num">${won(spent)} <span class="muted">/ ${won(total)}</span></span></div>
      ${tb.html}
      <div class="bud-left ${tb.cls}">${Math.round(tb.pct * 100)}% 사용${pace}</div>
    </div>
    ${rows}
    <p class="note bud-note">신용카드·마이너스 통장으로 쓴 돈도 포함해요.</p>
    <div class="bud-foot"><button class="reg-link bud-link" data-budget-edit>예산 설정 ›</button></div>
  </section>`;
}

/** 예산 설정: 전체 예산(선택) + 지출 카테고리별 예산, 지난달 사용액을 참고로 보여 줌 */
function openBudgetDialog() {
  const B = liveBudgets();
  const [y, m] = ui.month.split("-").map(Number);
  const prev = ym(new Date(y, m - 2, 1));
  const lastBy = {};
  liveTx().filter((t) => t.kind === "지출" && t.date.startsWith(prev)).forEach((t) => (lastBy[t.category] = (lastBy[t.category] || 0) + txKRW(t)));
  const input = (key) => `<div class="amount-wrap bud-in"><input class="input amount-input" data-bud="${esc(key)}" inputmode="numeric" autocomplete="off" placeholder="0" value="${B[key] ? fmtAmount(B[key]) : ""}"><span class="amount-unit">원</span></div>`;
  const group = (et) => {
    const cats = catsFor("지출", et);
    if (!cats.length) return "";
    return `<div class="section-title">${et}지출</div>
      ${cats.map((c) => `<div class="bud-edit-row"><div class="bud-edit-name"><span>${esc(c)}</span>${lastBy[c] ? `<span class="muted">지난달 ${won(lastBy[c])}</span>` : ""}</div>${input(c)}</div>`).join("")}`;
  };
  const panel = openModal({
    title: "예산 설정",
    body: `
      <p class="note">매달 같은 금액으로 적용돼요. 비워 두면 그 카테고리는 예산 없음. 신용카드·마이너스 통장으로 쓴 돈도 사용액에 들어가요.</p>
      <div class="field"><label>전체 예산 <span class="muted">(선택)</span></label>${input(BUDGET_TOTAL)}
        <p class="note" style="margin-top:6px" data-bud-sum></p></div>
      ${EXPENSE_TYPES.map(group).join("")}
      <div class="btn-row"><button class="btn" data-cancel>취소</button><button class="btn primary" data-save>저장</button></div>`,
  });
  const ins = [...panel.querySelectorAll("[data-bud]")];
  const showSum = () => {
    const catSum = ins.filter((i) => i.dataset.bud !== BUDGET_TOTAL).reduce((a, i) => a + parseAmount(i.value), 0);
    panel.querySelector("[data-bud-sum]").textContent = catSum
      ? `카테고리 예산 합계 ${won(catSum)} · 전체 예산을 비우면 이 합계가 전체 예산이 돼요.`
      : "전체 예산만 정해도 돼요. 카테고리별로 나누면 어디서 많이 쓰는지 보여요.";
  };
  ins.forEach((i) => { bindAmount(i); i.addEventListener("input", showSum); });
  showSum();
  panel.querySelector("[data-cancel]").onclick = closeModal;
  panel.querySelector("[data-save]").onclick = async () => {
    const now = nowISO();
    S.budgets ||= {};
    for (const i of ins) {
      const cat = i.dataset.bud, id = budgetId(cat), v = parseAmount(i.value);
      const cur = S.budgets[id];
      if (v > 0 && (!cur || cur.deleted || cur.amount !== v)) S.budgets[id] = { id, category: cat, amount: v, createdAt: cur?.createdAt || now, updatedAt: now, deleted: false };
      else if (!(v > 0) && cur && !cur.deleted) S.budgets[id] = { ...cur, deleted: true, updatedAt: now };
    }
    closeModal();
    await commit();
    toast("예산을 저장했어요");
  };
}

// ---------------- 반복 내역 ----------------
// 매달 같은 날 생기는 내역을 등록해 두고(기록된 내역에서 '반복 내역으로 등록'), 그달 상태를 보여 준다.
// 기록하면 내역에 recurId·recurMonth가 붙어 그달은 '기록됨'. 건너뛴 달은 skips. 상태는 내역에서 계산한다.
// 자동 기록(금액 고정 + 원화만)은 앱을 열 때 날짜가 지난 달을 'recur:템플릿:월' id로 만든다(기기끼리 겹치지 않음).
const liveRecurs = () => Object.values(S.recurring || {}).filter((r) => !r.deleted)
  .sort((a, b) => a.day - b.day || a.createdAt.localeCompare(b.createdAt));
const monthLast = (month) => { const [y, m] = month.split("-").map(Number); return new Date(y, m, 0).getDate(); };
const recurDate = (r, month) => `${month}-${pad(Math.min(r.day, monthLast(month)))}`;
const recurTx = (r, month) => liveTx().find((t) => t.recurId === r.id && t.recurMonth === month);
function recurName(r) {
  if (r.nature === "repay") return `${S.debts[parseLinkKey(r.repay?.debt)?.id]?.name || "부채"} 상환`;
  return r.fields?.content || "반복 내역";
}
function recurStatus(r, month) {
  if (recurTx(r, month)) return "done";
  if ((r.skips || []).includes(month)) return "skip";
  return recurDate(r, month) <= todayStr() ? "due" : "plan";
}
/** 금액이 달라지는 항목: 가장 최근에 기록한 금액 */
function recurLastAmount(r) {
  const last = liveTx().filter((t) => t.recurId === r.id).sort((a, b) => b.recurMonth.localeCompare(a.recurMonth))[0];
  return last ? last.amount : r.amount;
}
const recurItem = (r) => PICK_ITEMS.find((it) => it.key === r.nature) || PICK_ITEMS[1];
function recurVia(r) {
  const key = r.nature === "repay" ? r.repay?.asset : r.nature === "move" ? r.fields?.fromAsset : r.fields?.link;
  const ref = key && parseLinkKey(key);
  const h = ref && S[ref.col]?.[ref.id];
  return h && !h.deleted ? h.name : "";
}

/** 현황: 이번 달 반복 내역 */
function recurringSection() {
  const all = liveRecurs();
  const head = (right) => `<div class="card-head">${homeLabel("반복", "반복 내역 (이번 달)", "rec")}${right}</div>`;
  if (!all.length) return `
  <section class="card home-sec">
    ${head("<span></span>")}
    <p class="note bud-empty">월세·구독료·공과금처럼 매달 생기는 내역을 등록해 두면 날짜에 맞춰 챙겨 드려요. 기록된 내역을 열고 '반복 내역으로 등록'을 누르세요.</p>
  </section>`;
  const list = all.filter((r) => (r.startMonth || "") <= ui.month);
  if (!list.length) return "";
  const today = todayStr();
  const st = list.map((r) => [r, recurStatus(r, ui.month)]);
  const done = st.filter(([, x]) => x === "done").length;
  const rowOf = ([r, x]) => {
    const date = recurDate(r, ui.month);
    const it = recurItem(r);
    const tx = x === "done" ? recurTx(r, ui.month) : null;
    const late = x === "due" ? Math.round((new Date(today) - new Date(date)) / 86400000) : 0;
    // 미납으로 기록한 달: 기록은 됐지만 갚아야 함
    const unpaid = tx && tx.assetDelta?.col === "debts" && debtType(S.debts[tx.assetDelta.id]) === "미납금";
    const mark = unpaid ? "!" : { done: "✓", skip: "–", due: "!", plan: "○" }[x];
    const state = unpaid ? "미납 · 상환 필요" : x === "done" ? `${Number(tx.date.slice(8))}일 기록` : x === "skip" ? "이번 달 건너뜀" : x === "due" ? (late ? `${late}일 지남` : "오늘") : "예정";
    const amount = x === "done" ? won(txKRW(tx)) : r.variable ? `<span class="muted">금액 확인</span>` : won(r.amount);
    const via = recurVia(r);
    return `
    <button class="rc-row ${x}${unpaid ? " unpaid" : ""}" data-recur="${r.id}">
      <span class="rc-mark">${mark}</span>
      <span class="rc-text"><span class="rc-name">${esc(recurName(r))}</span>
        <span class="rc-sub">매달 ${r.day >= 31 ? "말일" : `${r.day}일`} · <span class="${it.cls}">${it.name}</span>${via ? ` · ${esc(via)}` : ""}</span></span>
      <span class="rc-right"><span class="rc-amt">${amount}</span><span class="rc-state">${state}</span></span>
    </button>`;
  };
  // 현황에는 처리할 것(날짜 지남·미납)만 펼치고, 나머지는 개수 한 줄 + 전체 보기
  const isUnpaid = ([r, x]) => { const tx = x === "done" && recurTx(r, ui.month); return tx && tx.assetDelta?.col === "debts" && debtType(S.debts[tx.assetDelta.id]) === "미납금"; };
  const urgent = st.filter((e) => e[1] === "due" || isUnpaid(e));
  const rest = st.filter((e) => !urgent.includes(e));
  const cnt = (k) => rest.filter(([, x]) => x === k).length;
  const next = st.find(([, x]) => x === "plan");
  const summary = urgent.length
    ? [`✓ 기록 ${cnt("done")}`, `○ 예정 ${cnt("plan")}`, cnt("skip") ? `– 건너뜀 ${cnt("skip")}` : ""].filter(Boolean).join(" · ")
    : next ? `이번 달 할 일 없음 · 다음: ${esc(recurName(next[0]))} ${Math.min(next[0].day, monthLast(ui.month))}일${next[0].variable ? "" : ` ${won(next[0].amount)}`}`
    : "이번 달 모두 처리했어요";
  const open = ui.recurOpen;
  const rows = urgent.map(rowOf).join("") + (rest.length ? `
    <button class="fold-line" data-fold="recurOpen"><span>${summary}</span><span class="fold-go">${open ? "접기 ⌃" : "전체 보기 ⌄"}</span></button>
    ${open ? rest.map(rowOf).join("") : ""}` : "");
  return `
  <section class="card home-sec">
    ${head(`<span class="rec">${done}/${list.length} 기록</span>`)}
    ${rows}
    <div class="bud-foot"><button class="reg-link rec-link" data-recur-manage>반복 내역 관리 ›</button></div>
  </section>`;
}

/** 반복 내역 하나 누르기: 기록됨 → 그 내역, 아니면 기록·미납·건너뛰기 고르기 */
function openRecurAction(id) {
  const r = S.recurring[id];
  const month = ui.month;
  const x = recurStatus(r, month);
  if (x === "done") return openTxDialog(recurTx(r, month));
  const date = recurDate(r, month);
  const expense = r.nature === "fixed" || r.nature === "var";
  const amt = r.variable ? recurLastAmount(r) : r.amount;
  const panel = openModal({
    title: recurName(r),
    body: `
      <p class="rc-info">${Number(month.slice(5))}월분 · 예정일 ${Number(date.slice(5, 7))}월 ${Number(date.slice(8))}일<br>
        ${r.variable ? `지난번 ${won(amt)} · 금액이 매달 달라서 기록할 때 확인해요` : `${won(amt)}`}</p>
      ${x === "skip" ? `
      <div class="rc-acts"><button class="btn primary" data-ra="unskip">건너뛰기 취소</button></div>` : `
      <div class="rc-acts">
        <button class="btn primary" data-ra="record">기록하기</button>
        ${expense ? `<button class="btn" data-ra="unpaid">미납으로 기록 <span class="muted">(아직 못 냄 · 나중에 부채 상환)</span></button>` : ""}
        <button class="btn" data-ra="skip">이번 달 건너뛰기</button>
        <button class="btn" data-ra="later">나중에</button>
      </div>`}`,
  });
  const act = async (a) => {
    if (a === "later") return closeModal();
    if (a === "skip" || a === "unskip") {
      const skips = (r.skips || []).filter((m) => m !== month);
      S.recurring[r.id] = { ...r, skips: a === "skip" ? [...skips, month] : skips, updatedAt: nowISO() };
      closeModal();
      await commit();
      const nm = recurName(r);
      const obj = (nm.charCodeAt(nm.length - 1) - 0xac00) % 28 > 0 ? "을" : "를"; // 받침 있으면 '을'
      return toast(a === "skip" ? `${Number(month.slice(5))}월 ${nm}${obj} 건너뛰었어요` : "건너뛰기를 취소했어요");
    }
    // 기록: 날짜가 지났으면 오늘(이번 달일 때), 아니면 예정일
    const recDate = month === todayStr().slice(0, 7) && date <= todayStr() ? todayStr() : date;
    if (r.nature === "repay") {
      return openRepayDialog({
        presetDebt: parseLinkKey(r.repay?.debt)?.id || "",
        preset: { amount: amt, date: recDate, time: nowTime(), memo: r.repay?.memo || "", asset: liveLink(r.repay?.asset), recur: { id: r.id, month } },
        onDone: () => { closeModal(); render(); },
      });
    }
    const d = applyFav(newTxDraft(recDate), r.fields);
    Object.assign(d, { amount: amt, time: nowTime(), debtMode: r.fields.debtMode || "", pay: r.fields.pay || "", recurId: r.id, recurMonth: month });
    if (a === "unpaid") {
      // 미납: 그날 내야 했던 돈을 '미납금' 부채로 잡아 두고, 나중에 내면 부채 상환
      let debt = Object.values(S.debts).find((x) => !x.deleted && debtType(x) === "미납금");
      if (!debt) {
        const now = nowISO();
        debt = { id: uid(), type: "미납금", name: "미납금", currency: "KRW", amount: 0, base: 0, order: 10000, createdAt: now, updatedAt: now, deleted: false };
        S.debts[debt.id] = debt;
        await saveState(S);
      }
      Object.assign(d, { date, link: linkKey("debts", debt.id), debtMode: "", pay: "", memo: `${d.memo ? `${d.memo} · ` : ""}미납` });
    }
    openTxDialog(null, null, d);
  };
  panel.querySelectorAll("[data-ra]").forEach((b) => (b.onclick = () => act(b.dataset.ra)));
}

/** 기록된 내역 → 반복 내역 등록 (그 내역의 달은 '기록됨') */
async function registerRecurring(tx, src) {
  const now = nowISO();
  const nature = src.nature;
  if (liveRecurs().some((r) => r.nature === nature && recurName(r) === (nature === "repay" ? `${S.debts[parseLinkKey(src.repay.debt)?.id]?.name || "부채"} 상환` : src.fields.content)))
    return toast("이미 같은 반복 내역이 있어요."), false;
  const id = uid();
  const month = tx.date.slice(0, 7);
  S.recurring ||= {};
  S.recurring[id] = {
    id, nature, day: Number(tx.date.slice(8)), amount: src.amount, currency: src.currency || "KRW",
    variable: nature === "repay", auto: false, startMonth: month, skips: [],
    ...(src.fields ? { fields: src.fields } : {}), ...(src.repay ? { repay: src.repay } : {}),
    createdAt: now, updatedAt: now, deleted: false,
  };
  const cur = S.transactions[tx.id];
  if (cur) S.transactions[tx.id] = { ...cur, recurId: id, recurMonth: month, updatedAt: now };
  await saveState(S);
  scheduleSync();
  toast(`반복 내역으로 등록했어요 · 매달 ${Number(tx.date.slice(8))}일`);
  return { id, month };
}

/** 반복 내역 관리: 날짜·금액·금액 달라짐·자동 기록, 삭제 */
function openRecurringDialog() {
  const rows = liveRecurs().map((r) => ({ ...r, del: false }));
  const draw = () => {
    const panel = openModal({
      title: "반복 내역 관리",
      body: `
        <p class="note">기록된 내역을 열고 '반복 내역으로 등록'을 누르면 여기에 추가돼요. 내용·카테고리를 바꾸려면 삭제하고 다시 등록하세요.</p>
        ${rows.length ? rows.map((r, i) => {
          const it = recurItem(r);
          const canAuto = !r.variable && r.nature !== "repay" && (r.currency || "KRW") === "KRW";
          return `
          <div class="rc-edit${r.del ? " del" : ""}" data-i="${i}">
            <div class="rc-edit-top"><span class="rc-name">${esc(recurName(r))}</span><span class="${it.cls} rc-nat">${it.name}</span>
              <button class="edit-del" data-rdel>${r.del ? "되돌리기" : "삭제"}</button></div>
            <div class="rc-edit-line">매달
              <select class="input sm rc-day" name="day" ${r.del ? "disabled" : ""}>${Array.from({ length: 31 }, (_, k) => k + 1).map((dd) => `<option value="${dd}" ${dd === r.day ? "selected" : ""}>${dd === 31 ? "말일" : `${dd}일`}</option>`).join("")}</select>
              <div class="amount-wrap rc-amt-in"><input class="input sm amount-input" name="amount" inputmode="numeric" value="${fmtAmount(r.amount)}" ${r.del ? "disabled" : ""}><span class="amount-unit">원</span></div></div>
            <label class="check-line"><input type="checkbox" name="variable" ${r.variable ? "checked" : ""} ${r.del ? "disabled" : ""}> 금액이 매달 달라요 (기록할 때 금액 확인)</label>
            <label class="check-line ${canAuto ? "" : "off"}"><input type="checkbox" name="auto" ${r.auto && canAuto ? "checked" : ""} ${canAuto && !r.del ? "" : "disabled"}> 날짜가 되면 자동 기록 <span class="muted">(자동이체처럼 꼭 빠져나가는 것만)</span></label>
          </div>`;
        }).join("") : `<div class="empty">등록된 반복 내역이 없어요.</div>`}
        <div class="btn-row"><button class="btn" data-cancel>취소</button><button class="btn primary" data-save>저장</button></div>`,
    });
    const read = () => panel.querySelectorAll("[data-i]").forEach((el) => {
      const r = rows[el.dataset.i];
      if (r.del) return;
      r.day = Number(el.querySelector("[name=day]").value);
      r.amount = parseAmount(el.querySelector("[name=amount]").value);
      r.variable = el.querySelector("[name=variable]").checked;
      r.auto = el.querySelector("[name=auto]").checked && !r.variable;
    });
    panel.querySelectorAll("[name=amount]").forEach(bindAmount);
    panel.querySelectorAll("[name=variable]").forEach((c) => (c.onchange = () => { read(); draw(); }));
    panel.querySelectorAll("[data-rdel]").forEach((b) => (b.onclick = () => { read(); const r = rows[b.closest("[data-i]").dataset.i]; r.del = !r.del; draw(); }));
    panel.querySelector("[data-cancel]").onclick = closeModal;
    panel.querySelector("[data-save]").onclick = async () => {
      read();
      const now = nowISO();
      for (const r of rows) {
        const cur = S.recurring[r.id];
        if (r.del) { S.recurring[r.id] = { ...cur, deleted: true, updatedAt: now }; continue; }
        if (cur.day !== r.day || cur.amount !== r.amount || !!cur.variable !== r.variable || !!cur.auto !== r.auto)
          S.recurring[r.id] = { ...cur, day: r.day, amount: r.amount, variable: r.variable, auto: r.auto, updatedAt: now };
      }
      closeModal();
      const n = autoRecur();
      await commit();
      toast(`반복 내역을 저장했어요${n ? ` · ${n}건 자동 기록` : ""}`);
    };
  };
  draw();
}

/** 자동 기록 켠 반복 내역: 날짜가 지난 달을 내역으로 만든다. 만든 개수를 돌려준다. */
function autoRecur() {
  let n = 0;
  const today = todayStr();
  const thisMonth = today.slice(0, 7);
  for (const r of liveRecurs()) {
    if (!r.auto || r.variable || r.nature === "repay" || (r.currency || "KRW") !== "KRW" || !r.amount) continue;
    let month = r.startMonth;
    for (let guard = 0; month <= thisMonth && guard < 60; guard++) {
      const id = `recur:${r.id}:${month}`;
      const date = recurDate(r, month);
      if (date <= today && !S.transactions[id] && !recurTx(r, month) && !(r.skips || []).includes(month)) {
        const rec = buildRecurTx(r, month, id, date);
        if (rec) { S.transactions[id] = rec; n++; }
      }
      const [y, m] = month.split("-").map(Number);
      month = ym(new Date(y, m, 1));
    }
  }
  return n;
}
function buildRecurTx(r, month, id, date) {
  const f = r.fields || {};
  const now = nowISO();
  const rec = {
    id, date, time: "", kind: f.kind, expenseType: f.kind === "지출" ? f.expenseType || "고정" : "",
    category: f.kind === "자산이동" ? "" : f.category || "", subcategory: f.kind === "자산이동" ? "" : f.subcategory || "",
    currency: "KRW", amount: r.amount, content: f.content || "", party: f.party || "", memo: f.memo || "",
    recurId: r.id, recurMonth: month, createdAt: now, updatedAt: now, deleted: false,
  };
  const holding = (key) => { const ref = key && parseLinkKey(key); const h = ref && S[ref.col]?.[ref.id]; return h && !h.deleted && curOf(h) === "KRW" ? [ref, h] : null; };
  if (f.kind === "자산이동") {
    const a = holding(f.fromAsset), b = holding(f.toAsset);
    if (!a || !b) return null;
    rec.deltas = [{ col: "assets", id: a[1].id, amount: -r.amount }, { col: "assets", id: b[1].id, amount: r.amount }];
    return rec;
  }
  const h = holding(f.link);
  if (!h) return null;
  rec.assetDelta = { col: h[0].col, id: h[1].id, amount: linkSign(f.kind, h[0].col) * r.amount };
  if (f.kind === "지출" && h[0].col === "assets" && h[1].type === "은행") {
    if (f.pay === "card" && h[1].card) rec.card = h[1].card;
    else if (f.pay === "transfer") rec.transfer = true;
  }
  return rec;
}

// ---------------- 신용카드 결제일·할부 ----------------
// 카드(부채)에 payDay(결제일), closeDay(사용 기간 마감일, 31=말일), closeMonth("prev" 전월 | "this" 당월)를 둔다.
// M월 결제분 = (마감달 직전 마감일 다음 날) ~ (마감달 closeDay). 마감달 = 당월이면 M, 전월이면 M-1.
// 할부(t.inst=N개월)는 산 날이 속한 결제분부터 N번 나눠 청구(무이자로 계산, 나머지는 마지막 회차).
const dayIn = (month, day) => `${month}-${pad(Math.min(day, monthLast(month)))}`;
const addDays = (date, n) => { const d = new Date(`${date}T00:00:00`); d.setDate(d.getDate() + n); return `${ym(d)}-${pad(d.getDate())}`; };
const monthDiff = (a, b) => { const [ay, am] = a.split("-").map(Number), [by, bm] = b.split("-").map(Number); return (by - ay) * 12 + (bm - am); };
const hasBilling = (d) => d && d.payDay > 0 && d.closeDay > 0;
function cardCycle(d, payMonth) {
  const closeM = d.closeMonth === "this" ? payMonth : shiftMonth(payMonth, -1);
  const end = dayIn(closeM, d.closeDay);
  const start = addDays(dayIn(shiftMonth(closeM, -1), d.closeDay), 1);
  return { start, end, payDate: dayIn(payMonth, d.payDay), payMonth };
}
/** 그 날짜에 쓴 돈이 청구되는 결제 달 */
function payMonthOf(d, date) {
  const m = date.slice(0, 7);
  const closeM = date <= dayIn(m, d.closeDay) ? m : shiftMonth(m, 1);
  return d.closeMonth === "this" ? closeM : shiftMonth(closeM, 1);
}
const cardUses = (d) => liveTx().filter((t) => t.kind === "지출" && !t.interest && t.assetDelta?.col === "debts" && t.assetDelta.id === d.id);
const instPortion = (amt, n, k) => (k === n - 1 ? amt - Math.floor(amt / n) * (n - 1) : Math.floor(amt / n));
/** payMonth 결제분: 기간·청구 금액·항목(할부는 그 회차 금액) */
function cardBill(d, payMonth) {
  const cyc = cardCycle(d, payMonth);
  const items = [];
  for (const t of cardUses(d)) {
    const n = t.inst > 1 ? t.inst : 1;
    const k = monthDiff(payMonthOf(d, t.date), payMonth);
    if (k < 0 || k >= n) continue;
    items.push({ t, n, k, amount: instPortion(Math.round(txKRW(t)), n, k) });
  }
  items.sort((a, b) => a.t.date.localeCompare(b.t.date));
  // 결제분 마감 뒤 ~ 결제일 뒤 10일 사이에 이 카드를 갚은 금액(상환 완료 표시용)
  const paid = liveTx().filter(isRepayTx).filter((t) => t.date > cyc.end && t.date <= addDays(cyc.payDate, 10))
    .reduce((a, t) => a + (t.deltas || []).filter((x) => x.col === "debts" && x.id === d.id).reduce((b, x) => b - x.amount, 0), 0);
  return { ...cyc, items, total: items.reduce((a, x) => a + x.amount, 0), paid };
}
/** 다음 결제 달: 이번 달 결제일이 안 지났으면 이번 달, 지났으면 다음 달 */
const nextPayMonth = (d) => { const m = todayStr().slice(0, 7); return todayStr() <= dayIn(m, d.payDay) ? m : shiftMonth(m, 1); };
/** 진행 중인 할부: 다음 결제분부터 남은 회차·금액 */
function activeInstallments(d) {
  const pm = nextPayMonth(d);
  return cardUses(d).filter((t) => t.inst > 1).map((t) => {
    const n = t.inst, amt = Math.round(txKRW(t)), k = monthDiff(payMonthOf(d, t.date), pm);
    if (k >= n) return null;
    const from = Math.max(k, 0);
    let left = 0;
    for (let i = from; i < n; i++) left += instPortion(amt, n, i);
    return { t, n, next: from + 1, left, monthly: instPortion(amt, n, from) };
  }).filter(Boolean);
}
const md = (date) => `${Number(date.slice(5, 7))}/${Number(date.slice(8))}`;
const dday = (date) => { const n = Math.round((new Date(`${date}T00:00:00`) - new Date(`${todayStr()}T00:00:00`)) / 86400000); return n === 0 ? "오늘" : n > 0 ? `D-${n}` : `${-n}일 지남`; };

/** 현황: 카드 결제 예정 (신용카드가 있을 때만) */
function cardBillSection() {
  const cards = Object.values(S.debts).filter((d) => !d.deleted && debtType(d) === "신용카드");
  if (!cards.length) return "";
  const rows = cards.map((d) => {
    if (!hasBilling(d)) return `
    <button class="rc-row cb-row" data-card="${d.id}">
      <span class="rc-text"><span class="rc-name">${esc(d.name)}</span><span class="rc-sub">결제일·사용 기간을 정하면 청구 예정 금액을 미리 알려 드려요</span></span>
      <span class="rc-right"><span class="cb-set">결제일 설정 ›</span></span>
    </button>`;
    const b = cardBill(d, nextPayMonth(d));
    const done = b.total > 0 && b.paid >= b.total;
    const inst = activeInstallments(d).length;
    return `
    <button class="rc-row cb-row" data-card="${d.id}">
      <span class="rc-text"><span class="rc-name">${esc(d.name)}</span>
        <span class="rc-sub">${md(b.payDate)} 결제 · 사용 ${md(b.start)}~${md(b.end)}${inst ? ` · 할부 ${inst}건` : ""}</span></span>
      <span class="rc-right"><span class="rc-amt">${won(b.total)}</span><span class="rc-state ${done ? "cb-done" : ""}">${done ? "상환 완료" : dday(b.payDate)}</span></span>
    </button>`;
  }).join("");
  return `
  <section class="card home-sec">
    <div class="card-head">${homeLabel("단기부채", "카드 결제 예정", "cred")}<span></span></div>
    ${rows}
  </section>`;
}

/** 카드 결제일 설정 + 청구 예정 내역 + 할부 */
function openCardDialog(id) {
  const d = S.debts[id];
  const form = { payDay: d.payDay || 25, closeDay: d.closeDay || 31, closeMonth: d.closeMonth || "prev" };
  const draw = () => {
    const cfg = { ...d, ...form };
    const pm = hasBilling(d) ? nextPayMonth(d) : null;
    const b = pm && cardBill(d, pm);
    const after = pm && cardBill(d, shiftMonth(pm, 1));
    const insts = hasBilling(d) ? activeInstallments(d) : [];
    const ex = cardCycle(cfg, todayStr().slice(0, 7)); // 설정 미리보기
    const dayOpt = (sel, last) => Array.from({ length: 31 }, (_, i) => i + 1).map((n) => `<option value="${n}" ${n === sel ? "selected" : ""}>${n === 31 && last ? "말일" : `${n}일`}</option>`).join("");
    const itemRow = (x) => `<div class="row-sub"><span>${md(x.t.date)} ${esc(x.t.content || x.t.category)}${x.n > 1 ? ` <span class="muted">할부 ${x.k + 1}/${x.n}</span>` : ""}</span><span>${won(x.amount)}</span></div>`;
    const panel = openModal({
      cls: "theme-debts",
      title: d.name,
      body: `
        ${b ? `
        <div class="cb-head">
          <div class="row-main"><span>${Number(b.payDate.slice(5, 7))}월 ${Number(b.payDate.slice(8))}일 청구 예정 <span class="muted">${dday(b.payDate)}</span></span><span class="cred">${won(b.total)}</span></div>
          <div class="cb-period">사용 기간 ${md(b.start)} ~ ${md(b.end)}${b.paid > 0 ? ` · 상환 ${won(b.paid)}${b.paid >= b.total && b.total ? " (완료)" : ""}` : ""}</div>
          ${b.items.length ? b.items.map(itemRow).join("") : `<div class="row-sub"><span>이 기간 사용 내역이 없어요</span><span></span></div>`}
          ${b.total > b.paid ? `<button class="btn primary cb-pay" data-cb-pay>${won(b.total - b.paid)} 대금 상환 기록하기</button>` : ""}
        </div>
        <div class="cb-head">
          <div class="row-main"><span>다음 결제분 <span class="muted">지금까지</span></span><span>${won(after.total)}</span></div>
          <div class="cb-period">${Number(after.payDate.slice(5, 7))}월 ${Number(after.payDate.slice(8))}일 결제 · 사용 기간 ${md(after.start)} ~ ${md(after.end)}</div>
        </div>
        ${insts.length ? `<div class="section-title">진행 중인 할부</div>
          ${insts.map((x) => `<div class="row-sub cb-inst"><span>${esc(x.t.content || x.t.category)} <span class="muted">${x.next}/${x.n}회차 · 월 ${won(x.monthly)}</span></span><span>남은 ${won(x.left)}</span></div>`).join("")}` : ""}
        <p class="note">할부는 무이자 기준으로 나눠 계산해요. 실제 청구 금액은 카드사 명세서와 조금 다를 수 있어요.</p>` : `
        <p class="note">결제일과 사용 기간을 정하면 '이번 달 얼마가 청구될지'와 할부 남은 회차를 보여 드려요. 카드사 앱이나 명세서에서 확인할 수 있어요.</p>`}
        <div class="section-title">결제일 · 사용 기간</div>
        <div class="field"><label>결제일</label><select class="input" name="payDay">${dayOpt(form.payDay, false)}</select></div>
        <div class="field"><label>사용 기간 마감</label>
          <div class="money-line">
            <select class="input half" name="closeMonth"><option value="prev" ${form.closeMonth === "prev" ? "selected" : ""}>결제일 전월</option><option value="this" ${form.closeMonth === "this" ? "selected" : ""}>결제일 당월</option></select>
            <select class="input half" name="closeDay">${dayOpt(form.closeDay, true)}</select>
          </div>
          <p class="note" style="margin-top:6px">예: ${Number(ex.payDate.slice(5, 7))}월 ${Number(ex.payDate.slice(8))}일 결제분 = <span class="cred">${Number(ex.start.slice(5, 7))}월 ${Number(ex.start.slice(8))}일 ~ ${Number(ex.end.slice(5, 7))}월 ${Number(ex.end.slice(8))}일</span> 사용</p>
          <p class="note">많이 쓰는 예: 결제일 14일 → 전월 말일 마감(전월 1일~말일) / 결제일 25일 → 당월 11일 마감(전월 12일~당월 11일)</p>
        </div>
        <div class="btn-row"><button class="btn" data-cancel>닫기</button><button class="btn primary" data-save>설정 저장</button></div>`,
    });
    const q = (sel) => panel.querySelector(sel);
    const read = () => { form.payDay = Number(q("[name=payDay]").value); form.closeDay = Number(q("[name=closeDay]").value); form.closeMonth = q("[name=closeMonth]").value; };
    ["payDay", "closeDay", "closeMonth"].forEach((n) => (q(`[name=${n}]`).onchange = () => { read(); draw(); }));
    q("[data-cancel]").onclick = closeModal;
    q("[data-save]").onclick = async () => {
      read();
      S.debts[id] = { ...S.debts[id], ...form, updatedAt: nowISO() };
      Object.assign(d, form);
      await commit();
      toast(`${d.name} 결제일을 저장했어요`);
      draw();
    };
    q("[data-cb-pay]")?.addEventListener("click", () => openRepayDialog({
      presetDebt: id,
      preset: { amount: b.total - b.paid, date: todayStr(), time: nowTime(), memo: `${Number(b.payDate.slice(5, 7))}월 카드 대금` },
      onDone: () => { closeModal(); render(); },
    }));
  };
  draw();
}

/** 현황 탭 안의 작은 탭: 현황(종합) / 현황(상세) */
function homeTabs() {
  return `<div class="tabs sub-tabs home-parts">${[["summary", "현황(종합)"], ["detail", "현황(상세)"]]
    .map(([k, label]) => `<button data-home-part="${k}" class="${ui.homePart === k ? "active" : ""}">${label}</button>`).join("")}</div>`;
}

// ---------------- 결산 (이번 달) ----------------
/** 한 달 숫자 모으기 */
function monthFigures(list) {
  const exp = list.filter((t) => t.kind === "지출");
  const plain = exp.filter(isPlainExpense);
  return {
    inc: sum(list.filter((t) => t.kind === "수입")),
    exp: sum(plain),
    fixed: sum(plain.filter((t) => t.expenseType === "고정")),
    variable: sum(plain.filter((t) => t.expenseType !== "고정")),
    debtUse: sum(exp.filter(isShortDebt)),
    repay: sum(list.filter(isRepayTx)),
  };
}
const signedWon = (v) => (v > 0 ? "+" : v < 0 ? "-" : "") + won(Math.abs(v));

/** 고른 달 결산 숫자 (화면·엑셀 공용) */
function settleData() {
  const m = Number(ui.month.slice(5));
  const tx = monthTx();
  const cur = monthFigures(tx);
  const prevKey = shiftMonth(ui.month, -1);
  const prevTx = liveTx().filter((t) => t.date.startsWith(prevKey));
  const prev = monthFigures(prevTx);
  const left = cur.inc - cur.exp;
  const rate = cur.inc ? Math.round((left / cur.inc) * 100) : null;

  // 많이 쓴 카테고리: 카드·마통으로 쓴 돈도 그 카테고리 지출로 포함
  const byCat = {};
  tx.filter((t) => t.kind === "지출").forEach((t) => (byCat[t.category || "미분류"] = (byCat[t.category || "미분류"] || 0) + txKRW(t)));
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const catTotal = cats.reduce((n, [, v]) => n + v, 0);

  // 자산·부채 변화: 이번 달 내역이 자산·부채에 준 변화(원화 환산)
  let assetChg = 0, debtChg = 0;
  for (const t of tx) {
    const ds = [deltaRef(t.assetDelta), ...(t.deltas || [])].filter(Boolean);
    for (const d of ds) {
      const h = S[d.col]?.[d.id];
      const v = h ? toKRW(d.amount, curOf(h)) ?? 0 : 0;
      if (d.col === "debts") debtChg += v; else assetChg += v;
    }
  }
  const netChg = assetChg - debtChg;
  return { m, tx, cur, prevKey, prevTx, prev, left, rate, cats, catTotal, assetChg, debtChg, netChg };
}

// ---------------- 순자산 ----------------
// 자산·부채 잔액 = 시작 잔액(base) + 내역 변화이므로, 날짜까지의 내역만 더하면 그때의 잔액이 된다.
// (외화는 지금 환율, 지운 항목은 뺌, 앱 쓰기 전 기간은 시작 잔액 그대로)
const monthEnd = (month) => `${month}-${pad(monthLast(month))}`;
function holdingsAt(endDate) {
  const sums = new Map();
  for (const t of liveTx()) {
    if (endDate && t.date > endDate) continue;
    for (const d of [deltaRef(t.assetDelta), ...(t.deltas || [])].filter(Boolean)) sums.set(`${d.col}:${d.id}`, (sums.get(`${d.col}:${d.id}`) || 0) + d.amount);
  }
  const out = { assets: {}, debts: {}, asset: 0, debt: 0 };
  for (const col of ["assets", "debts"]) {
    for (const a of Object.values(S[col])) {
      if (a.deleted) continue;
      const bal = a.base === undefined ? a.amount || 0 : a.base + (sums.get(`${col}:${a.id}`) || 0);
      const v = toKRW(roundFor(bal, curOf(a)), curOf(a)) ?? 0;
      const type = col === "debts" ? debtType(a) : a.type;
      out[col][type] = (out[col][type] || 0) + v;
      if (col === "assets") out.asset += v; else out.debt += v;
    }
  }
  out.net = out.asset - out.debt;
  return out;
}
const hasHoldings = () => ["assets", "debts"].some((c) => Object.values(S[c]).some((a) => !a.deleted));
/** 순자산을 보여 줄 수 있는 첫 달: 가장 이른 내역·자산 등록 달 */
function netStartMonth() {
  let m = todayStr().slice(0, 7);
  for (const t of liveTx()) if ((t.assetDelta || t.deltas?.length) && t.date.slice(0, 7) < m) m = t.date.slice(0, 7);
  for (const c of ["assets", "debts"]) for (const a of Object.values(S[c])) if (!a.deleted && a.createdAt && a.createdAt.slice(0, 7) < m) m = a.createdAt.slice(0, 7);
  return m;
}

/** 현황 맨 위 한 줄: 순자산 + 지난달 말 대비 (누르면 결산의 순자산) */
function netWorthLine() {
  if (!hasHoldings()) return "";
  const now = holdingsAt(monthEnd(ui.month)).net;
  const prevM = shiftMonth(ui.month, -1);
  const d = prevM >= netStartMonth() ? now - holdingsAt(monthEnd(prevM)).net : null;
  const cur = ui.month === todayStr().slice(0, 7);
  const open = !!ui.nwOpen;
  return `<section class="nw-card${open ? " open" : ""}">
  <button class="nw-line" data-nw-toggle aria-expanded="${open}">
    <span class="nw-label">순자산${cur ? "" : ` (${Number(ui.month.slice(5))}월 말)`}</span>
    <span class="nw-val">${signedWon(Math.round(now)).replace(/^\+/, "")}${d === null ? "" : ` <span class="nw-diff ${d > 0 ? "inc" : d < 0 ? "exp" : "muted"}">${d ? `${d > 0 ? "▲" : "▼"} ${won(Math.abs(d))}` : "변화 없음"}</span>`} <span class="nw-go">${open ? "⌃" : "⌄"}</span></span>
  </button>
  ${open ? `<div class="nw-body">${networthBody({ withChg: false })}</div>` : ""}
  </section>`;
}

/** 결산: 순자산 — 지금 값, 최근 12개월 추이, 이번 달 바뀐 이유, 자산·부채 구성 */
function networthSection() {
  if (!hasHoldings()) return `
  <section class="card home-sec" id="networth">
    <div class="card-head"><span>순자산</span><span></span></div>
    <div class="empty" style="padding:14px 0">나의 자산·부채를 등록하면 순자산과 달마다 추이를 볼 수 있어요.</div>
  </section>`;
  const end = holdingsAt(monthEnd(ui.month));
  return `
  <section class="card home-sec" id="networth">
    <div class="card-head"><span>순자산 <span class="muted settle-note">${Number(ui.month.slice(5))}월 말 · 자산 − 부채</span></span><span>${signedWon(Math.round(end.net)).replace(/^\+/, "")}</span></div>
    ${networthBody({ withChg: true })}
  </section>`;
}
/** 순자산 본문(결산 섹션과 현황 펼침에서 같이 씀) */
function networthBody({ withChg = true } = {}) {
  const m = Number(ui.month.slice(5));
  const end = holdingsAt(monthEnd(ui.month));
  const prevKey = shiftMonth(ui.month, -1);
  const start = netStartMonth();
  const prev = prevKey >= start ? holdingsAt(monthEnd(prevKey)) : null;
  const chg = prev ? end.net - prev.net : null;

  // 최근 12개월(고른 달까지) 막대: 양수 초록·음수 빨강, 고른 달은 진하게. 막대를 누르면 그 달로
  const months = [];
  for (let k = 11; k >= 0; k--) { const mk = shiftMonth(ui.month, -k); if (mk >= start) months.push(mk); }
  const vals = months.map((mk) => (mk === ui.month ? end.net : holdingsAt(monthEnd(mk)).net));
  const W = 340, H = 140, top = 18, bottom = 22;
  const max = Math.max(0, ...vals), min = Math.min(0, ...vals);
  const span = max - min || 1;
  const y = (v) => top + ((max - v) / span) * (H - top - bottom);
  const slot = W / months.length;
  const bw = Math.min(18, slot - 6);
  const bars = months.map((mk, i) => {
    const v = vals[i], x = i * slot + (slot - bw) / 2;
    const y0 = y(0), y1 = y(v);
    const h = Math.max(Math.abs(y1 - y0), v ? 2 : 0);
    const on = mk === ui.month;
    const r = Math.min(4, h / 2, bw / 2);
    // 끝(0에서 먼 쪽)만 둥글게
    const path = v >= 0
      ? `M${x},${y0} V${y0 - h + r} Q${x},${y0 - h} ${x + r},${y0 - h} H${x + bw - r} Q${x + bw},${y0 - h} ${x + bw},${y0 - h + r} V${y0} Z`
      : `M${x},${y0} V${y0 + h - r} Q${x},${y0 + h} ${x + r},${y0 + h} H${x + bw - r} Q${x + bw},${y0 + h} ${x + bw},${y0 + h - r} V${y0} Z`;
    return `<g class="nw-bar${on ? " on" : ""}" data-nw-month="${mk}">
      <title>${Number(mk.slice(5))}월 말 순자산 ${signedWon(Math.round(v))}</title>
      <rect x="${i * slot}" y="0" width="${slot}" height="${H}" fill="transparent"/>
      <path d="${path}" class="${v >= 0 ? "pos" : "neg"}"/>
      <text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle" class="nw-tick">${Number(mk.slice(5))}월</text>
    </g>`;
  }).join("");
  const chart = months.length > 1 ? `
    <svg class="nw-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="최근 ${months.length}개월 순자산 추이">
      <line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" class="nw-zero"/>
      ${bars}
    </svg>
    <p class="note nw-hint">막대를 누르면 그 달로 이동해요.</p>` : "";

  // 이번 달 바뀐 이유: 내역이 자산·부채에 준 변화를 성격별로
  let inc = 0, expCash = 0, expDebt = 0, moves = 0, anyMove = false;
  for (const t of monthTx()) {
    for (const d of [deltaRef(t.assetDelta), ...(t.deltas || [])].filter(Boolean)) {
      const h = S[d.col]?.[d.id];
      if (!h || h.deleted) continue;
      const v = (toKRW(d.amount, curOf(h)) ?? 0) * (d.col === "debts" ? -1 : 1); // 순자산에 준 영향
      if (t.kind === "수입") inc += v;
      else if (t.kind === "지출") { if (d.col === "debts") expDebt += v; else expCash += v; }
      else { moves += v; anyMove = true; }
    }
  }
  const other = chg === null ? 0 : chg - (inc + expCash + expDebt + moves);
  const why = (label, v, cls = "") => `<div class="row-sub"><span>${label}</span><span class="${cls || (v > 0 ? "inc" : v < 0 ? "exp" : "")}">${signedWon(Math.round(v))}</span></div>`;
  const reasons = chg === null ? "" : `
    <div class="row nw-why">
      <div class="row-main"><span>${m}월에 바뀐 이유</span><span></span></div>
      ${inc ? why("수입", inc) : ""}
      ${expCash ? why("지출 (통장·현금)", expCash) : ""}
      ${expDebt ? why("지출 (카드·마통 등 부채로)", expDebt) : ""}
      ${anyMove ? `<div class="row-sub"><span>부채 상환·대출·자산이동<br><span class="muted nw-why-note">자산과 부채가 같이 움직여서 순자산은 그대로</span></span><span>${signedWon(Math.round(moves))}</span></div>` : ""}
      ${Math.abs(other) >= 1 ? why("기타 (환율·잔액 직접 수정 등)", other, "muted") : ""}
    </div>`;

  const comp = (obj, types, cls) => types.filter((t) => Math.round(obj[t] || 0)).map((t) => `<div class="row-sub"><span>${t}</span><span class="${cls}">${won(obj[t])}</span></div>`).join("");
  return `
    ${chg === null || !withChg ? "" : `<div class="nw-chg">지난달 말보다 <span class="${chg > 0 ? "inc" : chg < 0 ? "exp" : "muted"}">${chg ? `${chg > 0 ? "▲" : "▼"} ${won(Math.abs(chg))}` : "변화 없음"}</span></div>`}
    ${chart}
    ${reasons}
    <div class="row nw-comp">
      <div class="row-main"><span>자산</span><span class="inc">${won(end.asset)}</span></div>
      ${comp(end.assets, ASSET_TYPES, "")}
      <div class="row-main nw-debt-head"><span>부채</span><span class="cred">${won(end.debt)}</span></div>
      ${comp(end.debts, DEBT_TYPES, "")}
    </div>
    <p class="note">외화는 오늘 환율로, 앱을 쓰기 전 기간은 처음 등록한 잔액으로 계산해요.</p>`;
}

// ---------------- 카테고리 추이 ----------------
// 고른 카테고리(또는 전체 지출)의 최근 6개월 지출 막대 + 6개월 평균선. 카드·마통으로 쓴 돈도 포함.
function catTrendSection() {
  const months = [];
  for (let k = 5; k >= 0; k--) months.push(shiftMonth(ui.month, -k));
  const from = months[0], to = ui.month;
  const exp = liveTx().filter((t) => t.kind === "지출" && t.date.slice(0, 7) >= from && t.date.slice(0, 7) <= to);
  if (!exp.length) return "";
  // 고를 수 있는 카테고리: 6개월 동안 쓴 금액 순
  const tot = {};
  exp.forEach((t) => (tot[t.category || "미분류"] = (tot[t.category || "미분류"] || 0) + txKRW(t)));
  const cats = Object.entries(tot).sort((a, b) => b[1] - a[1]).map(([c]) => c);
  if (ui.statCat && !cats.includes(ui.statCat)) ui.statCat = "";
  const sel = ui.statCat || "";
  const vals = months.map((mk) => exp.filter((t) => t.date.startsWith(mk) && (!sel || (t.category || "미분류") === sel)).reduce((a, t) => a + txKRW(t), 0));
  const used = vals.filter((v, i) => v || i === vals.length - 1);
  // 평균은 가계부를 쓰기 시작한 달(첫 지출 기록)부터만 — 그 전 달을 0원으로 세지 않음
  const first = liveTx().filter((t) => t.kind === "지출").reduce((m, t) => (t.date.slice(0, 7) < m ? t.date.slice(0, 7) : m), to);
  const avgIdx = months.map((mk, i) => (mk >= first ? i : -1)).filter((i) => i >= 0);
  const avg = avgIdx.reduce((a, i) => a + vals[i], 0) / Math.max(avgIdx.length, 1);
  const now = vals[vals.length - 1];
  const W = 340, H = 150, top = 22, bottom = 22;
  const max = Math.max(...vals, avg) || 1;
  const y = (v) => top + (1 - v / max) * (H - top - bottom);
  const slot = W / months.length, bw = Math.min(22, slot - 10);
  const bars = months.map((mk, i) => {
    const v = vals[i], x = i * slot + (slot - bw) / 2, h = Math.max(H - bottom - y(v), v ? 2 : 0), y0 = H - bottom;
    const r = Math.min(4, h / 2, bw / 2);
    const path = h ? `M${x},${y0} V${y0 - h + r} Q${x},${y0 - h} ${x + r},${y0 - h} H${x + bw - r} Q${x + bw},${y0 - h} ${x + bw},${y0 - h + r} V${y0} Z` : "";
    const on = mk === ui.month;
    return `<g class="ct-bar${on ? " on" : ""}" data-stat-month="${mk}">
      <title>${Number(mk.slice(5))}월 ${sel || "전체 지출"} ${won(v)}</title>
      <rect x="${i * slot}" y="0" width="${slot}" height="${H}" fill="transparent"/>
      ${path ? `<path d="${path}"/>` : ""}
      ${on && v ? `<text x="${x + bw / 2}" y="${y0 - h - 6}" text-anchor="middle" class="ct-val">${won(v).replace("원", "")}</text>` : ""}
      <text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle" class="nw-tick">${Number(mk.slice(5))}월</text>
    </g>`;
  }).join("");
  const ay = y(avg);
  const diff = now - avg;
  return `
  <section class="card home-sec" id="cat-trend">
    <div class="card-head"><span>카테고리 추이 <span class="muted settle-note">최근 6개월 · 카드·마통 포함</span></span><span></span></div>
    <select class="input ct-select" data-stat-cat>
      <option value="" ${sel ? "" : "selected"}>전체 지출</option>
      ${cats.map((c) => `<option value="${esc(c)}" ${c === sel ? "selected" : ""}>${esc(c)}</option>`).join("")}
    </select>
    <svg class="nw-chart ct-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(sel || "전체 지출")} 최근 6개월 지출">
      <line x1="0" x2="${W}" y1="${H - bottom}" y2="${H - bottom}" class="nw-zero"/>
      ${bars}
      ${avg ? `<line x1="0" x2="${W}" y1="${ay}" y2="${ay}" class="ct-avg"/>` : ""}
    </svg>
    <div class="ct-sum">
      <div class="row-sub"><span>${Number(ui.month.slice(5))}월</span><span>${won(now)}</span></div>
      <div class="row-sub"><span><i class="ct-avg-sw" aria-hidden="true"></i>${avgIdx.length < months.length ? `${avgIdx.length}개월` : "6개월"} 평균 (점선)</span><span>${won(Math.round(avg))}</span></div>
      <div class="row-sub"><span>평균과 비교</span><span class="${!avg || Math.abs(diff) < 1 ? "muted" : diff > 0 ? "exp" : "inc"}">${!avg ? "-" : Math.abs(diff) < 1 ? "평균과 같아요" : `${diff > 0 ? "▲" : "▼"} ${won(Math.abs(Math.round(diff)))} ${diff > 0 ? "더 씀" : "덜 씀"}`}</span></div>
    </div>
    <p class="note nw-hint">막대를 누르면 그 달 결산으로 바뀌어요.${used.length < 3 ? " 기록이 쌓일수록 추이가 정확해져요." : ""}</p>
  </section>`;
}

/** 결산 탭: 고른 달의 결산 — 요약·저축률 / 지난달 대비 / 많이 쓴 카테고리 / 순자산 */
function settleView() {
  const { m, tx, cur, prevKey, prevTx, prev, left, rate, cats, catTotal, assetChg, debtChg, netChg } = settleData();
  if (!tx.length) return `<div class="card"><div class="empty">${m}월 기록이 없어요.</div></div>${networthSection()}`;
  const top = ui.rankAll ? cats : cats.slice(0, 5);
  // 지난달 대비: 늘었으면 ▲, 줄었으면 ▼. 수입은 늘면 초록, 지출·부채는 늘면 레드/핑크
  const diffRow = (label, now, before, upGood, upCls) => {
    const d = now - before;
    const cls = !d ? "muted" : (d > 0) === upGood ? "inc" : upCls;
    return `<div class="diff-row">
      <div class="row-main"><span>${label}</span><span class="${cls}">${d ? `${d > 0 ? "▲" : "▼"} ${won(Math.abs(d))}` : "변화 없음"}</span></div>
      <div class="diff-sub">${Number(prevKey.slice(5))}월 ${won(before)} → ${m}월 ${won(now)}</div>
    </div>`;
  };

  return `
  <section class="card">
    <div class="card-head"><span>${m}월 결산</span><span>${rate === null ? "" : `<span class="muted">저축률</span> ${rate}%`}</span></div>
    <div class="row"><div class="row-main">${homeLabel("수입", "수입", "inc")}<span class="inc">${signed(cur.inc, "+")}</span></div></div>
    <div class="row">
      <div class="row-main">${homeLabel("지출", "지출", "exp")}<span class="exp">${signed(cur.exp, "-")}</span></div>
      <div class="row-sub"><span>└ 고정지출</span><span>${signed(cur.fixed, "-")}</span></div>
      <div class="row-sub"><span>└ 변동지출</span><span>${signed(cur.variable, "-")}</span></div>
    </div>
    <div class="row"><div class="row-main"><span>남은 돈 (수입-지출)</span><span>${signedWon(left)}</span></div></div>
    ${cur.debtUse ? `<div class="row"><div class="row-main">${homeLabel("단기부채", "단기 부채 사용", "cred")}<span class="cred">${won(cur.debtUse)}</span></div>
      <div class="row-sub"><span>카드·마통으로 쓴 돈은 갚을 때 통장에서 나가요</span><span></span></div></div>` : ""}
  </section>

  <section class="card home-sec">
    <div class="card-head"><span>지난달(${Number(prevKey.slice(5))}월) 대비</span><span></span></div>
    ${prevTx.length ? `<div class="row">
      ${diffRow("수입", cur.inc, prev.inc, true, "exp")}
      ${diffRow("지출", cur.exp, prev.exp, false, "exp")}
      ${diffRow("단기 부채 사용", cur.debtUse, prev.debtUse, false, "cred")}
    </div>` : `<div class="empty" style="padding:14px 0">지난달 기록이 없어요.</div>`}
  </section>

  <section class="card home-sec">
    <div class="card-head"><span>많이 쓴 카테고리</span><span class="muted settle-note">카드·마통 사용 포함</span></div>
    ${top.length ? `<div class="row">${top.map(([c, v], i) => `
      <div class="rank-row" data-stat-pick="${esc(c)}">
        <div class="rank-top"><span><span class="rank-no">${i + 1}</span>${esc(c)}</span><span>${won(v)} <span class="muted">${Math.round((v / catTotal) * 100)}%</span></span></div>
        <div class="rank-bar"><span style="width:${(v / top[0][1]) * 100}%"></span></div>
      </div>`).join("")}</div>
      ${cats.length > 5 ? `<button class="fold-line" data-fold="rankAll"><span>${ui.rankAll ? `전체 ${cats.length}개` : `나머지 ${cats.length - 5}개 카테고리`}</span><span class="fold-go">${ui.rankAll ? "접기 ⌃" : "전체 보기 ⌄"}</span></button>` : ""}
      <p class="note rank-hint">카테고리를 누르면 아래 '카테고리 추이'에서 몇 달 흐름을 볼 수 있어요.</p>` : `<div class="empty" style="padding:14px 0">지출 기록이 없어요.</div>`}
  </section>
  ${catTrendSection()}

  ${networthSection()}
  <button class="btn excel-btn settle-excel" data-settle-excel>${EXCEL_ICON}${m}월 결산 엑셀 파일로 내보내기</button>`;
}

const EXCEL_ICON = `<svg class="excel-ico" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" fill="#1d7a45"/><path d="M8.2 8l7.6 8M15.8 8l-7.6 8" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>`;

/** 결산 엑셀: 시트 1 '결산'(요약·지난달 대비·카테고리 전체·자산 변화), 시트 2 '내역'(그달 내역) */
function exportSettlement() {
  const { m, tx, cur, prevKey, prevTx, prev, left, rate, cats, catTotal, assetChg, debtChg, netChg } = settleData();
  if (!tx.length) return toast("내보낼 기록이 없어요");
  const y = ui.month.slice(0, 4), pm = Number(prevKey.slice(5));
  const rows = [], heads = [];
  const head = (...cells) => { heads.push(rows.length); rows.push(cells); };
  const gap = () => rows.push([]);
  head(`${y}년 ${m}월 결산`, "금액");
  rows.push(["수입", cur.inc], ["지출", cur.exp], ["  고정지출", cur.fixed], ["  변동지출", cur.variable],
    ["남은 돈 (수입-지출)", left], ["저축률", rate === null ? "-" : `${rate}%`], ["단기 부채 사용 (카드·마통)", cur.debtUse], ["부채 상환", cur.repay]);
  gap();
  head(`지난달 대비`, `${pm}월`, `${m}월`, "증감");
  if (prevTx.length) {
    for (const [label, a, b] of [["수입", prev.inc, cur.inc], ["지출", prev.exp, cur.exp], ["단기 부채 사용", prev.debtUse, cur.debtUse]]) rows.push([label, a, b, b - a]);
  } else rows.push(["지난달 기록이 없어요"]);
  gap();
  head("카테고리별 지출 (카드·마통 포함)", "금액", "비율");
  cats.forEach(([c, v]) => rows.push([c, v, `${Math.round((v / catTotal) * 100)}%`]));
  if (!cats.length) rows.push(["지출 기록이 없어요"]);
  gap();
  head("자산·부채 변화 (이번 달 기록 기준)", "금액");
  rows.push(["자산", Math.round(assetChg)], ["부채", Math.round(debtChg)], ["순자산 변화 (자산-부채)", Math.round(netChg)]);
  const list = [...tx].sort((a, b) => (a.date + (a.time || "") + a.createdAt).localeCompare(b.date + (b.time || "") + b.createdAt));
  const blob = makeXlsxBook([
    { name: "결산", rows, widths: [30, 14, 14, 14], heads, freeze: false },
    { name: "내역", rows: txSheetRows(list), widths: TX_SHEET_WIDTHS },
  ]);
  downloadBlob(blob, `${FILE_PREFIX}_결산_${y}년${m}월.xlsx`);
  toast(`${m}월 결산을 엑셀로 저장했어요`);
}

/** part: "summary" = 현황(종합), "detail" = 현황(상세) */
function homeView(part = "summary") {
  const tx = monthTx();
  const inc = tx.filter((t) => t.kind === "수입");
  const exp = tx.filter((t) => t.kind === "지출");
  const mov = tx.filter(isMoveTx);
  const repay = tx.filter(isRepayTx); // 부채 상환: 자산이동과 따로
  const loans = tx.filter(isLoanTx); // 대출 실행: 수입이 아니라 빌린 돈
  // 신용카드·마이너스통장으로 결제한 지출은 단기부채로 따로 묶고, 지출(고정·변동)에서는 뺀다
  const shortDebt = exp.filter(isShortDebt);
  const fixed = exp.filter((t) => isPlainExpense(t) && t.expenseType === "고정");
  const variable = exp.filter((t) => isPlainExpense(t) && t.expenseType !== "고정");

  // 단기 부채 섹션: 종류별 줄 + 그 아래 항목(카드·통장)별 사용액
  const shortDebtRows = Object.entries(SHORT_DEBT).map(([type, info]) => {
    const items = shortDebt.filter((t) => shortDebtType(t) === type);
    if (!sum(items)) return ""; // 0원인 종류는 생략
    const byDebt = {};
    items.forEach((t) => { const id = deltaRef(t.assetDelta).id; byDebt[id] = (byDebt[id] || 0) + txKRW(t); });
    const subs = Object.entries(byDebt)
      .sort((a, b) => b[1] - a[1])
      .map(([id, v]) => `<div class="row-sub"><span>└ ${esc(S.debts[id]?.name || type)}</span><span>${won(v)}</span></div>`)
      .join("");
    return `
    <div class="row">
      <div class="row-main"><span>${info.title}</span><span class="cred">${won(sum(items))}</span></div>
      ${subs}
    </div>`;
  }).join("");

  const segs = {
    수입: [inc, "inc", "+"],
    고정지출: [fixed, "exp", "-"],
    변동지출: [variable, "exp", "-"],
    자산이동: [mov, "mov", ""],
    "단기 부채(이번 달)": [shortDebt, "cred", ""], // 단기 부채는 부호 없이(갚아야 할 돈)
    "부채 상환": [repay, "repay", ""],
  };
  if (!segs[ui.seg]) ui.seg = "수입"; // 이전 버전의 구분 이름이 남아 있을 때
  const [selTx, cls, sign] = segs[ui.seg];
  // 카테고리마다 섹션 하나: 머리줄(카테고리·합계, 색 유지) → 구분선 → 하위 카테고리별 금액(회색)
  const buildCatSections = (list, group = "", allCats = []) => {
    const byCat = {};
    allCats.forEach((c) => (byCat[c] = { total: 0, subs: {} })); // 0원이어도 보여 줄 카테고리(고정지출)
    list.forEach((t) => {
      const c = (byCat[t.category] ||= { total: 0, subs: {} });
      const v = txKRW(t);
      c.total += v;
      const sub = t.subcategory || "";
      c.subs[sub] = (c.subs[sub] || 0) + v;
    });
    return Object.entries(byCat)
      .sort((a, b) => b[1].total - a[1].total) // 0원끼리는 카테고리 순서 그대로
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
        <div class="asset-group-head"><span>${esc(c)} <span class="cat-chev">${open ? "⌄" : "›"}</span></span><span class="${total ? cls : "muted"}">${total ? signed(total, sign) : "0원"}</span></div>
        ${rows.map(([s, v]) => `<div class="asset-row detail-sub"><span class="name">${esc(s)}</span><span class="amt">${signed(v, sign)}</span></div>`).join("")}
        ${open ? `<div class="detail-items">${items.map((t) => txRow(t, { withDate: true })).join("")}</div>` : ""}
      </section>`;
      })
      .join("");
  };
  // 단기부채는 신용카드 / 마이너스통장으로 나눠서, 각 묶음 제목(뱃지·소계) 아래에 카테고리 섹션
  const catSections = ui.seg === "단기 부채(이번 달)"
    ? Object.entries(SHORT_DEBT).map(([type, info]) => {
        const list = selTx.filter((t) => shortDebtType(t) === type);
        if (!list.length) return "";
        return `
      <div class="group-title"><span class="cat-badge b-cred">${info.label}</span></div>
      ${buildCatSections(list, type)}`;
      }).join("")
    : ui.seg === "자산이동" || ui.seg === "부채 상환" ? "" // 자산이동·부채 상환은 합계 아래 경로별 하위 항목만
    : buildCatSections(selTx, "", ui.seg === "고정지출" ? catsFor("지출", "고정") : []);


  // 현황: 이번 달 현재(수입·지출) → 단기 부채 → 자산이동 → 부채 상환 → 대출 실행, 각각 섹션(카드)으로
  const subRows = (pairs) => pairs.length ? `<div class="row">${pairs.map(([r, v]) => `<div class="row-sub"><span>└ ${esc(r)}</span><span>${won(v)}</span></div>`).join("")}</div>` : "";
  const section = (key, title, cls, total, body) => `
  <section class="card home-sec">
    <div class="card-head">${homeLabel(key, title, cls)}<span class="${cls}">${won(total)}</span></div>
    ${body}
  </section>`;
  const summary = `
  ${netWorthLine()}
  <section class="card">
    <div class="card-head"><span>이번 달 현재 (수입-지출)</span><span>${won(sum(inc) - sum(fixed) - sum(variable))}</span></div>
    <div class="row"><div class="row-main">${homeLabel("수입", "수입", "inc")}<span class="inc">${signed(sum(inc), "+")}</span></div></div>
    <div class="row">
      <div class="row-main">${homeLabel("지출", "지출", "exp")}<span class="exp">${signed(sum(fixed) + sum(variable), "-")}</span></div>
      <div class="row-sub"><span>└ 고정지출</span><span>${signed(sum(fixed), "-")}</span></div>
      <div class="row-sub"><span>└ 변동지출</span><span>${signed(sum(variable), "-")}</span></div>
    </div>
  </section>
  ${budgetSection(exp)}
  ${recurringSection()}
  ${cardBillSection()}
  ${section("단기부채", "단기 부채 (이번 달)", "cred", sum(shortDebt), shortDebtRows)}
  ${section("자산이동", "자산이동", "mov", sum(mov), subRows(routeTotals(mov)))}
  ${repay.length ? section("부채상환", "부채 상환", "repay", sum(repay), subRows(repayTotals(repay))) : ""}
  ${loans.length ? section("대출실행", "대출 실행", "cred", sum(loans), subRows(loanTotals(loans))) : ""}`;
  if (part === "summary") return summary;
  return `
  <section class="card">
    <div class="seg seg-6" data-role="detail-seg">
      ${Object.keys(segs).map((s) => `<button data-seg="${s}" class="${s === ui.seg ? "on" : ""}">${s}</button>`).join("")}
    </div>
    <div class="total-bar">
      <div class="tb-main"><span class="home-label"><span class="${cls}">${SUM_ICON}</span>${ui.seg} 합계</span><span class="${cls}">${signed(sum(selTx), sign)}</span></div>
      ${ui.seg === "단기 부채(이번 달)" ? Object.entries(SHORT_DEBT).map(([type, info]) => {
        const v = sum(selTx.filter((t) => shortDebtType(t) === type));
        return v ? `<div class="tb-sub"><span>└ ${info.label}</span><span>${won(v)}</span></div>` : "";
      }).join("") : ""}
      ${ui.seg === "자산이동" || ui.seg === "부채 상환" ? (ui.seg === "부채 상환" ? repayTotals : routeTotals)(selTx).map(([r, v]) => `<div class="tb-sub"><span>└ ${esc(r)}</span><span>${won(v)}</span></div>`).join("") : ""}
    </div>
    ${selTx.length ? catSections : `<div class="empty" style="padding:16px 0">이번 달 내역이 없어요.</div>`}
  </section>`;
}

/** 내역 한 줄 (누르면 수정 창) */
/** withDate: 여러 날짜가 섞인 목록(현황(상세) 펼치기)에서는 날짜도 함께 표시 */
function txRow(t, { withDate = false } = {}) {
  // 뱃지: 카테고리(수입 초록·지출 레드) / 자산이동(화이트) / 부채상환(옐로우: 자산에서 밖으로 나가 빚을 줄임) + 부채로 결제했으면 그 부채 종류(핑크)
  const kindBadge = t.kind === "수입" ? "b-inc" : t.kind === "지출" ? "b-exp" : "b-mov";
  const d = deltaRef(t.assetDelta);
  const debt = d?.col === "debts" ? S.debts[d.id] : null;
  const isRepay = isRepayTx(t), isLoan = isLoanTx(t);
  const route = esc(moveRoute(t)); // 자산이동: 출금 자산 → 입금 자산(상환은 → 부채)
  const when = withDate ? `${Number(t.date.slice(5, 7))}/${Number(t.date.slice(8, 10))} ${t.time || ""}`.trim() : t.time;
  const sub = [when, t.party ? esc(t.party) : ""].filter(Boolean).join(" · ");
  // 시간 아래 줄: 수입=입금 자산, 지출=출금 자산(신용카드·마통 등 부채는 '결제'), 자산이동=출금 → 입금
  const linked = d && (d.col === "debts" ? S.debts[d.id] : S.assets[d.id]);
  const via = linked ? `${t.kind === "수입" ? "입금" : d.col === "debts" ? "결제" : "출금"} ${esc(linked.name)}` : route;
  return `
          <button class="tx" data-tx="${t.id}">
            <div class="left">
              <div class="badges">${isRepay ? `<span class="cat-badge b-repay">부채상환</span>` : isLoan ? `<span class="cat-badge b-cred">대출 실행</span>` : t.kind === "자산이동" ? `<span class="cat-badge b-mov">자산이동</span>` : ""}${debt ? `<span class="cat-badge b-cred">${esc(debtType(debt) || debt.name)}</span>` : ""}${t.kind !== "자산이동" ? `<span class="cat-badge ${kindBadge}">${esc(t.category)}</span>` : ""}${t.photos?.length ? `<span class="tx-photo" title="영수증 사진">${CAMERA}</span>` : ""}</div>
              ${t.content ? `<div class="tx-content">${esc(isLoan ? t.content.replace(/ 대출 실행$/, "") : t.content)}</div>` : ""}
              ${sub ? `<div class="memo">${sub}</div>` : ""}
              ${via ? `<div class="memo${isRepay ? " repay" : isLoan ? " cred" : t.kind === "자산이동" ? " mov" : ""}">${via}</div>` : ""}
              ${t.kind === "지출" && (t.card || t.transfer) ? `<div class="memo">결제 ${t.card ? esc(t.card) : "계좌이체"}</div>` : ""}
              ${t.inst > 1 ? `<div class="memo cred">할부 ${t.inst}개월</div>` : ""}
            </div>
            <span class="amt ${isShortDebt(t) || isLoan ? "cred" : isRepay ? "repay" : KIND_CLASS[t.kind]}">${isShortDebt(t) ? SHORT_DEBT[shortDebtType(t)].short + " " : isRepay ? "상환 " : isLoan ? "대출 " : ""}${t.currency && t.currency !== "KRW"
              ? `${txSign(t)}${formatMoney(t.amount, t.currency)}<span class="fx-sub">≈ ${won(t.krw || 0)}</span>`
              : signed(t.amount, txSign(t))}</span>
          </button>`;
}

/** 날짜 머리줄: 왼쪽 [일] [요일] [년-월], 오른쪽 1줄 수입·지출, 그 아래 신용·마통 등을 한 줄씩 */
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
          <div class="dh-right">${line1 ? `<div>${line1}</div>` : ""}${line2}</div>
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
        ${cred ? `<span class="cal-amt cred">${compact(cred)}</span>` : ""}
      </button>`);
  }

  const sel = ui.day ? (byDay[ui.day] || []).sort(txNewestFirst) : [];
  return `
  <section class="card">
    <div class="card-head cal-head"><span class="month-badge">${m}월</span><div class="cal-sum">${monthCols(tx) || `<div class="muted">내역 없음</div>`}</div></div>
    <div class="cal-grid cal-week">${"일월화수목금토".split("").map((w, i) => `<span class="${i === 0 ? "sun" : i === 6 ? "sat" : ""}">${w}</span>`).join("")}</div>
    <div class="cal-grid">${cells.join("")}</div>
  </section>
  ${ui.day ? `
  <section class="card day">
    ${dayHead(ui.day, sel)}
    ${sel.length ? sel.map(txRow).join("") : `<div class="empty" style="padding:16px 0">이 날의 내역이 없어요.<br>+ 버튼을 누르면 이 날짜로 추가돼요.</div>`}
  </section>` : ""}`;
}

// 월별: 상단 연도 합계, 아래 달마다 합계와 수입·지출 비교 막대. 달을 누르면 그 달 현황으로 이동.
/** 월별·달력 합계 두 칸: 왼쪽 수입·지출·합계(수입-지출), 오른쪽 신용·마통 등·부채(합). 내역이 없으면 "" */
function monthCols(items) {
  const inc = sum(items.filter((t) => t.kind === "수입"));
  const exp = sum(items.filter(isPlainExpense));
  const debt = sum(items.filter(isShortDebt));
  const left = inc || exp ? `
    <div class="inc">${signed(inc, "+")}</div>
    <div class="exp">${signed(exp, "-")}</div>
    <div class="mc-total">합계: ${won(inc - exp)}</div>` : "";
  const right = debt ? `${shortDebtTotals(items)}<div class="mc-total">합계: ${won(debt)}</div>` : "";
  if (!left && !right) return "";
  return `<div class="mc-cols">${left ? `<div>${left}</div>` : ""}${right ? `<div>${right}</div>` : ""}</div>`;
}

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
  const yearTotals = monthCols(yearTx);
  return `
  <section class="card">
    <div class="card-head cal-head"><span class="month-badge">${year}년</span><div class="cal-sum">${yearTotals || `<div class="muted">내역 없음</div>`}</div></div>
    ${months.map((x) => {
      const totals = monthCols(x.items);
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

// 내역 탭: 위에 검색창, 아래에 목록(검색어가 있으면 전체 기간 검색 결과, 없으면 이번 달 목록)
const RECENT_DAYS = 3, DAY_LIMIT = 5;
/** 날짜 카드: 하루 내역이 많으면 DAY_LIMIT건까지만 보이고 '더 보기'로 나머지를 연다 */
function dayCard([date, items]) {
  const more = ui.dayMore[date] || items.length <= DAY_LIMIT + 1;
  return `
      <section class="card day">
        ${dayHead(date, items)}
        ${(more ? items : items.slice(0, DAY_LIMIT)).map((t) => txRow(t)).join("")}
        ${!more ? `<button class="day-more" data-day-more="${date}">${items.length - DAY_LIMIT}건 더 보기 ▾</button>` : ""}
        ${ui.dayMore[date] && items.length > DAY_LIMIT + 1 ? `<button class="day-more" data-day-less="${date}">줄이기 ▴</button>` : ""}
      </section>`;
}
const groupByDate = (list) => {
  const days = {};
  list.forEach((t) => (days[t.date] ||= []).push(t));
  return Object.entries(days);
};

function listView() {
  return `
  <div class="search-bar">
    <svg class="search-ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>
    <input class="search-input" type="search" name="q" placeholder="내역 검색 · 내용, 거래처, 카테고리, 금액" value="${esc(ui.q)}" autocomplete="off" enterkeyhint="search">
    <button class="search-clear" data-search-clear aria-label="검색어 지우기" ${ui.q ? "" : "hidden"}>✕</button>
  </div>
  <div id="list-results">${listBody()}</div>`;
}

function listBody() {
  return ui.q.trim() ? searchResults(ui.q) : monthList();
}

/** 이번 달 목록: 최근 RECENT_DAYS일은 그대로, 그 전 날짜는 '이전 내역' 한 줄로 묶어 펼치기/접기 */
function monthList() {
  const tx = monthTx().sort(txNewestFirst);
  if (!tx.length) return `<div class="card"><div class="empty">이번 달 내역이 없어요.<br>아래 + 버튼으로 추가해 보세요.</div></div>`;
  const entries = groupByDate(tx);
  const recent = entries.slice(0, RECENT_DAYS), older = entries.slice(RECENT_DAYS);
  if (!older.length) return recent.map(dayCard).join("");
  const open = ui.olderOpen === ui.month;
  const count = older.reduce((n, [, items]) => n + items.length, 0);
  const toggle = (label) => `
      <button class="older-toggle" data-older-toggle>
        <span>이전 내역 <span class="muted">${older.length}일 · ${count}건</span></span>
        <span class="muted">${label}</span>
      </button>`;
  return recent.map(dayCard).join("") + toggle(open ? "접기 ▴" : "펼치기 ▾") +
    (open ? older.map(dayCard).join("") + toggle("접기 ▴") : "");
}

/** 검색: 띄어 쓴 낱말이 모두 들어 있는 내역(전체 기간). 숫자는 금액(쉼표·'원' 무시)으로도 찾는다. */
function txMatches(t, words) {
  const d = deltaRef(t.assetDelta);
  const linked = d && S[d.col]?.[d.id];
  const text = [
    t.content, t.party, t.memo, t.category, t.subcategory, isRepayTx(t) ? "부채상환 상환" : isLoanTx(t) ? "대출실행 대출" : t.kind,
    t.kind === "지출" ? `${t.expenseType || ""}지출` : "", linked?.name, d?.col === "debts" ? debtType(linked) : "",
    moveRoute(t), t.currency && t.currency !== "KRW" ? t.currency : "",
  ].filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => {
    const digits = w.replace(/[,원]/g, "");
    if (/^\d+$/.test(digits)) return text.includes(digits) || String(t.amount).includes(digits) || String(Math.round(txKRW(t))).includes(digits);
    return text.includes(w);
  });
}
const SEARCH_MAX = 300;
function searchResults(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const found = liveTx().filter((t) => txMatches(t, words)).sort(txNewestFirst);
  if (!found.length) return `<div class="card"><div class="empty">'${esc(q.trim())}'에 맞는 내역이 없어요.<br>전체 기간에서 찾았어요.</div></div>`;
  const shown = found.slice(0, SEARCH_MAX);
  const inc = sum(found.filter((t) => t.kind === "수입")), exp = sum(found.filter(isPlainExpense));
  return `
  <div class="search-summary">
    <span>검색 결과 ${found.length}건 <span class="muted">· 전체 기간</span></span>
    <span>${inc ? `<span class="inc">${signed(inc, "+")}</span> ` : ""}${exp ? `<span class="exp">${signed(exp, "-")}</span>` : ""}</span>
  </div>
  ${groupByDate(shown).map(dayCard).join("")}
  ${found.length > SEARCH_MAX ? `<p class="note" style="text-align:center">최근 ${SEARCH_MAX}건까지 보여요. 검색어를 더 자세히 적어 보세요.</p>` : ""}`;
}

/** 검색창: 글자를 칠 때마다 결과만 다시 그린다(입력창은 그대로라 키보드가 닫히지 않음) */
function bindSearch() {
  const input = $("#view [name=q]");
  if (!input) return;
  const clear = $("#view [data-search-clear]");
  const update = () => {
    ui.q = input.value;
    clear.hidden = !ui.q;
    $("#list-results").innerHTML = listBody();
  };
  input.addEventListener("input", update);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
  clear.onclick = () => { input.value = ""; update(); input.focus(); };
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
  지출: { label: "출금 되는 자산", cols: ["assets", "debts"] }, // 자산에서 출금하거나 신용카드 등 부채로 결제
};
/** 내역 창의 자산·부채 칸: 카드·마통 사용이면 그 종류 부채만, 고정·변동지출이면 카드·마통은 빼고(그쪽 성격으로) */
function linkCfgOf(d) {
  if (d.kind === "지출" && CARD_MODES.includes(d.debtMode)) return { label: `사용한 ${SHORT_DEBT[d.debtMode].label}`, cols: ["debts"] };
  if (d.kind === "지출") return { ...ASSET_LINK.지출, exclude: CARD_MODES, help: ["assets"] };
  return ASSET_LINK[d.kind];
}
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

// ---------------- 잔액 계산 ----------------
// 잔액은 저장해 두고 더하고 빼는 대신, 항상 '기준 금액(base) + 이 자산·부채에 연결된 살아 있는 내역의 변화 합'으로 계산한다.
// 내역은 기록만 하고 잔액 숫자를 고치지 않으므로, 폰·PC에서 동시에 입력해도 동기화 순서와 상관없이 잔액이 맞는다.
// base가 없는 예전 기록은 migrateBalances가 한 번 계산해 넣는다(그 전까지는 예전 amount를 그대로 보여 줌).
let linkCache = null;
/** "col:id" → 연결된 내역 변화 합 (한 번 그리는 동안만 기억) */
function linkedTotals() {
  if (linkCache) return linkCache;
  const m = new Map();
  const add = (col, id, v) => { const k = `${col}:${id}`; m.set(k, (m.get(k) || 0) + v); };
  for (const t of liveTx()) {
    const d = deltaRef(t.assetDelta);
    if (d) add(d.col, d.id, d.amount);
    for (const x of t.deltas || []) add(x.col, x.id, x.amount);
  }
  linkCache = m;
  queueMicrotask(() => (linkCache = null));
  return m;
}
const linkedSum = (col, id) => linkedTotals().get(`${col}:${id}`) || 0;
/** 지금 잔액 */
function balanceOf(col, a) {
  if (a.base === undefined) return a.amount || 0;
  return roundFor(a.base + linkedSum(col, a.id), curOf(a));
}
/** 예전 방식(amount에 직접 더하기)으로 저장된 자산·부채에 기준 금액을 넣는다 */
/** 2026-10-11~12 버그로 deltas 없이 저장된 대출 실행 내역에 부채 증가분을 되살린다(입금 자산은 알 수 없어 빠짐) */
function repairLoanTxs() {
  let n = 0;
  for (const t of Object.values(S.transactions)) {
    if (t.deleted || t.kind !== "자산이동" || t.deltas?.length || t.assetDelta || t.fromAsset) continue;
    const d = Object.values(S.debts).find((x) => !x.deleted && x.name === t.content && x.base === 0
      && Math.abs(new Date(x.createdAt) - new Date(t.createdAt)) < 60000);
    if (!d) continue;
    S.transactions[t.id] = { ...t, deltas: [{ col: "debts", id: d.id, amount: t.amount }], updatedAt: nowISO() };
    n++;
  }
  return n;
}

function migrateBalances() {
  let n = 0;
  const now = nowISO();
  for (const col of ["assets", "debts"]) {
    for (const a of Object.values(S[col])) {
      if (a.deleted || a.base !== undefined) continue;
      S[col][a.id] = { ...a, base: roundFor((a.amount || 0) - linkedSum(col, a.id), curOf(a)), updatedAt: now };
      n++;
    }
  }
  return n;
}

/** 내역 창의 자산·부채 선택 아래 안내: 등록된 게 없으면 알려 주고, 바로 등록할 수 있는 버튼 */
function holdingHelp(cols) {
  const has = cols.some((col) => Object.values(S[col]).some((a) => !a.deleted));
  const msg = has ? "찾는 항목이 없나요?" : cols.includes("debts") ? "등록된 자산·부채가 없어요. 등록해 두면 잔액이 자동으로 바뀌어요." : "등록된 자산이 없어요. 등록해 두면 잔액이 자동으로 바뀌어요.";
  return `<div class="holding-help${has ? "" : " no-holding"}"><span>${msg}</span>
    ${cols.map((col) => `<button class="reg-link" data-reg="${col}">+ ${col === "debts" ? "부채(신용카드 등)" : "자산"} 등록</button>`).join("")}</div>`;
}

/** 선택 목록: 자산(종류별) → 부채(종류별), 현재 잔액을 함께 보여 준다 */
function holdingOptions(cols, selectedKey, { balance = true, withCard = false, onlyType = "", exclude = [] } = {}) {
  const html = cols.map((col) => {
    const types = HOLDINGS[col].types.filter((t) => !onlyType || t === onlyType);
    const items = Object.values(S[col]).filter((a) => !a.deleted && (!onlyType || debtType(a) === onlyType)
      && !(col === "debts" && exclude.includes(debtType(a)) && linkKey(col, a.id) !== selectedKey)).sort(makeOrder(types));
    return types.filter((t) => items.some((a) => a.type === t)).map((t) => `
    <optgroup label="${col === "debts" ? `부채 · ${t}` : t}">${items.filter((a) => (col === "debts" ? debtType(a) : a.type) === t).map((a) => {
      const key = linkKey(col, a.id);
      return `<option value="${key}" ${key === selectedKey ? "selected" : ""}>${esc(a.name)}${withCard && a.card ? ` | ${esc(a.card)}` : ""}${balance ? ` · ${formatMoney(balanceOf(col, a), curOf(a))}` : ""}</option>`;
    }).join("")}
    </optgroup>`).join("");
  }).join("");
  return `<option value="">선택 안 함</option>` + html;
}

// ---------------- 부채 상환 ----------------
// 나의 부채 → 부채 상환: 고른 부채를 줄이고, 고른 자산(통장 등)에서 같은 금액을 뺀다.
// 자산이동 내역으로 기록하고, 실제로 바꾼 값들을 내역의 deltas에 남겨 수정·삭제 때 정확히 되돌린다.
// 지출이 아니므로(이미 부채로 잡힌 돈을 갚는 것) 지출·이번달 현재에는 영향을 주지 않는다.

/**
 * existing: 수정할 상환 내역(없으면 새로)
 * presetDebt: 미리 고를 부채 id
 * onDone: 닫은 뒤 할 일(나의 부채 창으로 돌아가기 등)
 */
function openRepayDialog({ existing = null, presetDebt = "", onDone = closeModal, preset = null, replaces = null } = {}) {
  const prevDebt = existing?.deltas?.find((d) => d.col === "debts");
  const prevAsset = existing?.deltas?.find((d) => d.col === "assets");
  // 이자: 상환과 같이 낸 이자는 '금융/이자' 고정지출로 따로 기록하고 상환 내역에 연결해 둔다
  const prevInterest = existing?.interestTx && S.transactions[existing.interestTx];
  const liveInterest = prevInterest && !prevInterest.deleted ? prevInterest : null;
  const draft = {
    interest: liveInterest?.amount || 0,
    debt: existing ? linkKey("debts", prevDebt?.id) : presetDebt ? linkKey("debts", presetDebt) : "",
    asset: prevAsset ? linkKey("assets", prevAsset.id) : preset?.asset || "",
    amount: existing?.amount || preset?.amount || 0,
    date: existing?.date || preset?.date || todayStr(),
    time: existing ? existing.time || "" : preset?.time || nowTime(),
    memo: existing?.memo || preset?.memo || "",
  };
  let confirmDelete = false;
  let amountTouched = !!existing || !!preset?.amount; // 넘겨받은 금액은 부채를 골라도 덮어쓰지 않음
  let addStart = true; // 부채보다 많이 갚으면 '시작 잔액에 더하기' (기본 체크)

  /** 부채 잔액(이 내역이 이미 갚은 만큼은 되돌린 상태로 계산) */
  const debtBalance = (ref) => {
    const d = ref && S.debts[ref.id];
    if (!d) return null;
    const already = prevDebt && prevDebt.id === ref.id ? -prevDebt.amount : 0;
    return balanceOf("debts", d) + already;
  };

  const draw = () => {
    const debtRef = parseLinkKey(draft.debt);
    const debt = debtRef && S.debts[debtRef.id];
    const cur = debt ? curOf(debt) : "KRW";
    const panel = openModal({
      cls: "theme-debts",
      title: existing ? "부채 상환 수정" : replaces ? "내역 수정" : "부채 상환",
      body: `
        ${natureSelect("repay")}
        <div class="field"><label>상환할 부채</label>
          <select class="input" name="debt">${holdingOptions(["debts"], draft.debt).replace("선택 안 함", "부채를 골라 주세요")}</select>
          <div class="fx-hint" data-debt-hint></div>
          <div class="start-fix" data-start-fix hidden>
            <p data-start-msg></p>
            <label class="check-line"><input type="checkbox" name="addStart" ${addStart ? "checked" : ""}> 네, 앱 쓰기 전 사용분이에요 · 시작 잔액에 더하기</label>
          </div>
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
        <div class="field"><label>상환 금액 <span class="muted">(원금)</span></label>
          <div class="amount-wrap" data-long="${cur !== "KRW"}">
            <input class="input amount-input" name="amount" inputmode="decimal" autocomplete="off" placeholder="0" value="${toInput(draft.amount, cur)}">
            <span class="amount-unit">${unitLabel(cur)}</span>
          </div>
        </div>
        <div class="field"><label>이자 <span class="muted">(선택 · 대출 원리금 낼 때)</span></label>
          <div class="amount-wrap" data-long="${cur !== "KRW"}">
            <input class="input amount-input" name="interest" inputmode="decimal" autocomplete="off" placeholder="0" value="${toInput(draft.interest, cur)}">
            <span class="amount-unit">${unitLabel(cur)}</span>
          </div>
          <p class="note" style="margin-top:6px">원금은 부채에서 빠지고, 이자는 지출(${INTEREST_CAT})로 기록돼요. 이자만 기록하려면 상환 금액을 0으로 두세요. 출금 자산을 비우면 이자는 이 부채에 더해져요(마통 이자 자동 차감처럼).</p>
        </div>
        <div class="field"><label>메모</label><input class="input" name="memo" placeholder="예: 10월 카드값" value="${esc(draft.memo)}"></div>
        ${existing && !S.transactions[existing.id]?.recurId && draft.amount > 0 ? `<button class="btn fav-add-btn rec-add-btn" data-act="add-recur">${HOME_ICONS.반복} 반복 내역으로 등록 <span class="muted">(매달 ${Number(existing.date.slice(8))}일)</span></button>` : ""}
        <div class="btn-row">
          ${existing ? `<button class="btn danger" data-act="delete">${confirmDelete ? "한 번 더 누르면 삭제" : "삭제"}</button>` : `<button class="btn" data-act="cancel">취소</button>`}
          <button class="btn primary" data-act="save">${existing || replaces ? "저장" : "상환하기"}</button>
        </div>`,
    });
    const $p = (s) => panel.querySelector(s);
    const read = () => {
      draft.debt = $p("[name=debt]").value;
      draft.asset = $p("[name=asset]").value;
      draft.amount = parseMoney($p("[name=amount]").value, cur);
      draft.interest = parseMoney($p("[name=interest]").value, cur);
      draft.date = $p("[name=date]").value;
      draft.time = $p("[name=time]").value;
      draft.memo = $p("[name=memo]").value;
    };
    const amt = $p("[name=amount]");
    const hints = () => {
      const bal = debtBalance(debtRef);
      const pay = parseMoney(amt.value, cur);
      const over = debt ? roundFor(pay - bal, cur) : 0;
      $p("[data-start-fix]").hidden = !(over > 0);
      if (over > 0) $p("[data-start-msg]").textContent = `${debt.name}에 기록된 부채보다 ${formatMoney(over, cur)} 많아요. 앱을 쓰기 전에 사용한 대금(예: 지난달 카드값)인가요?`;
      const fixOn = over > 0 && $p("[name=addStart]").checked;
      const aRef = parseLinkKey($p("[name=asset]").value);
      const addInt = aRef ? 0 : parseMoney($p("[name=interest]").value, cur); // 출금 자산이 없으면 이자는 부채에 더해짐(마통 이자 자동 차감)
      $p("[data-debt-hint]").textContent = debt
        ? `현재 ${formatMoney(bal, cur)} → ${pay ? "상환 후" : "기록 후"} ${formatMoney(roundFor(bal - pay + addInt + (fixOn ? over : 0), cur), cur)}${addInt ? ` (이자 ${formatMoney(addInt, cur)} 더해짐)` : ""}${over > 0 && !fixOn ? " (잔액보다 많아요)" : ""}`
        : "";
      const a = aRef && S.assets[aRef.id];
      if (!a || !debt) { $p("[data-asset-hint]").textContent = ""; return; }
      const intr = parseMoney($p("[name=interest]").value, cur);
      const total = pay + intr;
      const out = amountInCurrency({ currency: cur, amount: total, krw: toKRW(total, cur) }, curOf(a));
      $p("[data-asset-hint]").textContent = out === null ? "환율 정보가 없어 반영할 수 없어요" : total
        ? `${a.name}에서 -${formatMoney(roundFor(out, curOf(a)), curOf(a))} 빠져나가요${intr ? ` (원금 ${formatMoney(pay, cur)} + 이자 ${formatMoney(intr, cur)})` : ""}${out > balanceOf("assets", a) ? " (잔액보다 많아요)" : ""}`
        : "";
    };
    amt.addEventListener("input", () => { amt.value = formatInput(amt.value, cur); amountTouched = true; hints(); });
    $p("[name=nature]").onchange = (e) => {
      read();
      goNature(e.target.value, { amount: draft.amount, date: draft.date, time: draft.time, text: draft.memo, asset: draft.asset }, existing || replaces);
    };
    const intIn = $p("[name=interest]");
    intIn.addEventListener("input", () => { intIn.value = formatInput(intIn.value, cur); hints(); });
    $p("[name=asset]").addEventListener("change", hints);
    $p("[name=addStart]").onchange = (e) => { addStart = e.target.checked; hints(); };
    $p("[name=asset]").onchange = hints;
    $p("[name=debt]").onchange = () => {
      read();
      const ref = parseLinkKey(draft.debt);
      // 카드·마통 등 단기 부채는 처음엔 남은 전액으로 채움(대출은 원금 일부를 갚으므로 비워 둠)
      if (ref && !amountTouched) draft.amount = SHORT_DEBT[debtType(S.debts[ref.id])] ? Math.max(0, debtBalance(ref)) : 0;
      draw();
    };
    hints();

    const cancel = $p("[data-act=cancel]");
    if (cancel) cancel.onclick = () => onDone();
    const addRecur = $p("[data-act=add-recur]");
    if (addRecur) addRecur.onclick = async () => {
      read();
      if (await registerRecurring(existing, { nature: "repay", amount: draft.amount, currency: cur, repay: { debt: draft.debt, asset: draft.asset, memo: draft.memo } })) draw();
    };
    $p("[data-act=save]").onclick = async () => {
      read();
      const ref = parseLinkKey(draft.debt);
      const d = ref && S.debts[ref.id];
      if (!d || d.deleted) return toast("상환할 부채를 골라 주세요.");
      if (draft.amount <= 0 && !(draft.interest > 0)) return toast("상환 금액이나 이자를 입력해 주세요.");
      if (draft.amount < 0) return toast("상환 금액을 확인해 주세요.");
      if (!draft.date) return toast("날짜를 입력해 주세요.");
      const now = nowISO();
      const dcur = curOf(d);
      const over = roundFor(draft.amount - debtBalance(ref), dcur); // 저장 전에 계산(이 상환이 반영되기 전 잔액 기준)
      const curTx = existing && S.transactions[existing.id];
      const recurOf = curTx?.recurId ? { id: curTx.recurId, month: curTx.recurMonth } : preset?.recur || null;
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
      // 이자: 같은 출금 자산에서 나간 고정지출(금융/이자)로 기록. 비우면 기존 이자 기록은 지운다.
      let interestId = liveInterest?.id || null;
      if (draft.interest > 0) {
        const ikrw = dcur === "KRW" ? draft.interest : toKRW(draft.interest, dcur);
        if (ikrw === null) return toast("환율 정보가 없어 반영할 수 없어요.");
        let iDelta = null;
        if (aRef) {
          const a = S.assets[aRef.id];
          const iout = amountInCurrency({ currency: dcur, amount: draft.interest, krw: ikrw }, curOf(a));
          if (iout === null) return toast("환율 정보가 없어 반영할 수 없어요.");
          iDelta = { col: "assets", id: a.id, amount: -roundFor(iout, curOf(a)) };
        } else {
          iDelta = { col: "debts", id: d.id, amount: draft.interest }; // 출금 자산 없음: 이자가 부채에 더해짐(마통 이자)
        }
        interestId ||= uid();
        S.transactions[interestId] = {
          ...(liveInterest || {}),
          id: interestId, date: draft.date, time: draft.time || "", kind: "지출", expenseType: "고정",
          category: liveInterest?.category || INTEREST_CAT, subcategory: liveInterest?.subcategory || "",
          currency: dcur, amount: draft.interest, ...(dcur !== "KRW" ? { krw: Math.round(ikrw) } : {}),
          content: `${d.name} 이자`, party: liveInterest?.party || "", memo: liveInterest?.memo || "",
          ...(iDelta ? { assetDelta: iDelta } : {}),
          interest: true, // 단기 부채로 결제돼도 지출로 센다
          repayOf: existing?.id || null,
          createdAt: liveInterest?.createdAt || now, updatedAt: now, deleted: false,
        };
        if (!iDelta) delete S.transactions[interestId].assetDelta;
      } else if (liveInterest) {
        S.transactions[liveInterest.id] = { ...liveInterest, deleted: true, updatedAt: now };
        interestId = null;
      }
      const rec = {
        id: existing?.id || uid(),
        date: draft.date,
        time: draft.time || "",
        kind: "자산이동",
        expenseType: "",
        category: "",
        currency: dcur,
        amount: draft.amount,
        ...(dcur !== "KRW" ? { krw: Math.round(krw) } : {}),
        content: `${d.name} 상환`,
        party: "",
        memo: draft.memo.trim(),
        deltas,
        ...(interestId ? { interestTx: interestId } : {}),
        ...(recurOf ? { recurId: recurOf.id, recurMonth: recurOf.month } : {}),
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        deleted: false,
      };
      if (draft.amount > 0) {
        if (interestId) S.transactions[interestId].repayOf = rec.id;
        S.transactions[rec.id] = rec;
      } else {
        // 이자만: 상환 내역은 만들지 않고(고치던 상환은 지움) 이자 지출만 남긴다
        if (existing) S.transactions[existing.id] = { ...existing, deleted: true, updatedAt: now };
        if (interestId) S.transactions[interestId].repayOf = null;
      }
      if (replaces) dropTx(replaces, now);
      // 앱 쓰기 전 사용분: 기록된 부채보다 많이 갚은 만큼 시작 잔액(base)을 올려 0원에서 끝나게
      if (over > 0 && addStart) S.debts[d.id] = { ...S.debts[d.id], base: roundFor((S.debts[d.id].base || 0) + over, dcur), updatedAt: now };
      await saveState(S);
      scheduleSync();
      onDone();
      toast(draft.amount > 0
        ? `${d.name} ${formatMoney(draft.amount, dcur)} 상환했어요${draft.interest > 0 ? ` · 이자 ${formatMoney(draft.interest, dcur)} → 지출` : ""}`
        : `${d.name} 이자 ${formatMoney(draft.interest, dcur)} 지출로 기록했어요${aRef ? "" : ` · ${d.name}에 더해짐`}`);
    };
    const del = $p("[data-act=delete]");
    if (del) del.onclick = async () => {
      if (!confirmDelete) { read(); confirmDelete = true; return draw(); }
      const now = nowISO();
      S.transactions[existing.id] = { ...existing, deleted: true, updatedAt: now };
      if (liveInterest) S.transactions[liveInterest.id] = { ...liveInterest, deleted: true, updatedAt: now }; // 함께 낸 이자 기록도
      await saveState(S);
      scheduleSync();
      onDone();
      toast(`상환 기록을 삭제했어요${liveInterest ? " · 이자 기록도" : ""} · 잔액도 되돌렸어요`);
    };
  };
  draw();
}

// ---------------- 대출 실행 ----------------
// 대출을 받으면 부채(+)와 받은 돈이 들어간 자산(+)이 함께 늘어난다. 수입이 아니므로 수입·지출 합계에는 넣지 않는다.
/** 대출 실행 내역 만들기/고치기 (rec: 기존 내역 또는 null) */
function saveLoanTx({ existing = null, debt, asset, amount, date, time, memo }) {
  const now = nowISO();
  const dcur = curOf(debt);
  const krw = dcur === "KRW" ? amount : toKRW(amount, dcur);
  if (krw === null) return "환율 정보가 없어 반영할 수 없어요.";
  const deltas = [{ col: "debts", id: debt.id, amount }];
  if (asset) {
    const inn = amountInCurrency({ currency: dcur, amount, krw }, curOf(asset));
    if (inn === null) return "환율 정보가 없어 반영할 수 없어요.";
    deltas.push({ col: "assets", id: asset.id, amount: roundFor(inn, curOf(asset)) });
  }
  const id = existing?.id || uid();
  S.transactions[id] = {
    id, date, time: time || "", kind: "자산이동", expenseType: "", category: "", subcategory: "",
    currency: dcur, amount, ...(dcur !== "KRW" ? { krw: Math.round(krw) } : {}),
    content: debt.name, party: "", // 뱃지에 '대출 실행'이 있으므로 내용은 부채 이름만
    memo: (memo || "").trim(), deltas,
    createdAt: existing?.createdAt || now, updatedAt: now, deleted: false,
  };
  return null;
}

/** 부채 발생(대출 실행·돈 빌림) 기록하기 / 고치기·삭제 */
function openLoanDialog({ existing = null, presetDate = "", onBack = null, preset = null, replaces = null } = {}) {
  const prevDebt = existing?.deltas.find((d) => d.col === "debts");
  const prevAsset = existing?.deltas.find((d) => d.col === "assets");
  const draft = existing
    ? { debt: linkKey("debts", prevDebt.id), asset: prevAsset ? linkKey("assets", prevAsset.id) : "", amount: existing.amount,
      date: existing.date, time: existing.time || "", memo: existing.memo || "" }
    : { debt: "", asset: preset?.asset || "", amount: preset?.amount || 0, date: preset?.date || presetDate || todayStr(), time: preset?.time || nowTime(), memo: preset?.memo || "" };
  let confirmDelete = false;
  const draw = () => {
    const debt = S.debts[parseLinkKey(draft.debt)?.id];
    const cur = debt ? curOf(debt) : "KRW";
    const panel = openModal({
      cls: "theme-debts",
      title: existing ? "대출 실행 수정" : replaces ? "내역 수정" : "부채 발생",
      body: `
        ${natureSelect("borrow")}
        ${existing ? "" : `<p class="note kp-lead">이미 등록된 부채(대출·마이너스 통장·지인에게 빌린 돈 등)가 늘어났을 때 기록해요.</p>`}
        <div class="field"><label>${existing ? "대출(부채)" : "늘어난 부채"}</label>
          <select class="input" name="debt">${holdingOptions(["debts"], draft.debt, { balance: false }).replace("선택 안 함", "부채를 골라 주세요")}</select>
          ${existing ? "" : `<div class="holding-help"><span>처음 생긴 부채라면</span><button class="reg-link" data-new-debt>+ 새 부채 등록</button></div>
          <p class="note" style="margin-top:4px">새 부채는 등록하면서 '받은 돈 입금 자산'을 고르면 부채 발생까지 함께 기록돼요.</p>`}</div>
        <div class="field"><label>받은 돈 입금 자산</label>
          <select class="input" name="asset">${holdingOptions(["assets"], draft.asset, { balance: false })}</select></div>
        <div class="field"><label>날짜 · 시간</label>
          <div class="money-line">
            <input class="input" type="date" name="date" value="${draft.date}">
            <input class="input time-input" type="time" name="time" value="${draft.time}">
          </div></div>
        <div class="field"><label>${existing ? "대출 금액" : "늘어난 금액"}</label>
          <div class="amount-wrap" data-long="${cur !== "KRW"}">
            <input class="input amount-input" name="amount" inputmode="decimal" autocomplete="off" placeholder="0" value="${toInput(draft.amount, cur)}">
            <span class="amount-unit">${unitLabel(cur)}</span>
          </div></div>
        <div class="field"><label>메모</label><input class="input" name="memo" placeholder="예: 주택 구입 자금" value="${esc(draft.memo)}"></div>
        <p class="note">부채 발생(대출 실행)은 수입이 아니에요. 부채와 입금 자산이 같이 늘어나요.</p>
        <div class="btn-row">
          ${existing ? `<button class="btn danger" data-act="delete">${confirmDelete ? "한 번 더 누르면 삭제" : "삭제"}</button>` : ""}
          <button class="btn primary" data-act="save">저장</button>
        </div>`,
    });
    const $p = (q) => panel.querySelector(q);
    const read = () => {
      draft.debt = $p("[name=debt]").value; draft.asset = $p("[name=asset]").value;
      draft.amount = parseMoney($p("[name=amount]").value, cur);
      draft.date = $p("[name=date]").value; draft.time = $p("[name=time]").value; draft.memo = $p("[name=memo]").value;
    };
    const amt = $p("[name=amount]");
    amt.addEventListener("input", () => { amt.value = formatInput(amt.value, cur); });
    $p("[name=debt]").onchange = () => { read(); draw(); };
    if (onBack) $p("[data-close]").onclick = onBack;
    $p("[name=nature]").onchange = (e) => {
      read();
      goNature(e.target.value, { amount: draft.amount, date: draft.date, time: draft.time, text: draft.memo, asset: draft.asset }, existing || replaces, { onBack });
    };
    const newDebt = $p("[data-new-debt]");
    if (newDebt) newDebt.onclick = () => {
      read();
      openHoldingsDialog("debts", { startAdd: true, onDone: (id) => { if (id) { closeModal(); render(); } else openLoanDialog({ presetDate, onBack, preset: draft, replaces }); } });
    };
    $p("[data-act=save]").onclick = async () => {
      read();
      const d = S.debts[parseLinkKey(draft.debt)?.id];
      if (!d || d.deleted) return toast("부채를 골라 주세요.");
      if (draft.amount <= 0) return toast("금액을 입력해 주세요.");
      const aRef = parseLinkKey(draft.asset);
      const a = aRef && S.assets[aRef.id];
      const err = saveLoanTx({ existing, debt: d, asset: a && !a.deleted ? a : null, amount: draft.amount, date: draft.date, time: draft.time, memo: draft.memo });
      if (err) return toast(err);
      if (replaces) dropTx(replaces);
      closeModal();
      await commit();
      toast(existing ? "대출 실행 기록을 고쳤어요" : `${d.name} ${formatMoney(draft.amount, curOf(d))} 부채 발생을 기록했어요`);
    };
    if (existing) $p("[data-act=delete]").onclick = async () => {
      if (!confirmDelete) { read(); confirmDelete = true; return draw(); }
      S.transactions[existing.id] = { ...existing, deleted: true, updatedAt: nowISO() };
      closeModal();
      await commit();
      toast("대출 실행 기록을 삭제했어요 · 잔액도 되돌렸어요");
    };
  };
  draw();
}

// 내역 추가/수정
// 외화 내역은 원래 금액(amount, currency)과 입력 당시 원화 금액(krw)을 함께 저장한다.
// 원화 금액은 환율로 자동 계산되지만, 실제 입금·결제된 원화로 직접 고칠 수 있다.
/** 새 내역의 기본값 (kind·expenseType 등을 덮어쓸 수 있음) */
function newTxDraft(presetDate, over = {}) {
  const d = { kind: "지출", expenseType: "고정", date: presetDate || todayStr(), time: nowTime(), currency: "KRW", amount: 0, krw: 0, content: "", party: "", memo: "", ...over };
  d.category = d.kind === "자산이동" ? "" : catsFor(d.kind, d.kind === "지출" ? d.expenseType : null)[0] || "";
  return d;
}

/** 새 내역 추가 1단계: 내역 성격부터 고른다 (수정할 때는 이 화면 없이 바로 입력 창) */
const PICK_ITEMS = [
  { key: "income", cls: "inc", icon: "수입", name: "수입", desc: "급여·용돈·이자처럼 들어온 돈" },
  { key: "fixed", cls: "exp", icon: "지출", name: "고정지출", desc: "월세·통신비·보험료처럼 매달 나가는 돈" },
  { key: "var", cls: "exp", icon: "지출", name: "변동지출", desc: "식비·쇼핑처럼 그때그때 쓴 돈 (현금·체크카드·계좌이체)" },
  { key: "move", cls: "mov", icon: "자산이동", name: "자산이동", desc: "내 통장·현금·증권 사이에서 옮긴 돈" },
  { key: "card", cls: "cred", icon: "단기부채", name: "신용카드 사용", desc: "*신용카드 사용은 지출이 아닌 부채로 잡혀요" },
  { key: "minus", cls: "cred", icon: "단기부채", name: "마이너스 통장 사용", desc: "*마이너스 통장에서 쓴 돈도 지출이 아닌 부채로 잡혀요" },
  { key: "borrow", cls: "cred", icon: "대출실행", name: "부채 발생", desc: "대출을 받거나 돈을 빌림 · 수입이 아니에요" },
  { key: "repay", cls: "repay", icon: "부채상환", name: "부채 상환", desc: "카드 대금·마통·대출금 갚기 · 지출이 아니에요" },
];
const CARD_MODES = ["신용카드", "마이너스통장"]; // 지출이지만 단기 부채로 잡히는 사용
/** 그 종류 부채가 하나뿐이면 그것 */
function onlyDebt(type) {
  const list = Object.values(S.debts).filter((a) => !a.deleted && debtType(a) === type);
  return list.length === 1 ? linkKey("debts", list[0].id) : "";
}
/** 내역 창 draft → 내역 성격 키 */
function natureOf(d) {
  if (d.kind === "수입") return "income";
  if (d.kind === "자산이동") return "move";
  if (d.debtMode === "신용카드") return "card";
  if (d.debtMode === "마이너스통장") return "minus";
  return d.expenseType === "변동" ? "var" : "fixed";
}
/** 내역 성격 → 내역 창 draft 값 (prevLink: 지금 고른 자산·부채, 맞으면 유지) */
function natureDraft(key, prevLink = "") {
  const ref = parseLinkKey(prevLink);
  const type = ref?.col === "debts" ? debtType(S.debts[ref.id]) : "";
  const asset = ref?.col === "assets" ? prevLink : "";
  switch (key) {
    case "income": return { kind: "수입", debtMode: "", link: asset };
    case "fixed": case "var": return { kind: "지출", expenseType: key === "fixed" ? "고정" : "변동", debtMode: "", link: CARD_MODES.includes(type) ? "" : prevLink };
    case "move": return { kind: "자산이동", debtMode: "", ...(asset ? { fromAsset: asset } : {}) };
    case "card": case "minus": {
      const mode = key === "card" ? "신용카드" : "마이너스통장";
      return { kind: "지출", expenseType: "변동", debtMode: mode, link: type === mode ? prevLink : onlyDebt(mode) };
    }
  }
  return {};
}
/** 내역 성격 셀렉트 (모든 입력 창 맨 위) */
function natureSelect(key) {
  const cur = PICK_ITEMS.find((it) => it.key === key);
  return `<div class="field nature-field"><label>내역 성격</label>
    <select class="input nature-sel ${cur?.cls || ""}" name="nature">${PICK_ITEMS.map((it, i) =>
      `<option value="${it.key}" ${it.key === key ? "selected" : ""}>${"①②③④⑤⑥⑦⑧"[i]} ${it.name}</option>`).join("")}</select></div>`;
}
/** 다른 성격의 창으로 넘어가기. c: 이어받을 값 {date, time, amount, text, asset}, replaces: 저장하면 지울 원래 내역 */
function goNature(key, c, replaces = null, { onBack = null } = {}) {
  const done = () => { closeModal(); render(); };
  if (key === "repay") return openRepayDialog({ preset: { amount: c.amount, date: c.date, time: c.time, memo: c.text, asset: c.asset || "" }, replaces, onDone: done });
  if (key === "borrow") return openLoanDialog({ preset: { amount: c.amount, date: c.date, time: c.time, memo: c.text, asset: c.asset || "" }, replaces, onBack });
  openTxDialog(null, null, newTxDraft(c.date, { ...natureDraft(key, c.asset || ""), amount: c.amount || 0, time: c.time || nowTime(), content: c.text || "" }), { replaces });
}
/** 성격을 바꿔 다른 창에서 저장할 때 원래 내역(과 연결된 이자 기록)을 지운다 */
function dropTx(t, now = nowISO()) {
  const cur = S.transactions[t.id];
  if (!cur || cur.deleted) return;
  S.transactions[t.id] = { ...cur, deleted: true, updatedAt: now };
  const it = cur.interestTx && S.transactions[cur.interestTx];
  if (it && !it.deleted) S.transactions[it.id] = { ...it, deleted: true, updatedAt: now };
}

function openKindPicker(presetDate) {
  const panel = openModal({
    cls: "kind-picker",
    title: "내역 추가",
    headExtra: `<button class="icon-only star-btn" data-act="favs" aria-label="자주 쓰는 내역">${STAR}</button>`,
    body: `
      <p class="kp-intro">내역을 추가하시나요?<br>그러면 아래에서 <span class="kp-em">내역 성격</span>부터 정해 주세요.</p>
      <div class="kp-list">${PICK_ITEMS.map((it, i) => `
        <button class="kp-item" data-pick="${it.key}">
          <span class="kp-num">${"①②③④⑤⑥⑦⑧"[i]}</span>
          <span class="kp-ico ${it.cls}">${HOME_ICONS[it.icon]}</span>
          <span class="kp-text"><span class="kp-name ${it.cls}">${it.name}</span><span class="kp-desc">${it.desc}</span></span>
          <span class="kp-go">›</span>
        </button>`).join("")}</div>`,
  });
  const back = () => openKindPicker(presetDate);
  panel.querySelectorAll("[data-pick]").forEach((b) => (b.onclick = () =>
    goNature(b.dataset.pick, { date: presetDate || todayStr(), time: nowTime(), amount: 0, text: "" }, null, { onBack: back })));
  panel.querySelector("[data-act=favs]").onclick = () => openFavorites({
    onPick: (f) => { const d = applyFav(newTxDraft(presetDate), f); delete d.debtMode; openTxDialog(null, null, d); },
    onBack: back,
  });
}

function openTxDialog(existing, presetDate, preset = null, { replaces = null } = {}) {
  if (existing && isRepayTx(existing)) return openRepayDialog({ existing }); // 상환 기록은 상환 창에서 고친다
  if (existing && isLoanTx(existing)) return openLoanDialog({ existing }); // 대출 실행 기록은 대출 창에서
  const draft = preset ? { ...preset } : existing ? { currency: "KRW", ...existing } : newTxDraft(presetDate);
  let confirmDelete = false;
  let krwTouched = !!existing?.krw; // 원화 금액을 직접 고쳤으면 자동 계산으로 덮어쓰지 않음
  if (existing) { const d = deltaRef(existing.assetDelta); draft.link = d ? linkKey(d.col, d.id) : ""; }
  if (existing && !preset) draft.pay = existing.card ? "card" : existing.transfer ? "transfer" : ""; // 은행 계좌 결제 수단
  // 신용카드·마이너스통장으로 쓴 지출이면 '신용카드 사용'·'마이너스 통장 사용'으로 연다(이자 기록은 지출 그대로)
  if (draft.kind === "지출" && draft.debtMode === undefined) {
    const r = parseLinkKey(draft.link);
    const t = r?.col === "debts" && !draft.interest ? debtType(S.debts[r.id]) : "";
    draft.debtMode = CARD_MODES.includes(t) ? t : "";
  }
  // 자산이동: 출금 자산 → 입금 자산
  const prevOut = existing?.deltas?.find((d) => d.col === "assets" && d.amount < 0);
  const prevIn = existing?.deltas?.find((d) => d.col === "assets" && d.amount > 0);
  if (!preset) {
    draft.fromAsset = prevOut ? linkKey("assets", prevOut.id) : "";
    draft.toAsset = prevIn ? linkKey("assets", prevIn.id) : "";
  }

  refreshRates(); // 외화를 고를 때를 대비해 환율 준비

  const draw = () => {
    const cardMode = draft.kind === "지출" && CARD_MODES.includes(draft.debtMode);
    // 카드·마통 사용은 고정/변동을 묻지 않고, 카테고리를 고정·변동 묶음으로 함께 보여 준다(고른 카테고리를 따라감)
    const catList = cardMode ? EXPENSE_TYPES.flatMap((et) => catsFor("지출", et)) : catsFor(draft.kind, draft.kind === "지출" ? draft.expenseType : null);
    if (!catList.includes(draft.category) && !(existing && existing.kind === draft.kind && existing.category === draft.category)) draft.category = catList[0] || "";
    if (draft.category && !catList.includes(draft.category)) catList.push(draft.category); // 지워진 카테고리를 쓰던 내역
    const foreign = draft.currency !== "KRW";
    const debtMode = cardMode ? draft.debtMode : ""; // 신용카드 사용·마이너스통장 사용
    const linkCfg = linkCfgOf(draft);
    const optOf = (c) => `<option ${c === draft.category ? "selected" : ""}>${esc(c)}</option>`;
    const catOpts = cardMode
      ? EXPENSE_TYPES.map((et) => `<optgroup label="${et}지출">${catsFor("지출", et).map(optOf).join("")}</optgroup>`).join("")
        + catList.filter((c) => !EXPENSE_TYPES.some((et) => catsFor("지출", et).includes(c))).map(optOf).join("")
      : catList.map(optOf).join("");
    const panel = openModal({
      title: existing || replaces ? "내역 수정" : debtMode ? `${SHORT_DEBT[debtMode].title}` : "내역 추가",
      headExtra: existing || replaces ? "" : `<button class="icon-only star-btn" data-act="favs" aria-label="자주 쓰는 내역">${STAR}</button>`,
      body: `
        ${natureSelect(natureOf(draft))}
        ${draft.recurId && S.recurring?.[draft.recurId] ? `<p class="note rc-tag">${HOME_ICONS.반복} 반복 내역 · ${Number((draft.recurMonth || "").slice(5))}월분</p>` : ""}
        <div class="field"><label>날짜 · 시간 <span class="req">*</span></label>
          <div class="money-line">
            <input class="input" type="date" name="date" value="${draft.date}">
            <input class="input time-input" type="time" name="time" value="${draft.time || ""}">
          </div>
        </div>
        <div class="field"><label>금액 <span class="req">*</span></label>
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
        <div class="field"><label>${linkCfg.label} <span class="req">*</span></label>
          <select class="input" name="asset">${holdingOptions(linkCfg.cols, draft.link, { balance: false, onlyType: debtMode, exclude: linkCfg.exclude || [] })}</select>
          <div class="fx-hint tx-hint ${KIND_CLASS[draft.kind]}" data-asset-hint></div>
          ${holdingHelp(linkCfg.help || linkCfg.cols)}
          ${debtMode === "신용카드" ? `<div class="field inst-field"><label>할부</label>
            <select class="input" name="inst">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 18, 24, 36].map((n) => `<option value="${n}" ${(draft.inst || 1) === n ? "selected" : ""}>${n === 1 ? "일시불" : `${n}개월`}</option>`).join("")}</select></div>` : ""}
          ${debtMode ? `<p class="note debt-mode-note">${SHORT_DEBT[debtMode].label} 사용은 지출이 아니라 <span class="cred">단기 부채</span>로 잡혀요. 나중에 대금을 낼 때는 '부채 상환'으로 기록해요.</p>` : ""}
          ${draft.kind === "지출" && !debtMode ? `<div class="repay-tip" data-repay-tip>
            <span>신용카드 대금·마이너스 통장 대금·대출금을 갚는 거라면 지출이 아니라 <b class="tip-em">부채 상환</b>이에요. 부채 상환으로 내역을 저장해주세요.</span>
            <button class="reg-link repay-link" data-go-repay>부채 상환 바로가기</button>
          </div>` : ""}
        </div>
        ${draft.kind === "지출" ? `<div class="field" data-pay-field hidden><label>결제 수단 <span class="req">*</span></label>
          <select class="input" name="pay"></select></div>` : ""}` : ""}
        ${draft.kind === "자산이동" ? `
        <div class="field"><label>출금 자산 <span class="req">*</span></label>
          <select class="input" name="fromAsset">${holdingOptions(["assets"], draft.fromAsset, { balance: false })}</select>
          <div class="fx-hint tx-hint exp" data-from-hint></div>
          ${holdingHelp(["assets"])}
        </div>
        <div class="flow-arrow" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v15"/><path d="M6.5 13.5 12 19l5.5-5.5"/></svg></div>
        <div class="field flow-to"><label>입금 자산 <span class="req">*</span></label>
          <select class="input" name="toAsset">${holdingOptions(["assets"], draft.toAsset, { balance: false })}</select>
          <div class="fx-hint tx-hint inc" data-to-hint></div>
        </div>` : ""}
        <div class="field"><label>내용 <span class="req">*</span></label><input class="input" name="content" placeholder="${draft.kind === "수입" ? "예: 10월 급여" : draft.kind === "자산이동" ? "예: 비상금 통장으로 이체" : "예: 점심 식사"}" value="${esc(draft.content || "")}"></div>
        ${draft.kind !== "자산이동" ? `<div class="field"><label>거래처/출처</label><input class="input" name="party" placeholder="${draft.kind === "수입" ? "예: (주)회사명 / 통장에 입력된 내역 이름" : "예: 김밥천국 / 통장에 입력된 내역 이름"}" value="${esc(draft.party || "")}"></div>
        ` : ""}
        ${draft.kind !== "자산이동" ? `<div class="field"><label>카테고리 · 하위 카테고리 <span class="req">*</span></label>
          <div class="money-line">
            <select class="input half" name="category">${catOpts}</select>
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
        </div>` : ""}
        ${draft.kind !== "자산이동" ? `<div class="field"><label>메모</label>
          <div class="money-line">
            <input class="input" name="memo" placeholder="자유롭게 메모" value="${esc(draft.memo)}">
            <button class="icon-only photo-btn" data-act="add-photo" aria-label="영수증 사진 추가">${CAMERA}</button>
          </div>
          <input type="file" accept="image/*" multiple data-photo-file hidden>
          ${draft.photos?.length ? `<div class="photo-strip">${draft.photos.map((id) => `
            <div class="photo-thumb" data-photo="${id}"><span class="pt-wait">사진</span><img alt="영수증 사진" hidden><button class="photo-del" data-photo-del="${id}" aria-label="사진 빼기">✕</button></div>`).join("")}</div>` : ""}
        </div>` : ""}
        <button class="btn fav-add-btn" data-act="add-fav">${STAR} 자주 쓰는 내역으로 등록</button>
        ${existing && !draft.recurId && !existing.interest ? `<button class="btn fav-add-btn rec-add-btn" data-act="add-recur">${HOME_ICONS.반복} 반복 내역으로 등록 <span class="muted">(매달 ${Number(existing.date.slice(8))}일)</span></button>` : ""}
        <div class="btn-row">
          ${existing ? `<button class="btn danger" data-act="delete">${confirmDelete ? "한 번 더 누르면 삭제" : "삭제"}</button>` : ""}
          <button class="btn primary" data-act="save">저장</button>
        </div>`,
    });
    const $p = (sel) => panel.querySelector(sel);
    // 고치기 시작하면 빨간 표시를 지움
    panel.addEventListener("input", (e) => e.target.classList?.remove("invalid"));
    panel.addEventListener("change", (e) => e.target.classList?.remove("invalid"));
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
      // 카드·마통 사용: 고른 카테고리가 고정인지 변동인지를 따라감
      if (draft.kind === "지출" && CARD_MODES.includes(draft.debtMode) && draft.category) draft.expenseType = catsFor("지출", "고정").includes(draft.category) ? "고정" : "변동";
      const sc = $p("[name=subcategory]")?.value;
      if (sc !== undefined) draft.subcategory = sc === "__add__" ? draft.subcategory || "" : sc;
      draft.content = $p("[name=content]").value;
      if ($p("[name=party]")) draft.party = $p("[name=party]").value;
      if ($p("[name=memo]")) draft.memo = $p("[name=memo]").value;
      if ($p("[name=fromAsset]")) { draft.fromAsset = $p("[name=fromAsset]").value; draft.toAsset = $p("[name=toAsset]").value; }
      if ($p("[name=asset]")) draft.link = $p("[name=asset]").value;
      const payField = $p("[data-pay-field]");
      draft.pay = payField && !payField.hidden ? $p("[name=pay]").value : "";
      if ($p("[name=inst]")) draft.inst = Number($p("[name=inst]").value);
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
      hint.className = `fx-hint tx-hint ${ref.col === "debts" ? "cred" : KIND_CLASS[draft.kind]}`; // 카드·마통 등 부채로 결제하면 핑크
      const cur = curOf(a);
      const add = amountInCurrency({ currency: curSel.value, amount: parseMoney(amt.value, curSel.value), krw: parseAmount(krwIn.value) }, cur);
      const what = ref.col === "debts" ? "부채가" : "잔액이";
      hint.textContent = add === null ? "환율 정보가 없어 반영할 수 없어요" : !add ? "" : linkSign(draft.kind, ref.col) > 0
        ? `저장하면 ${a.name} ${what} +${formatMoney(roundFor(add, cur), cur)} 늘어나요`
        : `저장하면 ${a.name} ${what} -${formatMoney(roundFor(add, cur), cur)} 줄어들어요`;
    };
    // 은행 계좌로 지출하면 결제 수단: 연결된 체크카드 / 계좌이체(출금)
    const payField = $p("[data-pay-field]");
    const refreshPay = () => {
      if (!payField) return;
      const ref = parseLinkKey(assetSel.value);
      const a = ref?.col === "assets" && S.assets[ref.id];
      payField.hidden = !(a && a.type === "은행");
      if (payField.hidden) return;
      const opts = [...(a.card ? [["card", a.card]] : []), ["transfer", "계좌이체(출금)"]];
      const want = opts.some(([v]) => v === draft.pay) ? draft.pay : opts[0][0];
      $p("[name=pay]").innerHTML = opts.map(([v, label]) => `<option value="${v}" ${v === want ? "selected" : ""}>${esc(label)}</option>`).join("");
    };
    if (assetSel) {
      assetSel.addEventListener("change", () => { draft.pay = ""; refreshPay(); });
      $p("[name=pay]")?.addEventListener("change", (e) => (draft.pay = e.target.value));
      refreshPay();
      assetSel.onchange = refreshAssetHint;
      [amt, krwIn].forEach((el) => el.addEventListener("input", refreshAssetHint));
      curSel.addEventListener("change", refreshAssetHint);
      refreshAssetHint();
    }

    // 내역 성격 바꾸기: 수입·지출·자산이동·카드·마통은 이 창에서, 부채 발생·상환은 그 창으로(값 이어받기)
    $p("[name=nature]").onchange = (e) => {
      read();
      const key = e.target.value;
      if (key === "repay" || key === "borrow") {
        const ref = parseLinkKey(draft.link);
        return goNature(key, { amount: draft.amount, date: draft.date, time: draft.time, text: draft.content,
          asset: draft.kind === "자산이동" ? draft.fromAsset : ref?.col === "assets" ? draft.link : "" }, existing || replaces);
      }
      Object.assign(draft, natureDraft(key, draft.kind === "자산이동" ? draft.fromAsset : draft.link));
      draft.subcategory = "";
      draw();
    };
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
      // 필수 항목: 빠지면 저장하지 않고 그 칸을 빨갛게 표시하고 그리로 이동
      const bad = (sel, msg) => {
        const el = $p(sel);
        if (el) { el.classList.add("invalid"); el.scrollIntoView({ block: "center" }); el.focus(); }
        toast(msg);
      };
      if (!draft.date) return bad("[name=date]", "날짜를 입력해 주세요.");
      if (draft.amount <= 0) return bad("[name=amount]", "금액을 입력해 주세요.");
      if (foreignNow && draft.krw <= 0) return bad("[name=krw]", "원화 금액을 입력해 주세요.");
      if (draft.kind === "자산이동") {
        if (!draft.fromAsset) return bad("[name=fromAsset]", "출금 자산을 골라 주세요.");
        if (!draft.toAsset) return bad("[name=toAsset]", "입금 자산을 골라 주세요.");
      }
      // 화면 위에서부터 순서대로 확인
      if (ASSET_LINK[draft.kind] && !draft.link) return bad("[name=asset]", `${linkCfgOf(draft).label}${/카드$/.test(linkCfgOf(draft).label) ? "를" : "을"} 골라 주세요.`);
      if (draft.kind === "지출" && $p("[data-pay-field]") && !$p("[data-pay-field]").hidden && !draft.pay) return bad("[name=pay]", "결제 수단을 골라 주세요.");
      if (!(draft.content || "").trim()) return bad("[name=content]", "내용을 입력해 주세요.");
      if (draft.kind !== "자산이동" && !draft.category) return bad("[name=category]", "카테고리를 골라 주세요.");
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
        draft.category = ""; // 자산이동은 카테고리 없이 출금 → 입금 자산으로 구분
        draft.subcategory = "";
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
        ...(!isMove && draft.photos?.length ? { photos: [...draft.photos] } : {}),
        ...(existing?.interest && draft.kind === "지출" ? { interest: true } : {}), // 대출·마통 이자 기록
        ...(existing?.repayOf ? { repayOf: existing.repayOf } : {}),
        ...(draft.recurId ? { recurId: draft.recurId, recurMonth: draft.recurMonth } : {}), // 반복 내역에서 기록
        ...(draft.kind === "지출" && draft.debtMode === "신용카드" && draft.inst > 1 ? { inst: draft.inst } : {}), // 할부 개월
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
        // 은행 계좌: 결제 수단(연결된 체크카드 / 계좌이체)을 그때 이름으로 기록
        if (rec.kind === "지출" && ref.col === "assets" && a.type === "은행") {
          if (draft.pay === "card" && a.card) rec.card = a.card;
          else if (draft.pay === "transfer") rec.transfer = true;
        }
      }
      // 잔액은 내역에서 계산하므로 변화만 기록한다(예전 값은 내역을 바꾸면 자연히 빠짐)
      if (delta) rec.assetDelta = delta;
      if (deltas?.length) rec.deltas = deltas;
      // 영수증 사진: 새로 고른 것은 기기에 저장, 뺀 것은 기기에서 지움
      for (const id of rec.photos || []) {
        if (pendingPhotos.has(id)) { await putPhoto({ id, blob: pendingPhotos.get(id), uploaded: false }); pendingPhotos.delete(id); }
      }
      for (const id of existing?.photos || []) if (!(rec.photos || []).includes(id)) await deletePhoto(id).catch(() => {});
      S.transactions[rec.id] = rec;
      if (replaces) dropTx(replaces, now); // 다른 성격(상환·부채 발생)에서 바꿔 온 내역
      closeModal();
      ui.month = rec.date.slice(0, 7);
      await commit();
      const target = delta && S[delta.col][delta.id];
      toast(`${rec.kind} ${formatMoney(rec.amount, rec.currency)} ${existing || replaces ? "수정" : "추가"}했어요` +
        (target ? ` · ${target.name} ${delta.amount >= 0 ? "+" : "-"}${formatMoney(Math.abs(delta.amount), curOf(target))}` : ""));
    };
    const del = $p("[data-act=delete]");
    if (del) del.onclick = async () => {
      if (!confirmDelete) { read(); confirmDelete = true; return draw(); }
      const now = nowISO();
      const prev = deltaRef(existing.assetDelta);
      S.transactions[existing.id] = { ...existing, deleted: true, updatedAt: now };
      for (const id of existing.photos || []) await deletePhoto(id).catch(() => {});
      closeModal();
      await commit();
      toast(prev ? `삭제했어요 · ${prev.col === "debts" ? "부채" : "자산 잔액"}도 되돌렸어요` : existing.deltas?.length ? "삭제했어요 · 자산 잔액도 되돌렸어요" : "삭제했어요");
    };
    // 카드 대금 등을 지출로 적으려 하면: 내용에 '카드값·대금·상환' 같은 말이 있으면 안내를 강조
    const tip = $p("[data-repay-tip]");
    if (tip) {
      const REPAY_WORDS = /카드\s*(값|대금|결제)|대금|상환|할부금|원리금|마통|마이너스/;
      const checkTip = () => tip.classList.toggle("warn", REPAY_WORDS.test($p("[name=content]").value));
      $p("[name=content]").addEventListener("input", checkTip);
      checkTip();
      $p("[data-go-repay]").onclick = () => {
        read();
        const ref = parseLinkKey(draft.link);
        goNature("repay", { amount: draft.amount, date: draft.date, time: draft.time, text: draft.content,
          asset: ref?.col === "assets" ? draft.link : "" }, existing || replaces);
      };
    }
    panel.querySelectorAll("[data-reg]").forEach((b) => (b.onclick = () => {
      read();
      const col = b.dataset.reg;
      openHoldingsDialog(col, {
        startAdd: true,
        onDone: (newId) => {
          if (newId) {
            const key = linkKey(col, newId);
            if (draft.kind === "자산이동") { if (!draft.fromAsset) draft.fromAsset = key; else if (!draft.toAsset) draft.toAsset = key; }
            else draft.link = key;
          }
          openTxDialog(existing, null, draft, { replaces });
        },
      });
    }));
    // 영수증 사진: 카메라 버튼 → 촬영/앨범, 썸네일 누르면 크게, ✕로 빼기 (저장해야 반영)
    const photoFile = $p("[data-photo-file]");
    if (photoFile) {
      $p("[data-act=add-photo]").onclick = () => photoFile.click();
      photoFile.onchange = async () => {
        const files = [...photoFile.files];
        if (!files.length) return;
        read();
        toast("사진을 줄이는 중…");
        const ids = [];
        for (const f of files) {
          try {
            const blob = await shrinkImage(f);
            const id = uid();
            pendingPhotos.set(id, blob);
            ids.push(id);
          } catch { toast("사진을 읽지 못했어요"); }
        }
        draft.photos = [...(draft.photos || []), ...ids];
        draw();
      };
      panel.querySelectorAll("[data-photo]").forEach(async (el) => {
        const blob = await photoBlob(el.dataset.photo);
        if (!blob) { el.querySelector(".pt-wait").textContent = "동기화 대기"; return; }
        const img = el.querySelector("img");
        img.src = URL.createObjectURL(blob);
        img.onload = () => URL.revokeObjectURL(img.src);
        img.hidden = false;
        el.querySelector(".pt-wait").remove();
      });
      panel.querySelectorAll("[data-photo]").forEach((el) => (el.onclick = (e) => {
        if (e.target.closest("[data-photo-del]")) return;
        openPhotoViewer(el.dataset.photo);
      }));
      panel.querySelectorAll("[data-photo-del]").forEach((b) => (b.onclick = () => {
        read();
        draft.photos = draft.photos.filter((x) => x !== b.dataset.photoDel);
        draw();
      }));
    }
    const addRecur = $p("[data-act=add-recur]");
    if (addRecur) addRecur.onclick = async () => {
      read();
      const f = favFromDraft(draft);
      f.debtMode = draft.kind === "지출" ? draft.debtMode || "" : "";
      f.pay = draft.pay || "";
      const res = await registerRecurring(existing, { nature: natureOf(draft), amount: draft.amount, currency: draft.currency, fields: f });
      if (res) { draft.recurId = res.id; draft.recurMonth = res.month; draw(); }
    };
    // 자주 쓰는 내역: 수정 창에서 등록, 추가 창의 별을 눌러 불러오기
    const addFav = $p("[data-act=add-fav]");
    if (addFav) addFav.onclick = async () => {
      read();
      const f = favFromDraft(draft);
      if (!f.amount) return toast("금액을 입력해 주세요.");
      const same = liveFavs().find((x) => favKey(x) === favKey(f));
      if (same) return toast("이미 자주 쓰는 내역에 있어요.");
      const now = nowISO();
      const id = uid();
      S.favorites[id] = { id, ...f, createdAt: now, updatedAt: now, deleted: false };
      await saveState(S);
      scheduleSync();
      toast("자주 쓰는 내역으로 등록했어요");
    };
    const favBtn = $p("[data-act=favs]");
    if (favBtn) favBtn.onclick = () => {
      read();
      openFavorites({
        onPick: (f) => { const d = applyFav(draft, f); delete d.debtMode; openTxDialog(null, null, d); },
        onBack: () => openTxDialog(null, null, draft),
      });
    };
    if (!existing && !draft.amount) amt.focus();
  };
  draw();
}

// ---------------- 자주 쓰는 내역 ----------------
const STAR = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>`;
const FAV_FIELDS = ["kind", "expenseType", "category", "subcategory", "currency", "amount", "krw", "content", "party", "memo", "link", "fromAsset", "toAsset"];
const liveFavs = () => Object.values(S.favorites || {}).filter((f) => !f.deleted).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
function favFromDraft(d) {
  const f = {};
  for (const k of FAV_FIELDS) f[k] = d[k] ?? "";
  if (f.kind !== "지출") f.expenseType = "";
  if (f.kind !== "자산이동") { f.fromAsset = ""; f.toAsset = ""; } else { f.link = ""; f.party = ""; f.memo = ""; }
  if (f.currency === "KRW") f.krw = 0;
  return f;
}
const favKey = (f) => FAV_FIELDS.map((k) => (k === "krw" ? "" : String(f[k] ?? ""))).join("|");
/** 연결된 자산·부채가 지워졌으면 비운다 */
function liveLink(key) {
  const r = key && parseLinkKey(key);
  return r && S[r.col]?.[r.id] && !S[r.col][r.id].deleted ? key : "";
}
/** 지금 창의 날짜·시간은 그대로 두고 나머지를 자주 쓰는 내역 값으로 채운다 */
function applyFav(draft, f) {
  const d = { ...draft };
  for (const k of FAV_FIELDS) d[k] = f[k] ?? "";
  if (d.kind === "지출" && !d.expenseType) d.expenseType = "고정";
  d.link = liveLink(d.link);
  d.fromAsset = liveLink(d.fromAsset);
  d.toAsset = liveLink(d.toAsset);
  d.krw = 0; // 외화면 오늘 환율로 다시 계산
  return d;
}
function favViaText(f) {
  const name = (key) => { const r = key && parseLinkKey(key); const h = r && S[r.col]?.[r.id]; return h && !h.deleted ? esc(h.name) : ""; };
  if (f.kind === "자산이동") { const a = name(f.fromAsset), b = name(f.toAsset); return a || b ? `${a || "?"} → ${b || "?"}` : ""; }
  const n = name(f.link);
  return n ? `${f.kind === "수입" ? "입금" : parseLinkKey(f.link)?.col === "debts" ? "결제" : "출금"} ${n}` : "";
}

/** 자주 쓰는 내역 목록: 누르면 onPick, ✕는 onBack(내역 추가 창으로). 편집 아이콘으로 삭제 모드 */
function openFavorites({ onPick, onBack }) {
  let editing = false;
  const draw = () => {
    const favs = liveFavs();
    const panel = openModal({
      title: "자주 쓰는 내역",
      headExtra: favs.length ? `<button class="icon-only${editing ? " on" : ""}" data-act="edit" aria-label="편집">${PENCIL}</button>` : "",
      body: favs.length ? favs.map((f) => {
        const badge = f.kind === "수입" ? "b-inc" : f.kind === "지출" ? "b-exp" : "b-mov";
        const cat = esc(f.category || "");
        const via = favViaText(f);
        const sd = shortDebtType({ kind: f.kind, assetDelta: parseLinkKey(f.link) });
        return `
        <div class="fav-row">
          <button class="tx" data-fav="${f.id}">
            <div class="left">
              <div class="badges">${f.kind === "자산이동" ? `<span class="cat-badge b-mov">자산이동</span>` : ""}${cat && f.kind !== "자산이동" ? `<span class="cat-badge ${badge}">${cat}</span>` : ""}</div>
              ${f.content ? `<div class="tx-content">${esc(f.content)}</div>` : ""}
              ${[f.party ? esc(f.party) : "", via].filter(Boolean).map((x) => `<div class="memo">${x}</div>`).join("")}
            </div>
            <span class="amt ${sd ? "cred" : KIND_CLASS[f.kind]}">${sd ? SHORT_DEBT[sd].short + " " : ""}${f.currency && f.currency !== "KRW" ? `${sd ? "" : KIND_SIGN[f.kind]}${formatMoney(f.amount, f.currency)}` : signed(f.amount, sd ? "" : KIND_SIGN[f.kind])}</span>
          </button>
          ${editing ? `<button class="btn danger fav-del" data-del="${f.id}">삭제</button>` : ""}
        </div>`;
      }).join("") + `<p class="note fav-note">${editing ? "삭제할 내역의 '삭제'를 누르세요." : "누르면 내역 추가 창에 그대로 채워져요. 날짜·시간은 지금 값이 유지돼요."}</p>`
        : `<div class="empty">자주 쓰는 내역이 없어요.<br>내역을 연 뒤 '자주 쓰는 내역으로 등록'을 눌러 추가하세요.</div>`,
    });
    panel.querySelector("[data-close]").onclick = onBack;
    const edit = panel.querySelector("[data-act=edit]");
    if (edit) edit.onclick = () => { editing = !editing; draw(); };
    panel.querySelectorAll("[data-fav]").forEach((b) => (b.onclick = () => { if (!editing) onPick(S.favorites[b.dataset.fav]); }));
    panel.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
      const f = S.favorites[b.dataset.del];
      S.favorites[f.id] = { ...f, deleted: true, updatedAt: nowISO() };
      await saveState(S);
      scheduleSync();
      toast("삭제했어요");
      draw();
    }));
  };
  draw();
}

// 나의 자산
const PENCIL = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>`;

const curOf = (a) => a.currency || "KRW"; // 예전 자산은 통화 정보가 없으면 원화
const currencyOptions = (sel) =>
  CURRENCIES.map((c) => `<option value="${c}" ${c === sel ? "selected" : ""}>${c === "KRW" ? "원 (KRW)" : `${c} · ${CURRENCY_NAMES[c]}`}</option>`).join("");

/** 원화 환산 합계. 환율을 모르는 외화가 있으면 missing에 개수를 센다. */
function krwTotal(assets, col) {
  let total = 0, missing = 0;
  for (const a of assets) {
    const v = toKRW(balanceOf(col, a), curOf(a));
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
/**
 * 끌어서 순서 바꾸기(워드프레스 메뉴처럼): 손잡이를 잡으면 줄이 떠올라 손가락을 따라 움직이고,
 * 놓일 자리는 빈 칸(점선)으로 보이며 다른 줄들은 부드럽게 비켜난다. 같은 묶음(섹션) 안에서만 움직인다.
 */
function enableReorder(panel, onDrop) {
  const overlay = panel.closest(".overlay");
  panel.querySelectorAll("[data-handle]").forEach((handle) => {
    handle.addEventListener("pointerdown", (e) => {
      const item = handle.closest(".edit-item");
      const section = item.parentElement;
      e.preventDefault();
      try { handle.setPointerCapture(e.pointerId); } catch {}

      const rect = item.getBoundingClientRect();
      const grabY = e.clientY - rect.top; // 줄 안에서 잡은 위치
      // 빈 자리 표시
      const holder = document.createElement("div");
      holder.className = "drag-placeholder";
      holder.style.height = `${rect.height}px`;
      section.insertBefore(holder, item);
      // 줄을 띄워서 손가락을 따라오게
      Object.assign(item.style, { position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, zIndex: 50 });
      item.classList.add("dragging");

      // 다른 줄이 자리를 옮길 때 미끄러지듯 움직이기(FLIP)
      const slide = (moveFn) => {
        const others = [...section.children].filter((x) => x !== item && x !== holder);
        const before = new Map(others.map((x) => [x, x.getBoundingClientRect().top]));
        moveFn();
        for (const x of others) {
          const dy = before.get(x) - x.getBoundingClientRect().top;
          if (!dy) continue;
          x.style.transition = "none";
          x.style.transform = `translateY(${dy}px)`;
          requestAnimationFrame(() => { x.style.transition = "transform 160ms ease"; x.style.transform = ""; });
        }
      };

      let lastY = e.clientY;
      let scrollTimer = null;
      const place = () => {
        item.style.top = `${lastY - grabY}px`;
        const others = [...section.querySelectorAll(":scope > .edit-item")].filter((x) => x !== item);
        const target = others.find((x) => {
          const r = x.getBoundingClientRect();
          return lastY < r.top + r.height / 2;
        });
        if (target) { if (holder.nextElementSibling !== target) slide(() => section.insertBefore(holder, target)); }
        else if (others.length && section.lastElementChild !== holder) slide(() => section.appendChild(holder));
      };
      // 화면 위·아래 끝에 가까우면 계속 스크롤(손가락을 가만히 대고 있어도)
      const autoScroll = () => {
        const edge = 80;
        const speed = lastY < edge ? -(edge - lastY) / 4 : lastY > window.innerHeight - edge ? (lastY - (window.innerHeight - edge)) / 4 : 0;
        if (speed) { overlay.scrollTop += speed; place(); }
        scrollTimer = requestAnimationFrame(autoScroll);
      };
      scrollTimer = requestAnimationFrame(autoScroll);

      const onMove = (ev) => { lastY = ev.clientY; place(); };
      const onUp = () => {
        cancelAnimationFrame(scrollTimer);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        // 빈 자리로 내려앉기
        const to = holder.getBoundingClientRect();
        item.style.transition = "top 140ms ease";
        item.style.top = `${to.top}px`;
        setTimeout(() => {
          section.insertBefore(item, holder);
          holder.remove();
          item.classList.remove("dragging");
          item.removeAttribute("style");
          section.querySelectorAll(":scope > .edit-item").forEach((x) => { x.style.transition = ""; x.style.transform = ""; });
          onDrop();
        }, 150);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    });
  });
}

function openHoldingsDialog(col, { startAdd = false, onDone = null } = {}) {
  const cfg = HOLDINGS[col];
  const order = makeOrder(cfg.types);
  const liveList = () => Object.values(S[col]).filter((a) => !a.deleted);
  let mode = startAdd ? "add" : null;   // null: 목록 | "add": 등록 | "edit": 전체 편집
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
    const all = krwTotal(assets, col);
    const hasForeign = assets.some((a) => curOf(a) !== "KRW");
    const body =
      `<div class="asset-total"><span class="muted">${cfg.total}</span><span>${all.missing ? "약 " : ""}${won(all.total)}</span></div>` +
        groups.map((t) => {
          const items = assets.filter((a) => a.type === t);
          const g = krwTotal(items, col);
          return `
          <section class="asset-group">
            <div class="asset-group-head"><span class="sector-badge">${t}</span><span class="sector-total">${won(g.total)}</span></div>
            ${items.length ? items.map((a) => {
              const cur = curOf(a);
              const bal = balanceOf(col, a);
              const krw = cur === "KRW" ? null : toKRW(bal, cur);
              return `<div class="asset-row"><span class="name">${esc(a.name)}</span>
                <span class="amt">${formatMoney(bal, cur)}${cur !== "KRW" ? `<span class="fx-sub">${krw === null ? "환율 없음" : `≈ ${won(krw)}`}</span>` : ""}</span></div>`;
            }).join("") : `<div class="asset-row asset-none">등록된 ${cfg.subj} 없습니다</div>`}
          </section>`;
        }).join("") +
        (hasForeign ? `<p class="note fx-note">외화는 ${ratesDate() ? `${ratesDate()} 환율` : "환율"}로 원화 환산해 합계에 넣었어요.${all.missing ? ` 환율을 받지 못한 ${all.missing}개는 합계에서 빠졌어요.` : ""}</p>` : "");
    const panel = openModal({
      cls: `theme-${col}`,
      title: cfg.title,
      headExtra: `<button class="${col === "debts" ? "red-btn" : "green-btn"}" data-add>${cfg.unit} 등록</button>` +
        (col === "debts" ? `<button class="yellow-btn" data-repay>부채 상환</button>` : "") +
        (assets.length ? `<button class="icon-only" data-edit aria-label="${cfg.unit} 편집">${PENCIL}</button>` : ""),
      body: body + `<button class="btn" data-close-btn style="margin-top:18px">닫기</button>`,
    });
    panel.querySelector("[data-add]").onclick = () => { mode = "add"; draw(); };
    const repay = panel.querySelector("[data-repay]");
    if (repay) repay.onclick = () => openRepayDialog({ onDone: () => openHoldingsDialog("debts") });
    panel.querySelector("[data-close-btn]").onclick = closeModal;
    const edit = panel.querySelector("[data-edit]");
    if (edit) edit.onclick = () => {
      drafts = sortedAssets().map((a) => ({ id: a.id, type: a.type, name: a.name, currency: curOf(a), amount: balanceOf(col, a), card: a.card || "", del: false }));
      mode = "edit";
      draw();
    };
  };

  // 전체 편집: 모든 자산의 종류·이름·통화·금액을 한 번에 고치고, 삭제는 표시해 두었다가 저장할 때 반영.
  // '+ 추가'로 새 항목(isNew)도 여기서 바로 넣을 수 있다.
  const drawEdit = () => {
    const sectionOf = (d) => (d.isNew ? d.type : S[col][d.id].type); // 새 항목은 고른 종류, 기존 항목은 원래 종류 섹션
    const groups = cfg.types.filter((t) => drafts.some((d) => sectionOf(d) === t));
    const panel = openModal({
      cls: `theme-${col}`,
      title: `${cfg.unit} 편집`,
      body: groups.map((t) => `
        <section class="asset-group">
          <div class="asset-group-head"><span class="sector-badge">${t}</span></div>
          ${drafts.filter((d) => sectionOf(d) === t).map((d) => `
          <div class="edit-item${d.del ? " removed" : ""}" data-id="${d.id}">
            <button class="grip" data-handle aria-label="끌어서 순서 바꾸기">${GRIP}</button>
            <div class="edit-body">
            <div class="edit-line">
              <input class="input sm" name="name" value="${esc(d.name)}" placeholder="이름" ${d.del ? "disabled" : ""}>
              <button class="sign-btn" data-sign aria-label="플러스/마이너스 바꾸기" ${d.del ? "disabled" : ""}>±</button>
              <input class="input sm amount-input amt-fixed" name="amount" inputmode="decimal" value="${toInput(d.amount, d.currency)}" placeholder="0" ${d.del ? "disabled" : ""}>
            </div>
            <div class="edit-line">
              <select class="input sm type" name="type" ${d.del ? "disabled" : ""}>${cfg.types.map((x) => `<option ${x === d.type ? "selected" : ""}>${x}</option>`).join("")}</select>
              <select class="input sm cur" name="currency" ${d.del ? "disabled" : ""}>${CURRENCIES.map((c) => `<option ${c === d.currency ? "selected" : ""}>${c}</option>`).join("")}</select>
              <button class="edit-del" data-toggle-del>${d.isNew ? "빼기" : d.del ? "되돌리기" : "삭제"}</button>
            </div>
            ${col === "assets" && d.type === "은행" ? `<div class="edit-line"><input class="input sm" name="card" value="${esc(d.card || "")}" placeholder="연결된 체크카드 (선택)" ${d.del ? "disabled" : ""}></div>` : ""}
            </div>
          </div>`).join("")}
        </section>`).join("") +
        `<button class="btn edit-add-btn ${col === "debts" ? "red-tone" : "green-tone"}" data-add-item>+ ${cfg.unit} 추가</button>` +
        `<div class="btn-row"><button class="btn" data-cancel>취소</button><button class="btn primary" data-save>저장</button></div>`,
    });
    const read = () => panel.querySelectorAll(".edit-item").forEach((el) => {
      const d = drafts.find((x) => x.id === el.dataset.id);
      if (d.del) return;
      d.name = el.querySelector("[name=name]").value;
      d.type = el.querySelector("[name=type]").value;
      d.currency = el.querySelector("[name=currency]").value;
      d.amount = parseMoney(el.querySelector("[name=amount]").value, d.currency);
      const cardIn = el.querySelector("[name=card]");
      if (cardIn) d.card = cardIn.value;
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
    // ± : 휴대폰 숫자 자판엔 '-'가 없는 경우가 많아 버튼으로 부호를 바꾼다(마이너스 통장 잔액 등)
    panel.querySelectorAll("[data-sign]").forEach((b) => (b.onclick = () => {
      const inp = b.closest(".edit-item").querySelector("[name=amount]");
      const v = inp.value.trim();
      inp.value = v.startsWith("-") ? v.slice(1) : v ? `-${v}` : "-";
    }));
    panel.querySelectorAll("[data-toggle-del]").forEach((b) => (b.onclick = () => {
      read();
      syncOrder();
      const d = drafts.find((x) => x.id === b.closest(".edit-item").dataset.id);
      if (d.isNew) drafts = drafts.filter((x) => x !== d); // 새로 넣은 항목은 바로 뺀다
      else d.del = !d.del;
      drawEdit();
    }));
    // 새 항목의 종류를 바꾸면 그 종류 섹션으로 옮긴다
    panel.querySelectorAll(".edit-item [name=type]").forEach((sel) => {
      const d = drafts.find((x) => x.id === sel.closest(".edit-item").dataset.id);
      if (d.isNew) sel.addEventListener("change", () => { read(); syncOrder(); drawEdit(); });
    });
    panel.querySelector("[data-add-item]").onclick = () => {
      read();
      syncOrder();
      const id = uid();
      drafts.push({ id, isNew: true, type: cfg.types[0], name: "", currency: "KRW", amount: 0, del: false });
      drawEdit();
      const input = $("#modal-root").querySelector(`.edit-item[data-id="${id}"] [name=name]`);
      input?.scrollIntoView({ block: "center" });
      input?.focus();
    };
    panel.querySelector("[data-cancel]").onclick = () => { mode = null; drafts = null; draw(); };
    panel.querySelector("[data-save]").onclick = async () => {
      read();
      syncOrder();
      if (drafts.some((d) => !d.del && !d.name.trim())) return toast(`이름이 빈 ${cfg.subj} 있어요.`);
      const now = nowISO();
      let changed = 0;
      const pos = {}; // 섹션(원래 종류)별 순번
      for (const d of drafts) {
        if (d.isNew) {
          const i = (pos[d.type] = (pos[d.type] ?? -1) + 1);
          S[col][d.id] = { id: d.id, type: d.type, order: 10000 + i, name: d.name.trim(), currency: d.currency, amount: d.amount, base: d.amount, ...(col === "assets" && d.type === "은행" && (d.card || "").trim() ? { card: d.card.trim() } : {}), createdAt: now, updatedAt: now, deleted: false };
          changed++;
          continue;
        }
        const a = S[col][d.id];
        if (d.del) {
          S[col][d.id] = { ...a, deleted: true, updatedAt: now };
          changed++;
          continue;
        }
        const i = (pos[a.type] = (pos[a.type] ?? -1) + 1);
        const order = d.type === a.type ? i : 10000 + i; // 종류를 옮긴 자산은 새 섹션의 맨 뒤로
        const was = balanceOf(col, a);
        const card = d.type === "은행" ? (d.card || "").trim() : "";
        if (a.type !== d.type || a.name !== d.name.trim() || curOf(a) !== d.currency || was !== d.amount || a.order !== order || (a.card || "") !== card) {
          // 잔액을 고쳤으면 기준 금액을 다시 맞춘다(입력한 잔액 = 기준 금액 + 연결된 내역 합)
          const base = was !== d.amount || a.base === undefined ? roundFor(d.amount - linkedSum(col, a.id), d.currency) : a.base;
          S[col][d.id] = { ...a, type: d.type, name: d.name.trim(), currency: d.currency, amount: d.amount, base, order, updatedAt: now };
          if (col === "assets") { if (card) S[col][d.id].card = card; else delete S[col][d.id].card; }
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
        ${col === "assets" ? `<div class="field" data-card-field hidden><label>연결된 체크카드 <span class="muted">(선택)</span></label>
          <input class="input" name="card" placeholder="예: KB체크카드">
          <p class="note" style="margin-top:6px">지출할 때 이 계좌가 '국민763 | KB체크카드'처럼 함께 보이고, 내역에 결제수단으로 남아요.</p></div>` : ""}
        <div class="field"><label>통화</label><select class="input" name="currency">${currencyOptions("KRW")}</select></div>
        <div class="field"><label data-amt-label>금액</label><input class="input amount-input" name="amount" inputmode="decimal" placeholder="0">
          <div class="fx-hint" data-hint></div>
          ${col === "debts" ? `<p class="note start-bal-note" data-amt-note hidden></p>` : ""}</div>
        ${col === "debts" ? `<div class="field" data-loan-field><label>받은 돈 입금 자산 <span class="muted">(선택)</span></label>
          <select class="input" name="loanAsset">${holdingOptions(["assets"], "", { balance: false })}</select>
          <p class="note" style="margin-top:6px">새로 대출을 받아 통장에 들어왔다면 고르세요. 부채와 입금 자산이 같이 늘고 '대출 실행' 내역이 남아요(수입 아님). 예전부터 있던 빚이면 비워 두세요.</p>
        </div>` : ""}
        <div class="btn-row"><button class="btn" data-cancel>취소</button><button class="btn primary" data-save>저장</button></div>`,
    });
    const cur = panel.querySelector("[name=currency]");
    const amt = panel.querySelector("[name=amount]");
    const cardField = panel.querySelector("[data-card-field]");
    if (cardField) {
      const typeSel = panel.querySelector("[name=type]");
      const toggleCard = () => (cardField.hidden = typeSel.value !== "은행"); // 은행 계좌에만
      typeSel.addEventListener("change", toggleCard);
      toggleCard();
    }
    // 신용카드·마통: 앱을 쓰기 전에 쓴 대금(지난달 사용분 등)을 시작 잔액으로 넣도록 안내
    const amtNote = panel.querySelector("[data-amt-note]");
    if (amtNote) {
      const typeSel = panel.querySelector("[name=type]");
      const START_LABEL = {
        신용카드: ["현재 남은 대금 (아직 안 갚은 사용액)", "지난달 사용분처럼 앞으로 갚아야 할 카드값이 있으면 그 금액을 넣으세요. 나중에 대금을 상환하면 0원이 돼요. 다 갚았으면 0."],
        마이너스통장: ["현재 빌려 쓴 금액 (마이너스 잔액)", "통장에 찍힌 마이너스 금액을 넣으세요(예: -300,000원이면 300,000). 안 쓰고 있으면 0."],
      };
      const toggleStart = () => {
        const t = START_LABEL[typeSel.value];
        panel.querySelector("[data-amt-label]").textContent = t ? t[0] : "금액";
        amtNote.hidden = !t;
        amtNote.textContent = t ? t[1] : "";
        panel.querySelector("[data-loan-field]").hidden = !!t; // 카드·마통은 '받은 돈'이 없음
        if (t) panel.querySelector("[name=loanAsset]").value = "";
      };
      typeSel.addEventListener("change", toggleStart);
      toggleStart();
    }
    const updateHint = bindMoney(amt, () => cur.value, panel.querySelector("[data-hint]"));
    cur.onchange = () => { amt.value = formatInput(amt.value, cur.value); updateHint(); };
    // 내역 창에서 바로 등록하러 온 경우: 취소·✕·저장 모두 내역 창으로 돌아감
    const back = () => (onDone ? onDone(null) : (mode = null, draw()));
    panel.querySelector("[data-cancel]").onclick = back;
    if (onDone) panel.querySelector("[data-close]").onclick = back;
    panel.querySelector("[data-save]").onclick = async () => {
      const name = panel.querySelector("[name=name]").value.trim();
      if (!name) return toast("이름을 입력해 주세요.");
      const now = nowISO();
      const type = panel.querySelector("[name=type]").value;
      const last = Math.max(-1, ...liveList().filter((a) => a.type === type && a.order != null && a.order < NO_ORDER).map((a) => a.order));
      const value = parseMoney(amt.value, cur.value);
      const loanRef = col === "debts" && parseLinkKey(panel.querySelector("[name=loanAsset]")?.value);
      const loanAsset = loanRef && S.assets[loanRef.id];
      const rec = {
        id: uid(),
        type,
        order: last + 1,
        name,
        currency: cur.value,
        amount: value,
        base: loanAsset && value > 0 ? 0 : value, // 처음 등록한 잔액이 기준 금액(새 대출이면 0 + 대출 실행 내역)
        ...(col === "assets" && type === "은행" && panel.querySelector("[name=card]")?.value.trim() ? { card: panel.querySelector("[name=card]").value.trim() } : {}),
        createdAt: now,
        updatedAt: now,
        deleted: false,
      };
      S[col][rec.id] = rec;
      if (loanAsset && value > 0) {
        const err = saveLoanTx({ debt: rec, asset: loanAsset, amount: value, date: todayStr(), time: nowTime(), memo: "" });
        if (err) { delete S[col][rec.id]; return toast(err); }
      }
      await saveState(S);
      scheduleSync();
      mode = null;
      if (onDone) { onDone(rec.id); toast(`'${name}' 등록했어요`); return; }
      draw();
      toast(loanAsset && value > 0 ? `등록했어요 · ${loanAsset.name}에 ${formatMoney(value, cur.value)} 입금으로 기록` : "등록했어요");
      render();
    };
  };
  draw();
}

// 백업/복원 (파일로 내보내기·가져오기)
/** 동기화 상태 뱃지: 동기화됨 초록, 진행 중 옐로우, 끊김·실패 레드, 오프라인 회색 */
const SYNC_BADGE = {
  ok: ["동기화됨", "sb-ok"],
  syncing: ["동기화 중…", "sb-busy"],
  offline: ["오프라인", "sb-off"],
  "need-login": ["연결 끊김", "sb-bad"],
  error: ["동기화 실패", "sb-bad"],
};
function syncBadge() {
  const [text, cls] = SYNC_BADGE[sync.status] || ["연결됨", "sb-ok"];
  return `<span class="sync-badge ${cls}">${text}</span>`;
}
function syncSection() {
  if (!isConfigured()) return `<p class="note">구글 드라이브 동기화 설정 전이에요. 지금은 이 기기에만 저장되고, 아래처럼 파일로 옮길 수 있어요.</p>`;
  if (!isConnected()) return `
    <p class="note">구글 드라이브에 연결하면 폰과 PC의 내역이 자동으로 합쳐져요. 이 앱이 만든 파일 하나에만 접근해요.</p>
    <button class="btn primary" data-connect style="margin-top:10px">구글 드라이브 연결</button>`;
  const last = S.meta.lastSync ? new Date(S.meta.lastSync).toLocaleString("ko-KR") : "아직 없음";
  return `
    <div class="asset-total"><span class="muted">상태</span>${syncBadge()}</div>
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
      <p class="note">마지막 백업: ${S.meta.lastBackup ? new Date(S.meta.lastBackup).toLocaleString("ko-KR") : "아직 없음"} · 30일마다 알려 드려요.</p>
      <button class="btn primary" data-export style="margin-top:10px">백업 파일 저장</button>
      <p class="note" style="margin-top:16px">엑셀 파일은 표로 보거나 정리할 때 쓰는 용도예요. 복원에는 백업 파일을 쓰세요.</p>
      <div class="money-line" style="margin-top:10px">
        <select class="input excel-range" name="excelRange">
          <option value="month">${Number(ui.month.slice(5))}월 내역</option>
          <option value="year">${ui.month.slice(0, 4)}년 내역</option>
          <option value="all">전체 내역</option>
        </select>
        <button class="btn excel-btn" data-excel><svg class="excel-ico" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" fill="#1d7a45"/><path d="M8.2 8l7.6 8M15.8 8l-7.6 8" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>엑셀 파일 저장</button>
      </div>
      <div class="section-title">가져오기</div>
      <p class="note">백업 파일의 내역을 지금 데이터에 <b style="font-weight:400;color:#fff">합쳐요</b>. 같은 내역은 최신 것으로 바뀌고, 지금 데이터는 지워지지 않아요.</p>
      <input type="file" accept=".json,application/json" data-file hidden>
      <button class="btn" data-import style="margin-top:10px">백업 파일 불러오기</button>
      <div class="section-title">초기화</div>
      <p class="note">모든 내역(수입·지출·자산이동·상환)을 지워요. 카테고리·자산·부채·자주 쓰는 내역은 남아요. 드라이브에 연결된 다른 기기에서도 지워지고, 되돌릴 수 없어요.</p>
      <label class="check-line"><input type="checkbox" data-reset-holdings checked> 자산·부채 잔액도 내역 입력 전으로 되돌리기</label>
      <button class="btn danger" data-reset style="margin-top:10px">내역 초기화</button>`,
  });
  panel.querySelector("[data-connect]")?.addEventListener("click", connect);
  panel.querySelector("[data-disconnect]")?.addEventListener("click", () => { disconnect(); openBackupDialog(); });
  panel.querySelector("[data-sync]")?.addEventListener("click", async () => {
    if (sync.status === "need-login") return connect();
    await runSync();
    openBackupDialog();
    toast(sync.status === "ok" ? "동기화했어요" : SYNC_TEXT[sync.status]);
  });
  panel.querySelector("[data-export]").onclick = async () => { await exportBackup(); openBackupDialog(); };
  panel.querySelector("[data-excel]").onclick = () => exportExcel(panel.querySelector("[name=excelRange]").value);
  const file = panel.querySelector("[data-file]");
  panel.querySelector("[data-import]").onclick = () => file.click();
  // 내역 초기화: 두 번 눌러야 실행. 삭제 표시로 남겨 다른 기기에도 반영된다.
  const resetBtn = panel.querySelector("[data-reset]");
  let resetArmed = false;
  resetBtn.onclick = async () => {
    const list = liveTx();
    if (!list.length) return toast("지울 내역이 없어요");
    if (!resetArmed) { resetArmed = true; resetBtn.textContent = `한 번 더 누르면 ${list.length}건 모두 삭제`; return; }
    const revert = panel.querySelector("[data-reset-holdings]").checked;
    const now = nowISO();
    // 잔액은 내역에서 계산되므로 내역을 지우면 저절로 되돌아간다. 되돌리지 않으려면 지금 잔액을 기준 금액으로 고정.
    const keep = revert ? null : ["assets", "debts"].flatMap((col) => Object.values(S[col]).filter((a) => !a.deleted).map((a) => [col, a.id, balanceOf(col, a)]));
    for (const t of list) S.transactions[t.id] = { ...t, deleted: true, updatedAt: now };
    linkCache = null;
    if (keep) for (const [col, id, bal] of keep) S[col][id] = { ...S[col][id], base: roundFor(bal - linkedSum(col, id), curOf(S[col][id])), amount: bal, updatedAt: now };
    closeModal();
    await commit();
    toast(`내역 ${list.length}건을 지웠어요${revert ? " · 잔액도 되돌렸어요" : ""}`);
  };
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
  // 날짜·시간 칸: 작은 아이콘이 아니라 칸 어디를 눌러도 달력·시계가 열리게
  document.addEventListener("click", (e) => {
    const el = e.target.closest?.('input[type="date"], input[type="time"]');
    if (!el || el.disabled || typeof el.showPicker !== "function") return;
    try { el.showPicker(); } catch {}
  });
  $("#prev").onclick = () => { ui.month = shiftMonth(ui.month, -1); render(); };
  $("#next").onclick = () => { ui.month = shiftMonth(ui.month, 1); render(); };
  $("#month-title").onclick = openDatePicker;
  document.querySelectorAll("nav.tabs button").forEach((b) => (b.onclick = () => { ui.tab = b.dataset.tab; render(); }));
  $("#fab").onclick = () => openKindPicker(ui.tab === "calendar" && ui.day ? ui.day : undefined);
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
  $("#view").addEventListener("change", (e) => {
    if (e.target.matches("[data-stat-cat]")) { ui.statCat = e.target.value; render(); } // 카테고리 추이: 고른 카테고리
  });
  $("#view").addEventListener("click", (e) => {
    const seg = e.target.closest("[data-seg]");
    if (seg) { ui.seg = seg.dataset.seg; ui.openCat = null; render(); return; }
    if (e.target.closest("[data-settle-excel]")) return exportSettlement();
    if (e.target.closest("[data-budget-edit]")) return openBudgetDialog();
    const ft = e.target.closest("[data-ft]");
    if (ft) return openFooterLink(ft.dataset.ft);
    if (e.target.closest("[data-nw-toggle]")) { ui.nwOpen = !ui.nwOpen; render(); return; }
    const sm = e.target.closest("[data-stat-month]");
    if (sm) { ui.month = sm.dataset.statMonth; render(); return; }
    const sp = e.target.closest("[data-stat-pick]");
    if (sp) {
      ui.statCat = sp.dataset.statPick;
      render();
      setTimeout(() => document.getElementById("cat-trend")?.scrollIntoView({ block: "start", behavior: "smooth" }), 30);
      return;
    }
    const nwm = e.target.closest("[data-nw-month]");
    if (nwm) { ui.month = nwm.dataset.nwMonth; render(); return; }
    if (e.target.closest("[data-recur-manage]")) return openRecurringDialog();
    const fold = e.target.closest("[data-fold]");
    if (fold) { ui[fold.dataset.fold] = !ui[fold.dataset.fold]; render(); return; }
    const cb = e.target.closest("[data-card]");
    if (cb) return openCardDialog(cb.dataset.card);
    const rc = e.target.closest("[data-recur]");
    if (rc) return openRecurAction(rc.dataset.recur);
    const part = e.target.closest("[data-home-part]");
    if (part) { ui.homePart = part.dataset.homePart; render(); return; }
    const older = e.target.closest("[data-older-toggle]");
    if (older) {
      const opening = ui.olderOpen !== ui.month;
      ui.olderOpen = opening ? ui.month : null;
      render();
      if (!opening) document.querySelector("[data-older-toggle]")?.scrollIntoView({ block: "center" }); // 아래쪽 '접기'를 눌러도 제자리로
      return;
    }
    const more = e.target.closest("[data-day-more],[data-day-less]");
    if (more) { ui.dayMore[more.dataset.dayMore || more.dataset.dayLess] = !!more.dataset.dayMore; render(); return; }
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

// 금액 가리기: 맨 위 눈 버튼을 누르면 15초 동안 보여 주고 다시 가린다
let revealTimer = null;
const EYE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/></svg>`;
const EYE_OFF = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.7"/><path d="M6.5 6.9C3.9 8.6 2.5 12 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.2-1"/><path d="M9.9 9.9a2.8 2.8 0 0 0 4 4"/></svg>`;
function updateEye() {
  const b = $("#eye-btn");
  if (!b) return;
  b.hidden = !hideAmounts();
  b.innerHTML = globalThis.__hideAmt ? EYE_OFF : EYE;
  b.setAttribute("aria-label", globalThis.__hideAmt ? "금액 잠깐 보기" : "금액 가리기");
  b.classList.toggle("on", !globalThis.__hideAmt);
}
function bindEye() {
  $("#eye-btn").onclick = () => {
    clearTimeout(revealTimer);
    globalThis.__hideAmt = !globalThis.__hideAmt;
    if (!globalThis.__hideAmt) revealTimer = setTimeout(() => { globalThis.__hideAmt = hideAmounts(); updateEye(); render(); }, 15_000);
    updateEye();
    render();
  };
}

async function main() {
  const fresh = handleRedirect(); // 구글 로그인에서 돌아온 경우 토큰 저장
  if (!fresh && refreshIfNeeded()) return; // 토큰 만료 → 조용히 재로그인하러 이동
  S = await loadState();
  if (seedCats() + retireOldCats() + seedSubcats() + migrateDebtTypes() + cleanMoveCategories() + repairLoanTxs() + migrateBalances() + freezeCatEtypes()) await saveState(S);
  const autoN = autoRecur(); // 자동 기록 켠 반복 내역
  if (autoN) await saveState(S);
  sync.onChange = renderSyncBar;
  globalThis.__hideAmt = hideAmounts();
  bindEvents();
  bindEye();
  updateEye();
  render();
  initLock({ toast, status: () => ({ connected: isConfigured() && isConnected(), lastSync: S.meta.lastSync, lastBackup: S.meta.lastBackup }) }); // 앱 잠금(켜 둔 경우)
  runSync();
  if (fresh) toast("구글 드라이브에 연결했어요");
  else if (autoN) toast(`반복 내역 ${autoN}건을 자동 기록했어요`);
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}
main();
