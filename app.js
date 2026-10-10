import { loadState, saveState, mergeInto, uid, nowISO } from "./store.js";
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
const sum = (arr) => arr.reduce((a, t) => a + t.amount, 0);
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
const liveAssets = () => Object.values(S.assets).filter((a) => !a.deleted);
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
  selTx.forEach((t) => (byCat[t.category] = (byCat[t.category] || 0) + t.amount));
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
            <span class="amt ${KIND_CLASS[t.kind]}">${signed(t.amount, KIND_SIGN[t.kind])}</span>
          </button>`).join("")}
      </section>`;
    })
    .join("");
}

// ---------------- 팝업 창 ----------------
function openModal({ title, headExtra = "", body }) {
  $("#modal-root").innerHTML = `
    <div class="overlay" data-overlay>
      <div class="panel" role="dialog" aria-label="${esc(title)}">
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
function openTxDialog(existing) {
  const draft = existing
    ? { ...existing }
    : { kind: "지출", expenseType: "변동", date: todayStr(), category: CATEGORIES["지출"][0], amount: 0, memo: "" };
  let confirmDelete = false;

  const draw = () => {
    if (!CATEGORIES[draft.kind].includes(draft.category)) draft.category = CATEGORIES[draft.kind][0];
    const panel = openModal({
      title: existing ? "내역 수정" : "내역 추가",
      body: `
        <div class="seg" data-role="kind">${KINDS.map((k) => `<button data-v="${k}" class="${k === draft.kind ? "on" : ""}">${k}</button>`).join("")}</div>
        ${draft.kind === "지출" ? `
        <div class="field"><label>지출 종류</label>
          <div class="seg" data-role="etype">${EXPENSE_TYPES.map((k) => `<button data-v="${k}" class="${k === draft.expenseType ? "on" : ""}">${k}지출</button>`).join("")}</div>
        </div>` : ""}
        <div class="field"><label>금액(원)</label><input class="input amount-input" name="amount" inputmode="numeric" autocomplete="off" placeholder="0" value="${fmtAmount(draft.amount)}"></div>
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
    const read = () => {
      draft.amount = parseAmount(panel.querySelector("[name=amount]").value);
      draft.date = panel.querySelector("[name=date]").value;
      draft.category = panel.querySelector("[name=category]").value;
      draft.memo = panel.querySelector("[name=memo]").value;
    };
    bindAmount(panel.querySelector("[name=amount]"));
    panel.querySelectorAll("[data-role=kind] button").forEach((b) => (b.onclick = () => { read(); draft.kind = b.dataset.v; draw(); }));
    panel.querySelectorAll("[data-role=etype] button").forEach((b) => (b.onclick = () => { read(); draft.expenseType = b.dataset.v; draw(); }));
    panel.querySelector("[data-act=save]").onclick = async () => {
      read();
      if (draft.amount <= 0) return toast("금액을 입력해 주세요.");
      if (!draft.date) return toast("날짜를 입력해 주세요.");
      const now = nowISO();
      const rec = {
        id: existing?.id || uid(),
        date: draft.date,
        kind: draft.kind,
        expenseType: draft.kind === "지출" ? draft.expenseType : "",
        category: draft.category,
        amount: draft.amount,
        memo: draft.memo.trim(),
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        deleted: false,
      };
      S.transactions[rec.id] = rec;
      closeModal();
      ui.month = rec.date.slice(0, 7);
      await commit();
      toast(`${rec.kind} ${won(rec.amount)} ${existing ? "수정" : "추가"}했어요`);
    };
    const del = panel.querySelector("[data-act=delete]");
    if (del) del.onclick = async () => {
      if (!confirmDelete) { read(); confirmDelete = true; return draw(); }
      S.transactions[existing.id] = { ...existing, deleted: true, updatedAt: nowISO() };
      closeModal();
      await commit();
      toast("삭제했어요");
    };
    if (!existing && !draft.amount) panel.querySelector("[name=amount]").focus();
  };
  draw();
}

