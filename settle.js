// 가탈작 가계부 — 결산 탭(순자산·카테고리 추이·결산 엑셀)
import { toKRW } from "./fx.js";
import { makeXlsxBook } from "./xlsx.js";
import { $, ASSET_TYPES, DEBT_TYPES, FILE_PREFIX, S, esc, liveTx, monthTx, shiftMonth, signed, sum, toast, txKRW, ui, won } from "./core.js";
import { curOf, deltaRef, hasHoldings, holdingsAt, isLoanTx, isShortDebt, monthEnd, monthFigures, netStartMonth, signedWon } from "./model.js";
import { EXCEL_ICON, homeLabel, openModal } from "./uikit.js";
import { TX_SHEET_WIDTHS, downloadBlob, txSheetRows } from "./manage.js";
import { main, render } from "./app.js";
export function settleData() {
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
export function networthSection() {
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
export function networthBody({ withChg = true } = {}) {
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
      ${on ? `<text x="${x + bw / 2}" y="${v >= 0 ? y0 - h - 5 : y0 + h + 12}" text-anchor="${i === 0 ? "start" : i === months.length - 1 ? "end" : "middle"}" class="ct-val">${won(Math.round(v)).replace("원", "")}</text>` : ""}
      <text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle" class="nw-tick">${Number(mk.slice(5))}월</text>
    </g>`;
  }).join("");
  // 자산·부채 구성 아래에 둔다. 한 달뿐이어도 보여 주고, 기록이 쌓이면 달마다 늘어난다
  const chart = `
    <div class="nw-trend">
      <div class="nw-trend-head"><span>순자산 추이</span><span class="muted">최근 ${months.length}개월 · 달마다 말일 기준</span></div>
      <svg class="nw-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="최근 ${months.length}개월 순자산 추이">
        <line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" class="nw-zero"/>
        ${bars}
      </svg>
    </div>`;
  const trendHint = months.length > 1 ? "막대를 누르면 그 달로 이동해요." : "다음 달부터 달마다 막대가 늘어나 추이를 볼 수 있어요.";

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
    ${reasons}
    <div class="row nw-comp">
      <div class="row-main"><span class="nw-badge nb-asset">자산</span><span class="inc">${won(end.asset)}</span></div>
      ${comp(end.assets, ASSET_TYPES, "")}
    </div>
    <div class="row nw-comp nw-comp-debt">
      <div class="row-main"><span class="nw-badge nb-debt">부채</span><span class="cred">${won(end.debt)}</span></div>
      ${comp(end.debts, DEBT_TYPES, "")}
    </div>
    ${chart}
    <ul class="note nw-notes"><li>${trendHint}</li><li>외화는 오늘 환율로, 앱을 쓰기 전 기간은 처음 등록한 잔액으로 계산해요.</li></ul>`;
}

// ---------------- 카테고리 추이 ----------------
// 고른 카테고리(또는 전체 지출)의 최근 6개월 지출 막대 + 6개월 평균선. 카드·마통으로 쓴 돈도 포함.
export function catTrendSection() {
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
      <div class="row-sub ct-avg-row"><span><i class="ct-avg-sw" aria-hidden="true"></i>${avgIdx.length < months.length ? `${avgIdx.length}개월` : "6개월"} 평균 (점선)</span><span>${won(Math.round(avg))}</span></div>
    </div>
    <ul class="note nw-notes ct-notes">
      <li>${avg && Math.abs(diff) < 1 ? "평균 지출 금액과 이번 달 지출 금액이 같아요"
        : `평균 지출 금액에 비해: <span class="${!avg ? "muted" : diff > 0 ? "exp" : "inc"}">${!avg ? "-" : `${diff > 0 ? "▲" : "▼"} ${won(Math.abs(Math.round(diff)))} ${diff > 0 ? "더 씀" : "덜 씀"}`}</span>`}</li>
      <li>막대를 누르면 그 달 결산으로 바뀌어요.</li>
      ${used.length < 3 ? "<li>기록이 쌓일수록 추이가 정확해져요.</li>" : ""}
    </ul>
  </section>`;
}

/** 많이 쓴 카테고리(결산 탭·통계 창) */
export function rankSection(cats, catTotal) {
  const top = ui.rankAll ? cats : cats.slice(0, 5);
  return `
  <section class="card home-sec">
    <div class="card-head"><span>많이 쓴 카테고리</span><span class="muted settle-note">카드·마통 사용 포함</span></div>
    ${top.length ? `<div class="row">${top.map(([c, v], i) => `
      <div class="rank-row" data-stat-pick="${esc(c)}">
        <div class="rank-top"><span><span class="rank-no">${i + 1}</span>${esc(c)}</span><span>${won(v)} <span class="muted">${Math.round((v / catTotal) * 100)}%</span></span></div>
        <div class="rank-bar"><span style="width:${(v / top[0][1]) * 100}%"></span></div>
      </div>`).join("")}</div>
      ${cats.length > 5 ? `<button class="fold-line" data-fold="rankAll"><span>${ui.rankAll ? `전체 ${cats.length}개` : `나머지 ${cats.length - 5}개 카테고리`}</span><span class="fold-go">${ui.rankAll ? "접기 ⌃" : "전체 보기 ⌄"}</span></button>` : ""}
      <p class="note rank-hint">카테고리를 누르면 아래 '카테고리 추이'에서 몇 달 흐름을 볼 수 있어요.</p>` : `<div class="empty" style="padding:14px 0">지출 기록이 없어요.</div>`}
  </section>`;
}

/** 결산 탭: 고른 달의 결산 — 요약·저축률 / 지난달 대비 / 많이 쓴 카테고리 / 순자산 */
export function settleView() {
  const { m, tx, cur, prevKey, prevTx, prev, left, rate, cats, catTotal, assetChg, debtChg, netChg } = settleData();
  if (!tx.length) return `<div class="card"><div class="empty">${m}월 기록이 없어요.</div></div>${networthSection()}`;
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
    <div class="row"><div class="row-main"><span>합계 (수입-지출)</span><span>${signedWon(left)}</span></div></div>
    ${cur.debtUse + cur.borrow ? `<div class="row"><div class="row-main">${homeLabel("단기부채", "부채 (신규 발생)", "cred")}<span class="cred">${won(cur.debtUse + cur.borrow)}</span></div>
      ${(() => {
        // 어느 카드·통장에서 얼마나 생겼는지(예: KB신용카드 60,000원)
        const by = {};
        tx.filter(isShortDebt).forEach((t) => { const id = deltaRef(t.assetDelta)?.id; by[id] = (by[id] || 0) + txKRW(t); });
        tx.filter(isLoanTx).forEach((t) => { const id = (t.deltas || []).find((x) => x.col === "debts" && x.amount > 0)?.id; by[id] = (by[id] || 0) + txKRW(t); }); // 차입
        return Object.entries(by).sort((a, b) => b[1] - a[1]).map(([id, v]) => `<div class="row-sub"><span>└ ${esc(S.debts[id]?.name || "부채")}</span><span>${won(v)}</span></div>`).join("");
      })()}</div>` : ""}
  </section>

  <section class="card home-sec">
    <div class="card-head"><span>지난달(${Number(prevKey.slice(5))}월) 대비</span><span></span></div>
    ${prevTx.length ? `<div class="row">
      ${diffRow("수입", cur.inc, prev.inc, true, "exp")}
      ${diffRow("지출", cur.exp, prev.exp, false, "exp")}
      ${diffRow("부채 (신규 발생)", cur.debtUse + cur.borrow, prev.debtUse + prev.borrow, false, "cred")}
    </div>` : `<div class="empty" style="padding:14px 0">지난달 기록이 없어요.</div>`}
  </section>

  ${rankSection(cats, catTotal)}
  ${catTrendSection()}

  ${networthSection()}
  <button class="btn excel-btn settle-excel" data-settle-excel>${EXCEL_ICON}${m}월 결산 엑셀 파일로 내보내기</button>`;
}

export function exportSettlement() {
  const { m, tx, cur, prevKey, prevTx, prev, left, rate, cats, catTotal, assetChg, debtChg, netChg } = settleData();
  if (!tx.length) return toast("내보낼 기록이 없어요");
  const y = ui.month.slice(0, 4), pm = Number(prevKey.slice(5));
  const rows = [], heads = [];
  const head = (...cells) => { heads.push(rows.length); rows.push(cells); };
  const gap = () => rows.push([]);
  head(`${y}년 ${m}월 결산`, "금액");
  rows.push(["수입", cur.inc], ["지출", cur.exp], ["  고정지출", cur.fixed], ["  변동지출", cur.variable],
    ["합계 (수입-지출)", left], ["저축률", rate === null ? "-" : `${rate}%`], ["부채 (신규 발생)", cur.debtUse + cur.borrow], ["부채 상환", cur.repay]);
  gap();
  head(`지난달 대비`, `${pm}월`, `${m}월`, "증감");
  if (prevTx.length) {
    for (const [label, a, b] of [["수입", prev.inc, cur.inc], ["지출", prev.exp, cur.exp], ["부채 (신규 발생)", prev.debtUse + prev.borrow, cur.debtUse + cur.borrow]]) rows.push([label, a, b, b - a]);
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

// ---------------- 푸터: 통계·순자산 창 ----------------
// 창 안에서 달을 바꾸거나 막대·카테고리를 누르면 창을 다시 그린다(뒤 화면도 같은 달로)
function monthNav() {
  return `<div class="sd-nav"><button class="icon-btn" data-sd-month="-1" aria-label="이전 달">‹</button><span>${ui.month.slice(0, 4)}년 ${Number(ui.month.slice(5))}월</span><button class="icon-btn" data-sd-month="1" aria-label="다음 달">›</button></div>`;
}
function bindStatPanel(panel, redraw) {
  const go = (fn) => { fn(); render(); redraw(true); };
  panel.addEventListener("change", (e) => {
    if (e.target.matches("[data-stat-cat]")) go(() => (ui.statCat = e.target.value));
  });
  panel.addEventListener("click", (e) => {
    const nav = e.target.closest("[data-sd-month]");
    if (nav) return go(() => (ui.month = shiftMonth(ui.month, Number(nav.dataset.sdMonth))));
    const sm = e.target.closest("[data-stat-month]") || e.target.closest("[data-nw-month]");
    if (sm) return go(() => (ui.month = sm.dataset.statMonth || sm.dataset.nwMonth));
    const fold = e.target.closest("[data-fold]");
    if (fold) return go(() => (ui[fold.dataset.fold] = !ui[fold.dataset.fold]));
    const sp = e.target.closest("[data-stat-pick]");
    if (sp) {
      go(() => (ui.statCat = sp.dataset.statPick));
      setTimeout(() => $("#modal-root #cat-trend")?.scrollIntoView({ block: "start", behavior: "smooth" }), 30);
    }
  });
}
export function openStatsDialog() {
  const draw = (keep = false) => {
    const { cats, catTotal } = settleData();
    const panel = openModal({
      title: "통계",
      center: true,
      cls: "stat-panel",
      keepScroll: keep,
      body: `${monthNav()}
        ${rankSection(cats, catTotal)}
        ${catTrendSection().replace("그 달 결산으로 바뀌어요", "그 달로 바뀌어요")}`,
    });
    bindStatPanel(panel, draw);
  };
  draw();
}
export function openNetworthDialog() {
  const draw = (keep = false) => {
    const body = hasHoldings()
      ? (() => {
          const end = holdingsAt(monthEnd(ui.month));
          return `<div class="sd-nw-head"><span class="muted">${Number(ui.month.slice(5))}월 말 · 자산 − 부채</span><span class="sd-nw-val">${signedWon(Math.round(end.net)).replace(/^\+/, "")}</span></div>
            ${networthBody({ withChg: true })}`;
        })()
      : `<div class="empty" style="padding:14px 0">나의 자산·부채를 등록하면 순자산과 달마다 추이를 볼 수 있어요.</div>`;
    const panel = openModal({ title: "순자산", center: true, cls: "stat-panel", keepScroll: keep, body: `${monthNav()}${body}` });
    bindStatPanel(panel, draw);
  };
  draw();
}
