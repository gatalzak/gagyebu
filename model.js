// 가탈작 가계부 — 데이터 계산(잔액·카테고리·반복·카드·필터 등, 화면 없음)
import { uid, nowISO } from "./store.js";
import { CURRENCIES, CURRENCY_NAMES, toKRW, rateKRW, decimals } from "./fx.js";
import { $, ASSET_TYPES, CATEGORIES, DEBT_TYPES, DEFAULT_SUBCATS, EXPENSE_TYPES, KIND_SIGN, S, debtType, liveTx, nowTime, pad, shiftMonth, sum, todayStr, txKRW, txNewestFirst, ui, won, ym } from "./core.js";
export const SEED_TIME = "2026-01-01T00:00:00.000Z";
export function seedSubcats() {
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
export function subcatsFor(kind, category) {
  return Object.values(S.subcats || {})
    .filter((s) => !s.deleted && s.kind === kind && s.category === category)
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.createdAt.localeCompare(b.createdAt))
    .map((s) => s.name);
}
export function addSubcat(kind, category, name) {
  const now = nowISO();
  const id = uid();
  S.subcats[id] = { id, kind, category, name, order: 999, createdAt: now, updatedAt: now, deleted: false };
}
// ---------------- 카테고리 ----------------
// 카테고리도 기기 간 동기화되는 cats 묶음에 { kind, name, order } 로 저장한다(기본값은 고정 id defcat:…).
// 내역·하위 카테고리는 카테고리를 '이름'으로 가리키므로, 이름을 바꾸면 그 이름을 쓰는 기록도 함께 바꾼다.
// 지출 카테고리는 고정지출/변동지출 중 하나에 속한다(etype). 예전 기본 카테고리는 이 목록으로 판단.
export const DEFAULT_FIXED = new Set(["주거/통신", "보험", "교육", "금융/이자"]);
export const INTEREST_CAT = "금융/이자"; // 대출 이자를 기록하는 지출 카테고리
export const catEtype = (c) => c.etype || (DEFAULT_FIXED.has(c.name) ? "고정" : "변동");

