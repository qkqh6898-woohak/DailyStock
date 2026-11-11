// tests/validate.test.mjs — 강의 검증기 테스트
//   node --test tests/*.test.mjs
//
// 1) 저장소의 샘플 강의 3개는 통과해야 한다.
// 2) 일부러 깨뜨린 JSON 7종(facts 누락, 출처 없음, 잘못된 용어 id, 계산 오답, 금지 표현,
//    퀴즈 type 중복, 본문 직접 숫자)은 "그 이유로" 실패해야 한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT, loadLessons, readJson } from '../tools/common.mjs';
import {
  validateLesson, validateCurriculum, validateGlossary, validateAll, validateFile,
  findBareNumbers, findBanned, curriculumEntryFor, isHttpsUrl, buildIndexItems,
} from '../tools/validate.mjs';
import { mergeTerms } from '../tools/merge-terms.mjs';
import { nextLesson } from '../tools/next-lesson.mjs';

const curriculum = await readJson(path.join(ROOT, 'curriculum', 'curriculum.json'));
const glossary = await readJson(path.join(ROOT, 'glossary', 'terms.json'));
const lessons = await loadLessons(ROOT);
const glossaryById = new Map(glossary.terms.map((t) => [t.id, t]));
const shared = { curriculum, glossaryIds: new Set(glossaryById.keys()), lookupGlossary: (id) => glossaryById.get(id) };

const SAMPLE_PER = 'lessons/2026/11/2026-11-11.json';
const perSample = lessons.find((x) => x.rel === SAMPLE_PER);

/** PER 샘플을 복사해 고친 뒤 검증한다. */
function broken(mutate) {
  const copy = structuredClone(perSample.lesson);
  mutate(copy);
  return validateLesson(copy, { ...shared, filePath: SAMPLE_PER });
}

function assertFails(result, pattern) {
  assert.ok(result.errors.length > 0, '오류가 나와야 하는데 통과했습니다');
  assert.ok(
    result.errors.some((e) => pattern.test(e)),
    `기대한 오류(${pattern})가 없습니다. 실제 오류:\n  ${result.errors.join('\n  ')}`,
  );
}

/* ───────────── 정상 통과 ───────────── */

test('샘플 강의가 3개 있고 모두 검증을 통과한다', () => {
  const samples = lessons.filter((x) => x.lesson.sample === true);
  assert.equal(samples.length, 3);
  assert.deepEqual(samples.map((x) => x.lesson.lesson_no).sort((a, b) => a - b), [1, 9, 21]);
  for (const { rel, lesson } of samples) {
    const r = validateLesson(lesson, { ...shared, filePath: rel });
    assert.deepEqual(r.errors, [], `${rel} 오류`);
  }
});

test('고치지 않은 사본은 통과한다(깨뜨리기 테스트의 기준선)', () => {
  assert.deepEqual(broken(() => {}).errors, []);
});

test('저장소 전체 검증(--all)이 통과한다', async () => {
  const { ok, reports } = await validateAll({ root: ROOT });
  const failed = reports.filter((r) => r.errors.length).map((r) => `${r.file}: ${r.errors.join(' / ')}`);
  assert.equal(ok, true, failed.join('\n'));
});

test('파일 하나만 검증해도 통과한다', async () => {
  const r = await validateFile(path.join(ROOT, SAMPLE_PER));
  assert.deepEqual(r.errors, []);
});

test('커리큘럼은 8개 트랙 68강이고 검증을 통과한다', () => {
  const r = validateCurriculum(curriculum);
  assert.deepEqual(r.errors, []);
  assert.equal(curriculum.tracks.length, 8);
  assert.equal(curriculum.lessons.length, 68);
  const perTrack = Object.fromEntries(curriculum.tracks.map((t) => [t.id, curriculum.lessons.filter((l) => l.track === t.id).length]));
  assert.deepEqual(perTrack, { T1: 8, T2: 12, T3: 10, T4: 10, T5: 8, T6: 8, T7: 6, T8: 6 });
});

