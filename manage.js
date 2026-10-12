// 가탈작 가계부 — 관리 창(카테고리·자산/부채·백업·동기화·푸터·보안 설정)
import { saveState, mergeInto, uid, nowISO } from "./store.js";
import { CURRENCIES, parseMoney, formatInput, toInput, formatMoney, toKRW, refreshRates, ratesDate } from "./fx.js";
import { sync, isConfigured, isConnected, connect, disconnect, photoCleanInfo } from "./sync.js";
import { makeXlsx } from "./xlsx.js";
import { lockSection, bindLockSection } from "./lock.js";
import { $, EXPENSE_TYPES, FILE_PREFIX, S, esc, liveTx, nowTime, toast, todayStr, txKRW, ui, won } from "./core.js";
import { HOLDINGS, NO_ORDER, SHORT_DEBT, balanceOf, catEtype, catRecords, catsFor, clearLinkCache, curOf, currencyOptions, deltaRef, isLoanTx, isRepayTx, krwTotal, linkedSum, makeOrder, moveRoute, parseLinkKey, renameCategory, renameSubcat, roundFor, saveLoanTx, shortDebtType, subcatRecords } from "./model.js";
import { GRIP, LOCK_ICON, PENCIL, bindMoney, closeModal, enableReorder, holdingOptions, openModal } from "./uikit.js";
import { openBudgetDialog, openRecurringDialog } from "./home.js";
import { openRepayDialog } from "./entry.js";
import { commit, main, render, runSync, scheduleSync, updateEye } from "./app.js";
export function openCategoryEditor({ kind: startKind = "지출", etype: startEtype = "고정", onClose = closeModal } = {}) {
  const CAT_KINDS = ["수입", "지출", "자산이동"];
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
export const SYNC_TEXT = {
  syncing: "동기화 중…",
  ok: "동기화됨",
  offline: "오프라인 · 연결되면 동기화돼요",
  "need-login": "구글 드라이브 연결이 끊겼어요 · 눌러서 다시 연결",
  error: "동기화 실패 · 눌러서 다시 시도",
};
export function renderSyncBar() {
  const bar = $("#sync-bar");
  const show = isConfigured() && isConnected() && ["need-login", "error", "offline"].includes(sync.status);
  bar.hidden = !show;
  if (show) bar.textContent = SYNC_TEXT[sync.status];
}

// 백업 알림: 마지막 백업 파일 저장 후 BACKUP_DAYS일이 지나면(한 번도 안 했으면 바로) 위에 알림줄.
// '나중에'를 누르면 BACKUP_SNOOZE_DAYS일 뒤에 다시. 기록은 기기별(meta)이다.
export const BACKUP_DAYS = 30, BACKUP_SNOOZE_DAYS = 7, DAY_MS = 86400000;
export function renderBackupBar() {
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
export async function exportBackup() {
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
export function exportExcel(range) {
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
export const TX_SHEET_WIDTHS = [11, 7, 8, 9, 12, 12, 22, 16, 12, 6, 12, 24, 12, 20];
export function txSheetRows(list) {
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
      t.date, t.time || "", isRepayTx(t) ? "부채상환" : isLoanTx(t) ? "부채발생" : t.kind, t.kind === "지출" ? `${t.expenseType || ""}지출` : "",
      t.category || "", t.subcategory || "", t.content || "", t.party || "",
      t.amount, t.currency || "KRW", txKRW(t), holdingName(t), sd ? SHORT_DEBT[sd].label : "", t.memo || "",
    ]);
  }
  return rows;
}

export function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function footerHTML() {
  const links = [["settings", `${LOCK_ICON}보안 설정`], ["budget", "예산"], ["recur", "반복 내역"], ["cats", "카테고리"], ["backup", "백업/복원"]];
  return `
  <footer class="app-footer">
    <nav class="ft-links">${links.map(([k, t]) => `<button class="ft-link${k === "settings" ? " ft-main" : ""}" data-ft="${k}">${t}</button>`).join('<span class="ft-dot">·</span>')}</nav>
    <div class="ft-meta">가탈작 가계부 <span data-app-ver></span> · <a href="privacy.html">개인정보처리방침</a> · <a href="terms.html">이용약관</a></div>
  </footer>`;
}
/** 버전: 설치된 화면 파일 캐시 이름(gagyebu-vNNN)에서 읽는다 — sw.js만 올리면 자동으로 맞음 */
export let appVersion = "";
export function fillVersion() {
  const put = () => document.querySelectorAll("[data-app-ver]").forEach((el) => (el.textContent = appVersion));
  if (appVersion || !("caches" in window)) return put();
  caches.keys().then((keys) => {
    const v = keys.map((k) => /^gagyebu-(v\d+)$/.exec(k)?.[1]).filter(Boolean).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))[0];
    if (v) { appVersion = v; put(); }
  }).catch(() => {});
}
export function openFooterLink(k) {
  if (k === "settings") return openSettingsDialog();
  if (k === "budget") return openBudgetDialog();
  if (k === "recur") return openRecurringDialog();
  if (k === "cats") return openCategoryEditor({ onClose: () => { closeModal(); render(); } });
  if (k === "backup") return openBackupDialog();
}
/** 보안 설정: 앱 잠금 · 금액 가리기 (이 기기에만) */
export function openSettingsDialog() {
  const panel = openModal({
    title: "보안 설정",
    body: `${lockSection()}
      <p class="note" style="margin-top:18px">백업·동기화는 '백업/복원', 예산·반복 내역·카테고리는 아래 메뉴에서 바꿀 수 있어요.</p>`,
  });
  bindLockSection(panel, { reopen: openSettingsDialog, onHideChange: (on) => { globalThis.__hideAmt = on; updateEye(); render(); } });
}

