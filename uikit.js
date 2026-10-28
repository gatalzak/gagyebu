// 가탈작 가계부 — 공통 화면 부품(창·아이콘·선택 목록)
import { parseMoney, formatInput, formatMoney, toKRW, rateKRW } from "./fx.js";
import { $, S, debtType, esc, fmtAmount, liveTx, pad, parseAmount, shiftMonth, todayStr, ui, won } from "./core.js";
import { HOLDINGS, balanceOf, curOf, linkKey, makeOrder } from "./model.js";
export const CAMERA = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l1.6-2.2h6.8L17 8h3v11H4z"/><circle cx="12" cy="13.3" r="3.4"/></svg>`;
export const LOCK_ICON = `<svg class="ft-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>`;
export const ICO = (paths) => `<svg class="home-ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
export const HOME_ICONS = {
  수입: ICO('<path d="M12 4v11"/><path d="M7.5 10.5 12 15l4.5-4.5"/><path d="M5 19h14"/>'),      // 들어오는 돈
  지출: ICO('<path d="M12 15V4"/><path d="M7.5 8.5 12 4l4.5 4.5"/><path d="M5 19h14"/>'),        // 나가는 돈
  자산이동: ICO('<path d="M4 8h14"/><path d="M14.5 4.5 18 8l-3.5 3.5"/><path d="M20 16H6"/><path d="M9.5 12.5 6 16l3.5 3.5"/>'), // 옮기기
  대출실행: ICO('<path d="M4 9.5 12 5l8 4.5"/><path d="M6 10v7M10 10v7M14 10v7M18 10v7"/><path d="M4 19.5h16"/>'), // 은행
  부채상환: ICO('<circle cx="12" cy="12" r="8.5"/><path d="M8.3 12.2l2.5 2.5 5-5"/>'), // 갚음(체크)
  단기부채: ICO('<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M7 15h4"/>'), // 카드
  반복: ICO('<path d="M4.5 11a7.5 7.5 0 0 1 13-4.5L19.5 8.5"/><path d="M19.5 4v4.5H15"/><path d="M19.5 13a7.5 7.5 0 0 1-13 4.5L4.5 15.5"/><path d="M4.5 20v-4.5H9"/>'), // 반복
  예산: ICO('<path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5H12z"/><path d="M15 3.8a8.5 8.5 0 0 1 5.2 5.2H15z"/>'), // 나눠 쓰기(원그래프)
};
export const SUM_ICON = ICO('<path d="M17 5H7l6 7-6 7h10"/>'); // 합계(Σ)
export const homeLabel = (key, text, cls) => `<span class="home-label"><span class="${cls}">${HOME_ICONS[key]}</span>${text}</span>`;

// ---------------- 예산 ----------------
// 지출 카테고리별 월 예산(매달 같은 금액). 신용카드·마통으로 쓴 지출도 그 카테고리 사용액에 들어간다.
// 기기마다 따로 만들어도 겹치지 않게 id는 'budget:카테고리'(전체 예산은 'budget:*').
export const EXCEL_ICON = `<svg class="excel-ico" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" fill="#1d7a45"/><path d="M8.2 8l7.6 8M15.8 8l-7.6 8" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>`;

