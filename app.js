import { loadState, saveState, mergeInto, uid, nowISO } from "./store.js";
import { CURRENCIES, CURRENCY_NAMES, parseMoney, formatInput, toInput, formatMoney, toKRW, rateKRW, refreshRates, ratesDate } from "./fx.js";
import { sync, isConfigured, isConnected, connect, disconnect, handleRedirect, refreshIfNeeded, syncNow } from "./sync.js";

// ---------------- 기본 목록 ----------------
const KINDS = ["수입", "지출", "자산이동"];
const EXPENSE_TYPES = ["변동", "고정"];
const CATEGORIES = {
  수입: ["월급", "부수입", "용돈", "이자/배당", "환급", "기타"],
  지출: ["식비", "카페/간식", "교통", "주거/통신", "생활용품", "쇼핑", "의료/건강", "문화/여가", "교육", "경조사", "보험", "기타"],
  자산이동: ["계좌이체", "저축", "투자", "카드대금", "현금인출", "기타"],
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
function dayLabel(date) {
  const d = new Date(date + "T00:00:00");
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${"일월화수목금토"[d.getDay()]})`;
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
const ui = { month: ym(new Date()), tab: "home", seg: "수입" };

const liveTx = () => Object.values(S.transactions).filter((t) => !t.deleted);
const monthTx = () => liveTx().filter((t) => t.date.startsWith(ui.month));

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
  if (ui.tab === "home") view.innerHTML = homeView();
  else if (ui.tab === "list") view.innerHTML = listView();
  else view.innerHTML = `<div class="card"><div class="empty">${ui.tab === "calendar" ? "달력" : "월별"} 화면은 준비 중이에요.</div></div>`;
}

function homeView() {
  const tx = monthTx();
  const inc = tx.filter((t) => t.kind === "수입");
  const exp = tx.filter((t) => t.kind === "지출");
  const mov = tx.filter((t) => t.kind === "자산이동");
  const fixed = exp.filter((t) => t.expenseType === "고정");
  const variable = exp.filter((t) => t.expenseType !== "고정");

  const segs = {
    수입: [inc, "inc", "+"],
    고정지출: [fixed, "exp", "-"],
    변동지출: [variable, "exp", "-"],
    자산이동: [mov, "mov", ""],
  };
  const [selTx, cls, sign] = segs[ui.seg];
  const byCat = {};
  selTx.forEach((t) => (byCat[t.category] = (byCat[t.category] || 0) + txKRW(t)));
  const catRows = Object.entries(byCat)
    .sort((a, b) => b[1] - a[1])
    .map(([c, v]) => `<div class="row-sub" style="padding:6px 4px 0"><span>${esc(c)}</span><span class="${cls}">${signed(v, sign)}</span></div>`)
    .join("");

  return `
  <section class="card">
    <div class="card-head"><span>이번달 현재</span><span>${won(sum(inc) - sum(exp))}</span></div>
    <div class="row"><div class="row-main"><span>수입</span><span class="inc">${signed(sum(inc), "+")}</span></div></div>
    <div class="row">
      <div class="row-main"><span>지출</span><span class="exp">${signed(sum(exp), "-")}</span></div>
      <div class="row-sub"><span>└ 고정지출</span><span class="exp">${signed(sum(fixed), "-")}</span></div>
      <div class="row-sub"><span>└ 변동지출</span><span class="exp">${signed(sum(variable), "-")}</span></div>
    </div>
    <div class="row"><div class="row-main"><span>자산이동</span><span class="mov">${won(sum(mov))}</span></div></div>
  </section>
  <section class="card">
    <div class="card-head plain"><span>상세 현황</span></div>
    <div class="seg" data-role="detail-seg">
      ${Object.keys(segs).map((s) => `<button data-seg="${s}" class="${s === ui.seg ? "on" : ""}">${s}</button>`).join("")}
    </div>
    <div class="row" style="margin-top:6px">
      <div class="row-main"><span>합계</span><span class="${cls}">${signed(sum(selTx), sign)}</span></div>
      ${catRows}
    </div>
  </section>`;
}

function listView() {
  const tx = monthTx().sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
  if (!tx.length) return `<div class="card"><div class="empty">이번 달 내역이 없어요.<br>아래 + 버튼으로 추가해 보세요.</div></div>`;
  const days = {};
  tx.forEach((t) => (days[t.date] ||= []).push(t));
  return Object.entries(days)
    .map(([date, items]) => {
      const dayInc = sum(items.filter((t) => t.kind === "수입"));
      const dayExp = sum(items.filter((t) => t.kind === "지출"));
      const totals = [dayInc && `<span class="inc">${signed(dayInc, "+")}</span>`, dayExp && `<span class="exp">${signed(dayExp, "-")}</span>`]
        .filter(Boolean).join(" ");
      return `
      <section class="card day">
        <div class="day-head"><span>${dayLabel(date)}</span><span>${totals}</span></div>
        ${items.map((t) => `
          <button class="tx" data-tx="${t.id}">
            <div class="left">
              <div>${esc(t.category)}${t.kind === "지출" ? ` <span class="muted" style="font-size:.75rem">${t.expenseType}</span>` : ""}</div>
              ${t.memo ? `<div class="memo">${esc(t.memo)}</div>` : ""}
            </div>
            <span class="amt ${KIND_CLASS[t.kind]}">${t.currency && t.currency !== "KRW"
              ? `${KIND_SIGN[t.kind]}${formatMoney(t.amount, t.currency)}<span class="fx-sub">≈ ${won(t.krw || 0)}</span>`
              : signed(t.amount, KIND_SIGN[t.kind])}</span>
          </button>`).join("")}
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
  root.querySelector("[data-close]").onclick = closeModal;
  root.querySelector("[data-overlay]").onclick = (e) => { if (e.target.dataset.overlay !== undefined) closeModal(); };
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

// 내역 추가/수정
// 외화 내역은 원래 금액(amount, currency)과 입력 당시 원화 금액(krw)을 함께 저장한다.
// 원화 금액은 환율로 자동 계산되지만, 실제 입금·결제된 원화로 직접 고칠 수 있다.
function openTxDialog(existing) {
  const draft = existing
    ? { currency: "KRW", ...existing }
    : { kind: "지출", expenseType: "변동", date: todayStr(), category: CATEGORIES["지출"][0], currency: "KRW", amount: 0, krw: 0, memo: "" };
  let confirmDelete = false;
  let krwTouched = !!existing?.krw; // 원화 금액을 직접 고쳤으면 자동 계산으로 덮어쓰지 않음

  refreshRates(); // 외화를 고를 때를 대비해 환율 준비

  const draw = () => {
    if (!CATEGORIES[draft.kind].includes(draft.category)) draft.category = CATEGORIES[draft.kind][0];
    const foreign = draft.currency !== "KRW";
    const panel = openModal({
      title: existing ? "내역 수정" : "내역 추가",
      body: `
        <div class="seg" data-role="kind">${KINDS.map((k) => `<button data-v="${k}" class="${k === draft.kind ? "on" : ""}">${k}</button>`).join("")}</div>
        ${draft.kind === "지출" ? `
        <div class="field"><label>지출 종류</label>
          <div class="seg" data-role="etype">${EXPENSE_TYPES.map((k) => `<button data-v="${k}" class="${k === draft.expenseType ? "on" : ""}">${k}지출</button>`).join("")}</div>
        </div>` : ""}
        <div class="field"><label>금액</label>
          <div class="money-line">
            <select class="input cur-select" name="currency">${CURRENCIES.map((c) => `<option value="${c}" ${c === draft.currency ? "selected" : ""}>${c === "KRW" ? "원" : c}</option>`).join("")}</select>
            <input class="input amount-input" name="amount" inputmode="decimal" autocomplete="off" placeholder="0" value="${toInput(draft.amount, draft.currency)}">
          </div>
        </div>
        <div class="field" data-krw-field ${foreign ? "" : "hidden"}><label>원화 금액 <span class="muted" data-rate></span></label>
          <input class="input amount-input" name="krw" inputmode="numeric" autocomplete="off" placeholder="0" value="${fmtAmount(Math.round(draft.krw || 0))}">
        </div>
        <div class="field"><label>날짜</label><input class="input" type="date" name="date" value="${draft.date}"></div>
        <div class="field"><label>카테고리</label>
          <select class="input" name="category">${CATEGORIES[draft.kind].map((c) => `<option ${c === draft.category ? "selected" : ""}>${c}</option>`).join("")}</select>
        </div>
        <div class="field"><label>메모</label><input class="input" name="memo" placeholder="예: 점심 김치찌개" value="${esc(draft.memo)}"></div>
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
      draft.category = $p("[name=category]").value;
      draft.memo = $p("[name=memo]").value;
    };
    amt.addEventListener("input", () => { amt.value = formatInput(amt.value, curSel.value); krwTouched = false; refreshKRW(); });
    curSel.onchange = () => { amt.value = formatInput(amt.value, curSel.value); krwTouched = false; refreshKRW(); };
    bindAmount(krwIn);
    krwIn.addEventListener("input", () => (krwTouched = true));
    refreshKRW();

    panel.querySelectorAll("[data-role=kind] button").forEach((b) => (b.onclick = () => { read(); draft.kind = b.dataset.v; draw(); }));
    panel.querySelectorAll("[data-role=etype] button").forEach((b) => (b.onclick = () => { read(); draft.expenseType = b.dataset.v; draw(); }));
    $p("[data-act=save]").onclick = async () => {
      read();
      const foreignNow = draft.currency !== "KRW";
      if (draft.amount <= 0) return toast("금액을 입력해 주세요.");
      if (foreignNow && draft.krw <= 0) return toast("원화 금액을 입력해 주세요.");
      if (!draft.date) return toast("날짜를 입력해 주세요.");
      const now = nowISO();
      const rec = {
        id: existing?.id || uid(),
        date: draft.date,
        kind: draft.kind,
        expenseType: draft.kind === "지출" ? draft.expenseType : "",
        category: draft.category,
        currency: draft.currency,
        amount: draft.amount,
        ...(foreignNow ? { krw: draft.krw } : {}),
        memo: draft.memo.trim(),
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        deleted: false,
      };
      S.transactions[rec.id] = rec;
      closeModal();
      ui.month = rec.date.slice(0, 7);
      await commit();
      toast(`${rec.kind} ${formatMoney(rec.amount, rec.currency)} ${existing ? "수정" : "추가"}했어요`);
    };
    const del = $p("[data-act=delete]");
    if (del) del.onclick = async () => {
      if (!confirmDelete) { read(); confirmDelete = true; return draw(); }
      S.transactions[existing.id] = { ...existing, deleted: true, updatedAt: nowISO() };
      closeModal();
      await commit();
      toast("삭제했어요");
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
    const groups = cfg.types.filter((t) => assets.some((a) => a.type === t));
    const all = krwTotal(assets);
    const hasForeign = assets.some((a) => curOf(a) !== "KRW");
    const body = assets.length
      ? `<div class="asset-total"><span class="muted">${cfg.total}</span><span>${all.missing ? "약 " : ""}${won(all.total)}</span></div>` +
        groups.map((t) => {
          const items = assets.filter((a) => a.type === t);
          const g = krwTotal(items);
          return `
          <section class="asset-group">
            <div class="asset-group-head"><span class="sector-badge">${t}</span><span class="sector-total">${won(g.total)}</span></div>
            ${items.map((a) => {
              const cur = curOf(a);
              const krw = cur === "KRW" ? null : toKRW(a.amount, cur);
              return `<div class="asset-row"><span class="name">${esc(a.name)}</span>
                <span class="amt">${formatMoney(a.amount, cur)}${cur !== "KRW" ? `<span class="fx-sub">${krw === null ? "환율 없음" : `≈ ${won(krw)}`}</span>` : ""}</span></div>`;
            }).join("")}
          </section>`;
        }).join("") +
        (hasForeign ? `<p class="note fx-note">외화는 ${ratesDate() ? `${ratesDate()} 환율` : "환율"}로 원화 환산해 합계에 넣었어요.${all.missing ? ` 환율을 받지 못한 ${all.missing}개는 합계에서 빠졌어요.` : ""}</p>` : "")
      : `<div class="empty">등록된 ${cfg.subj} 없어요.<br>오른쪽 위 '${cfg.unit} 등록'으로 추가해 보세요.</div>`;
    const panel = openModal({
      cls: `theme-${col}`,
      title: cfg.title,
      headExtra: `<button class="${col === "debts" ? "red-btn" : "green-btn"}" data-add>${cfg.unit} 등록</button>` +
        (assets.length ? `<button class="icon-only" data-edit aria-label="${cfg.unit} 편집">${PENCIL}</button>` : ""),
      body: body + `<button class="btn" data-close-btn style="margin-top:18px">닫기</button>`,
    });
    panel.querySelector("[data-add]").onclick = () => { mode = "add"; draw(); };
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

// ---------------- 이벤트 ----------------
function bindEvents() {
  $("#prev").onclick = () => { ui.month = shiftMonth(ui.month, -1); render(); };
  $("#next").onclick = () => { ui.month = shiftMonth(ui.month, 1); render(); };
  document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => { ui.tab = b.dataset.tab; render(); }));
  $("#fab").onclick = () => openTxDialog();
  $("#open-assets").onclick = () => openHoldingsDialog("assets");
  $("#open-debts").onclick = () => openHoldingsDialog("debts");
  $("#open-backup").onclick = openBackupDialog;
  $("#sync-bar").onclick = () => (sync.status === "need-login" ? connect() : runSync());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") runSync(); });
  window.addEventListener("online", () => runSync());
  window.addEventListener("offline", () => { sync.status = "offline"; renderSyncBar(); });
  $("#view").addEventListener("click", (e) => {
    const seg = e.target.closest("[data-seg]");
    if (seg) { ui.seg = seg.dataset.seg; render(); return; }
    const tx = e.target.closest("[data-tx]");
    if (tx) openTxDialog(S.transactions[tx.dataset.tx]);
  });
  // 자산 창은 닫힐 때 홈 화면을 다시 그릴 필요가 없지만, 다른 창이 닫히면 최신 상태로 그린다.
  new MutationObserver(() => { if (!$("#modal-root").children.length) render(); }).observe($("#modal-root"), { childList: true });
}

async function main() {
  const fresh = handleRedirect(); // 구글 로그인에서 돌아온 경우 토큰 저장
  if (!fresh && refreshIfNeeded()) return; // 토큰 만료 → 조용히 재로그인하러 이동
  S = await loadState();
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
