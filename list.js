// 가탈작 가계부 — 내역·달력·월별 탭, 검색·필터
import { formatMoney } from "./fx.js";
import { $, EXPENSE_TYPES, KIND_CLASS, S, debtType, esc, fmtAmount, liveTx, monthTx, pad, parseAmount, signed, sum, toast, todayStr, txNewestFirst, ui, won, ym } from "./core.js";
import { PERIODS, PICK_ITEMS, SHORT_DEBT, catsFor, deltaRef, emptyFilter, filterCount, isLoanTx, isMoveTx, isPlainExpense, isRepayTx, isShortDebt, moveRoute, parseLinkKey, periodLabel, shortDebtTotals, shortDebtType, txMatches, txNature, txPassesFilter, txSign } from "./model.js";
import { CAMERA, FUNNEL, bindAmount, closeModal, holdingOptions, openModal } from "./uikit.js";
import { render } from "./app.js";
/** 자산이동 경로: 자산 이름 아래 줄에 (자산 종류) — 예: 토스 (은행) → 국민763 (은행) */
function moveRouteBlock(t) {
  const ds = t.deltas || [];
  const end = (x) => {
    const a = x && S.assets[x.id];
    return a ? `<span class="rt-end"><span>${esc(a.name)}</span><span class="rt-type">(${esc(a.type)})</span></span>` : `<span class="rt-end"><span>?</span></span>`;
  };
  const out = ds.find((x) => x.col === "assets" && x.amount < 0), into = ds.find((x) => x.col === "assets" && x.amount > 0);
  if (!out && !into) return "";
  return `<span class="rt-block">${end(out)}<span class="rt-arrow">→</span>${end(into)}</span>`;
}
export function txRow(t, { withDate = false } = {}) {
  // 뱃지: 카테고리(수입 초록·지출 레드) / 자산이동(화이트) / 부채상환(옐로우: 자산에서 밖으로 나가 빚을 줄임) + 부채로 결제했으면 그 부채 종류(핑크)
  const kindBadge = t.kind === "수입" ? "b-inc" : t.kind === "지출" ? "b-exp" : "b-mov";
  const d = deltaRef(t.assetDelta);
  const debt = d?.col === "debts" ? S.debts[d.id] : null;
  const isRepay = isRepayTx(t), isLoan = isLoanTx(t);
  // 빌린 돈(부채 발생): 뱃지는 나의 부채에 등록된 종류 이름(대출·지인에게 빌린 돈 등)
  const loanType = (x) => { const ld = x.deltas.find((y) => y.col === "debts" && y.amount > 0); return debtType(S.debts[ld?.id]) || "부채"; };
  const route = esc(moveRoute(t)); // 자산이동: 출금 자산 → 입금 자산(상환은 → 부채)
  const when = withDate ? `${Number(t.date.slice(5, 7))}/${Number(t.date.slice(8, 10))} ${t.time || ""}`.trim() : t.time;
  const sub = [when, t.party ? esc(t.party) : ""].filter(Boolean).join(" · ");
  // 시간 아래 줄: 수입=입금 자산, 지출=출금 자산(신용카드·마통 등 부채는 '결제'), 자산이동=출금 → 입금
  const linked = d && (d.col === "debts" ? S.debts[d.id] : S.assets[d.id]);
  const via = linked ? `${t.kind === "수입" ? "입금" : d.col === "debts" ? "결제" : "출금"} ${esc(linked.name)}` : isMoveTx(t) ? moveRouteBlock(t) || route : route;
  return `
          <button class="tx" data-tx="${t.id}">
            <div class="left">
              <div class="badges">${isRepay ? `<span class="cat-badge b-repay">부채상환</span>` : isLoan ? `<span class="cat-badge b-cred">${esc(loanType(t))}</span>` : t.kind === "자산이동" ? `<span class="cat-badge b-mov">자산이동</span>` : ""}${debt ? `<span class="cat-badge b-cred">${esc(debtType(debt) || debt.name)}</span>` : ""}${t.kind !== "자산이동" ? `<span class="cat-badge ${kindBadge}">${esc(t.category)}</span>` : ""}${t.photos?.length ? `<span class="tx-photo" title="영수증 사진">${CAMERA}</span>` : ""}</div>
              ${t.content ? `<div class="tx-content">${esc(isLoan ? t.content.replace(/ 대출 실행$/, "") : t.content)}</div>` : ""}
              ${sub ? `<div class="memo">${sub}</div>` : ""}
              ${via ? `<div class="memo${isRepay ? " repay" : isLoan ? " cred" : t.kind === "자산이동" ? " mov" : ""}">${via}</div>` : ""}
              ${t.kind === "지출" && (t.card || t.transfer) ? `<div class="memo">결제 ${t.card ? esc(t.card) : "계좌이체"}</div>` : ""}
              ${t.inst > 1 ? `<div class="memo cred">할부 ${t.inst}개월</div>` : ""}
            </div>
            <span class="amt ${isShortDebt(t) || isLoan ? "cred" : isRepay ? "repay" : KIND_CLASS[t.kind]}">${isShortDebt(t) ? SHORT_DEBT[shortDebtType(t)].short + " " : isRepay ? "상환 " : isLoan ? "차입 " : ""}${t.currency && t.currency !== "KRW"
              ? `${txSign(t)}${formatMoney(t.amount, t.currency)}<span class="fx-sub">≈ ${won(t.krw || 0)}</span>`
              : signed(t.amount, txSign(t))}</span>
          </button>`;
}