/** 단기부채로 잡는 결제 수단(부채 종류)과 화면 표시 글자 */
export function openHoldingsDialog(col, { startAdd = false, onDone = null } = {}) {
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
          <p class="note" style="margin-top:6px">새로 대출을 받아 통장에 들어왔다면 고르세요. 부채와 입금 자산이 같이 늘고 '부채 발생' 내역이 남아요(수입 아님). 예전부터 있던 빚이면 비워 두세요.</p>
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
export const SYNC_BADGE = {
  ok: ["동기화됨", "sb-ok"],
  syncing: ["동기화 중…", "sb-busy"],
  offline: ["오프라인", "sb-off"],
  "need-login": ["연결 끊김", "sb-bad"],
  error: ["동기화 실패", "sb-bad"],
};
export function syncBadge() {
  const [text, cls] = SYNC_BADGE[sync.status] || ["연결됨", "sb-ok"];
  return `<span class="sync-badge ${cls}">${text}</span>`;
}
export function syncSection() {
  if (!isConfigured()) return `<p class="note">구글 드라이브 동기화 설정 전이에요. 지금은 이 기기에만 저장되고, 아래처럼 파일로 옮길 수 있어요.</p>`;
  if (!isConnected()) return `
    <p class="note">구글 드라이브에 연결하면 폰과 PC의 내역이 자동으로 합쳐져요. 이 앱이 만든 파일(동기화 파일·영수증 사진)에만 접근해요.</p>
    <button class="btn primary" data-connect style="margin-top:10px">구글 드라이브 연결</button>`;
  const last = S.meta.lastSync ? new Date(S.meta.lastSync).toLocaleString("ko-KR") : "아직 없음";
  return `
    <div class="asset-total"><span class="muted">상태</span>${syncBadge()}</div>
    <div class="asset-total"><span class="muted">마지막 동기화</span><span>${last}</span></div>
    ${(() => { const c = photoCleanInfo(); return c ? `<div class="asset-total"><span class="muted">사진 정리</span><span>${new Date(c.at).toLocaleDateString("ko-KR")} · ${c.drive ? `${c.drive}장 휴지통으로` : "정리할 사진 없음"}</span></div>` : ""; })()}
    ${sync.status === "error" && sync.error ? `<p class="note">오류: ${esc(sync.error)}</p>` : ""}
    <div class="btn-row">
      <button class="btn" data-disconnect>연결 해제</button>
      <button class="btn primary" data-sync>${sync.status === "need-login" ? "다시 연결" : "지금 동기화"}</button>
    </div>`;
}

export function openBackupDialog() {
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
    clearLinkCache();
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