// 예전 기본 자산이동 카테고리: 이용자가 손대지 않았으면(만든 그대로) 정리한다.
// 모든 기기에서 같은 시각으로 지워 동기화 때 다시 살아나지 않게 한다. 이미 입력한 내역의 카테고리 이름은 그대로 남는다.
export const RETIRED_CATS = { 자산이동: ["저축", "투자", "카드대금", "부채상환", "현금인출", "기타", "계좌이체", "ATM입금", "ATM출금"] };
export const RETIRE_TIME = "2026-10-10T12:00:00.000Z";
// 자산이동 경로형 기본값(v186) — 손대지 않은 것만 지운다
const RETIRED_MOVE = ["현금 → 은행", "은행 → 현금", "은행 → 은행", "은행 → 증권", "증권 → 은행"];
const RETIRE_MOVE_TIME = "2026-10-13T00:00:00.000Z";
export function retireOldCats() {
  let n = 0;
  // v194 기본값 '단순 계좌이체' → '단순 이체'(2026-10-13): 손대지 않은 기본값이면 지우고, 그 이름을 쓰던 내역·자주 쓰는 내역·반복 내역도 새 이름으로
  const oldMove = S.cats["defmove:단순 계좌이체"];
  if (oldMove && !oldMove.deleted && oldMove.updatedAt === SEED_TIME) {
    const now = nowISO();
    S.cats[oldMove.id] = { ...oldMove, deleted: true, updatedAt: now };
    for (const col of ["transactions", "favorites"]) {
      for (const t of Object.values(S[col] || {})) if (!t.deleted && t.kind === "자산이동" && t.category === "단순 계좌이체") S[col][t.id] = { ...t, category: "단순 이체", updatedAt: now };
    }
    for (const r of Object.values(S.recurring || {})) if (!r.deleted && r.fields?.kind === "자산이동" && r.fields.category === "단순 계좌이체") S.recurring[r.id] = { ...r, fields: { ...r.fields, category: "단순 이체" }, updatedAt: now };
    n++;
  }
  for (const name of RETIRED_MOVE) {
    const c = S.cats[`defmove:${name}`];
    if (c && !c.deleted && c.updatedAt === SEED_TIME) { S.cats[c.id] = { ...c, deleted: true, updatedAt: RETIRE_MOVE_TIME }; n++; }
  }
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
export function cleanMoveCategories() {
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
export function freezeCatEtypes() {
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

export function seedCats() {
  let added = 0;
  for (const [kind, names] of Object.entries(CATEGORIES)) {
    names.forEach((name, i) => {
      const id = kind === "자산이동" ? `defmove:${name}` : `defcat:${kind}:${name}`;
      if (S.cats[id]) return;
      S.cats[id] = { id, kind, name, order: i, ...(kind === "지출" ? { etype: DEFAULT_FIXED.has(name) ? "고정" : "변동" } : {}), createdAt: SEED_TIME, updatedAt: SEED_TIME, deleted: false };
      added++;
    });
  }
  return added;
}
export const catRecords = (kind) => Object.values(S.cats || {})
  .filter((c) => !c.deleted && c.kind === kind)
  .sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.createdAt.localeCompare(b.createdAt));
/** 그 구분(수입/지출/자산이동)의 카테고리 이름들. 지출은 etype(고정/변동)으로 거를 수 있다. */
export const catsFor = (kind, etype = null) => catRecords(kind).filter((c) => !etype || catEtype(c) === etype).map((c) => c.name);
export const subcatRecords = (kind, category) => Object.values(S.subcats || {})
  .filter((s) => !s.deleted && s.kind === kind && s.category === category)
  .sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.createdAt.localeCompare(b.createdAt));

/** 카테고리 이름 바꾸기: 하위 카테고리와 내역의 카테고리 이름도 같이 바꾼다 */
export function renameCategory(kind, from, to, now) {
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
export function renameSubcat(id, to, now) {
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
export function moveRoute(t) {
  const ds = t.deltas || [];
  const out = ds.find((x) => x.col === "assets" && x.amount < 0) || ds.find((x) => x.col === "debts" && x.amount > 0);
  const into = ds.find((x) => x.col === "assets" && x.amount > 0) || ds.find((x) => x.col === "debts" && x.amount < 0);
  if (!out && !into) return "";
  const name = (x) => (x && S[x.col]?.[x.id]?.name) || "?";
  return `${name(out)} → ${name(into)}`;
}
export const MOVE_NONE = "자산 미지정";
/** 부채 상환 내역을 갚은 부채별로 묶어 ['KB신용카드 대금 상환', 합계] (큰 순서) */
export function repayTotals(list) {
  const by = {};
  list.forEach((t) => {
    const d = t.deltas?.find((x) => x.col === "debts");
    const label = `${S.debts[d?.id]?.name || "부채"} 대금 상환`;
    by[label] = (by[label] || 0) + txKRW(t);
  });
  return Object.entries(by).sort((a, b) => b[1] - a[1]);
}
/** 대출 실행 내역을 부채(대출) 이름별로 묶어 ['주택담보대출', 합계] (큰 순서) */
export function loanTotals(list) {
  const by = {};
  list.forEach((t) => {
    const d = t.deltas?.find((x) => x.col === "debts");
    const h = S.debts[d?.id];
    // 무엇이 생겼는지: '엄마 · 지인에게 빌린 돈', '전세대출 · 대출' (이름이 종류와 같으면 이름만)
    const label = h ? (h.name === debtType(h) ? h.name : `${h.name} · ${debtType(h)}`) : "부채";
    by[label] = (by[label] || 0) + txKRW(t);
  });
  return Object.entries(by).sort((a, b) => b[1] - a[1]);
}
/** 자산이동 내역을 경로별로 묶어 [경로, 합계] (큰 순서) */
export function routeTotals(list) {
  const by = {};
  list.forEach((t) => { const r = moveRoute(t) || MOVE_NONE; by[r] = (by[r] || 0) + txKRW(t); });
  return Object.entries(by).sort((a, b) => b[1] - a[1]);
}

export const SHORT_DEBT = {
  신용카드: { short: "신용", title: "신용카드 사용", label: "신용카드" },
  마이너스통장: { short: "마통", title: "마이너스통장 사용", label: "마이너스통장" },
  미납금: { short: "미납", title: "미납금", label: "미납금" },
  "지인에게 빌린 돈": { short: "지인", title: "지인에게 빌린 돈", label: "지인에게 빌린 돈" },
  기타: { short: "기타부채", title: "기타", label: "기타 부채" },
};

/** 단기부채(신용카드·마이너스통장·미납금·지인에게 빌린 돈·기타)로 결제한 지출이면 그 부채 종류, 아니면 null.
 *  부채가 나중에 지워져도 기록(삭제 표시)은 남아 있어 종류로 계속 구분된다. */
export function shortDebtType(t) {
  if (t.kind !== "지출" || t.interest) return null; // 이자(마통에서 자동 차감 등)는 비용이라 지출로 센다
  const d = deltaRef(t.assetDelta);
  const type = d?.col === "debts" ? debtType(S.debts[d.id]) : null;
  return SHORT_DEBT[type] ? type : null;
}
export const isShortDebt = (t) => !!shortDebtType(t);

/** 부채 상환(내 자산 → 부채): 자산이동과 따로 집계한다 */
export const isRepayTx = (t) => !!t.deltas?.some((x) => x.col === "debts" && x.amount < 0);
/** 대출 실행(부채 + , 받은 돈은 자산 +): 수입이 아니라 빌린 돈 */
export const isLoanTx = (t) => !!t.deltas?.some((x) => x.col === "debts" && x.amount > 0);
/** 순수 자산이동(내 자산끼리) */
export const isMoveTx = (t) => t.kind === "자산이동" && !isRepayTx(t) && !isLoanTx(t);

/** 금액 앞 부호: 수입 +, 지출 -, 자산이동·단기 부채(신용·마통 등)는 없음 */
export const txSign = (t) => (isShortDebt(t) ? "" : KIND_SIGN[t.kind]);

/** 지출(신용카드·마이너스통장 사용 제외) */
export const isPlainExpense = (t) => t.kind === "지출" && !isShortDebt(t);

/** 단기부채 종류별 합계를 한 줄씩: '<div>신용 -1,000원</div><div>마통 -2,000원</div>' (없는 종류는 생략) */
export function shortDebtTotals(items) {
  return Object.keys(SHORT_DEBT).map((type) => {
    const v = sum(items.filter((t) => shortDebtType(t) === type));
    return v ? `<div><span class="cred">${SHORT_DEBT[type].short} ${won(v)}</span></div>` : "";
  }).join("");
}

/** 현황 섹션 제목 앞 아이콘 (글자색은 구분색을 따른다) */
export const BUDGET_TOTAL = "*";
export const budgetId = (cat) => `budget:${cat}`;
/** {카테고리: 금액} (전체 예산은 '*') */
export function liveBudgets() {
  const out = {};
  for (const b of Object.values(S.budgets || {})) if (!b.deleted && b.amount > 0) out[b.category] = b.amount;
  return out;
}
export const expenseCats = () => EXPENSE_TYPES.flatMap((et) => catsFor("지출", et));
export const liveRecurs = () => Object.values(S.recurring || {}).filter((r) => !r.deleted)
  .sort((a, b) => a.day - b.day || a.createdAt.localeCompare(b.createdAt));
export const monthLast = (month) => { const [y, m] = month.split("-").map(Number); return new Date(y, m, 0).getDate(); };
export const recurDate = (r, month) => `${month}-${pad(Math.min(r.day, monthLast(month)))}`;
export const recurTx = (r, month) => liveTx().find((t) => t.recurId === r.id && t.recurMonth === month);
export function recurName(r) {
  if (r.nature === "repay") return `${S.debts[parseLinkKey(r.repay?.debt)?.id]?.name || "부채"} 상환`;
  return r.fields?.content || "반복 내역";
}
export function recurStatus(r, month) {
  if (recurTx(r, month)) return "done";
  if ((r.skips || []).includes(month)) return "skip";
  return recurDate(r, month) <= todayStr() ? "due" : "plan";
}
/** 금액이 달라지는 항목: 가장 최근에 기록한 금액 */
export function recurLastAmount(r) {
  const last = liveTx().filter((t) => t.recurId === r.id).sort((a, b) => b.recurMonth.localeCompare(a.recurMonth))[0];
  return last ? last.amount : r.amount;
}
export const recurItem = (r) => PICK_ITEMS.find((it) => it.key === r.nature) || PICK_ITEMS[1];
export function recurVia(r) {
  const key = r.nature === "repay" ? r.repay?.asset : r.nature === "move" ? r.fields?.fromAsset : r.fields?.link;
  const ref = key && parseLinkKey(key);
  const h = ref && S[ref.col]?.[ref.id];
  return h && !h.deleted ? h.name : "";
}

/** 현황: 이번 달 반복 내역 */
export function autoRecur() {
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
export function buildRecurTx(r, month, id, date) {
  const f = r.fields || {};
  const now = nowISO();
  const rec = {
    id, date, time: "", kind: f.kind, expenseType: f.kind === "지출" ? f.expenseType || "고정" : "",
    category: f.category || "", subcategory: f.subcategory || "",
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
export const dayIn = (month, day) => `${month}-${pad(Math.min(day, monthLast(month)))}`;
export const addDays = (date, n) => { const d = new Date(`${date}T00:00:00`); d.setDate(d.getDate() + n); return `${ym(d)}-${pad(d.getDate())}`; };
export const monthDiff = (a, b) => { const [ay, am] = a.split("-").map(Number), [by, bm] = b.split("-").map(Number); return (by - ay) * 12 + (bm - am); };
export const hasBilling = (d) => d && d.payDay > 0 && d.closeDay > 0;
export function cardCycle(d, payMonth) {
  const closeM = d.closeMonth === "this" ? payMonth : shiftMonth(payMonth, -1);
  const end = dayIn(closeM, d.closeDay);
  const start = addDays(dayIn(shiftMonth(closeM, -1), d.closeDay), 1);
  return { start, end, payDate: dayIn(payMonth, d.payDay), payMonth };
}
/** 그 날짜에 쓴 돈이 청구되는 결제 달 */
export function payMonthOf(d, date) {
  const m = date.slice(0, 7);
  const closeM = date <= dayIn(m, d.closeDay) ? m : shiftMonth(m, 1);
  return d.closeMonth === "this" ? closeM : shiftMonth(closeM, 1);
}
export const cardUses = (d) => liveTx().filter((t) => t.kind === "지출" && !t.interest && t.assetDelta?.col === "debts" && t.assetDelta.id === d.id);
export const instPortion = (amt, n, k) => (k === n - 1 ? amt - Math.floor(amt / n) * (n - 1) : Math.floor(amt / n));
/** payMonth 결제분: 기간·청구 금액·항목(할부는 그 회차 금액) */
export function cardBill(d, payMonth) {
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
export const nextPayMonth = (d) => { const m = todayStr().slice(0, 7); return todayStr() <= dayIn(m, d.payDay) ? m : shiftMonth(m, 1); };
/** 진행 중인 할부: 다음 결제분부터 남은 회차·금액 */
export function activeInstallments(d) {
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
export const md = (date) => `${Number(date.slice(5, 7))}/${Number(date.slice(8))}`;
export const dday = (date) => { const n = Math.round((new Date(`${date}T00:00:00`) - new Date(`${todayStr()}T00:00:00`)) / 86400000); return n === 0 ? "오늘" : n > 0 ? `D-${n}` : `${-n}일 지남`; };

/** 현황: 카드 결제 예정 (신용카드가 있을 때만) */
export function monthFigures(list) {
  const exp = list.filter((t) => t.kind === "지출");
  const plain = exp.filter(isPlainExpense);
  return {
    inc: sum(list.filter((t) => t.kind === "수입")),
    exp: sum(plain),
    fixed: sum(plain.filter((t) => t.expenseType === "고정")),
    variable: sum(plain.filter((t) => t.expenseType !== "고정")),
    debtUse: sum(exp.filter(isShortDebt)),
    borrow: sum(list.filter(isLoanTx)), // 빌린 돈(대출 차입 등) — 부채 신규 발생에 같이 셈
    repay: sum(list.filter(isRepayTx)),
  };
}
export const signedWon = (v) => (v > 0 ? "+" : v < 0 ? "-" : "") + won(Math.abs(v));

/** 고른 달 결산 숫자 (화면·엑셀 공용) */
export const monthEnd = (month) => `${month}-${pad(monthLast(month))}`;
export function holdingsAt(endDate) {
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
export const hasHoldings = () => ["assets", "debts"].some((c) => Object.values(S[c]).some((a) => !a.deleted));
/** 순자산을 보여 줄 수 있는 첫 달: 가장 이른 내역·자산 등록 달 */
export function netStartMonth() {
  let m = todayStr().slice(0, 7);
  for (const t of liveTx()) if ((t.assetDelta || t.deltas?.length) && t.date.slice(0, 7) < m) m = t.date.slice(0, 7);
  for (const c of ["assets", "debts"]) for (const a of Object.values(S[c])) if (!a.deleted && a.createdAt && a.createdAt.slice(0, 7) < m) m = a.createdAt.slice(0, 7);
  return m;
}

/** 현황 맨 위 한 줄: 순자산 + 지난달 말 대비 (누르면 결산의 순자산) */
export const PERIODS = { month: "고른 달", "3m": "최근 3개월", "6m": "최근 6개월", year: "올해", all: "전체 기간", custom: "직접 지정" };
export const emptyFilter = () => ({ period: "month", from: "", to: "", natures: [], cats: [], holding: "", min: 0, max: 0 });
ui.filter = emptyFilter();
/** 기본값과 다른 조건 수 (기간은 검색할 때 전체가 기본이라 '고른 달'이어도 다른 조건이 있을 때만 셈) */
export function filterCount() {
  const f = ui.filter;
  return (f.period !== "month" ? 1 : 0) + (f.natures.length ? 1 : 0) + (f.cats.length ? 1 : 0) + (f.holding ? 1 : 0) + (f.min || f.max ? 1 : 0);
}
/** 내역 하나의 성격 키 (입력 창의 8가지와 같음) */
export function txNature(t) {
  if (t.kind === "수입") return "income";
  if (t.kind === "자산이동") return isRepayTx(t) ? "repay" : isLoanTx(t) ? "borrow" : "move";
  const sd = shortDebtType(t);
  if (sd === "신용카드") return "card";
  if (sd === "마이너스통장") return "minus";
  return t.expenseType === "고정" ? "fixed" : "var";
}
export function filterRange() {
  const f = ui.filter, today = todayStr(), m = today.slice(0, 7);
  if (f.period === "month") return [`${ui.month}-01`, monthEnd(ui.month)];
  if (f.period === "3m") return [`${shiftMonth(m, -2)}-01`, monthEnd(m)];
  if (f.period === "6m") return [`${shiftMonth(m, -5)}-01`, monthEnd(m)];
  if (f.period === "year") return [`${m.slice(0, 4)}-01-01`, `${m.slice(0, 4)}-12-31`];
  if (f.period === "custom") return [f.from || "0000-00-00", f.to || "9999-12-31"];
  return ["0000-00-00", "9999-12-31"];
}
export const periodLabel = () => {
  const f = ui.filter;
  if (f.period === "month") return `${ui.month.slice(0, 4)}년 ${Number(ui.month.slice(5))}월`;
  if (f.period === "custom") return `${f.from ? md(f.from) : "처음"} ~ ${f.to ? md(f.to) : "지금"}`;
  return PERIODS[f.period];
};
export function txPassesFilter(t) {
  const f = ui.filter;
  if (!filterCount()) return true;
  const [from, to] = filterRange();
  if (t.date < from || t.date > to) return false;
  if (f.natures.length && !f.natures.includes(txNature(t))) return false;
  if (f.cats.length && !f.cats.includes(t.category)) return false;
  if (f.holding) {
    const keys = [deltaRef(t.assetDelta), ...(t.deltas || [])].filter(Boolean).map((d) => linkKey(d.col, d.id));
    if (!keys.includes(f.holding)) return false;
  }
  const v = txKRW(t);
  if (f.min && v < f.min) return false;
  if (f.max && v > f.max) return false;
  return true;
}
export function txMatches(t, words) {
  const d = deltaRef(t.assetDelta);
  const linked = d && S[d.col]?.[d.id];
  const text = [
    t.content, t.party, t.memo, t.category, t.subcategory, isRepayTx(t) ? "부채상환 상환" : isLoanTx(t) ? "부채발생 부채 발생 대출실행 대출 빌림" : t.kind,
    t.kind === "지출" ? `${t.expenseType || ""}지출` : "", linked?.name, d?.col === "debts" ? debtType(linked) : "",
    moveRoute(t), t.currency && t.currency !== "KRW" ? t.currency : "",
  ].filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => {
    const digits = w.replace(/[,원]/g, "");
    if (/^\d+$/.test(digits)) return text.includes(digits) || String(t.amount).includes(digits) || String(Math.round(txKRW(t))).includes(digits);
    return text.includes(w);
  });
}
export const unitLabel = (cur) => (cur === "KRW" ? "원" : cur);

// ---------------- 수입 → 자산 입금 / 지출 → 자산 출금 또는 부채(신용카드 등) 증가 ----------------
// 저장하면 고른 자산·부채 잔액을 바꾸고, 실제로 바꾼 값(그 항목 통화 기준)을 내역의 assetDelta {col, id, amount}에 기록한다.
// 내역을 고치거나 지우면 그 값을 그대로 빼서 되돌린다(그사이 환율이 바뀌어도 정확히 되돌아감).
// 예전 기록은 {assetId, amount} 형태라 col이 없으면 자산으로 본다.
export const ASSET_LINK = {
  수입: { label: "입금 자산", cols: ["assets"] },
  지출: { label: "출금 되는 자산", cols: ["assets", "debts"] }, // 자산에서 출금하거나 신용카드 등 부채로 결제
};
/** 내역 창의 자산·부채 칸: 카드·마통 사용이면 그 종류 부채만, 고정·변동지출이면 카드·마통은 빼고(그쪽 성격으로) */
export function linkCfgOf(d) {
  if (d.kind === "지출" && CARD_MODES.includes(d.debtMode)) return { label: `사용한 ${SHORT_DEBT[d.debtMode].label}`, cols: ["debts"] };
  if (d.kind === "지출") return { ...ASSET_LINK.지출, exclude: CARD_MODES, help: ["assets"] };
  return ASSET_LINK[d.kind];
}
/** 잔액 변화 방향: 수입→자산 +, 지출→자산 -, 지출→부채 + */
export const linkSign = (kind, col) => (kind === "수입" ? 1 : col === "debts" ? 1 : -1);
export const deltaRef = (d) => d && { col: d.col || "assets", id: d.id || d.assetId, amount: d.amount };
export const linkKey = (col, id) => `${col}:${id}`;
export const parseLinkKey = (key) => { const [col, id] = (key || "").split(":"); return id ? { col, id } : null; };

/** 내역 금액을 자산·부채 통화로 바꾼다. 환율을 몰라 바꿀 수 없으면 null. */
export function amountInCurrency(rec, cur) {
  if (cur === rec.currency) return rec.amount;
  const krw = rec.currency === "KRW" ? rec.amount : rec.krw;
  if (cur === "KRW") return krw;
  const r = rateKRW(cur);
  return r ? krw / r : null;
}
export const roundFor = (n, cur) => { const f = 10 ** decimals(cur); return Math.round(n * f) / f; };

// ---------------- 잔액 계산 ----------------
// 잔액은 저장해 두고 더하고 빼는 대신, 항상 '기준 금액(base) + 이 자산·부채에 연결된 살아 있는 내역의 변화 합'으로 계산한다.
// 내역은 기록만 하고 잔액 숫자를 고치지 않으므로, 폰·PC에서 동시에 입력해도 동기화 순서와 상관없이 잔액이 맞는다.
// base가 없는 예전 기록은 migrateBalances가 한 번 계산해 넣는다(그 전까지는 예전 amount를 그대로 보여 줌).
export let linkCache = null;
export function clearLinkCache() { linkCache = null; }
/** "col:id" → 연결된 내역 변화 합 (한 번 그리는 동안만 기억) */
export function linkedTotals() {
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
export const linkedSum = (col, id) => linkedTotals().get(`${col}:${id}`) || 0;
/** 지금 잔액 */
export function balanceOf(col, a) {
  if (a.base === undefined) return a.amount || 0;
  return roundFor(a.base + linkedSum(col, a.id), curOf(a));
}
/** 예전 방식(amount에 직접 더하기)으로 저장된 자산·부채에 기준 금액을 넣는다 */
/** 2026-10-11~12 버그로 deltas 없이 저장된 대출 실행 내역에 부채 증가분을 되살린다(입금 자산은 알 수 없어 빠짐) */
export function repairLoanTxs() {
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

export function migrateBalances() {
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
export function saveLoanTx({ existing = null, debt, asset, amount, date, time, memo }) {
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
export function newTxDraft(presetDate, over = {}) {
  const d = { kind: "지출", expenseType: "고정", date: presetDate || todayStr(), time: nowTime(), currency: "KRW", amount: 0, krw: 0, content: "", party: "", memo: "", ...over };
  d.category = catsFor(d.kind, d.kind === "지출" ? d.expenseType : null)[0] || "";
  return d;
}

/** 새 내역 추가 1단계: 내역 성격부터 고른다 (수정할 때는 이 화면 없이 바로 입력 창) */
export const PICK_ITEMS = [
  { key: "income", cls: "inc", icon: "수입", name: "수입", desc: "급여·용돈·이자처럼 들어온 돈" },
  { key: "fixed", cls: "exp", icon: "지출", name: "고정지출", desc: "월세·통신비·보험료처럼 매달 나가는 돈" },
  { key: "var", cls: "exp", icon: "지출", name: "변동지출", desc: "식비·쇼핑처럼 그때그때 쓴 돈 (현금·체크카드·계좌이체)" },
  { key: "move", cls: "mov", icon: "자산이동", name: "자산이동", desc: "내 통장·현금·증권 사이에서 옮긴 돈" },
  { key: "card", cls: "cred", icon: "단기부채", name: "신용카드 사용", desc: "*신용카드 사용은 지출이 아닌 부채로 잡혀요" },
  { key: "minus", cls: "cred", icon: "단기부채", name: "마이너스 통장 사용", desc: "*마이너스 통장에서 쓴 돈도 지출이 아닌 부채로 잡혀요" },
  { key: "borrow", cls: "cred", icon: "대출실행", name: "부채 발생", desc: "대출을 받거나 돈을 빌림 · 수입이 아니에요" },
  { key: "repay", cls: "repay", icon: "부채상환", name: "부채 상환", desc: "카드 대금·마통·대출금 갚기 · 지출이 아니에요" },
];
export const CARD_MODES = ["신용카드", "마이너스통장"]; // 지출이지만 단기 부채로 잡히는 사용
/** 그 종류 부채가 하나뿐이면 그것 */
export function onlyDebt(type) {
  const list = Object.values(S.debts).filter((a) => !a.deleted && debtType(a) === type);
  return list.length === 1 ? linkKey("debts", list[0].id) : "";
}
/** 내역 창 draft → 내역 성격 키 */
export function natureOf(d) {
  if (d.kind === "수입") return "income";
  if (d.kind === "자산이동") return "move";
  if (d.debtMode === "신용카드") return "card";
  if (d.debtMode === "마이너스통장") return "minus";
  return d.expenseType === "변동" ? "var" : "fixed";
}
/** 내역 성격 → 내역 창 draft 값 (prevLink: 지금 고른 자산·부채, 맞으면 유지) */
export function natureDraft(key, prevLink = "") {
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
export function dropTx(t, now = nowISO()) {
  const cur = S.transactions[t.id];
  if (!cur || cur.deleted) return;
  S.transactions[t.id] = { ...cur, deleted: true, updatedAt: now };
  const it = cur.interestTx && S.transactions[cur.interestTx];
  if (it && !it.deleted) S.transactions[it.id] = { ...it, deleted: true, updatedAt: now };
}

export const FAV_FIELDS = ["kind", "expenseType", "category", "subcategory", "currency", "amount", "krw", "content", "party", "memo", "link", "fromAsset", "toAsset"];
export const liveFavs = () => Object.values(S.favorites || {}).filter((f) => !f.deleted).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
export function favFromDraft(d) {
  const f = {};
  for (const k of FAV_FIELDS) f[k] = d[k] ?? "";
  if (f.kind !== "지출") f.expenseType = "";
  if (f.kind !== "자산이동") { f.fromAsset = ""; f.toAsset = ""; } else { f.link = ""; f.party = ""; f.memo = ""; }
  if (f.currency === "KRW") f.krw = 0;
  return f;
}
export const favKey = (f) => FAV_FIELDS.map((k) => (k === "krw" ? "" : String(f[k] ?? ""))).join("|");
/** 연결된 자산·부채가 지워졌으면 비운다 */
export function liveLink(key) {
  const r = key && parseLinkKey(key);
  return r && S[r.col]?.[r.id] && !S[r.col][r.id].deleted ? key : "";
}
/** 지금 창의 날짜·시간은 그대로 두고 나머지를 자주 쓰는 내역 값으로 채운다 */
export function applyFav(draft, f) {
  const d = { ...draft };
  for (const k of FAV_FIELDS) d[k] = f[k] ?? "";
  if (d.kind === "지출" && !d.expenseType) d.expenseType = "고정";
  if (!d.currency) d.currency = "KRW"; // 통화가 비어 있던 예전 기록
  d.link = liveLink(d.link);
  d.fromAsset = liveLink(d.fromAsset);
  d.toAsset = liveLink(d.toAsset);
  d.krw = 0; // 외화면 오늘 환율로 다시 계산
  return d;
}
export const curOf = (a) => a.currency || "KRW"; // 예전 자산은 통화 정보가 없으면 원화
export const currencyOptions = (sel) =>
  CURRENCIES.map((c) => `<option value="${c}" ${c === sel ? "selected" : ""}>${c === "KRW" ? "원 (KRW)" : `${c} · ${CURRENCY_NAMES[c]}`}</option>`).join("");

/** 원화 환산 합계. 환율을 모르는 외화가 있으면 missing에 개수를 센다. */
export function krwTotal(assets, col) {
  let total = 0, missing = 0;
  for (const a of assets) {
    const v = toKRW(balanceOf(col, a), curOf(a));
    if (v === null) missing++;
    else total += v;
  }
  return { total, missing };
}

/** 금액 입력칸: 통화에 맞게 쉼표/소수점 정리, 원화 환산 안내 갱신 */
export const NO_ORDER = 1e9; // 순서를 정한 적 없는 자산은 뒤로(등록 순)

/** 정렬: 종류 순 → 사용자가 드래그로 정한 순서 → 등록 순 */
export const makeOrder = (types) => (a, b) =>
  types.indexOf(a.type) - types.indexOf(b.type) ||
  (a.order ?? NO_ORDER) - (b.order ?? NO_ORDER) ||
  a.createdAt.localeCompare(b.createdAt);

/** 나의 자산 / 나의 부채는 같은 창을 쓰고 이름·종류만 다르다. */
export const HOLDINGS = {
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

/** 이 자산·부채(col, id들)에 연결된 살아 있는 내역 */
export function linkedTxs(col, ids) {
  const set = new Set(ids);
  return liveTx().filter((t) => [deltaRef(t.assetDelta), ...(t.deltas || [])].some((x) => x && x.col === col && set.has(x.id)));
}
/** 지워진(또는 없는) 자산·부채에 연결된 채 남은 내역 */
export function orphanTxs() {
  return liveTx().filter((t) => [deltaRef(t.assetDelta), ...(t.deltas || [])].some((x) => x && (!S[x.col]?.[x.id] || S[x.col][x.id].deleted)));
}
/** 내역 한 줄 요약: '10/7 동생 차입 300,000원' */
export function txBrief(t) {
  const what = isLoanTx(t) ? "차입" : isRepayTx(t) ? "상환" : t.kind;
  return `${Number(t.date.slice(5, 7))}/${Number(t.date.slice(8))} ${t.content || t.category || ""} ${what} ${won(txKRW(t))}`;
}

// ---------------- 자주 쓰는 내용·거래처 ----------------
// phrases: { id: 'phrase:필드:종류:글자', field: 'content'|'party', kind, text } — 같은 글자는 기기끼리 겹치지 않게 id를 글자로
export const phraseId = (field, kind, text) => `phrase:${field}:${kind}:${text}`;
export const livePhrases = (field, kind) => Object.values(S.phrases || {})
  .filter((p) => !p.deleted && p.field === field && p.kind === kind)
  .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
export function addPhrase(field, kind, text, now) {
  const id = phraseId(field, kind, text);
  S.phrases ||= {};
  S.phrases[id] = { id, field, kind, text, createdAt: S.phrases[id]?.createdAt || now, updatedAt: now, deleted: false };
}
export function removePhrase(id, now) {
  if (S.phrases?.[id]) S.phrases[id] = { ...S.phrases[id], deleted: true, updatedAt: now };
}
/** 내용·거래처가 같은 가장 최근 내역의 카테고리(새 내역 자동 선택용). 내용이 비면 null */
export function guessCategory(kind, content, party) {
  const c = (content || "").trim(), p = (party || "").trim();
  if (!c) return null;
  const hit = liveTx().filter((t) => t.kind === kind && t.category && (t.content || "").trim() === c && (t.party || "").trim() === p).sort(txNewestFirst)[0];
  return hit ? { category: hit.category, subcategory: hit.subcategory || "" } : null;
}