test('누적 용어 사전이 검증을 통과한다', () => {
  assert.deepEqual(validateGlossary(glossary).errors, []);
});

/* ───────────── 깨뜨린 JSON 7종 ───────────── */

test('깨뜨리기 1 — facts 누락: 없는 숫자를 참조하면 실패', () => {
  assertFails(broken((l) => { l.body[1] += ' 시가총액은 {{f:99}}이다.'; }), /body\[1\].*\{\{f:99\}\}.*facts 항목이 없습니다/);
});

test('깨뜨리기 1-2 — facts 누락: 기준일·값이 빠지면 실패', () => {
  assertFails(broken((l) => { delete l.facts[0].asof; }), /facts\[0\]\.asof.*기준일/);
  assertFails(broken((l) => { l.facts[0].value = '206,000'; }), /facts\[0\]\.value.*숫자여야/);
  assertFails(broken((l) => { delete l.facts[0].unit; }), /facts\[0\]\.unit/);
});

test('깨뜨리기 2 — 출처 없음: source_url 이 없거나 https 가 아니면 실패', () => {
  assertFails(broken((l) => { delete l.facts[0].source_url; }), /facts\[0\]\.source_url.*출처 주소가 없습니다/);
  assertFails(broken((l) => { l.facts[0].source_url = 'http://example.com/a'; }), /facts\[0\]\.source_url.*https/);
  assertFails(broken((l) => { l.news_case.sources = []; }), /news_case\.sources.*1개 이상/);
});

test('깨뜨리기 3 — 잘못된 용어 id: 사전에 없는 용어를 쓰면 실패', () => {
  assertFails(broken((l) => { l.body[0] += ' [[no-such-term]]도 함께 본다.'; }), /body\[0\].*\[\[no-such-term\]\].*없습니다/);
  assertFails(broken((l) => { l.body[0] += ' [[PER]]은 대문자라 안 된다.'; }), /body\[0\].*마크업 형식/);
});

test('깨뜨리기 4 — 계산 오답: 정답 보기가 계산 결과와 다르면 실패', () => {
  assertFails(broken((l) => { l.quiz[1].answer = 1; }), /quiz\[1\]\.calc.*±1%/);
  assertFails(broken((l) => { l.quiz[1].calc.vars.eps = 5000; }), /quiz\[1\]\.calc.*±1%/);
});

test('깨뜨리기 4-2 — 계산값(derived)이 틀리면 실패', () => {
  assertFails(broken((l) => { l.facts[2].value = 13.2; }), /facts\[2\]\.derived.*±1% 초과/);
});

test('깨뜨리기 5 — 금지 표현: 투자 권유로 읽히는 말이 있으면 실패', () => {
  assertFails(broken((l) => { l.body[4] += ' 그러니 지금 사야 한다.'; }), /body\[4\].*금지 표현.*지금 사/);
  assertFails(broken((l) => { l.summary[0] = '이 종목은 매수 추천이다.'; }), /summary\[0\].*금지 표현.*매수 추천/);
  assertFails(broken((l) => { l.news_case.explain[0] += ' 증권사 목표가는 높다.'; }), /금지 표현.*목표가/);
});

test('깨뜨리기 6 — 퀴즈 type 중복: concept·calc·case 가 각각 1개가 아니면 실패', () => {
  assertFails(broken((l) => { l.quiz[2].type = 'concept'; }), /quiz: type 은 concept · calc · case 가 각각 1개/);
  assertFails(broken((l) => { l.quiz.pop(); }), /quiz: 정확히 3문제/);
});

test('깨뜨리기 7 — 본문 직접 숫자: facts 참조 없이 쓴 숫자는 실패', () => {
  assertFails(broken((l) => { l.body[1] += ' 어제 주가는 52,300원이었다.'; }), /body\[1\]: 숫자 "52,300"이 facts 참조 없이 쓰였습니다/);
  assertFails(broken((l) => { l.body[3] += ' PER 12배는 낮은 편이다.'; }), /body\[3\]: 숫자 "12"이 facts 참조 없이/);
});

/* ───────────── 그 밖의 규칙 ───────────── */