/** 결산 엑셀: 시트 1 '결산'(요약·지난달 대비·카테고리 전체·자산 변화), 시트 2 '내역'(그달 내역) */
export const FUNNEL = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16l-6.2 7.6V19l-3.6-1.8v-4.6z"/></svg>`;
const BACK_ICON = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/></svg>`; // ← 화살표
/** onBack이 있으면 제목 왼쪽에 뒤로 가기 버튼(예: 내역 추가 → 내역 성격 고르기) */
// 설정 메뉴에서 연 창: 창 스스로 뒤로 가기를 주지 않으면 ←로 설정 메뉴에 돌아간다(창을 닫으면 풀림)
let menuBack = null;
export const setMenuBack = (fn) => (menuBack = fn);
export function openModal({ title, headExtra = "", body, cls = "", onBack = null, center = false, keepScroll = false }) {
  onBack ||= menuBack;
  const prevScroll = keepScroll ? $("#modal-root .overlay")?.scrollTop || 0 : 0; // 같은 창을 다시 그릴 때 보던 위치 유지
  $("#modal-root").innerHTML = `
    <div class="overlay" data-overlay>
      <div class="panel ${cls}" role="dialog" aria-label="${esc(title)}">
        <div class="panel-head${center ? " center" : ""}">
          ${center
            ? `<div class="head-left">${onBack ? `<button class="back-btn" data-back aria-label="뒤로 가기">${BACK_ICON}</button>` : ""}</div><h2>${esc(title)}</h2>`
            : `<div class="head-left">${onBack ? `<button class="back-btn" data-back aria-label="뒤로 가기">${BACK_ICON}</button>` : ""}<h2>${esc(title)}</h2></div>`}
          <div class="head-actions">${headExtra}<button class="x-btn" data-close aria-label="닫기">✕</button></div>
        </div>
        <div class="panel-body">${body}</div>
      </div>
    </div>`;
  const root = $("#modal-root");
  addAmountClear(root);
  addTextClear(root);
  root.querySelector("[data-close]").onclick = closeModal; // 창 밖 여백을 눌러도 닫히지 않고, ✕(또는 창 안의 닫기·취소)로만 닫힌다
  if (onBack) root.querySelector("[data-back]").onclick = onBack;
  if (keepScroll) root.querySelector(".overlay").scrollTop = prevScroll;
  return root.querySelector(".panel");
}
/** 내용·거래처·메모 칸 오른쪽의 작은 ✕: 누르면 칸을 비우고 바로 다시 입력(글자가 있을 때만 보임) */
function addTextClear(root) {
  root.querySelectorAll('input[name=content], input[name=party], input[name=memo]').forEach((input) => {
    if (input.disabled || input.readOnly || input.parentElement.classList.contains("text-clear-wrap")) return;
    const wrap = document.createElement("span");
    wrap.className = "text-clear-wrap";
    input.replaceWith(wrap);
    wrap.appendChild(input);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "amount-clear text-clear";
    btn.setAttribute("aria-label", "지우기");
    btn.textContent = "✕";
    const sync = () => (btn.hidden = !input.value);
    btn.onclick = () => {
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      sync();
      input.focus();
    };
    input.addEventListener("input", sync);
    input.addEventListener("focus", sync);
    wrap.appendChild(btn);
    sync();
  });
}
/** 금액 칸 왼쪽의 작은 ✕: 누르면 금액을 비우고 바로 다시 입력(숫자가 있을 때만 보임) */
function addAmountClear(root) {
  root.querySelectorAll(".amount-wrap").forEach((wrap) => {
    const input = wrap.querySelector("input");
    if (!input || input.disabled || input.readOnly || wrap.querySelector(".amount-clear")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "amount-clear";
    btn.setAttribute("aria-label", "금액 지우기");
    btn.textContent = "✕";
    const sync = () => (btn.hidden = !input.value);
    btn.onclick = () => {
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      sync();
      input.focus();
    };
    input.addEventListener("input", sync);
    input.addEventListener("focus", sync); // 다른 칸이 값을 채워 넣은 경우도
    wrap.appendChild(btn);
    sync();
  });
}
export function closeModal() {
  menuBack = null;
  $("#modal-root").innerHTML = "";
}

export function bindAmount(input) {
  input.addEventListener("input", () => {
    input.value = fmtAmount(parseAmount(input.value));
  });
}

/** 금액칸 단위 표시: 원화는 '원', 외화는 통화 코드 */
export function holdingHelp(cols) {
  const has = cols.some((col) => Object.values(S[col]).some((a) => !a.deleted));
  const msg = has ? "찾는 항목이 없나요?" : cols.includes("debts") ? "등록된 자산·부채가 없어요. 등록해 두면 잔액이 자동으로 바뀌어요." : "등록된 자산이 없어요. 등록해 두면 잔액이 자동으로 바뀌어요.";
  return `<div class="holding-help${has ? "" : " no-holding"}"><span>${msg}</span>
    ${cols.map((col) => `<button class="reg-link" data-reg="${col}">+ ${col === "debts" ? "부채(신용카드 등)" : "자산"} 등록</button>`).join("")}</div>`;
}

/** 선택 목록: 자산(종류별) → 부채(종류별), 현재 잔액을 함께 보여 준다 */
export function holdingOptions(cols, selectedKey, { balance = true, withCard = false, onlyType = "", exclude = [] } = {}) {
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
export const STAR = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>`;
export const PENCIL = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>`;

export function bindMoney(input, getCur, hint) {
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

export const GRIP = `<svg width="14" height="18" viewBox="0 0 14 18" fill="currentColor" aria-hidden="true"><circle cx="4" cy="4" r="1.4"/><circle cx="10" cy="4" r="1.4"/><circle cx="4" cy="9" r="1.4"/><circle cx="10" cy="9" r="1.4"/><circle cx="4" cy="14" r="1.4"/><circle cx="10" cy="14" r="1.4"/></svg>`;
export function enableReorder(panel, onDrop) {
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

export function openDatePicker() {
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
