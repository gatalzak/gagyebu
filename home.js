// 가탈작 가계부 — 현황 탭(종합·상세, 예산·반복 내역·카드·순자산 줄)
import { saveState, uid, nowISO } from "./store.js";
import { toKRW } from "./fx.js";
import { $, EXPENSE_TYPES, S, debtType, esc, fmtAmount, liveTx, monthTx, nowTime, parseAmount, shiftMonth, signed, sum, toast, todayStr, txKRW, txNewestFirst, ui, won, ym } from "./core.js";
import { BUDGET_TOTAL, MOVE_NONE, SHORT_DEBT, activeInstallments, applyFav, autoRecur, balanceOf, budgetId, cardBill, cardCycle, catsFor, curOf, dday, deltaRef, expenseCats, hasBilling, hasHoldings, holdingsAt, isLoanTx, isMoveTx, isPlainExpense, isRepayTx, isShortDebt, linkKey, liveBudgets, liveLink, liveRecurs, loanTotals, md, monthEnd, monthLast, moveRoute, netStartMonth, newTxDraft, nextPayMonth, parseLinkKey, recurDate, recurItem, recurLastAmount, recurName, recurStatus, recurTx, recurVia, repayTotals, routeTotals, shortDebtType, signedWon } from "./model.js";
import { SUM_ICON, bindAmount, closeModal, homeLabel, openModal } from "./uikit.js";
import { networthBody } from "./settle.js";
import { txRow } from "./list.js";
import { openRepayDialog, openTxDialog } from "./entry.js";
import { commit, main, render, scheduleSync } from "./app.js";
export const budgetBar = (spent, budget) => {
  const pct = budget ? spent / budget : 0;
  const cls = pct > 1 ? "over" : pct >= 0.8 ? "warn" : "ok";
  return { cls, pct, html: `<div class="bud-bar"><i class="${cls}" style="width:${Math.min(100, pct * 100).toFixed(1)}%"></i></div>` };
};
/** 현황: 예산 섹션 (exp: 이번 달 지출 내역 전부) */
export function budgetSection(exp) {
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
export function openBudgetDialog() {
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
export function recurringSection() {
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
export function openRecurAction(id) {
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
export async function registerRecurring(tx, src) {
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
export function openRecurringDialog() {
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
export function cardBillSection() {
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
export function openCardDialog(id) {
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
export function homeTabs() {
  return `<div class="tabs sub-tabs home-parts">${[["summary", "현황(종합)"], ["detail", "현황(상세)"]]
    .map(([k, label]) => `<button data-home-part="${k}" class="${ui.homePart === k ? "active" : ""}">${label}</button>`).join("")}</div>`;
}

// ---------------- 결산 (이번 달) ----------------
/** 한 달 숫자 모으기 */
export function netWorthLine() {
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
export function homeView(part = "summary") {
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

  // 지금 남은 단기 부채(나의 부채 잔액 기준) — 이번 달 새로 생긴 금액과 다른 숫자라 종류별로 따로 보여 줌
  const shortDebts = Object.values(S.debts).filter((d) => !d.deleted && SHORT_DEBT[debtType(d)]);
  const owedBy = {};
  shortDebts.forEach((d) => { const t = debtType(d); owedBy[t] = (owedBy[t] || 0) + (toKRW(balanceOf("debts", d), curOf(d)) ?? 0); });
  const owed = Object.values(owedBy).reduce((a, v) => a + v, 0);
  const owedLine = shortDebts.length ? `<div class="row owed-row">
      <div class="row-main"><span>지금 남은 단기 부채</span><span class="cred">${won(owed)}</span></div>
      ${Object.keys(SHORT_DEBT).filter((t) => Math.round(owedBy[t] || 0)).map((t) => `<div class="row-sub"><span>└ ${SHORT_DEBT[t].label}</span><span>${won(owedBy[t])}</span></div>`).join("")}
    </div>` : "";

  const segs = {
    수입: [inc, "inc", "+"],
    고정지출: [fixed, "exp", "-"],
    변동지출: [variable, "exp", "-"],
    자산이동: [mov, "mov", ""],
    "단기 부채": [shortDebt, "cred", ""], // 이번 달 새로 생긴 단기 부채(카드·마통·미납 등으로 쓴 돈), 부호 없이
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
  const catSections = ui.seg === "단기 부채"
    ? Object.entries(SHORT_DEBT).map(([type, info]) => {
        const list = selTx.filter((t) => shortDebtType(t) === type);
        if (!list.length) return "";
        return `
      <div class="group-title"><span class="cat-badge b-cred">${info.label}</span></div>
      ${buildCatSections(list, type)}`;
      }).join("")
    // 자산이동: 경로(출금 → 입금)마다 섹션, 하위 줄은 내역의 '내용'별 금액
    : ui.seg === "자산이동" ? buildCatSections(selTx.map((t) => ({ ...t, category: moveRoute(t) || MOVE_NONE, subcategory: (t.content || "").trim() || "내용 없음" })))
    : ui.seg === "부채 상환" ? "" // 부채 상환은 합계 아래 경로별 하위 항목만
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
  ${section("단기부채", "단기 부채 · 이번 달 새로 생김", "cred", sum(shortDebt), shortDebtRows + owedLine)}
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
      ${ui.seg === "단기 부채" ? Object.entries(SHORT_DEBT).map(([type, info]) => {
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