// 나의 자산
const PENCIL = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>`;

function openAssetsDialog() {
  let mode = null;   // null: 목록 | "add": 등록 | "edit": 전체 편집
  let drafts = null; // 전체 편집 중인 값 [{ id, type, name, amount, del }]

  const sortedAssets = () =>
    liveAssets().sort((a, b) => ASSET_TYPES.indexOf(a.type) - ASSET_TYPES.indexOf(b.type) || a.createdAt.localeCompare(b.createdAt));

  // 목록(보기 전용): 종류별 한 덩어리, 안쪽은 줄로만 구분
  const draw = () => {
    if (mode === "add") return drawAdd();
    if (mode === "edit") return drawEdit();
    const assets = sortedAssets();
    const groups = ASSET_TYPES.filter((t) => assets.some((a) => a.type === t));
    const body = assets.length
      ? `<div class="asset-total"><span class="muted">총 자산</span><span>${won(sum(assets))}</span></div>` +
        groups.map((t) => {
          const items = assets.filter((a) => a.type === t);
          return `
          <section class="asset-group">
            <div class="asset-group-head"><span class="sector-badge">${t}</span><span class="sector-total">${won(sum(items))}</span></div>
            ${items.map((a) => `<div class="asset-row"><span class="name">${esc(a.name)}</span><span class="amt">${won(a.amount)}</span></div>`).join("")}
          </section>`;
        }).join("")
      : `<div class="empty">등록된 자산이 없어요.<br>오른쪽 위 '자산 등록'으로 추가해 보세요.</div>`;
    const panel = openModal({
      title: "나의 자산",
      headExtra: `<button class="green-btn" data-add>자산 등록</button>` +
        (assets.length ? `<button class="icon-only" data-edit aria-label="자산 편집">${PENCIL}</button>` : ""),
      body: body + `<button class="btn" data-close-btn style="margin-top:18px">닫기</button>`,
    });
    panel.querySelector("[data-add]").onclick = () => { mode = "add"; draw(); };
    panel.querySelector("[data-close-btn]").onclick = closeModal;
    const edit = panel.querySelector("[data-edit]");
    if (edit) edit.onclick = () => {
      drafts = sortedAssets().map((a) => ({ id: a.id, type: a.type, name: a.name, amount: a.amount, del: false }));
      mode = "edit";
      draw();
    };
  };

  // 전체 편집: 모든 자산의 종류·이름·금액을 한 번에 고치고, 삭제는 표시해 두었다가 저장할 때 반영
  const drawEdit = () => {
    const groups = ASSET_TYPES.filter((t) => drafts.some((d) => S.assets[d.id].type === t));
    const panel = openModal({
      title: "자산 편집",
      body: groups.map((t) => `
        <section class="asset-group">
          <div class="asset-group-head"><span class="sector-badge">${t}</span></div>
          ${drafts.filter((d) => S.assets[d.id].type === t).map((d) => `
          <div class="edit-item${d.del ? " removed" : ""}" data-id="${d.id}">
            <div class="edit-line">
              <input class="input sm" name="name" value="${esc(d.name)}" placeholder="이름" ${d.del ? "disabled" : ""}>
              <button class="edit-del" data-toggle-del>${d.del ? "되돌리기" : "삭제"}</button>
            </div>
            <div class="edit-line">
              <select class="input sm type" name="type" ${d.del ? "disabled" : ""}>${ASSET_TYPES.map((x) => `<option ${x === d.type ? "selected" : ""}>${x}</option>`).join("")}</select>
              <input class="input sm amount-input" name="amount" inputmode="numeric" value="${fmtAmount(d.amount)}" placeholder="0" ${d.del ? "disabled" : ""}>
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
      d.amount = parseAmount(el.querySelector("[name=amount]").value);
    });
    panel.querySelectorAll("[name=amount]").forEach(bindAmount);
    panel.querySelectorAll("[data-toggle-del]").forEach((b) => (b.onclick = () => {
      read();
      const d = drafts.find((x) => x.id === b.closest(".edit-item").dataset.id);
      d.del = !d.del;
      drawEdit();
    }));
    panel.querySelector("[data-cancel]").onclick = () => { mode = null; drafts = null; draw(); };
    panel.querySelector("[data-save]").onclick = async () => {
      read();
      if (drafts.some((d) => !d.del && !d.name.trim())) return toast("이름이 빈 자산이 있어요.");
      const now = nowISO();
      let changed = 0;
      for (const d of drafts) {
        const a = S.assets[d.id];
        if (d.del) {
          S.assets[d.id] = { ...a, deleted: true, updatedAt: now };
          changed++;
        } else if (a.type !== d.type || a.name !== d.name.trim() || a.amount !== d.amount) {
          S.assets[d.id] = { ...a, type: d.type, name: d.name.trim(), amount: d.amount, updatedAt: now };
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
      toast(changed ? `${changed}개 자산을 저장했어요` : "바뀐 내용이 없어요");
    };
  };

  // 새 자산 등록
  const drawAdd = () => {
    const panel = openModal({
      title: "자산 등록",
      body: `
        <div class="field" style="margin-top:4px"><label>종류</label>
          <select class="input" name="type">${ASSET_TYPES.map((t) => `<option>${t}</option>`).join("")}</select>
        </div>
        <div class="field"><label>이름</label><input class="input" name="name" placeholder="예: 국민은행 통장"></div>
        <div class="field"><label>금액(원)</label><input class="input amount-input" name="amount" inputmode="numeric" placeholder="0"></div>
        <div class="btn-row"><button class="btn" data-cancel>취소</button><button class="btn primary" data-save>저장</button></div>`,
    });
    bindAmount(panel.querySelector("[name=amount]"));
    panel.querySelector("[data-cancel]").onclick = () => { mode = null; draw(); };
    panel.querySelector("[data-save]").onclick = async () => {
      const name = panel.querySelector("[name=name]").value.trim();
      if (!name) return toast("이름을 입력해 주세요.");
      const now = nowISO();
      const rec = {
        id: uid(),
        type: panel.querySelector("[name=type]").value,
        name,
        amount: parseAmount(panel.querySelector("[name=amount]").value),
        createdAt: now,
        updatedAt: now,
        deleted: false,
      };
      S.assets[rec.id] = rec;
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
  $("#open-assets").onclick = openAssetsDialog;
  $("#open-debts").onclick = () => openModal({ title: "나의 부채", body: `<div class="empty">나의 부채 기능은 준비 중이에요.</div>` });
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
