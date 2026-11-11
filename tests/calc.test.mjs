// tests/calc.test.mjs — 계산기·검산 파서 단위 테스트 (손계산 예시와 비교)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compound, valuation, roeFromTotals, dividend, avgCost, compoundChartSvg } from '../js/calc.js';
import { evaluate, ExprError, tokenize, variablesIn } from '../js/expr.js';
import { parseKoreanNumber, parseChoice, withinTolerance, checkCalcQuiz, checkDerived } from '../tools/calc-check.mjs';

const close = (actual, expected, tol = 1e-6) => {
  assert.ok(Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected)), `${actual} ≠ ${expected}`);
};

/* ───────────── 손계산 예시 10개 ───────────── */

test('손계산 1 — 적립식: 월 50만 원, 연 7%, 20년(월 복리·월초 적립)', () => {
  const r = 0.07 / 12;
  const expected = 500000 * (((1 + r) ** 240 - 1) / r) * (1 + r);   // 연금 현가(기시급) 공식
  const out = compound({ monthly: 500000, annualRatePct: 7, years: 20 });
  close(out.finalValue, expected);
  assert.equal(out.principal, 120000000);
  close(out.profit, expected - 120000000);
  assert.equal(Math.round(out.finalValue), 261982699);
  assert.equal(out.yearly.length, 20);
  assert.equal(out.yearly[19].principal, 120000000);
});

test('손계산 2 — 거치식: 1,000만 원을 연 5%로 10년', () => {
  const out = compound({ initial: 10000000, annualRatePct: 5, years: 10 });
  close(out.finalValue, 10000000 * (1 + 0.05 / 12) ** 120);
  assert.equal(Math.round(out.finalValue), 16470095);
  assert.equal(out.principal, 10000000);
});

test('손계산 3 — 수익률 0%면 최종 금액 = 원금', () => {
  const out = compound({ initial: 1000000, monthly: 100000, annualRatePct: 0, years: 3 });
  assert.equal(out.finalValue, 1000000 + 100000 * 36);
  assert.equal(out.profit, 0);
});

test('손계산 4 — PER: 주가 50,000원 ÷ EPS 4,000원 = 12.5배', () => {
  const v = valuation({ price: 50000, eps: 4000 });
  assert.equal(v.per, 12.5);
});

test('손계산 5 — PBR·ROE: 주가 50,000 · EPS 4,000 · BPS 40,000 → PBR 1.25배, ROE 10%', () => {
  const v = valuation({ price: 50000, eps: 4000, bps: 40000 });
  assert.equal(v.pbr, 1.25);
  close(v.roe, 10);
  close(v.pbr / v.per * 100, v.roe);     // ROE = PBR ÷ PER
});

test('손계산 6 — 역산: PER 10배, EPS 5,000원 → 주가 50,000원', () => {
  const v = valuation({ per: 10, eps: 5000 });
  assert.equal(v.price, 50000);
});

test('손계산 7 — 역산: PBR 1.5배, ROE 12% → PER 12.5배', () => {
  const v = valuation({ pbr: 1.5, roe: 12 });
  close(v.per, 12.5);
});

test('손계산 8 — 배당: 주가 50,000 · 배당 2,000 · 세율 15.4% → 4%, 세후 1,692원·3.384%', () => {
  const d = dividend({ price: 50000, dps: 2000, taxRatePct: 15.4, shares: 100 });
  close(d.yieldPct, 4);
  close(d.netDps, 1692);
  close(d.netYieldPct, 3.384);
  close(d.gross, 200000);
  close(d.tax, 30800);
  close(d.net, 169200);
});

test('손계산 9 — 평단가: 10주 @50,000 + 10주 @40,000 → 45,000원(-10%)', () => {
  const a = avgCost({ qty: 10, avgPrice: 50000, addQty: 10, addPrice: 40000 });
  assert.equal(a.newAvg, 45000);
  close(a.changePct, -10);
  assert.equal(a.totalQty, 20);
  assert.equal(a.totalCost, 900000);
});

