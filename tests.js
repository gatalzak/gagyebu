import { cleanPhotos } from "./photos.js";
// 계산 자동 테스트: index.html?selftest(메모리 모드 앱)를 띄워 계산 함수를 정해진 예제로 검사한다.
// 실제 데이터(IndexedDB)·드라이브는 건드리지 않는다. 새 기능을 고칠 때마다 이 페이지가 모두 통과하는지 확인한다.

const NOW = "2026-01-01T00:00:00.000Z";
const asset = (id, name, base, type = "은행", extra = {}) => ({ id, type, name, currency: "KRW", amount: base, base, createdAt: NOW, updatedAt: NOW, deleted: false, ...extra });
const debt = (id, name, base, type = "신용카드", extra = {}) => ({ id, type, name, currency: "KRW", amount: base, base, createdAt: NOW, updatedAt: NOW, deleted: false, ...extra });
let seq = 0;
const tx = (o) => ({ id: o.id || `t${seq++}`, time: "12:00", expenseType: o.kind === "지출" ? "변동" : "", category: o.kind === "자산이동" ? "" : "식비", subcategory: "",
  currency: "KRW", content: "", party: "", memo: "", createdAt: NOW, updatedAt: NOW, deleted: false, ...o });
const byId = (arr) => Object.fromEntries(arr.map((x) => [x.id, x]));
const spend = (id, date, amount, link, o = {}) => tx({ id, date, kind: "지출", amount, assetDelta: { col: link[0], id: link[1], amount: link[0] === "debts" ? amount : -amount }, ...o });
const income = (id, date, amount, assetId) => tx({ id, date, kind: "수입", category: "월급", amount, assetDelta: { col: "assets", id: assetId, amount } });
const repay = (id, date, amount, debtId, assetId) => tx({ id, date, kind: "자산이동", amount, deltas: [{ col: "debts", id: debtId, amount: -amount }, { col: "assets", id: assetId, amount: -amount }] });

