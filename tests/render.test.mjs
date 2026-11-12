// tests/render.test.mjs — 본문 마크업 변환·숫자 포맷·날짜 도구 테스트 (XSS 무해화 포함)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderInline, toPlainText, toSpeechText, splitTokens, extractRefs, makeContext, termLabel, splitSentences, TERM_ID_RE,
} from '../js/render.js';
import {
  escapeHtml, html, raw, formatValue, formatFact, formatExact, fmtNum, roundTo, parseInputNumber,
  kstDate, kstIso, addDays, addMonths, mondayOf, diffDays, weekday, isValidYmd, formatDateKo, seededRng, shuffle, uuid,
} from '../js/util.js';

const lesson = {
  terms: [
    { id: 'per', ko: 'PER(주가수익비율)', en: 'P/E ratio', short: '주가가 1주당 순이익의 몇 배인지' },
    { id: 'eps', ko: 'EPS(주당순이익)', en: 'EPS', short: '1주가 벌어들인 이익' },
  ],
  facts: [
    { id: 0, label: '삼성전자 종가', value: 206000, unit: '원', asof: '2026-11-11', source_url: 'https://example.com/a' },
    { id: 1, label: '등락률', value: 3.57, unit: '%', asof: '2026-11-11', source_url: 'https://example.com/b', change: true },
    { id: 2, label: '하락', value: -1.2, unit: '%', asof: '2026-11-11', source_url: 'https://example.com/c', change: true },
  ],
};
const ctx = makeContext(lesson);

test('용어 마크업 → 버튼, 숫자 마크업 → 포맷된 숫자 + ⓘ', () => {
  const out = renderInline('[[per]]는 주가를 [[eps|주당순이익]]으로 나눈다. 종가는 {{f:0}}.', ctx);
  assert.match(out, /<button type="button" class="term" data-term="per">PER<\/button>/);
  assert.match(out, /data-term="eps">주당순이익<\/button>/);
  assert.match(out, /206,000원<button type="button" class="fact-info" data-fact="0"/);
  assert.match(out, /aria-label="삼성전자 종가 출처 보기"/);
});