test('손계산 10 — ROE: 순이익 100억 ÷ 자본 1,000억 = 10%', () => {
  close(roeFromTotals(100e8, 1000e8), 10);
});

/* ───────────── 경계·예외 ───────────── */

test('밸류에이션: 적자(EPS ≤ 0)면 PER 을 계산하지 않고 안내한다', () => {
  const v = valuation({ price: 10000, eps: -500 });
  assert.equal(v.per, null);
  assert.ok(v.notes.some((n) => /적자/.test(n)));
});

test('밸류에이션: 값이 하나뿐이면 아무것도 지어내지 않는다', () => {
  const v = valuation({ price: 50000 });
  assert.equal(v.per, null);
  assert.equal(v.pbr, null);
  assert.equal(v.eps, null);
});

test('배당·평단가: 잘못된 입력은 null', () => {
  assert.equal(dividend({ price: 0, dps: 100 }), null);
  assert.equal(dividend({ price: 1000, dps: -1 }), null);
  assert.equal(avgCost({ qty: -1, avgPrice: 1000, addQty: 1, addPrice: 1000 }), null);
  assert.equal(avgCost({ qty: 0, avgPrice: 0, addQty: 0, addPrice: 0 }), null);
  const fresh = avgCost({ qty: 0, avgPrice: 0, addQty: 5, addPrice: 30000 });
  assert.equal(fresh.newAvg, 30000);
  assert.equal(fresh.changePct, null);
  assert.equal(roeFromTotals(100, 0), null);
});

test('복리 그래프: 연도 수만큼 막대가 있는 SVG 를 만든다', () => {
  const out = compound({ monthly: 100000, annualRatePct: 5, years: 5 });
  const svg = compoundChartSvg(out.yearly);
  assert.match(svg, /^<svg class="chart"/);
  assert.equal((svg.match(/class="bar-principal"/g) ?? []).length, 5);
  assert.equal((svg.match(/class="bar-profit"/g) ?? []).length, 5);
  assert.equal(compoundChartSvg([]), '');
});

/* ───────────── 안전한 사칙연산 파서 ───────────── */

test('파서: 사칙연산·괄호·소수·거듭제곱·우선순위', () => {
  assert.equal(evaluate('price / eps', { price: 50000, eps: 4000 }), 12.5);
  assert.equal(evaluate('(1 + 2) * 3'), 9);
  assert.equal(evaluate('1 + 2 * 3'), 7);
  assert.equal(evaluate('1.5 * 2'), 3);
  assert.equal(evaluate('.5 + .25'), 0.75);
  assert.equal(evaluate('2 ^ 3 ^ 2'), 512);
  assert.equal(evaluate('-2 ^ 2'), -4);
  assert.equal(evaluate('2 ^ -1'), 0.5);
  assert.equal(evaluate('--3'), 3);
  assert.equal(evaluate('10 − 4 × 2 ÷ 4'), 8);           // 보기 좋게 쓴 기호도 받는다
  assert.equal(evaluate('f0 / f1 * 100', { f0: 30, f1: 75 }), 40);
});

test('파서: 0 으로 나누기·문법 오류·모르는 변수는 ExprError', () => {
  assert.throws(() => evaluate('10 / (5 - 5)'), ExprError);
  assert.throws(() => evaluate('1 +'), ExprError);
  assert.throws(() => evaluate('(1 + 2'), ExprError);
  assert.throws(() => evaluate('1 2'), ExprError);
  assert.throws(() => evaluate(''), ExprError);
  assert.throws(() => evaluate('a + 1'), /변수 "a"/);
  assert.throws(() => evaluate('x', { x: '3' }), ExprError);
  assert.throws(() => evaluate('1..2'), ExprError);
});

