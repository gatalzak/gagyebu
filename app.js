// 가탈작 가계부 — 시작·이벤트·동기화
import { loadState, saveState, setMemoryMode, emptyState } from "./store.js";
import { sync, isConfigured, isConnected, connect, handleRedirect, refreshIfNeeded, syncNow, syncDrivePhotos } from "./sync.js";
import { initLock, hideAmounts } from "./lock.js";
import { $, S, SELFTEST, liveTx, migrateDebtTypes, setS, shiftMonth, toast, ui } from "./core.js";
import { activeInstallments, autoRecur, balanceOf, cardBill, cardCycle, cleanMoveCategories, clearLinkCache, emptyFilter, freezeCatEtypes, holdingsAt, isLoanTx, isMoveTx, isRepayTx, liveBudgets, migrateBalances, monthFigures, natureDraft, natureOf, newTxDraft, nextPayMonth, payMonthOf, recurDate, recurLastAmount, recurStatus, repairLoanTxs, retireOldCats, saveLoanTx, seedCats, seedSubcats, shortDebtType, txNature, txPassesFilter } from "./model.js";
import { closeModal, openDatePicker } from "./uikit.js";
import { budgetSection, homeTabs, homeView, openBudgetDialog, openCardDialog, openRecurAction, openRecurringDialog } from "./home.js";
import { catTrendSection, exportSettlement, networthBody, settleView } from "./settle.js";
import { bindSearch, calendarView, listView, monthlyView, openFilterDialog } from "./list.js";
import { openKindPicker, openRepayDialog, openTxDialog } from "./entry.js";
import { fillVersion, footerHTML, openBackupDialog, openFooterLink, openHoldingsDialog, renderBackupBar, renderSyncBar } from "./manage.js";
export async function commit() {
  await saveState(S);
  render();
  scheduleSync();
}

// 데이터가 바뀌면 잠시 뒤 드라이브와 합친다(연속 입력은 한 번에).
export let syncTimer;
export function scheduleSync(delay = 1500) {
  if (SELFTEST) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, delay);
}
export async function runSync() {
  if (SELFTEST) return;
  const pulled = await syncNow(S);
  if (pulled && migrateBalances()) { await saveState(S); scheduleSync(); } // 예전 버전 기기에서 온 자산·부채
  if (pulled && autoRecur()) { await saveState(S); scheduleSync(); } // 다른 기기에서 켠 자동 기록
  if (pulled && !$("#modal-root").children.length) render();
  if (sync.status === "ok") await syncDrivePhotos(liveTx().flatMap((t) => t.photos || [])); // 영수증 사진은 따로
}

// ---------------- 영수증 사진 ----------------
export function render() {
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
export function bindEvents() {
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
  const idle = () => !SELFTEST && document.visibilityState === "visible" && !$("#modal-root").children.length; // 테스트 모드에선 로그인·동기화 안 함
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
    if (e.target.closest("[data-filter-open]")) return openFilterDialog();
    if (e.target.closest("[data-filter-reset]")) { ui.filter = emptyFilter(); render(); return; }
    const off = e.target.closest("[data-chip-off]");
    if (off) {
      const k = off.dataset.chipOff, f = ui.filter;
      if (k === "period") { f.period = "month"; f.from = f.to = ""; }
      else if (k === "amount") { f.min = 0; f.max = 0; }
      else if (k === "holding") f.holding = "";
      else f[k] = [];
      render();
      return;
    }
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
export let revealTimer = null;
export const EYE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/></svg>`;
export const EYE_OFF = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.7"/><path d="M6.5 6.9C3.9 8.6 2.5 12 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.2-1"/><path d="M9.9 9.9a2.8 2.8 0 0 0 4 4"/></svg>`;
export function updateEye() {
  const b = $("#eye-btn");
  if (!b) return;
  b.hidden = !hideAmounts();
  b.innerHTML = globalThis.__hideAmt ? EYE_OFF : EYE;
  b.setAttribute("aria-label", globalThis.__hideAmt ? "금액 잠깐 보기" : "금액 가리기");
  b.classList.toggle("on", !globalThis.__hideAmt);
}
export function bindEye() {
  $("#eye-btn").onclick = () => {
    clearTimeout(revealTimer);
    globalThis.__hideAmt = !globalThis.__hideAmt;
    if (!globalThis.__hideAmt) revealTimer = setTimeout(() => { globalThis.__hideAmt = hideAmounts(); updateEye(); render(); }, 15_000);
    updateEye();
    render();
  };
}

export async function main() {
  if (SELFTEST) return selfTestMain();
  const fresh = handleRedirect(); // 구글 로그인에서 돌아온 경우 토큰 저장
  if (!fresh && refreshIfNeeded()) return; // 토큰 만료 → 조용히 재로그인하러 이동
  setS(await loadState());
  if (seedCats() + retireOldCats() + seedSubcats() + migrateDebtTypes() + repairLoanTxs() + migrateBalances() + freezeCatEtypes()) await saveState(S);
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
/** 자동 테스트 모드: 메모리 저장소 + 계산 함수 노출 (tests.html에서 씀) */
export async function selfTestMain() {
  setMemoryMode(true);
  setS(await loadState());
  seedCats(); seedSubcats();
  bindEvents();
  render();
  globalThis.__gagyebu = {
    get S() { return S; },
    reset(state) { setS({ ...emptyState(), ...state }); clearLinkCache(); seedCats(); seedSubcats(); },
    clearCache() { clearLinkCache(); },
    ui, render, closeModal,
    balanceOf, holdingsAt, migrateBalances, repairLoanTxs, saveLoanTx,
    shortDebtType, isRepayTx, isLoanTx, isMoveTx, monthFigures,
    cardCycle, payMonthOf, cardBill, activeInstallments, nextPayMonth,
    recurDate, recurStatus, recurLastAmount, autoRecur,
    liveBudgets, budgetSection, catTrendSection, networthBody,
    natureOf, natureDraft, openRepayDialog, openTxDialog, newTxDraft,
    txNature, txPassesFilter, emptyFilter,
  };
}

main();
