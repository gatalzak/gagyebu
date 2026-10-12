// 가탈작 가계부 — 기본 목록·유틸·상태(S, ui)
import { nowISO } from "./store.js";

// 자동 테스트 모드: tests.html이 index.html?selftest를 띄워 계산을 검사한다(저장·동기화·잠금 없음)
export const SELFTEST = new URLSearchParams(location.search).has("selftest");






// ---------------- 기본 목록 ----------------
export const KINDS = ["수입", "지출", "자산이동"];
export const EXPENSE_TYPES = ["고정", "변동"]; // 화면 표시 순서(고정지출이 앞)
export const CATEGORIES = {
  수입: ["월급", "부수입", "용돈", "이자/배당", "환급", "기타"],
  지출: ["식비", "카페/간식", "교통", "주거/통신", "생활용품", "쇼핑", "의료/건강", "문화/여가", "교육", "경조사", "보험", "금융/이자", "기타"],
};
// 자산이동은 카테고리를 쓰지 않는다(출금 → 입금 자산으로 구분). 예전 기록의 카테고리는 cleanMoveCategories가 비운다.
// 처음에 넣어 두는 하위 카테고리 (이용자가 더하거나 지울 수 있음)
export const DEFAULT_SUBCATS = {
  지출: {
    식비: ["외식", "배달", "장보기"],
    "카페/간식": ["커피", "간식"],
    교통: ["대중교통", "택시", "주유", "주차"],
    "주거/통신": ["월세", "관리비", "통신비", "공과금"],
    쇼핑: ["의류", "전자기기", "온라인쇼핑"],
    "의료/건강": ["병원", "약국", "운동"],
    "문화/여가": ["영화/공연", "여행", "구독서비스"],
    교육: ["학원", "도서"],
    경조사: ["축의금", "부의금", "선물"],
  },
  수입: { 월급: ["기본급", "상여금"], 부수입: ["중고거래", "프리랜스"] },
};
export const ASSET_TYPES = ["현금", "은행", "증권", "부동산", "가상자산", "상품권", "기타"];
export const DEBT_TYPES = ["신용카드", "대출", "마이너스통장", "할부", "미납금", "지인에게 빌린 돈", "기타"];
export const OLD_DEBT_TYPE = { "개인(지인)": "지인에게 빌린 돈" }; // 예전 종류 이름 → 지금 이름
export const debtType = (d) => OLD_DEBT_TYPE[d?.type] || d?.type;
/** 예전 종류 이름으로 저장된 부채를 지금 이름으로 바꾼다 */
export function migrateDebtTypes() {
  let n = 0;
  const now = nowISO();
  for (const d of Object.values(S.debts)) {
    if (!d.deleted && OLD_DEBT_TYPE[d.type]) { S.debts[d.id] = { ...d, type: OLD_DEBT_TYPE[d.type], updatedAt: now }; n++; }
  }
  return n;
}
export const KIND_CLASS = { 수입: "inc", 지출: "exp", 자산이동: "mov" };
export const KIND_SIGN = { 수입: "+", 지출: "-", 자산이동: "" };

// ---------------- 유틸 ----------------
export const FILE_PREFIX = "가탈작가계부"; // 내려받는 파일(백업·엑셀) 이름 앞부분
export const $ = (sel, root = document) => root.querySelector(sel);
export const pad = (n) => String(n).padStart(2, "0");
export const ym = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
export const todayStr = () => { if (SELFTEST && globalThis.__fakeToday) return globalThis.__fakeToday; const d = new Date(); return `${ym(d)}-${pad(d.getDate())}`; };
export const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
/** 최신이 위로: 날짜 → 시각(없으면 맨 아래) → 등록 순 */
export const txNewestFirst = (a, b) => (b.date + (b.time || "") + b.createdAt).localeCompare(a.date + (a.time || "") + a.createdAt);
export const won = (n) => (globalThis.__hideAmt ? "●●●●원" : `${Math.round(n).toLocaleString("ko-KR")}원`); // 금액 가리기 중이면 ●●●●
export const signed = (n, sign) => `${sign}${won(n)}`;
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/** 내역의 원화 금액 (외화 내역은 입력 당시 원화로 저장한 krw) */
export const txKRW = (t) => (t.currency && t.currency !== "KRW" ? t.krw || 0 : t.amount);
export const sum = (arr) => arr.reduce((a, t) => a + txKRW(t), 0);
export const parseAmount = (s) => Number(String(s).replace(/[^\d]/g, "")) || 0;
export const fmtAmount = (n) => (n ? n.toLocaleString("ko-KR") : "");

export function shiftMonth(month, step) {
  const [y, m] = month.split("-").map(Number);
  return ym(new Date(y, m - 1 + step, 1));
}

export let toastTimer;
export function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2000);
}

// ---------------- 상태 ----------------
export let S;
export function setS(v) { S = v; } // 다른 파일에서 상태를 통째로 바꿀 때
export const ui = { month: ym(new Date()), tab: "home", seg: "수입", day: null, openCat: null, olderOpen: null, dayMore: {}, q: "", homePart: "summary" }; // homePart: 현황 탭 안의 종합(summary) / 상세(detail) // day: 달력에서 고른 날짜, openCat: 현황(상세)에서 펼친 카테고리, olderOpen: 내역 탭 이전 내역을 펼친 달, dayMore: 더 보기를 연 날짜

export const liveTx = () => Object.values(S.transactions).filter((t) => !t.deleted);
export const monthTx = () => liveTx().filter((t) => t.date.startsWith(ui.month));

// ---------------- 하위 카테고리 ----------------
// 기기 간 동기화되는 subcats 묶음에 { kind, category, name } 으로 저장한다.
// 기본 하위 카테고리는 모든 기기에서 같은 id(def:…)로 만들어 동기화 때 겹치지 않고, 지운 것은 다시 생기지 않는다.