test('형식 규칙: schema, 날짜·경로, 문단 수, 보기 수, disclaimer', () => {
  assertFails(broken((l) => { l.schema = 2; }), /^schema/);
  assertFails(broken((l) => { l.date = '2026-11-12'; }), /date.*일치하지 않습니다/);
  assertFails(broken((l) => { l.date = '2026-13-40'; }), /date.*올바른 날짜/);
  assertFails(broken((l) => { l.body = l.body.slice(0, 2); }), /body.*3~7개/);
  assertFails(broken((l) => { l.quiz[0].choices.pop(); }), /quiz\[0\]\.choices.*4개/);
  assertFails(broken((l) => { l.quiz[0].answer = 4; }), /quiz\[0\]\.answer/);
  assertFails(broken((l) => { l.disclaimer = false; }), /disclaimer/);
  assertFails(broken((l) => { l.summary.pop(); }), /summary.*3개/);
  assertFails(broken((l) => { l.terms[0].short = '가'.repeat(41); }), /terms\[0\]\.short.*40자/);
  assertFails(broken((l) => { l.terms[0].id = 'PER'; }), /terms\[0\]\.id/);
  assertFails(broken((l) => { l.facts[0].asof = '2026-11-12'; }), /facts\[0\]\.asof.*미래/);
});

test('강의 번호 규칙: 커리큘럼 트랙과 일치, 직전 번호 + 1, 2회차 허용', () => {
  assertFails(broken((l) => { l.track = 'T1'; }), /track.*21강의 트랙은 T3/);
  const real = structuredClone(perSample.lesson);
  delete real.sample;
  const ctx = { ...shared, filePath: SAMPLE_PER };
  assert.deepEqual(validateLesson(real, { ...ctx, prevLessonNo: 20 }).errors, []);
  assertFails(validateLesson(real, { ...ctx, prevLessonNo: 18 }), /lesson_no.*19 이어야/);
  assertFails(validateLesson(real, { ...ctx, prevLessonNo: null }), /lesson_no.*첫 강의는 1번/);
  // 샘플은 번호 순서 검사를 받지 않는다
  assert.deepEqual(validateLesson(perSample.lesson, { ...ctx, prevLessonNo: null }).errors, []);
  // 2회차: 89강 = 21강과 같은 주제
  const round2 = { ...real, lesson_no: 89 };
  assert.deepEqual(validateLesson(round2, { ...ctx, prevLessonNo: 88 }).errors, []);
  assert.deepEqual(curriculumEntryFor(curriculum, 89).round, 2);
  assert.equal(curriculumEntryFor(curriculum, 89).entry.no, 21);
  assert.equal(curriculumEntryFor(curriculum, 68).round, 1);
  assert.equal(curriculumEntryFor(curriculum, 0), null);
});

test('본문 숫자 예외: 연도·날짜·세는 말·고유 이름은 허용한다', () => {
  const ok = [
    '2026년 3분기 실적이 11월 30일 15시 30분에 나왔다.',
    '세 가지가 아니라 3가지, 2개 분기, 10년 이상, 1주당, 52주 최고가, 21강에서 배웠다.',
    '2차전지와 S&P500, 코스피200, 코스닥 150, NCM811, M2, G20, 5G, 코로나19 이후.',
    '1~2개월, 제2의 전성기, 1위 기업, 20대 투자자, 24시간 거래.',
  ];
  for (const text of ok) assert.deepEqual(findBareNumbers(text), [], text);
  assert.deepEqual(findBareNumbers('주가는 52,300원이고 PER은 12.5배, 수익률은 7%다.'), ['52,300', '12.5', '7']);
  assert.deepEqual(findBareNumbers('매출 9조 6,434억 원'), ['9', '6,434']);
  assert.deepEqual(findBareNumbers('주주는 500명, 주식은 100주'), ['500', '100']);
  assert.deepEqual(findBareNumbers('EPS4000원'), ['4000']);
  // 강의별 예외 목록(allow_numbers)
  assert.deepEqual(findBareNumbers('4680 배터리와 800V 충전'), ['4680', '800']);
  assert.deepEqual(findBareNumbers('4680 배터리와 800V 충전', ['4680', '800']), []);
  assert.deepEqual(findBareNumbers('가격은 4680원', ['4680']), ['4680'], '금액 단위가 붙으면 예외로 인정하지 않는다');
});