const tests = [];
const test = (group, name, fn) => tests.push({ group, name, fn });
function eq(actual, expected, what = "") {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what ? `${what}: ` : ""}기대 ${e} / 실제 ${a}`);
}
function ok(cond, what) { if (!cond) throw new Error(what); }

// ---------------- 잔액 ----------------
test("잔액", "기준 금액 + 수입·지출 내역으로 계산", (G) => {
  G.reset({ assets: byId([asset("a", "통장", 100000)]), transactions: byId([spend("x1", "2026-10-01", 30000, ["assets", "a"]), income("x2", "2026-10-02", 50000, "a")]) });
  eq(G.balanceOf("assets", G.S.assets.a), 120000, "통장 잔액");
  G.S.transactions.x1 = { ...G.S.transactions.x1, deleted: true };
  G.clearCache();
  eq(G.balanceOf("assets", G.S.assets.a), 150000, "지출 삭제 뒤 잔액");
});
test("잔액", "예전 기록(기준 금액 없음)은 migrateBalances가 지금 잔액을 유지하도록 채움", (G) => {
  const legacy = asset("a", "통장", 500); delete legacy.base;
  G.reset({ assets: byId([legacy]), transactions: byId([spend("x", "2026-10-01", 100, ["assets", "a"])]) });
  eq(G.migrateBalances(), 1, "고친 개수");
  G.clearCache();
  eq(G.S.assets.a.base, 600, "기준 금액");
  eq(G.balanceOf("assets", G.S.assets.a), 500, "잔액 유지");
});

// ---------------- 단기 부채·지출 구분 ----------------
test("지출 구분", "신용카드로 쓴 돈은 지출이 아니라 단기 부채", (G) => {
  G.reset({ assets: byId([asset("a", "통장", 0)]), debts: byId([debt("c", "카드", 0)]),
    transactions: byId([spend("x1", "2026-10-01", 20000, ["debts", "c"]), spend("x2", "2026-10-02", 5000, ["assets", "a"])]) });
  eq(G.shortDebtType(G.S.transactions.x1), "신용카드");
  const f = G.monthFigures(Object.values(G.S.transactions));
  eq([f.exp, f.debtUse], [5000, 20000], "[지출, 단기 부채]");
  eq(G.balanceOf("debts", G.S.debts.c), 20000, "카드 부채");
});
test("지출 구분", "마통 이자 기록(interest)은 지출로 셈", (G) => {
  G.reset({ debts: byId([debt("m", "마통", 0, "마이너스통장")]), transactions: byId([spend("x", "2026-10-01", 3000, ["debts", "m"], { interest: true, expenseType: "고정" })]) });
  eq(G.shortDebtType(G.S.transactions.x), null);
  eq(G.monthFigures(Object.values(G.S.transactions)).exp, 3000, "지출");
});

// ---------------- 부채 상환·대출 ----------------
test("부채", "부채 상환: 자산·부채가 같이 줄고 순자산은 그대로", (G) => {
  G.reset({ assets: byId([asset("a", "통장", 500000)]), debts: byId([debt("c", "카드", 100000)]), transactions: byId([repay("r", "2026-10-05", 100000, "c", "a")]) });
  const t = G.S.transactions.r;
  eq([G.isRepayTx(t), G.isMoveTx(t), G.isLoanTx(t)], [true, false, false], "[상환, 자산이동, 대출]");
  eq([G.balanceOf("assets", G.S.assets.a), G.balanceOf("debts", G.S.debts.c)], [400000, 0], "[통장, 카드]");
  eq(G.holdingsAt("2026-10-04").net, G.holdingsAt("2026-10-31").net, "상환 전후 순자산");
});
test("부채", "대출 실행 저장: 부채·입금 자산 변화와 메모가 저장됨 (주석 버그 재발 방지)", (G) => {
  G.reset({ assets: byId([asset("a", "통장", 0)]), debts: byId([debt("l", "전세대출", 0, "대출")]) });
  const err = G.saveLoanTx({ debt: G.S.debts.l, asset: G.S.assets.a, amount: 1000000, date: "2026-10-01", time: "", memo: "잔금" });
  eq(err, null, "오류");
  const t = Object.values(G.S.transactions)[0];
  eq([t.deltas?.length, t.memo, G.isLoanTx(t)], [2, "잔금", true], "[변화 개수, 메모, 대출 실행]");
  G.clearCache();
  eq([G.balanceOf("assets", G.S.assets.a), G.balanceOf("debts", G.S.debts.l)], [1000000, 1000000], "[통장, 대출]");
});
test("부채", "변화 없이 저장됐던 대출 실행 기록 복구 (repairLoanTxs)", (G) => {
  const d = debt("l", "주담대", 0, "대출", { createdAt: "2026-10-11T10:00:00.000Z" });
  const broken = tx({ id: "b", date: "2026-10-11", kind: "자산이동", amount: 200000000, content: "주담대", createdAt: "2026-10-11T10:00:00.500Z" });
  G.reset({ debts: byId([d]), transactions: byId([broken]) });
  eq(G.repairLoanTxs(), 1, "고친 개수");
  eq(G.S.transactions.b.deltas, [{ col: "debts", id: "l", amount: 200000000 }]);
});
test("부채", "시작 잔액 보정: 기록된 부채보다 많이 갚으면 시작 잔액에 더해 0원으로 끝남", async (G, doc) => {
  G.reset({ assets: byId([asset("a", "통장", 500000)]), debts: byId([debt("c", "카드", 0)]) });
  G.openRepayDialog({ presetDebt: "c", preset: { amount: 100000, asset: "assets:a", date: "2026-10-03", time: "09:00" } });
  const cb = doc.querySelector("[name=addStart]");
  ok(cb && cb.checked, "'시작 잔액에 더하기' 체크가 켜져 있어야 함");
  doc.querySelector("[data-act=save]").click();
  await new Promise((r) => setTimeout(r, 50));
  G.clearCache();
  eq([G.S.debts.c.base, G.balanceOf("debts", G.S.debts.c), G.balanceOf("assets", G.S.assets.a)], [100000, 0, 400000], "[카드 시작 잔액, 카드 부채, 통장]");
});

// ---------------- 순자산 ----------------
test("순자산", "날짜별 순자산 = 시작 잔액 + 그날까지 내역", (G) => {
  G.reset({ assets: byId([asset("a", "통장", 1000000)]), transactions: byId([income("i", "2026-09-10", 300000, "a"), spend("e", "2026-10-05", 100000, ["assets", "a"])]) });
  eq([G.holdingsAt("2026-08-31").net, G.holdingsAt("2026-09-30").net, G.holdingsAt("2026-10-31").net], [1000000, 1300000, 1200000]);
});

// ---------------- 카드 결제일·할부 ----------------
const card25 = () => debt("c", "삼성카드", 0, "신용카드", { payDay: 25, closeDay: 11, closeMonth: "this" });
const card14 = () => debt("k", "국민카드", 0, "신용카드", { payDay: 14, closeDay: 31, closeMonth: "prev" });
test("카드", "사용 기간: 25일 결제·당월 11일 마감 / 14일 결제·전월 말일 마감(2월 말일)", (G) => {
  G.reset({});
  const a = G.cardCycle(card25(), "2026-10");
  eq([a.start, a.end, a.payDate], ["2026-09-12", "2026-10-11", "2026-10-25"], "25일 카드");
  const b = G.cardCycle(card14(), "2026-03");
  eq([b.start, b.end, b.payDate], ["2026-02-01", "2026-02-28", "2026-03-14"], "14일 카드");
});
test("카드", "쓴 날짜 → 청구되는 결제 달 (마감일 당일·다음 날)", (G) => {
  G.reset({});
  eq([G.payMonthOf(card25(), "2026-10-11"), G.payMonthOf(card25(), "2026-10-12"), G.payMonthOf(card14(), "2026-02-28"), G.payMonthOf(card14(), "2026-12-31")],
    ["2026-10", "2026-11", "2026-03", "2027-01"]);
});
test("카드", "할부 3개월 100,000원 → 33,333 / 33,333 / 33,334, 넷째 달은 없음", (G) => {
  G.reset({ debts: byId([card25()]), transactions: byId([spend("x", "2026-10-03", 100000, ["debts", "c"], { inst: 3 })]) });
  const bills = ["2026-10", "2026-11", "2026-12", "2027-01"].map((m) => G.cardBill(G.S.debts.c, m).total);
  eq(bills, [33333, 33333, 33334, 0]);
});
test("카드", "청구 금액: 일시불 + 할부 회차, 이전 기간 사용분 제외 + 상환 완료 인식", (G) => {
  globalThis.__testWin.__fakeToday = "2026-10-12";
  G.reset({ assets: byId([asset("a", "통장", 1000000)]), debts: byId([card25()]), transactions: byId([
    spend("x1", "2026-09-05", 50000, ["debts", "c"]), spend("x2", "2026-09-20", 100000, ["debts", "c"]),
    spend("x3", "2026-10-03", 90000, ["debts", "c"], { inst: 3 }), spend("x4", "2026-10-12", 20000, ["debts", "c"]),
  ]) });
  const d = G.S.debts.c;
  eq(G.nextPayMonth(d), "2026-10", "다음 결제 달");
  eq([G.cardBill(d, "2026-10").total, G.cardBill(d, "2026-11").total], [130000, 50000], "[10월, 11월 청구]");
  G.S.transactions.r = repay("r", "2026-10-20", 130000, "c", "a");
  eq(G.cardBill(d, "2026-10").paid, 130000, "상환 인식");
  const inst = G.activeInstallments(d)[0];
  eq([inst.next, inst.n, inst.left], [1, 3, 90000], "[다음 회차, 개월, 남은 금액]");
});

// ---------------- 반복 내역 ----------------
const recur = (o) => ({ id: "rc", nature: "fixed", day: 5, amount: 17000, currency: "KRW", variable: false, auto: false, startMonth: "2026-08", skips: [],
  fields: { kind: "지출", expenseType: "고정", category: "문화/여가", subcategory: "", content: "구독료", party: "", memo: "", link: "assets:a", fromAsset: "", toAsset: "", debtMode: "", pay: "" },
  createdAt: NOW, updatedAt: NOW, deleted: false, ...o });
test("반복 내역", "매달 31일(말일) → 2월은 28일", (G) => {
  G.reset({});
  eq([G.recurDate(recur({ day: 31 }), "2026-02"), G.recurDate(recur({ day: 31 }), "2026-04"), G.recurDate(recur({ day: 5 }), "2026-10")], ["2026-02-28", "2026-04-30", "2026-10-05"]);
});
test("반복 내역", "상태: 예정 / 날짜 지남 / 기록됨 / 건너뜀", (G) => {
  G.reset({ assets: byId([asset("a", "통장", 0)]), recurring: byId([recur({ day: 15 })]) });
  const r = () => G.S.recurring.rc;
  globalThis.__testWin.__fakeToday = "2026-10-12";
  eq(G.recurStatus(r(), "2026-10"), "plan", "15일 전");
  globalThis.__testWin.__fakeToday = "2026-10-20";
  eq(G.recurStatus(r(), "2026-10"), "due", "15일 지남");
  G.S.transactions.d = spend("d", "2026-10-20", 17000, ["assets", "a"], { recurId: "rc", recurMonth: "2026-10" });
  eq(G.recurStatus(r(), "2026-10"), "done", "기록 후");
  G.S.recurring.rc = { ...r(), skips: ["2026-11"] };
  eq(G.recurStatus(r(), "2026-11"), "skip", "건너뛴 달");
});
test("반복 내역", "자동 기록: 지난 달만 한 번씩, 다시 돌려도 중복 없음, 건너뛴 달 제외", (G) => {
  globalThis.__testWin.__fakeToday = "2026-10-12";
  G.reset({ assets: byId([asset("a", "통장", 100000)]), recurring: byId([recur({ auto: true, skips: ["2026-09"] })]),
    transactions: byId([spend("src", "2026-08-05", 17000, ["assets", "a"], { recurId: "rc", recurMonth: "2026-08" })]) });
  eq(G.autoRecur(), 1, "처음 실행(9월은 건너뜀, 10월만)");
  eq(!!G.S.transactions["recur:rc:2026-10"], true, "10월 기록 id");
  eq(G.autoRecur(), 0, "다시 실행");
  G.clearCache();
  eq(G.balanceOf("assets", G.S.assets.a), 66000, "통장(8월 + 10월 지출)");
});

// ---------------- 예산·통계 ----------------
test("예산", "카드로 쓴 돈도 예산 사용액에 포함", (G) => {
  globalThis.__testWin.__fakeToday = "2026-10-12";
  G.ui.month = "2026-10";
  G.reset({ assets: byId([asset("a", "통장", 0)]), debts: byId([debt("c", "카드", 0)]),
    budgets: { "budget:식비": { id: "budget:식비", category: "식비", amount: 100000, createdAt: NOW, updatedAt: NOW, deleted: false } },
    transactions: byId([spend("x1", "2026-10-02", 60000, ["assets", "a"]), spend("x2", "2026-10-03", 30000, ["debts", "c"])]) });
  const html = G.budgetSection(Object.values(G.S.transactions));
  ok(html.includes("10,000원 남음"), "'10,000원 남음'이 보여야 함");
  ok(html.includes("90%"), "'90%'가 보여야 함");
});
test("통계", "카테고리 추이 평균은 기록을 시작한 달부터만", (G) => {
  G.ui.month = "2026-09";
  const food = { "05": 320000, "06": 280000, "07": 350000, "08": 300000, "09": 410000 };
  G.reset({ transactions: byId(Object.entries(food).map(([m, v]) => tx({ id: `f${m}`, date: `2026-${m}-05`, kind: "지출", amount: v, category: "식비" }))) });
  G.ui.statCat = "식비";
  const html = G.catTrendSection();
  ok(html.includes("5개월 평균"), "'5개월 평균'이어야 함(4월은 기록 전)");
  ok(html.includes("332,000원"), "평균 332,000원");
});

// ---------------- 내역 성격 ----------------
test("내역 성격", "성격 ↔ 입력 값 변환", (G) => {
  G.reset({ debts: byId([debt("c", "카드", 0)]), assets: byId([asset("a", "통장", 0)]) });
  eq([G.natureOf({ kind: "지출", debtMode: "신용카드" }), G.natureOf({ kind: "지출", expenseType: "고정", debtMode: "" }), G.natureOf({ kind: "자산이동" })], ["card", "fixed", "move"]);
  eq(G.natureDraft("fixed", "debts:c").link, "", "고정지출로 바꾸면 카드 연결은 비움");
  eq(G.natureDraft("card", "assets:a").link, "debts:c", "카드가 하나면 자동 선택");
  eq(G.natureDraft("move", "assets:a").fromAsset, "assets:a", "자산이동은 출금 자산으로");
});

// ---------------- 내역 필터 ----------------
test("내역 필터", "성격·카테고리·자산·금액·기간으로 거르기", (G) => {
  G.reset({ assets: byId([asset("a", "통장", 0), asset("b", "지갑", 0, "현금")]), debts: byId([debt("c", "카드", 0)]), transactions: byId([
    spend("x1", "2026-10-02", 12000, ["debts", "c"]), spend("x2", "2026-10-03", 5000, ["assets", "a"], { category: "카페/간식" }),
    spend("x3", "2026-08-03", 50000, ["assets", "a"]), income("x4", "2026-10-10", 3000000, "a"), repay("x5", "2026-10-20", 12000, "c", "a"),
  ]) });
  const T = G.S.transactions;
  eq(["x1", "x2", "x4", "x5"].map((k) => G.txNature(T[k])), ["card", "var", "income", "repay"], "성격");
  const pass = (f) => Object.keys(T).filter((k) => { G.ui.filter = { ...G.emptyFilter(), ...f }; return G.txPassesFilter(T[k]); }).sort();
  eq(pass({ natures: ["card"] }), ["x1"], "카드 사용만(10월)");
  eq(pass({ cats: ["식비"], period: "6m" }), ["x1", "x3"], "식비·최근 6개월");
  eq(pass({ holding: "assets:a", period: "all" }), ["x2", "x3", "x4", "x5"], "통장이 낀 내역");
  eq(pass({ min: 10000, max: 60000, period: "all" }), ["x1", "x3", "x5"], "금액 1만~6만");
  G.ui.filter = G.emptyFilter();
});

// ---------------- 카테고리 자동 선택 ----------------
test("입력", "내용·거래처가 같은 최근 내역의 카테고리를 고름 (거래처가 다르면 안 고름)", (G) => {
  G.reset({ assets: byId([asset("a", "통장", 0)]), transactions: byId([
    spend("x1", "2026-09-01", 9000, ["assets", "a"], { content: "점심", party: "김밥천국", category: "식비" }),
    spend("x2", "2026-10-01", 9000, ["assets", "a"], { content: "점심", party: "김밥천국", category: "카페/간식", subcategory: "" }),
    spend("x3", "2026-10-02", 9000, ["assets", "a"], { content: "점심", party: "회사", category: "식비" }),
  ]) });
  eq(G.guessCategory("지출", "점심", "김밥천국")?.category, "카페/간식", "가장 최근 것");
  eq(G.guessCategory("지출", "점심", "다른 곳"), null, "거래처 다름");
  eq(G.guessCategory("지출", "", "김밥천국"), null, "내용 없음");
});

// ---------------- 다 갚고 지운 부채 ----------------
test("부채", "다 갚고 지운 부채: 지난달 순자산에는 남고, 남은 내역 정리 대상이 아님", (G) => {
  G.reset({
    assets: byId([asset("a", "통장", 100000)]),
    debts: byId([debt("p", "휴대폰 요금 9월", 75740, "미납금", { createdAt: "2026-09-01T00:00:00.000Z" })]),
    transactions: byId([repay("r", "2026-10-05", 75740, "p", "a")]),
  });
  eq(Math.round(G.holdingsAt("2026-09-30").net), 100000 - 75740, "지우기 전 9월 말");
  G.S.debts.p = { ...G.S.debts.p, deleted: true, paidOff: true };
  G.clearCache();
  eq(Math.round(G.holdingsAt("2026-09-30").net), 100000 - 75740, "지운 뒤에도 9월 말은 그대로");
  eq(Math.round(G.holdingsAt("2026-10-31").net), 100000 - 75740, "10월 말");
  eq(G.orphanTxs().length, 0, "정리할 내역 없음");
  G.S.debts.p = { ...G.S.debts.p, paidOff: false };
  eq(G.orphanTxs().length, 1, "그냥 지운 부채는 정리 대상");
});

// ---------------- 사진 정리 ----------------
test("사진 정리", "안 쓰는 사진만 정리: 드라이브는 휴지통(2일 안 된 파일 제외), 기기 사진 삭제", async () => {
  const now = Date.parse("2026-10-12T00:00:00Z");
  const files = [
    { id: "f1", name: "클로드가계부_사진_keep.jpg", createdTime: "2026-09-01T00:00:00Z" }, // 쓰는 사진
    { id: "f2", name: "클로드가계부_사진_old.jpg", createdTime: "2026-09-01T00:00:00Z" }, // 안 씀 → 휴지통
    { id: "f3", name: "클로드가계부_사진_new.jpg", createdTime: "2026-10-11T12:00:00Z" }, // 안 쓰지만 하루 전 → 그대로
  ];
  const trashed = [];
  const api = async (path, opts = {}) => {
    if (opts.method === "PATCH") { trashed.push(path.split("/").pop()); return { json: async () => ({}) }; }
    return { json: async () => ({ files }) };
  };
  const removed = [];
  const r = await cleanPhotos(api, ["keep"], { now, list: async () => [{ id: "keep" }, { id: "gone" }], remove: async (id) => removed.push(id) });
  eq([trashed, removed, r], [["f2"], ["gone"], { drive: 1, local: 1 }], "[휴지통, 기기 삭제, 결과]");
});

// ---------------- 실행 ----------------
async function run() {
  const frame = document.getElementById("app");
  const win = frame.contentWindow;
  for (let i = 0; i < 100 && !win.__gagyebu; i++) await new Promise((r) => setTimeout(r, 50));
  const G = win.__gagyebu;
  const summary = document.getElementById("summary");
  if (!G) { summary.textContent = "앱을 테스트 모드로 띄우지 못했어요."; summary.className = "bad"; return; }
  globalThis.__testWin = win;
  win.__hideAmt = false;
  const results = [];
  for (const t of tests) {
    win.__fakeToday = "2026-10-12";
    G.ui.month = "2026-10";
    G.closeModal();
    try { await t.fn(G, frame.contentDocument); results.push({ ...t, pass: true }); }
    catch (e) { results.push({ ...t, pass: false, why: e.message }); }
  }
  G.closeModal();
  G.reset({});
  G.render();
  const failed = results.filter((r) => !r.pass);
  summary.textContent = failed.length ? `${results.length}개 중 ${failed.length}개 실패` : `${results.length}개 모두 통과`;
  summary.className = failed.length ? "bad" : "ok";
  let group = "";
  document.getElementById("results").innerHTML = results.map((r) => {
    const head = r.group !== group ? `<div class="group">${(group = r.group)}</div>` : "";
    return `${head}<div class="t ${r.pass ? "ok" : "bad"}"><span class="m">${r.pass ? "✓" : "✕"}</span><span>${r.name}${r.pass ? "" : `<span class="why">${r.why.replace(/</g, "&lt;")}</span>`}</span></div>`;
  }).join("");
  window.__testResults = { total: results.length, failed: failed.map((r) => `${r.group} · ${r.name}: ${r.why}`) };
}
run();
