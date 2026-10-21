// 가탈작 가계부 — 내역 입력 창(내역·상환·부채 발생·1단계·자주 쓰는 내역·사진)
import { saveState, uid, nowISO } from "./store.js";
import { CURRENCIES, parseMoney, formatInput, toInput, formatMoney, toKRW, rateKRW, refreshRates } from "./fx.js";
import { getPhoto, putPhoto, deletePhoto, shrinkImage } from "./photos.js";
import { $, EXPENSE_TYPES, KIND_CLASS, KIND_SIGN, S, debtType, esc, fmtAmount, nowTime, parseAmount, signed, toast, todayStr, ui } from "./core.js";
import { ASSET_LINK, CARD_MODES, INTEREST_CAT, PICK_ITEMS, SHORT_DEBT, addPhrase, addSubcat, amountInCurrency, applyFav, balanceOf, catsFor, clearLinkCache, curOf, deltaRef, dropTx, favFromDraft, favKey, frequentRoutes, guessCategory, isLoanTx, isRepayTx, linkCfgOf, linkKey, linkSign, liveFavs, livePhrases, natureDraft, natureOf, newTxDraft, parseLinkKey, removePhrase, roundFor, saveLoanTx, shortDebtType, subcatsFor, unitLabel } from "./model.js";
import { CAMERA, HOME_ICONS, PENCIL, STAR, bindAmount, closeModal, holdingHelp, holdingOptions, openModal } from "./uikit.js";
import { registerRecurring } from "./home.js";
import { openCategoryEditor, openHoldingsDialog } from "./manage.js";
import { commit, render, scheduleSync } from "./app.js";
export const pendingPhotos = new Map(); // 저장 전(내역 창에서 막 고른) 사진 id → Blob
/** 썸네일·크게 보기에 쓸 Blob (저장 전 사진 → 기기에 저장된 사진 순) */
export async function photoBlob(id) {
  return pendingPhotos.get(id) || (await getPhoto(id).catch(() => null))?.blob || null;
}
/** 사진 크게 보기: 화면 위에 덮어 띄우고, 누르면 닫힌다(내역 창은 그대로) */
export async function openPhotoViewer(id) {
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
/** 상환 저장·삭제 뒤: 다 갚아 0원이 된 부채는 목록에서 지울지 묻고, 지웠던(다 갚은) 부채에 다시 잔액이 생기면 목록에 되살린다.
 *  신용카드·마이너스 통장은 계속 쓰는 것이라 묻지 않는다. 지워도 상환 기록·지난 순자산은 그대로(paidOff) */
async function afterRepay(debtId, paid) {
  const d = debtId && S.debts[debtId];
  if (!d) return;
  clearLinkCache();
  const bal = balanceOf("debts", d);
  if (d.deleted && d.paidOff && bal !== 0) {
    S.debts[d.id] = { ...d, deleted: false, paidOff: false, updatedAt: nowISO() };
    await saveState(S);
    scheduleSync();
    clearLinkCache();
    render();
    return;
  }
  if (!paid || d.deleted || bal !== 0 || CARD_MODES.includes(debtType(d))) return;
  setTimeout(() => {
    const panel = openModal({
      title: "부채 상환 완료",
      center: true,
      body: `
        <p class="paid-msg">'${esc(d.name)}' 부채를 모두 상환해서 <span class="inc">0원</span>이 되었어요.<br>나의 부채 목록에서 삭제할까요?</p>
        <p class="note">삭제해도 상환 기록은 내역에 그대로 남아요.</p>
        <div class="btn-row"><button class="btn" data-paid-keep>그대로 두기</button><button class="btn primary" data-paid-del>예, 삭제</button></div>`,
    });
    panel.querySelector("[data-paid-keep]").onclick = () => { closeModal(); render(); };
    panel.querySelector("[data-paid-del]").onclick = async () => {
      S.debts[d.id] = { ...S.debts[d.id], deleted: true, paidOff: true, updatedAt: nowISO() };
      await saveState(S);
      scheduleSync();
      clearLinkCache();
      closeModal();
      render();
      toast(`'${d.name}'을(를) 나의 부채에서 삭제했어요`);
    };
  }, 0);
}

export function openRepayDialog({ existing = null, presetDebt = "", onDone = closeModal, preset = null, replaces = null, onBack = null } = {}) {
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

  let drawnOnce = false;
  const draw = () => {
    const keepPos = drawnOnce; drawnOnce = true;
    const debtRef = parseLinkKey(draft.debt);
    const debt = debtRef && S.debts[debtRef.id];
    const cur = debt ? curOf(debt) : "KRW";
    const panel = openModal({
      keepScroll: keepPos, // 다시 그릴 때(카테고리 고르기 등) 화면 위치 유지
      cls: "theme-debts",
      onBack,
      center: true,
      title: existing ? "부채 상환 수정" : replaces ? "내역 수정" : "부채 상환",
      body: `
        ${natureSelect("repay")}
        <div class="field"><label>상환할 부채 <span class="req">*</span></label>
          <select class="input" name="debt">${holdingOptions(["debts"], draft.debt).replace("선택 안 함", "부채를 골라 주세요")}</select>
          <div class="fx-hint" data-debt-hint></div>
          <div class="start-fix" data-start-fix hidden>
            <p data-start-msg></p>
            <label class="check-line"><input type="checkbox" name="addStart" ${addStart ? "checked" : ""}> 네, 앱 쓰기 전 사용분이에요 · 시작 잔액에 더하기</label>
          </div>
        </div>
        <div class="field"><label>출금 자산 <span class="req">*</span></label>
          <select class="input" name="asset">${holdingOptions(["assets"], draft.asset).replace("선택 안 함", "출금 자산을 골라 주세요")}</select>
          <div class="fx-hint" data-asset-hint></div>
        </div>
        <div class="field"><label>날짜 · 시간 <span class="req">*</span></label>
          <div class="money-line">
            <input class="input" type="date" name="date" value="${draft.date}">
            <input class="input time-input" type="time" name="time" value="${draft.time}">
          </div>
        </div>
        <div class="field"><label>상환 금액 <span class="muted">(원금)</span> <span class="req">*</span></label>
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
          <p class="note" style="margin-top:6px">원금은 부채에서 빠지고, 이자는 지출(${INTEREST_CAT})로 기록돼요. 이자만 기록하려면 상환 금액을 0으로 두세요. 이자만 기록할 때는 출금 자산을 비워도 되고, 그러면 이자가 이 부채에 더해져요(마통 이자 자동 차감처럼).</p>
        </div>
        <div class="field"><label>메모</label><input class="input" name="memo" placeholder="예: 10월 카드값" value="${esc(draft.memo)}"></div>
        ${existing && !S.transactions[existing.id]?.recurId && draft.amount > 0 ? `<button class="btn fav-add-btn rec-add-btn" data-act="add-recur">${HOME_ICONS.반복} 반복 내역으로 등록 <span class="muted">(매달 ${Number(existing.date.slice(8))}일)</span></button>` : ""}
        <div class="btn-row">
          ${existing ? `<button class="btn danger" data-act="delete">${confirmDelete ? "한 번 더 누르면 삭제" : "삭제"}</button>` : `<button class="btn" data-act="cancel">취소</button>`}
          <button class="btn primary" data-act="save" disabled>${existing || replaces ? "저장" : "상환하기"}</button>
        </div>
        <p class="note req-left" data-req-left></p>`,
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
      goNature(e.target.value, { amount: draft.amount, date: draft.date, time: draft.time, text: draft.memo, asset: draft.asset }, existing || replaces, { onBack });
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
    // 필수 항목(*)이 다 채워져야 상환하기 버튼이 눌린다. 빠진 항목은 버튼 아래에 알려 줌
    const checkReq = () => {
      const pay = parseMoney(amt.value, cur), intr = parseMoney(intIn.value, cur);
      const left = [];
      if (!debt) left.push("상환할 부채");
      if (pay > 0 && !$p("[name=asset]").value) left.push("출금 자산");
      if (!$p("[name=date]").value) left.push("날짜");
      if (!(pay > 0) && !(intr > 0)) left.push("상환 금액");
      $p("[data-act=save]").disabled = left.length > 0;
      $p("[data-req-left]").textContent = left.length ? `필수 항목을 채워 주세요 · ${left.join(", ")}` : "";
    };
    panel.addEventListener("input", checkReq);
    panel.addEventListener("change", checkReq);
    checkReq();

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
      if (draft.amount > 0 && !draft.asset) return toast("출금 자산을 골라 주세요.");
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
      afterRepay(d.id, draft.amount > 0);
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
      afterRepay(prevDebt?.id, false);
      toast(`상환 기록을 삭제했어요${liveInterest ? " · 이자 기록도" : ""} · 잔액도 되돌렸어요`);
    };
  };
  draw();
}

// ---------------- 대출 실행 ----------------
// 대출을 받으면 부채(+)와 받은 돈이 들어간 자산(+)이 함께 늘어난다. 수입이 아니므로 수입·지출 합계에는 넣지 않는다.
/** 대출 실행 내역 만들기/고치기 (rec: 기존 내역 또는 null) */
export function openLoanDialog({ existing = null, presetDate = "", onBack = null, preset = null, replaces = null } = {}) {
  const prevDebt = existing?.deltas.find((d) => d.col === "debts");
  const prevAsset = existing?.deltas.find((d) => d.col === "assets");
  const draft = existing
    ? { debt: linkKey("debts", prevDebt.id), asset: prevAsset ? linkKey("assets", prevAsset.id) : "", amount: existing.amount,
      date: existing.date, time: existing.time || "", memo: existing.memo || "" }
    : { debt: "", asset: preset?.asset || "", amount: preset?.amount || 0, date: preset?.date || presetDate || todayStr(), time: preset?.time || nowTime(), memo: preset?.memo || "" };
  let confirmDelete = false;
  let drawnOnce = false;
  const draw = () => {
    const keepPos = drawnOnce; drawnOnce = true;
    const debt = S.debts[parseLinkKey(draft.debt)?.id];
    const cur = debt ? curOf(debt) : "KRW";
    const panel = openModal({
      keepScroll: keepPos, // 다시 그릴 때(카테고리 고르기 등) 화면 위치 유지
      cls: "theme-debts",
      onBack,
      center: true,
      title: existing ? "부채 발생 수정" : replaces ? "내역 수정" : "부채 발생",
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
        <p class="note">부채 발생(대출 실행·돈 빌림)은 수입이 아니에요. 부채와 입금 자산이 같이 늘어나요.</p>
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
      toast(existing ? "부채 발생 기록을 고쳤어요" : `${d.name} ${formatMoney(draft.amount, curOf(d))} 부채 발생을 기록했어요`);
    };
    if (existing) $p("[data-act=delete]").onclick = async () => {
      if (!confirmDelete) { read(); confirmDelete = true; return draw(); }
      S.transactions[existing.id] = { ...existing, deleted: true, updatedAt: nowISO() };
      closeModal();
      await commit();
      toast("부채 발생 기록을 삭제했어요 · 잔액도 되돌렸어요");
    };
  };
  draw();
}

// 내역 추가/수정
// 외화 내역은 원래 금액(amount, currency)과 입력 당시 원화 금액(krw)을 함께 저장한다.
// 원화 금액은 환율로 자동 계산되지만, 실제 입금·결제된 원화로 직접 고칠 수 있다.
/** 새 내역의 기본값 (kind·expenseType 등을 덮어쓸 수 있음) */
export function natureSelect(key) {
  const cur = PICK_ITEMS.find((it) => it.key === key);
  return `<div class="field nature-field"><label>내역 성격</label>
    <select class="input nature-sel ${cur?.cls || ""}" name="nature">${PICK_ITEMS.map((it, i) =>
      `<option value="${it.key}" ${it.key === key ? "selected" : ""}>${"①②③④⑤⑥⑦⑧"[i]} ${it.name}</option>`).join("")}</select></div>`;
}
/** 다른 성격의 창으로 넘어가기. c: 이어받을 값 {date, time, amount, text, asset}, replaces: 저장하면 지울 원래 내역 */
export function goNature(key, c, replaces = null, { onBack = null } = {}) {
  const done = () => { closeModal(); render(); };
  if (key === "repay") return openRepayDialog({ preset: { amount: c.amount, date: c.date, time: c.time, memo: c.text, asset: c.asset || "" }, replaces, onDone: done, onBack });
  if (key === "borrow") return openLoanDialog({ preset: { amount: c.amount, date: c.date, time: c.time, memo: c.text, asset: c.asset || "" }, replaces, onBack });
  openTxDialog(null, null, newTxDraft(c.date, { ...natureDraft(key, c.asset || ""), amount: c.amount || 0, time: c.time || nowTime(), content: c.text || "" }), { replaces, onBack });
}
/** 성격을 바꿔 다른 창에서 저장할 때 원래 내역(과 연결된 이자 기록)을 지운다 */
export function openKindPicker(presetDate) {
  const panel = openModal({
    cls: "kind-picker",
    center: true,
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
    onPick: (f) => { const d = applyFav(newTxDraft(presetDate), f); delete d.debtMode; openTxDialog(null, null, d, { onBack: back }); },
    onBack: back,
  });
}

const ROUTE_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h13"/><path d="M14 4.5 17.5 8 14 11.5"/><path d="M20 16H7"/><path d="M10 12.5 6.5 16 10 19.5"/></svg>`;
/** 자주 쓰는 자산이동 창: 내역 창 위에 띄우고, 고르면 닫고 onPick(경로) */
function openRouteSheet(onPick) {
  document.getElementById("phrase-sheet")?.remove();
  const el = document.createElement("div");
  el.id = "phrase-sheet";
  el.className = "overlay sheet-overlay";
  const list = frequentRoutes();
  const end = (id) => { const a = S.assets[id]; return `<span class="rt-end"><span>${esc(a.name)}</span><span class="rt-type">(${esc(a.type)})</span></span>`; };
  el.innerHTML = `
    <div class="panel" role="dialog" aria-label="자주 쓰는 자산이동">
      <div class="panel-head center">
        <div class="head-left"></div><h2>자주 쓰는 자산이동</h2>
        <div class="head-actions"><button class="x-btn" data-sheet-close aria-label="닫기">✕</button></div>
      </div>
      <div class="panel-body">
        ${list.length ? `
        <div class="ps-head"><span class="muted">많이 쓴 순서 · 누르면 출금·입금 자산이 채워져요</span></div>
        <div class="ps-list">${list.map((r, i) => `<button class="ps-item route-item" data-route="${i}">
          <span class="rt-block">${end(r.from)}<span class="rt-arrow">→</span>${end(r.to)}</span>
          <span class="route-n muted">${r.count}회</span></button>`).join("")}</div>` : `
        <p class="note ps-empty">아직 자산이동 내역이 없어요. 자산이동을 기록하면, 많이 쓴 출금 자산 → 입금 자산이 여기에 차례로 모여요.</p>`}
      </div>
    </div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.querySelector("[data-sheet-close]").onclick = close;
  el.querySelectorAll("[data-route]").forEach((b) => (b.onclick = () => { close(); onPick(list[Number(b.dataset.route)]); }));
}

/** 자주 쓰는 내용·거래처 창: 내역 창을 닫지 않고 그 위에 띄운다 */
function openPhraseSheet({ field, kind, current, onPick, onChange }) {
  const name = field === "content" ? "내용" : "거래처";
  document.getElementById("phrase-sheet")?.remove();
  const el = document.createElement("div");
  el.id = "phrase-sheet";
  el.className = "overlay sheet-overlay";
  document.body.appendChild(el);
  let editing = false;
  const close = () => el.remove();
  const draw = () => {
    const list = livePhrases(field, kind);
    el.innerHTML = `
      <div class="panel" role="dialog" aria-label="자주 쓰는 ${name}">
        <div class="panel-head center">
          <div class="head-left"></div><h2>자주 쓰는 ${name}</h2>
          <div class="head-actions"><button class="x-btn" data-sheet-close aria-label="닫기">✕</button></div>
        </div>
        <div class="panel-body">
          <div class="money-line ps-add">
            <input class="input" name="phNew" placeholder="새 ${name} 입력" value="${esc(current && !list.some((x) => x.text === current) ? current : "")}">
            <button class="btn primary" data-ph-add>등록</button>
          </div>
          ${list.length ? `
          <div class="ps-head"><span class="muted">${editing ? "지울 항목을 누르세요" : "눌러서 바로 입력"}</span><button class="reg-link ps-edit" data-ph-edit>${editing ? "완료" : "편집"}</button></div>
          <div class="ps-list">${list.map((x, i) => `<button class="ps-item${editing ? " del" : ""}${x.text === current ? " on" : ""}" data-ph="${i}"><span>${esc(x.text)}</span>${editing ? `<span class="ps-x">✕</span>` : `<span class="ps-go">›</span>`}</button>`).join("")}</div>` : `
          <p class="note ps-empty">아직 등록한 ${name}이 없어요. 위 칸에 입력하고 등록하면, 다음부터 눌러서 바로 넣을 수 있어요.</p>`}
        </div>
      </div>`;
    el.querySelector("[data-sheet-close]").onclick = close;
    el.querySelectorAll("[data-ph]").forEach((b) => (b.onclick = async () => {
      const x = list[Number(b.dataset.ph)];
      if (editing) {
        removePhrase(x.id, nowISO());
        await saveState(S); scheduleSync(); onChange(); draw();
        return;
      }
      close();
      onPick(x.text);
    }));
    el.querySelector("[data-ph-edit]")?.addEventListener("click", () => { editing = !editing; draw(); });
    const add = async () => {
      const text = el.querySelector("[name=phNew]").value.trim();
      if (!text) return toast(`등록할 ${name}을 입력하세요`);
      if (list.some((x) => x.text === text)) return toast("이미 등록돼 있어요");
      addPhrase(field, kind, text, nowISO());
      await saveState(S); scheduleSync(); onChange();
      toast(`'${text}' 등록했어요`);
      current = "";
      draw();
    };
    el.querySelector("[data-ph-add]").onclick = add;
    el.querySelector("[name=phNew]").addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
  };
  draw();
}

export function openTxDialog(existing, presetDate, preset = null, { replaces = null, onBack = null } = {}) {
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

  // 내용·거래처 칸 + 오른쪽 별(자주 쓰는 내용·거래처). 등록된 글자면 별이 채워짐
  const phraseInput = (field, ph, val) => {
    const saved = (val || "").trim() && livePhrases(field, draft.kind).some((x) => x.text === (val || "").trim());
    return `<div class="money-line phrase-line">
      <input class="input" name="${field}" placeholder="${ph}" value="${esc(val || "")}">
      <button class="icon-only phrase-btn${saved ? " on" : ""}" data-phrase="${field}" aria-label="자주 쓰는 ${field === "content" ? "내용" : "거래처"}">${STAR}</button>
    </div>`;
  };
  let drawnOnce = false;
  const draw = () => {
    const keepPos = drawnOnce; drawnOnce = true;
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
      keepScroll: keepPos, // 다시 그릴 때(카테고리 고르기 등) 화면 위치 유지
      onBack: existing ? null : onBack, // 내역 성격 고르기에서 왔으면 뒤로 가기
      center: true, // 제목 가운데
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
        <button class="btn route-pick-btn" data-route-pick>${ROUTE_ICON}자주 쓰는 자산이동</button>
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
        <div class="field"><label>내용 <span class="req">*</span></label>${phraseInput("content", draft.kind === "수입" ? "예: 10월 급여" : draft.kind === "자산이동" ? "예: 비상금 통장으로 이체" : "예: 점심 식사", draft.content)}</div>
        ${draft.kind !== "자산이동" ? `<div class="field"><label>거래처/출처</label>${phraseInput("party", draft.kind === "수입" ? "예: (주)회사명 / 통장에 입력된 내역 이름" : "예: 김밥천국 / 통장에 입력된 내역 이름", draft.party)}</div>
        ` : ""}
        ${true ? `<div class="field"><label>카테고리 · 하위 카테고리 <span class="req">*</span></label>
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
          asset: draft.kind === "자산이동" ? draft.fromAsset : ref?.col === "assets" ? draft.link : "" }, existing || replaces, { onBack });
      }
      Object.assign(draft, natureDraft(key, draft.kind === "자산이동" ? draft.fromAsset : draft.link));
      draft.subcategory = "";
      draw();
    };
    if ($p("[name=category]")) {
    $p("[name=category]").onchange = () => { read(); draft.subcategory = ""; draft.catTouched = true; draw(); };
    // 내용·거래처가 이전 내역과 같으면 그 카테고리로(새 내역, 카테고리를 직접 고르기 전)
    const autoCat = () => {
      if (existing || draft.catTouched) return;
      read();
      const g = guessCategory(draft.kind, draft.content, draft.party);
      if (!g || g.category === draft.category || !catList.includes(g.category)) return;
      draft.category = g.category;
      draft.subcategory = g.subcategory;
      draw();
      toast(`이전 내역과 같아서 카테고리를 '${g.category}'(으)로 골랐어요`);
    };
    ["content", "party"].forEach((f) => $p(`[name=${f}]`)?.addEventListener("change", autoCat));
    // 자주 쓰는 내용·거래처: 별을 누르면 내역 창 위에 큰 창(목록을 누르면 바로 채움, 새로 등록, 편집으로 삭제)
    // 자주 쓰는 자산이동: 많이 쓴 '출금 → 입금' 목록에서 고르면 두 칸을 채움
    const rp = $p("[data-route-pick]");
    if (rp) rp.onclick = () => openRouteSheet((r) => {
      read();
      draft.fromAsset = linkKey("assets", r.from);
      draft.toAsset = linkKey("assets", r.to);
      draw();
    });
    panel.querySelectorAll("[data-phrase]").forEach((btn) => (btn.onclick = () => {
      const field = btn.dataset.phrase;
      const input = $p(`[name=${field}]`);
      openPhraseSheet({
        field, kind: draft.kind, current: input.value.trim(),
        onPick: (text) => { input.value = text; btn.classList.add("on"); autoCat(); },
        onChange: () => { const cur = input.value.trim(); btn.classList.toggle("on", !!cur && livePhrases(field, draft.kind).some((x) => x.text === cur)); },
      });
    }));
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
      if (!draft.category) return bad("[name=category]", "카테고리를 골라 주세요.");
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
          asset: ref?.col === "assets" ? draft.link : "" }, existing || replaces, { onBack });
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
          openTxDialog(existing, null, draft, { replaces, onBack });
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
        onPick: (f) => { const d = applyFav(draft, f); delete d.debtMode; openTxDialog(null, null, d, { onBack }); },
        onBack: () => openTxDialog(null, null, draft, { onBack }),
      });
    };
    if (!existing && !draft.amount) amt.focus();
  };
  draw();
}

// ---------------- 자주 쓰는 내역 ----------------
export function favViaText(f) {
  const name = (key) => { const r = key && parseLinkKey(key); const h = r && S[r.col]?.[r.id]; return h && !h.deleted ? esc(h.name) : ""; };
  if (f.kind === "자산이동") { const a = name(f.fromAsset), b = name(f.toAsset); return a || b ? `${a || "?"} → ${b || "?"}` : ""; }
  const n = name(f.link);
  return n ? `${f.kind === "수입" ? "입금" : parseLinkKey(f.link)?.col === "debts" ? "결제" : "출금"} ${n}` : "";
}

/** 자주 쓰는 내역 목록: 누르면 onPick, ✕는 onBack(내역 추가 창으로). 편집 아이콘으로 삭제 모드 */
export function openFavorites({ onPick, onBack }) {
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