/** 날짜 머리줄: 왼쪽 [일] [요일] [년-월], 오른쪽 1줄 수입·지출, 그 아래 신용·마통 등을 한 줄씩 */
export function dayHead(date, items) {
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
export const compact = (n) => new Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 1 }).format(Math.round(n));

export function calendarView() {
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
export function monthCols(items) {
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

export function monthlyView() {
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
export const RECENT_DAYS = 3, DAY_LIMIT = 5;
/** 날짜 카드: 하루 내역이 많으면 DAY_LIMIT건까지만 보이고 '더 보기'로 나머지를 연다 */
export function dayCard([date, items]) {
  const more = ui.dayMore[date] || items.length <= DAY_LIMIT + 1;
  return `
      <section class="card day">
        ${dayHead(date, items)}
        ${(more ? items : items.slice(0, DAY_LIMIT)).map((t) => txRow(t)).join("")}
        ${!more ? `<button class="day-more" data-day-more="${date}">${items.length - DAY_LIMIT}건 더 보기 ▾</button>` : ""}
        ${ui.dayMore[date] && items.length > DAY_LIMIT + 1 ? `<button class="day-more" data-day-less="${date}">줄이기 ▴</button>` : ""}
      </section>`;
}
export const groupByDate = (list) => {
  const days = {};
  list.forEach((t) => (days[t.date] ||= []).push(t));
  return Object.entries(days);
};

export function listView() {
  const n = filterCount();
  return `
  <div class="search-row">
  <div class="search-bar">
    <svg class="search-ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>
    <input class="search-input" type="search" name="q" placeholder="내역 검색 · 내용, 거래처, 카테고리, 금액" value="${esc(ui.q)}" autocomplete="off" enterkeyhint="search">
    <button class="search-clear" data-search-clear aria-label="검색어 지우기" ${ui.q ? "" : "hidden"}>✕</button>
  </div>
  <button class="filter-btn${n ? " on" : ""}" data-filter-open aria-label="필터">${FUNNEL}<span>필터${n ? ` ${n}` : ""}</span></button>
  </div>
  ${n ? `<div class="filter-chips">${filterChips()}<button class="chip-reset" data-filter-reset>초기화</button></div>` : ""}
  <div id="list-results">${listBody()}</div>`;
}

export function listBody() {
  return ui.q.trim() || filterCount() ? searchResults(ui.q) : monthList();
}

// ---------------- 내역 필터 ----------------
// 기간 · 내역 성격 · 카테고리 · 자산/부채 · 금액으로 거르고, 결과를 성격별 합계와 함께 보여 준다(검색어와 함께 써도 됨).
export function filterChips() {
  const f = ui.filter;
  const chip = (key, text) => `<button class="chip on" data-chip-off="${key}">${esc(text)} <span aria-hidden="true">✕</span></button>`;
  const holdingName = () => { const r = parseLinkKey(f.holding); return S[r?.col]?.[r?.id]?.name || "자산"; };
  return [
    chip("period", periodLabel()),
    f.natures.length ? chip("natures", f.natures.map((k) => PICK_ITEMS.find((it) => it.key === k)?.name).join(", ")) : "",
    f.cats.length ? chip("cats", f.cats.join(", ")) : "",
    f.holding ? chip("holding", holdingName()) : "",
    f.min || f.max ? chip("amount", `${f.min ? won(f.min) : ""} ~ ${f.max ? won(f.max) : ""}`) : "",
  ].join("");
}
export function openFilterDialog() {
  const f = JSON.parse(JSON.stringify(ui.filter));
  const draw = () => {
    const cats = [...new Set([...catsFor("수입"), ...EXPENSE_TYPES.flatMap((et) => catsFor("지출", et))])];
    const chips = (name, items, sel) => `<div class="chip-wrap">${items.map(([v, t, cls]) => `<button class="chip${sel.includes(v) ? " on" : ""}${cls ? ` ${cls}` : ""}" data-pick-${name}="${esc(v)}">${esc(t)}</button>`).join("")}</div>`;
    const panel = openModal({
      title: "내역 필터",
      body: `
        <div class="field" style="margin-top:4px"><label>기간</label>
          ${chips("period", Object.entries(PERIODS).map(([k, v]) => [k, k === "month" ? `${Number(ui.month.slice(5))}월(고른 달)` : v]), [f.period])}
          ${f.period === "custom" ? `<div class="money-line" style="margin-top:8px"><input class="input" type="date" name="from" value="${f.from}"><input class="input" type="date" name="to" value="${f.to}"></div>` : ""}
        </div>
        <div class="field"><label>내역 성격 <span class="muted">(여러 개 선택)</span></label>
          ${chips("nature", PICK_ITEMS.map((it) => [it.key, it.name, it.cls]), f.natures)}</div>
        <div class="field"><label>카테고리 <span class="muted">(여러 개 선택)</span></label>
          ${chips("cat", cats.map((c) => [c, c]), f.cats)}</div>
        <div class="field"><label>자산 · 부채</label>
          <select class="input" name="holding">${holdingOptions(["assets", "debts"], f.holding, { balance: false }).replace("선택 안 함", "전체")}</select></div>
        <div class="field"><label>금액</label>
          <div class="money-line">
            <div class="amount-wrap"><input class="input amount-input" name="min" inputmode="numeric" placeholder="최소" value="${f.min ? fmtAmount(f.min) : ""}"><span class="amount-unit">원</span></div>
            <span class="muted">~</span>
            <div class="amount-wrap"><input class="input amount-input" name="max" inputmode="numeric" placeholder="최대" value="${f.max ? fmtAmount(f.max) : ""}"><span class="amount-unit">원</span></div>
          </div></div>
        <div class="btn-row"><button class="btn" data-f-reset>초기화</button><button class="btn primary" data-f-apply>적용</button></div>`,
    });
    const q = (sel) => panel.querySelector(sel);
    const read = () => {
      f.holding = q("[name=holding]").value;
      f.min = parseAmount(q("[name=min]").value);
      f.max = parseAmount(q("[name=max]").value);
      if (q("[name=from]")) { f.from = q("[name=from]").value; f.to = q("[name=to]").value; }
    };
    ["min", "max"].forEach((n) => bindAmount(q(`[name=${n}]`)));
    panel.querySelectorAll("[data-pick-period]").forEach((b) => (b.onclick = () => { read(); f.period = b.dataset.pickPeriod; draw(); }));
    const toggle = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
    panel.querySelectorAll("[data-pick-nature]").forEach((b) => (b.onclick = () => { read(); f.natures = toggle(f.natures, b.dataset.pickNature); draw(); }));
    panel.querySelectorAll("[data-pick-cat]").forEach((b) => (b.onclick = () => { read(); f.cats = toggle(f.cats, b.dataset.pickCat); draw(); }));
    q("[data-f-reset]").onclick = () => { Object.assign(f, emptyFilter()); draw(); };
    q("[data-f-apply]").onclick = () => {
      read();
      if (f.min && f.max && f.min > f.max) return toast("최소 금액이 최대 금액보다 커요.");
      ui.filter = f;
      closeModal();
      render();
    };
  };
  draw();
}

/** 이번 달 목록: 최근 RECENT_DAYS일은 그대로, 그 전 날짜는 '이전 내역' 한 줄로 묶어 펼치기/접기 */
export function monthList() {
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
export const SEARCH_MAX = 300;
export function searchResults(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = filterCount() > 0;
  const where = filtered ? periodLabel() : "전체 기간";
  const found = liveTx().filter((t) => txPassesFilter(t) && txMatches(t, words)).sort(txNewestFirst);
  if (!found.length) return `<div class="card"><div class="empty">${q.trim() ? `'${esc(q.trim())}'에 맞는 내역이 없어요.` : "조건에 맞는 내역이 없어요."}<br>${where}에서 찾았어요.</div></div>`;
  const shown = found.slice(0, SEARCH_MAX);
  const inc = sum(found.filter((t) => t.kind === "수입")), exp = sum(found.filter(isPlainExpense));
  // 성격별 합계(0원은 생략)
  const by = (k) => sum(found.filter((t) => txNature(t) === k));
  const totals = [
    ["수입", inc, "inc", "+"], ["지출", exp, "exp", "-"], ["카드·마통 사용", by("card") + by("minus"), "cred", ""],
    ["자산이동", by("move"), "mov", ""], ["부채 상환", by("repay"), "repay", ""], ["부채 발생", by("borrow"), "cred", ""],
  ].filter(([, v]) => v);
  const cardUse = by("card") + by("minus");
  if (exp && cardUse) totals.push(["쓴 돈 합계 (지출 + 카드·마통)", exp + cardUse, "", ""]);
  return `
  <div class="search-summary">
    <span>${q.trim() ? "검색" : "필터"} 결과 ${found.length}건 <span class="muted">· ${esc(where)}</span></span>
    <span>${inc ? `<span class="inc">${signed(inc, "+")}</span> ` : ""}${exp ? `<span class="exp">${signed(exp, "-")}</span>` : ""}</span>
  </div>
  ${filtered && totals.length > 1 ? `<div class="card filter-totals">${totals.map(([label, v, cls, sign]) => `<div class="row-sub${cls ? "" : " ft-total"}"><span>${label}</span><span class="${cls}">${sign ? signed(v, sign) : won(v)}</span></div>`).join("")}</div>` : ""}
  ${groupByDate(shown).map(dayCard).join("")}
  ${found.length > SEARCH_MAX ? `<p class="note" style="text-align:center">최근 ${SEARCH_MAX}건까지 보여요. 검색어를 더 자세히 적어 보세요.</p>` : ""}`;
}

/** 검색창: 글자를 칠 때마다 결과만 다시 그린다(입력창은 그대로라 키보드가 닫히지 않음) */
export function bindSearch() {
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