test('파서: 코드 실행 시도는 막는다(eval 을 쓰지 않음)', () => {
  assert.throws(() => evaluate('alert(1)'), ExprError);
  assert.throws(() => evaluate('price; process.exit()'), ExprError);
  assert.throws(() => evaluate('constructor', {}), ExprError);     // 프로토타입 속성은 변수로 보지 않는다
  assert.throws(() => evaluate('__proto__', {}), ExprError);
  assert.throws(() => evaluate('"1" + 1'), ExprError);
  assert.throws(() => evaluate('1'.repeat(400)), /너무 깁니다/);
  assert.throws(() => evaluate('('.repeat(60) + '1' + ')'.repeat(60)), /중첩/);
  assert.deepEqual(variablesIn('price / eps + price'), ['price', 'eps']);
  assert.equal(tokenize('a+1').length, 3);
});

/* ───────────── 보기 숫자 읽기·검산 ───────────── */

test('한국식 숫자 읽기', () => {
  assert.equal(parseKoreanNumber('12.5배'), 12.5);
  assert.equal(parseKoreanNumber('3,870만 원'), 38700000);
  assert.equal(parseKoreanNumber('1억 2,000만 원'), 120000000);
  assert.equal(parseKoreanNumber('9조6,434억원'), 9643400000000);
  assert.equal(parseKoreanNumber('5천 원'), 5000);
  assert.equal(parseKoreanNumber('-5%'), -5);
  assert.equal(parseKoreanNumber('▼3.2%'), -3.2);
  assert.equal(parseKoreanNumber('약 92,020원'), 92020);
  assert.equal(parseKoreanNumber('없음'), null);
  assert.equal(parseChoice('150억 원', '억 원'), 150);
  assert.equal(parseChoice('92,020원', '원'), 92020);
});

test('허용 오차 ±1%', () => {
  assert.equal(withinTolerance(12.5, 12.5), true);
  assert.equal(withinTolerance(12.6, 12.5), true);      // 0.8%
  assert.equal(withinTolerance(12.7, 12.5), false);     // 1.6%
  assert.equal(withinTolerance(0, 0), true);
  assert.equal(withinTolerance(NaN, 1), false);
});

test('계산 퀴즈 검산: 정답 보기·중복 정답·템플릿 변수', () => {
  const good = {
    type: 'calc', q: '?', choices: ['8배', '10배', '12.5배', '20배'], answer: 2,
    calc: { vars: { price: 50000, eps: 4000 }, expr: 'price / eps', template: '주가 {price}원, EPS {eps}원', unit: '배' },
  };
  assert.deepEqual(checkCalcQuiz(good).errors, []);
  assert.equal(checkCalcQuiz(good).result, 12.5);
  assert.match(checkCalcQuiz({ ...good, answer: 1 }).errors.join(), /±1%/);
  assert.match(checkCalcQuiz({ ...good, choices: ['12.5배', '10배', '12.5 배 ', '20배'], answer: 2 }).errors.join(), /정답이 2개/);
  assert.match(checkCalcQuiz({ ...good, calc: { ...good.calc, template: '{price} {per}' } }).errors.join(), /\{per\}/);
  assert.match(checkCalcQuiz({ ...good, calc: { vars: {}, expr: '1' } }).errors.join(), /변수/);
  assert.match(checkCalcQuiz({ ...good, calc: { vars: { a: 1 }, expr: 'a / 0' } }).errors.join(), /0으로/);
});

test('facts 계산값(derived) 검산', () => {
  const facts = [
    { id: 0, value: 206000 }, { id: 1, value: 6605 },
    { id: 2, value: 31.2, derived: 'f0 / f1' },
  ];
  assert.deepEqual(checkDerived(facts), []);
  assert.match(checkDerived([...facts.slice(0, 2), { id: 2, value: 35, derived: 'f0 / f1' }]).join(), /±1% 초과/);
  assert.match(checkDerived([{ id: 0, value: 1, derived: 'f0 * 2' }]).join(), /자기 자신/);
  assert.match(checkDerived([{ id: 0, value: 1, derived: 'f9 * 2' }]).join(), /변수 "f9"/);
});
