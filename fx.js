// 외화 자산 지원: 통화 목록, 금액 입력/표시, 원화 환산.
// 환율은 open.er-api.com(무료, 키 없음)에서 하루에 한 번 받아 이 기기(localStorage)에 저장한다.
// 요청에는 가계부 데이터가 전혀 포함되지 않는다.

export const CURRENCIES = ["KRW", "USD", "EUR", "JPY", "CNY", "GBP", "AUD", "CAD", "HKD", "SGD", "CHF", "TWD", "THB", "VND"];
export const CURRENCY_NAMES = {
  KRW: "원", USD: "미국 달러", EUR: "유로", JPY: "일본 엔", CNY: "중국 위안", GBP: "영국 파운드",
  AUD: "호주 달러", CAD: "캐나다 달러", HKD: "홍콩 달러", SGD: "싱가포르 달러", CHF: "스위스 프랑",
  TWD: "대만 달러", THB: "태국 바트", VND: "베트남 동",
};

const RATES_KEY = "fx_rates"; // { fetchedAt, rates: { 통화: 1달러당 값 } }
const MAX_AGE = 12 * 60 * 60 * 1000;

/** 통화별 소수점 자리수 (KRW·JPY·VND 0, 나머지 2) */
export const decimals = (cur) => new Intl.NumberFormat("en", { style: "currency", currency: cur }).resolvedOptions().maximumFractionDigits;

/** 입력 문자열 → 숫자 (통화의 소수점 자리까지) */
export function parseMoney(s, cur) {
  const d = decimals(cur);
  const [int = "", frac = ""] = String(s).replace(/[^\d.]/g, "").split(".");
  const n = Number(`${int || 0}.${frac.slice(0, d) || 0}`);
  return Number.isFinite(n) ? n : 0;
}

/** 입력칸 표시용: 1234567.5 → "1,234,567.5" (빈 값이면 "") */
export function formatInput(raw, cur) {
  const d = decimals(cur);
  const clean = String(raw).replace(/[^\d.]/g, "");
  if (!clean) return "";
  let [int, ...rest] = clean.split(".");
  int = (int || "0").replace(/^0+(?=\d)/, "");
  const intFmt = Number(int).toLocaleString("en-US");
  if (!d || !rest.length) return intFmt;
  return `${intFmt}.${rest.join("").slice(0, d)}`;
}

/** 저장된 숫자 → 입력칸 초기값 */
export const toInput = (n, cur) => (n ? formatInput(String(n), cur) : "");

/** 화면 표시: KRW는 "45,000원", 외화는 "1,234.5 USD" */
export function formatMoney(n, cur = "KRW") {
  if (cur === "KRW") return `${Math.round(n).toLocaleString("ko-KR")}원`;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: decimals(cur) })} ${cur}`;
}

function loadRates() {
  try {
    return JSON.parse(localStorage.getItem(RATES_KEY));
  } catch {
    return null;
  }
}

/** 원화 환산 금액. 환율을 모르면 null. */
export function toKRW(amount, cur = "KRW") {
  if (cur === "KRW") return amount;
  const r = loadRates()?.rates;
  if (!r?.KRW || !r[cur]) return null;
  return (amount * r.KRW) / r[cur];
}

/** 1 단위 외화가 몇 원인지 (모르면 null) */
export const rateKRW = (cur) => toKRW(1, cur);

/** 환율이 없거나 12시간이 지났으면 새로 받는다. 새로 받았으면 true. */
export async function refreshRates() {
  const cached = loadRates();
  if (cached && Date.now() - cached.fetchedAt < MAX_AGE) return false;
  if (!navigator.onLine) return false;
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD");
    const data = await res.json();
    if (data.result !== "success" || !data.rates?.KRW) return false;
    localStorage.setItem(RATES_KEY, JSON.stringify({ fetchedAt: Date.now(), rates: data.rates }));
    return true;
  } catch {
    return false;
  }
}

export const ratesDate = () => {
  const c = loadRates();
  return c ? new Date(c.fetchedAt).toLocaleDateString("ko-KR") : null;
};
