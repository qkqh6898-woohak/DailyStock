// tests/logic.test.mjs — 백업·일지·진도·주간 퀴즈·용어장 로직 테스트
// IndexedDB 가 없는 Node 에서는 db.js 가 메모리 저장소로 동작하므로 저장 흐름도 그대로 시험할 수 있다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT, loadLessons, readJson } from '../tools/common.mjs';
import { APP_ID, buildBackup, parseBackup, mergeBackup, backupFileName, BACKUP_STORES } from '../js/backup.js';
import { validateEntry, dueEntries, REASON_MIN } from '../js/journal.js';
import { computeStreak, isComplete, overallPercent, trackProgress, markRead, markQuizDone, getProgressMap } from '../js/progress.js';
import { buildWeeklyQuiz, makeTermQuestion, varyCalcQuestion, varyNumber, plainQuestion, resultKey } from '../js/quiz.js';
import { quickCheck, curriculumEntry, neighbors, weekItems, lessonPath } from '../js/lessons.js';
import { evaluate } from '../js/expr.js';
import { parseKoreanNumber } from '../tools/calc-check.mjs';
import { seededRng } from '../js/util.js';
import * as db from '../js/db.js';
import * as terms from '../js/terms.js';
import { newCard } from '../js/srs.js';

const lessons = (await loadLessons(ROOT)).map((x) => x.lesson);
const curriculum = await readJson(path.join(ROOT, 'curriculum', 'curriculum.json'));
const perLesson = lessons.find((l) => l.date === '2026-11-11');

/* ───────────── 백업 ───────────── */