test('XSS: 본문·표시 이름·숫자 이름에 섞인 HTML 은 모두 글자로 바뀐다', () => {
  const evil = '<script>alert(1)</script> [[per|<img src=x onerror=alert(1)>]] "\' & {{f:0}}';
  const evilCtx = makeContext({
    terms: lesson.terms,
    facts: [{ ...lesson.facts[0], label: '"><svg onload=alert(1)>' }],
  });
  const out = renderInline(evil, evilCtx);
  assert.doesNotMatch(out, /<script|<img|<svg/i);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(out, /&quot;&#39; &amp;/);
  assert.match(out, /aria-label="&quot;&gt;&lt;svg onload=alert\(1\)&gt; 출처 보기"/);
});

test('사전에 없는 용어는 버튼 없이 글자로, 없는 숫자는 ? 로 표시', () => {
  const out = renderInline('[[unknown-term]] 와 {{f:9}}', ctx);
  assert.doesNotMatch(out, /<button[^>]*data-term/);
  assert.match(out, /unknown-term/);
  assert.match(out, /fact-missing/);
});

test('상승·하락 숫자는 ▲▼ 와 색 구분 클래스를 함께 붙인다(색만으로 구분하지 않음)', () => {
  const up = renderInline('{{f:1}}', ctx);
  const down = renderInline('{{f:2}}', ctx);
  assert.match(up, /class="fact num up">▲3\.57%/);
  assert.match(down, /class="fact num down">▼1\.2%/);
  assert.deepEqual(formatFact({ value: 0, unit: '%', change: true }), { text: '0%(보합)', dir: 'flat' });
});

test('순수 글자·읽기용 문장', () => {
  assert.equal(toPlainText('[[per]] {{f:0}} [[eps|주당순이익]]', ctx), 'PER 206,000원 주당순이익');
  assert.equal(toSpeechText('[[per]]은 {{f:1}}, 공식은 주가 ÷ EPS', ctx), 'PER은 3.57퍼센트 상승, 공식은 주가 나누기 EPS');
  assert.equal(toSpeechText('비율 7%p'), '비율 7퍼센트포인트');
});

test('마크업 조각 나누기·참조 모으기', () => {
  assert.deepEqual(splitTokens('a [[per]] b {{f:2}}').map((t) => t.type), ['text', 'term', 'text', 'fact']);
  assert.deepEqual(extractRefs('[[per]] [[eps|x]] {{f:0}} {{f:12}}'), { termIds: ['per', 'eps'], factIds: [0, 12] });
  assert.deepEqual(splitTokens('[[PER]] {{f:x}}').map((t) => t.type), ['text'], '형식이 틀린 마크업은 글자로 남는다');
  assert.equal(termLabel({ ko: 'PER(주가수익비율)' }), 'PER');
  assert.equal(termLabel({ ko: '배당' }), '배당');
  assert.equal(termLabel({ ko: 'X', label: '엑스' }), '엑스');
  assert.ok(TERM_ID_RE.test('forward-per') && !TERM_ID_RE.test('Per') && !TERM_ID_RE.test('per-') && !TERM_ID_RE.test('1per'));
});

test('긴 글은 문장 단위로 나눈다(듣기용)', () => {
  assert.deepEqual(splitSentences('첫 문장이다. 두 번째다! 세 번째?'), ['첫 문장이다.', '두 번째다!', '세 번째?']);
  const long = `${'가'.repeat(100)}, ${'나'.repeat(100)}`;
  const parts = splitSentences(long, 120);
  assert.ok(parts.length === 2 && parts.every((p) => p.length <= 121), JSON.stringify(parts));
});

test('금액·비율·배수 포맷', () => {
  assert.equal(formatValue(52300, '원'), '52,300원');
  assert.equal(formatValue(9643400000000, '원'), '9조 6,434억 원');
  assert.equal(formatValue(756000000000, '원'), '7,560억 원');
  assert.equal(formatValue(30000000000000, '원'), '30조 원');
  assert.equal(formatValue(75100000000000, '원'), '75조 1,000억 원');
  assert.equal(formatValue(-296900000000, '원'), '-2,969억 원');
  assert.equal(formatValue(250000000, '원'), '2.5억 원');
  assert.equal(formatValue(12.5, '배'), '12.5배');
  assert.equal(formatValue(31.2, '배'), '31.2배');
  assert.equal(formatValue(4.49, '배'), '4.49배');
  assert.equal(formatValue(10, '배'), '10.0배');
  assert.equal(formatValue(7.84, '%'), '7.84%');
  assert.equal(formatValue(40, '%', { digits: 0 }), '40%');
  assert.equal(formatValue(7971242, '명'), '797.1만 명');
  assert.equal(formatValue(1.5, '달러'), '1.5달러');
  assert.equal(formatValue(NaN, '원'), '–');
  assert.equal(formatExact(9643400000000, '원'), '9,643,400,000,000원');
});

test('숫자 도구', () => {
  assert.equal(roundTo(1.005, 2), 1.01);
  assert.equal(fmtNum(1234567.891, 2), '1,234,567.89');
  assert.equal(fmtNum(12.5, 2, 1), '12.5');
  assert.equal(fmtNum(10, 2, 1), '10.0');
  assert.equal(fmtNum(-0.004, 2), '0');
  assert.equal(parseInputNumber('1,234.5'), 1234.5);
  assert.equal(parseInputNumber(' 50 000 '), 50000);
  assert.equal(parseInputNumber(''), null);
  assert.equal(parseInputNumber('abc'), null);
  assert.equal(parseInputNumber('-'), null);
});

test('html 템플릿은 끼워 넣는 값을 자동으로 이스케이프한다', () => {
  const name = '<b onclick="x">';
  assert.equal(html`<p>${name}</p>`.value, '<p>&lt;b onclick=&quot;x&quot;&gt;</p>');
  assert.equal(html`<ul>${['a', '<b>'].map((s) => html`<li>${s}</li>`)}</ul>`.value, '<ul><li>a</li><li>&lt;b&gt;</li></ul>');
  assert.equal(html`${raw('<i>ok</i>')}`.value, '<i>ok</i>');
  assert.equal(html`${null}${undefined}${false}${0}`.value, '0');
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
});

test('한국 날짜(KST) 계산은 기기 시간대와 무관하다', () => {
  assert.equal(kstDate(new Date('2026-11-11T14:59:59Z')), '2026-11-11');
  assert.equal(kstDate(new Date('2026-11-11T15:00:00Z')), '2026-11-12');
  assert.equal(kstIso(new Date('2026-11-30T10:50:00Z')), '2026-11-30T19:50:00+09:00');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-11-30', 3), '2027-02-28');
  assert.equal(addMonths('2026-11-11', 6), '2027-05-11');
  assert.equal(mondayOf('2026-11-15'), '2026-11-09');    // 일요일 → 그 주 월요일
  assert.equal(mondayOf('2026-11-09'), '2026-11-09');
  assert.equal(weekday('2026-11-30'), 1);
  assert.equal(diffDays('2026-11-01', '2026-11-15'), 14);
  assert.equal(isValidYmd('2026-02-30'), false);
  assert.equal(isValidYmd('2026-11-30'), true);
  assert.equal(formatDateKo('2026-11-30'), '11월 30일 (월)');
  assert.equal(formatDateKo('2026-11-30', { year: true, withWeekday: false }), '2026년 11월 30일');
});

test('씨앗 난수는 같은 씨앗이면 같은 순서를 낸다(주간 퀴즈 고정)', () => {
  const a = shuffle([1, 2, 3, 4, 5, 6], seededRng('weekly:2026-11-09'));
  const b = shuffle([1, 2, 3, 4, 5, 6], seededRng('weekly:2026-11-09'));
  const c = shuffle([1, 2, 3, 4, 5, 6], seededRng('weekly:2026-11-16'));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.match(uuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