test('금지 표현: 권유 표현은 잡고, 평범한 문장은 통과시킨다', () => {
  const banned = ['매수 추천', '강력 추천합니다', '목표가 10만 원', '지금 사면 늦지 않다', '지금이 기회다',
    '무조건 오른다', '반드시 오릅니다', '매수하세요', '목표주가는 {{f:3}}이다', '수익을 보장합니다', '급등주를 찾는 법'];
  for (const text of banned) assert.ok(findBanned(text).length > 0, `잡아야 함: ${text}`);
  const fine = ['지금 사업보고서를 열어 보자.', '목표주가라는 개념을 비판적으로 읽는다.', '주식은 원금이 보장되지 않는다.',
    '회사는 지금 사상 최대 실적을 냈다.', '낮은 PER이 항상 싸다는 뜻은 아니다.', '이 회사세요? 아니요.'];
  for (const text of fine) assert.deepEqual(findBanned(text), [], `통과해야 함: ${text}`);
});

test('주소 검사: https 만 허용', () => {
  assert.equal(isHttpsUrl('https://dart.fss.or.kr/a?b=1'), true);
  assert.equal(isHttpsUrl('http://dart.fss.or.kr'), false);
  assert.equal(isHttpsUrl('https://localhost'), false);
  assert.equal(isHttpsUrl('javascript:alert(1)'), false);
  assert.equal(isHttpsUrl(''), false);
});

test('목록 생성: 최신 날짜가 먼저, 샘플 표시 유지', () => {
  const items = buildIndexItems(lessons);
  assert.equal(items.length, lessons.length);
  for (let i = 1; i < items.length; i += 1) assert.ok(items[i - 1].date > items[i].date);
  assert.ok(items.every((it) => it.path === `lessons/${it.date.slice(0, 4)}/${it.date.slice(5, 7)}/${it.date}.json`));
  assert.ok(items.filter((it) => it.sample).length === 3);
});

test('용어 병합: 새 용어만 추가하고, 있던 용어는 그대로 둔다', () => {
  const base = { version: 1, updated: 'x', terms: [{ id: 'per', ko: '옛 설명', en: 'P/E', short: '옛 뜻', first_lesson: 5, first_date: '2026-01-01' }] };
  const r = mergeTerms(base, [perSample.lesson]);
  assert.deepEqual(r.added.sort(), ['eps', 'forward-per', 'trailing-per']);
  assert.deepEqual(r.kept, ['per']);
  assert.equal(r.glossary.terms.find((t) => t.id === 'per').ko, '옛 설명');
  assert.equal(r.glossary.terms.find((t) => t.id === 'eps').first_lesson, 21);
  assert.deepEqual(r.glossary.terms.map((t) => t.id), [...r.glossary.terms.map((t) => t.id)].sort());
  const updated = mergeTerms(base, [perSample.lesson], { update: true });
  assert.equal(updated.glossary.terms.find((t) => t.id === 'per').ko, 'PER(주가수익비율)');
  assert.equal(updated.glossary.terms.find((t) => t.id === 'per').first_lesson, 5, '처음 나온 강의는 유지');
});

test('다음 강의 번호: 샘플은 세지 않으므로 첫 정식 강의는 1강', async () => {
  const info = await nextLesson({ root: ROOT, date: '2026-11-30' });
  assert.equal(info.lesson_no, 1);
  assert.equal(info.track, 'T1');
  assert.equal(info.weekday, '월');
  assert.equal(info.path, 'lessons/2026/11/2026-11-30.json');
  assert.equal(info.already_exists, false);
  const sampleDay = await nextLesson({ root: ROOT, date: '2026-11-11' });
  assert.equal(sampleDay.already_exists, true);
  assert.equal(sampleDay.existing_is_sample, true);
});