const sampleData = () => ({
  terms: [{ id: 'per', ko: 'PER', en: 'P/E', short: '주가 ÷ EPS', card: newCard(new Date('2026-11-01T00:00:00Z')), createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' }],
  reviewLogs: [{ id: 1, termId: 'per', rating: 3, state: 0, due: '2026-11-01T00:10:00Z', reviewedAt: '2026-11-01T00:00:00Z' }],
  quizResults: [{ key: '2026-11-11#0', date: '2026-11-11', index: 0, type: 'concept', correct: false, chosen: 0, answeredAt: '2026-11-11T12:00:00Z', attempts: 1, wrongCount: 1 }],
  progress: [{ lesson_no: 1, date: '2026-11-30', readAt: '2026-11-30T12:00:00Z', quizDoneAt: null, updatedAt: '2026-11-30T12:00:00Z' }],
  journal: [{
    id: 'a1b2c3d4-0000-4000-8000-000000000001', date: '2026-11-10', name: 'LG에너지솔루션', action: 'buy', price: 412000, currency: 'KRW', qty: 3,
    reason: 'ESS 수주가 늘고 보조금 없이도 흑자라서 장기 보유를 시작한다', metrics: '영업이익률', risks: '리튬 가격', revisitAt: '2027-02-10',
    review: null, tags: ['per'], createdAt: '2026-11-10T10:00:00Z', updatedAt: '2026-11-10T10:00:00Z',
  }],
  settings: [{ key: 'theme', value: 'dark', updatedAt: '2026-11-01T00:00:00Z' }, { key: 'newPerDay', value: 10, updatedAt: '2026-11-01T00:00:00Z' }],
});

test('백업: 만들기 → JSON → 읽기를 거쳐도 일지·용어가 그대로다', () => {
  const backup = buildBackup(sampleData(), new Date('2026-11-11T12:00:00Z'));
  assert.equal(backup.app, APP_ID);
  assert.equal(backup.backup_version, 1);
  for (const name of BACKUP_STORES) assert.ok(Array.isArray(backup[name]));
  const parsed = parseBackup(JSON.parse(JSON.stringify(backup)));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.skipped, 0);
  assert.deepEqual(parsed.counts, { terms: 1, reviewLogs: 1, quizResults: 1, progress: 1, journal: 1, settings: 2 });
  const j = parsed.data.journal[0];
  assert.equal(j.name, 'LG에너지솔루션');
  assert.equal(j.price, 412000);
  assert.equal(j.reason, sampleData().journal[0].reason);
  assert.equal(parsed.data.terms[0].card.state, 0);
  assert.equal(parsed.exportedAt, '2026-11-11T12:00:00.000Z');
});

test('백업: 다른 앱의 파일·새 버전·깨진 항목을 걸러 낸다', () => {
  assert.equal(parseBackup(null).ok, false);
  assert.match(parseBackup({ app: 'Other', backup_version: 1 }).error, /이 앱/);
  assert.match(parseBackup({ app: APP_ID, backup_version: 99 }).error, /새로운 버전/);
  assert.match(parseBackup({ app: APP_ID }).error, /버전/);
  const dirty = buildBackup({
    terms: [{ id: 'ok', ko: '좋음', short: '뜻' }, { id: 'no-ko' }, 'string'],
    journal: [{ id: 'bad id!', date: '2026-11-10', name: 'x' }, { id: 'good-1', date: '2026-11-10', name: 'x', action: 'hack', price: -5 }],
    settings: [{ key: 'unknownKey', value: 1 }, { key: 'theme', value: 123 }, { key: 'ttsRate', value: 1.2 }],
  });
  const p = parseBackup(dirty);
  assert.equal(p.ok, true);
  assert.deepEqual(p.data.terms.map((t) => t.id), ['ok']);
  assert.equal(p.data.terms[0].card.state, 0, '카드가 없으면 새 카드로 채운다');
  assert.deepEqual(p.data.journal.map((j) => j.id), ['good-1']);
  assert.equal(p.data.journal[0].action, 'watch');
  assert.equal(p.data.journal[0].price, null);
  assert.deepEqual(p.data.settings.map((s) => s.key), ['ttsRate']);
  assert.equal(p.skipped, 5);
});

test('백업 병합: 같은 항목은 더 최근에 고친 쪽, 진도는 먼저 한 기록, 복습 기록은 중복 없이', () => {
  const mine = sampleData();
  const theirs = sampleData();
  theirs.terms[0] = { ...theirs.terms[0], short: '새 뜻', updatedAt: '2026-11-20T00:00:00Z' };
  theirs.journal.push({ ...theirs.journal[0], id: 'other-device-entry', name: '삼성전자' });
  theirs.progress[0] = { lesson_no: 1, date: '2026-11-30', readAt: '2026-11-30T11:00:00Z', quizDoneAt: '2026-11-30T13:00:00Z', updatedAt: '2026-11-30T13:00:00Z' };
  theirs.reviewLogs.push({ termId: 'per', rating: 4, state: 1, due: null, reviewedAt: '2026-11-02T00:00:00Z' });
  theirs.quizResults[0] = { ...theirs.quizResults[0], correct: true, answeredAt: '2026-11-12T00:00:00Z' };
  const merged = mergeBackup(mine, parseBackup(buildBackup(theirs)).data);
  assert.equal(merged.terms.length, 1);
  assert.equal(merged.terms[0].short, '새 뜻');
  assert.deepEqual(merged.journal.map((j) => j.name).sort(), ['LG에너지솔루션', '삼성전자']);
  assert.equal(merged.progress[0].readAt, '2026-11-30T11:00:00Z');
  assert.equal(merged.progress[0].quizDoneAt, '2026-11-30T13:00:00Z');
  assert.equal(isComplete(merged.progress[0]), true);
  assert.equal(merged.reviewLogs.length, 2, '같은 기록은 한 번만');
  assert.equal(merged.quizResults[0].correct, true);
});

test('백업 파일 이름은 한국 날짜를 쓴다', () => {
  assert.equal(backupFileName(new Date('2026-11-11T16:00:00Z')), 'DailyStock-backup-2026-11-12.json');
});

/* ───────────── 투자 일지 ───────────── */

const entry = (patch = {}) => ({
  date: '2026-11-11', name: 'LG에너지솔루션', action: 'buy', price: 412000, qty: 3,
  reason: '배터리 수주잔고가 늘고 PER이 업종 평균보다 낮아서 분할로 산다', revisitAt: '2027-02-11', ...patch,
});

test('일지 양식 검사: 이유 최소 글자 수, 다시 볼 날, 숫자', () => {
  assert.deepEqual(validateEntry(entry()), {});
  assert.match(validateEntry(entry({ reason: '싸 보여서' })).reason, new RegExp(`${REASON_MIN}자`));
  assert.ok(validateEntry(entry({ revisitAt: '2026-11-11' })).revisitAt);
  assert.ok(validateEntry(entry({ revisitAt: '2026-11-01' })).revisitAt);
  assert.ok(validateEntry(entry({ name: '  ' })).name);
  assert.ok(validateEntry(entry({ action: 'short' })).action);
  assert.ok(validateEntry(entry({ price: -1 })).price);
  assert.ok(validateEntry(entry({ price: NaN })).price);
  assert.deepEqual(validateEntry(entry({ price: null, qty: null })), {});
});

test('회고 대기: 다시 볼 날이 지났고 회고가 없는 일지만', () => {
  const list = [
    { id: 'due', revisitAt: '2026-11-11', review: null },
    { id: 'past', revisitAt: '2026-09-01', review: null },
    { id: 'done', revisitAt: '2026-09-01', review: { verdict: 'right' } },
    { id: 'future', revisitAt: '2026-12-11', review: null },
  ];
  assert.deepEqual(dueEntries(list, '2026-11-11').map((e) => e.id), ['due', 'past']);
  assert.deepEqual(dueEntries(list, '2026-12-11').map((e) => e.id), ['due', 'past', 'future']);
});

/* ───────────── 진도·연속 학습일 ───────────── */

test('연속 학습일: 오늘 안 했어도 어제까지는 유지, 주말은 쉬어도 끊기지 않음', () => {
  const days = new Set(['2026-11-11', '2026-11-10', '2026-11-09', '2026-11-06', '2026-11-05']);
  assert.equal(computeStreak(days, '2026-11-11'), 5);                       // 수·화·월·(주말)·금·목
  assert.equal(computeStreak(days, '2026-11-12'), 5, '오늘(목) 아직 안 했으면 어제까지');
  assert.equal(computeStreak(days, '2026-11-13'), 0, '어제(목) 빠지면 끊김');
  assert.equal(computeStreak(new Set(['2026-11-07']), '2026-11-08'), 1, '토요일 공부도 센다');
  assert.equal(computeStreak(new Set(), '2026-11-11'), 0);
});

test('진도 계산: 읽기 + 퀴즈 = 완료, 트랙별 집계', () => {
  const map = new Map([
    [1, { readAt: 'x', quizDoneAt: 'y' }],
    [2, { readAt: 'x', quizDoneAt: null }],
    [9, { readAt: 'x', quizDoneAt: 'y' }],
  ]);
  assert.equal(overallPercent(map, 68), 3);      // 2/68 ≈ 2.9%
  const t = trackProgress(curriculum, map);
  assert.deepEqual(t.get('T1'), { done: 1, total: 8 });
  assert.deepEqual(t.get('T2'), { done: 1, total: 12 });
});

test('진도 저장: 샘플은 기록하지 않고, 정식 강의는 읽기·퀴즈를 모두 마치면 완료', async () => {
  assert.equal((await markRead(perLesson)).changed, false, '샘플 강의');
  const real = { ...perLesson, sample: undefined, lesson_no: 4242, date: '2026-12-01' };
  const r1 = await markRead(real);
  assert.equal(r1.changed, true);
  assert.equal(r1.completedNow, false);
  assert.equal((await markRead(real)).changed, false, '두 번 기록하지 않는다');
  const r2 = await markQuizDone(real);
  assert.equal(r2.completedNow, true);
  assert.equal(isComplete((await getProgressMap()).get(4242)), true);
});

/* ───────────── 용어장(⭐) ───────────── */

test('용어 저장은 중복 없이, 처음 나온 강의를 기록하고, 삭제·수정이 된다', async () => {
  const term = perLesson.terms.find((t) => t.id === 'per');
  const first = await terms.saveTerm(term, { track: 'T3', lessonNo: 21, date: '2026-11-11' });
  const again = await terms.saveTerm(term, { track: 'T3', lessonNo: 21, date: '2026-11-11' });
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal((await terms.listSaved()).filter((t) => t.id === 'per').length, 1);
  const saved = await terms.getSaved('per');
  assert.equal(saved.firstLesson, 21);
  assert.equal(saved.card.state, 0);
  await terms.updateTerm('per', { short: '  고친 뜻  ' });
  assert.equal((await terms.getSaved('per')).short, '고친 뜻');
  const custom = await terms.addCustomTerm({ ko: '안전마진', short: '가치보다 싸게 사서 남기는 여유' });
  assert.match(custom.id, /^custom-[0-9a-f]{8}$/);
  const counts = await terms.reviewCounts();
  assert.ok(counts.fresh >= 2);
  await terms.removeTerm('per');
  assert.equal(await terms.getSaved('per'), undefined);
  const found = await terms.resolveTerm('eps', perLesson.terms);
  assert.equal(found.term.id, 'eps');
  assert.equal(found.saved, null);
});

test('저장소 대체(메모리)에서도 백업 덮어쓰기·전체 삭제가 동작한다', async () => {
  assert.equal(db.memoryOnly, true, 'Node 에는 IndexedDB 가 없으므로 메모리 저장소');
  await db.replaceStores(parseBackup(buildBackup(sampleData())).data, { clearFirst: true });
  assert.equal((await db.getAll('journal')).length, 1);
  assert.equal((await db.getAll('reviewLogs'))[0].id >= 1, true, '복습 기록에는 새 번호가 붙는다');
  db.resetSettingsCache();
  assert.equal((await db.getSettings()).theme, 'dark');
  await db.wipeUserData();
  for (const name of db.USER_STORES) assert.equal(await db.count(name), 0, name);
  assert.equal((await db.getSettings()).theme, 'system', '설정은 기본값으로');
});

/* ───────────── 퀴즈 만들기 ───────────── */

test('강의 퀴즈는 마크업을 풀어 숫자를 채운 문장으로 보여 준다', () => {
  const q = plainQuestion(perLesson, 2, () => undefined);
  assert.match(q.q, /31\.2배에서 4\.49배로/);
  assert.match(q.explain, /206,000원/);
  assert.equal(resultKey('2026-11-11', 2), '2026-11-11#2');
});

test('계산 문제 숫자 바꾸기: 새 숫자로 다시 계산한 값이 정답 보기다', () => {
  const calcQuiz = perLesson.quiz.find((q) => q.type === 'calc');
  for (let seed = 0; seed < 25; seed += 1) {
    const made = varyCalcQuestion(calcQuiz, seededRng(seed));
    assert.ok(made, `seed ${seed}`);
    assert.equal(new Set(made.choices).size, 4);
    const expected = evaluate(made.expr, made.vars);
    const stated = parseKoreanNumber(made.choices[made.answer]);
    assert.ok(Math.abs(stated - expected) <= Math.abs(expected) * 0.01, `${stated} vs ${expected}`);
    assert.notDeepEqual(made.vars, calcQuiz.calc.vars);
    assert.match(made.q, /^주가 [\d,]+원, EPS [\d,]+원일 때 PER은\?$/);
  }
  assert.equal(varyCalcQuestion({ q: '?', calc: { vars: { a: 1 }, expr: 'a / 0' } }, seededRng(1)), null);
  assert.equal(varyNumber(0, seededRng(1)), 0);
  assert.notEqual(varyNumber(20, seededRng(1)), 20);
});

test('용어 뜻 고르기 문제', () => {
  const pool = lessons.flatMap((l) => l.terms);
  const term = pool.find((t) => t.id === 'per');
  const q = makeTermQuestion(term, pool, seededRng('x'));
  assert.equal(q.choices[q.answer], term.short);
  assert.equal(new Set(q.choices).size, q.choices.length);
  assert.equal(makeTermQuestion(term, [term], seededRng('x')), null, '보기가 모자라면 만들지 않는다');
});

test('주간 퀴즈: 그 주 용어 + 틀린 문제 다시 풀기 + 계산 2문제, 같은 주는 같은 문제', () => {
  const week = [perLesson];      // 저장소에 정식 강의가 늘어나도 흔들리지 않도록 샘플 강의만 쓴다
  const results = new Map([[resultKey('2026-11-11', 0), { correct: false, wrongCount: 1 }]]);
  const input = { weekId: '2026-11-09', lessons: week, results, glossaryTerms: lessons.flatMap((l) => l.terms) };
  const qs = buildWeeklyQuiz(input);
  assert.equal(qs.filter((q) => q.kind === 'term').length, week.flatMap((l) => l.terms).length);
  assert.equal(qs.filter((q) => q.kind === 'retry').length, 1);
  assert.equal(qs.filter((q) => q.kind === 'calc').length, 2);
  for (const q of qs) {
    assert.ok(q.answer >= 0 && q.answer < q.choices.length, q.q);
    assert.equal(new Set(q.choices).size, q.choices.length, q.q);
  }
  assert.deepEqual(buildWeeklyQuiz(input), qs, '같은 주는 새로고침해도 같다');
  const retry = qs.find((q) => q.kind === 'retry');
  assert.equal(retry.choices[retry.answer], plainQuestion(perLesson, 0, () => undefined).choices[perLesson.quiz[0].answer]);
});

/* ───────────── 강의 불러오기 도우미 ───────────── */

test('간이 검증·커리큘럼 찾기·이웃 강의', () => {
  for (const l of lessons) assert.equal(quickCheck(l), true, l.date);
  assert.equal(quickCheck({ ...perLesson, schema: 2 }), false);
  assert.equal(quickCheck({ ...perLesson, body: 'x' }), false);
  assert.equal(quickCheck(null), false);
  assert.equal(curriculumEntry(curriculum, 69).round, 2);
  assert.equal(curriculumEntry(curriculum, 69).entry.no, 1);
  assert.equal(curriculumEntry(curriculum, 0), null);
  const items = [{ date: '2026-11-12' }, { date: '2026-11-11' }, { date: '2026-11-10' }];
  assert.deepEqual(neighbors(items, '2026-11-11'), { prev: items[2], next: items[0] });
  assert.deepEqual(weekItems([{ date: '2026-11-15' }, { date: '2026-11-09' }, { date: '2026-11-16' }], '2026-11-09').map((i) => i.date), ['2026-11-09', '2026-11-15']);
  assert.equal(lessonPath('2026-11-30'), 'lessons/2026/11/2026-11-30.json');
});
