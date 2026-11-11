// tests/srs.test.mjs — FSRS 래퍼 테스트(시간을 앞당겨 일정 확인)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeScheduler, newCard, applyRating, previewRatings, formatInterval, isDue, cardStatus, buildQueue, nextDueAt,
  isValidCard, serializeCard, Rating, State, MATURE_DAYS,
} from '../js/srs.js';

const T0 = new Date('2026-11-30T11:00:00Z');       // 한국 시각 20:00
const minutes = (n) => n * 60 * 1000;
const days = (n) => n * 24 * 60 * 60 * 1000;
const at = (ms) => new Date(T0.getTime() + ms);
const sched = () => makeScheduler({ retention: 0.9, fuzz: false });

test('새 카드는 New 상태이고 지금 바로 볼 수 있다', () => {
  const card = newCard(T0);
  assert.equal(card.state, State.New);
  assert.equal(card.reps, 0);
  assert.equal(typeof card.due, 'string', '날짜는 ISO 문자열로 저장한다');
  assert.equal(isValidCard(card), true);
  assert.equal(isDue(card, T0), true);
  assert.equal(cardStatus(card), 'new');
});

test('알맞음 → 10분 뒤 다시(학습 중) → 알맞음 → 며칠 뒤 복습', () => {
  const s = sched();
  const first = applyRating(s, newCard(T0), Rating.Good, T0);
  assert.equal(first.card.state, State.Learning);
  assert.equal(new Date(first.card.due).getTime() - T0.getTime(), minutes(10));
  assert.equal(first.log.state, State.New, '기록에는 평가 직전 상태가 남는다');
  assert.equal(cardStatus(first.card), 'learning');

  const second = applyRating(s, first.card, Rating.Good, at(minutes(10)));
  assert.equal(second.card.state, State.Review);
  assert.ok(second.card.scheduled_days >= 1);
  const due = new Date(second.card.due).getTime();
  assert.equal(isDue(second.card, new Date(due - 1)), false, '복습 시각 전에는 나오지 않는다');
  assert.equal(isDue(second.card, new Date(due)), true, '복습 시각이 되면 나온다');
});

test('복습 단계에서 "다시"를 누르면 재학습으로 돌아가고 잊은 횟수가 늘어난다', () => {
  const s = sched();
  let card = applyRating(s, newCard(T0), Rating.Easy, T0).card;
  assert.equal(card.state, State.Review);
  const lapse = applyRating(s, card, Rating.Again, new Date(card.due));
  assert.equal(lapse.card.state, State.Relearning);
  assert.equal(lapse.card.lapses, 1);
  card = lapse.card;
  assert.ok(new Date(card.due).getTime() - new Date(lapse.log.reviewedAt).getTime() <= minutes(10));
});

test('계속 맞히면 간격이 점점 길어지고, 충분히 길면 "익힘"이 된다', () => {
  const s = sched();
  let card = newCard(T0);
  let now = T0;
  const intervals = [];
  for (let i = 0; i < 8; i += 1) {
    const r = applyRating(s, card, Rating.Good, now);
    card = r.card;
    intervals.push(card.scheduled_days);
    now = new Date(card.due);
  }
  const reviewIntervals = intervals.filter((d) => d > 0);
  for (let i = 1; i < reviewIntervals.length; i += 1) assert.ok(reviewIntervals[i] >= reviewIntervals[i - 1], `간격이 줄었다: ${intervals}`);
  assert.ok(card.scheduled_days >= MATURE_DAYS, `마지막 간격 ${card.scheduled_days}일`);
  assert.equal(cardStatus(card), 'mature');
});

test('네 버튼의 다음 간격 미리 보기: 다시 ≤ 어려움 ≤ 알맞음 ≤ 쉬움', () => {
  const s = sched();
  const reviewed = applyRating(s, applyRating(s, newCard(T0), Rating.Good, T0).card, Rating.Good, at(minutes(10))).card;
  const p = previewRatings(s, reviewed, new Date(reviewed.due));
  const t = [1, 2, 3, 4].map((r) => new Date(p[r].due).getTime());
  for (let i = 1; i < 4; i += 1) assert.ok(t[i] >= t[i - 1], JSON.stringify(p));
  for (const r of [1, 2, 3, 4]) assert.equal(typeof p[r].label, 'string');
});

test('저장했다 다시 읽은 카드(JSON)로도 계속 복습할 수 있다', () => {
  const s = sched();
  const r1 = applyRating(s, newCard(T0), Rating.Good, T0);
  const stored = JSON.parse(JSON.stringify(r1.card));
  const r2 = applyRating(s, stored, Rating.Good, at(minutes(10)));
  assert.equal(r2.card.reps, 2);
  assert.deepEqual(serializeCard({ ...r2.card, due: new Date(r2.card.due), last_review: new Date(r2.card.last_review) }), r2.card);
});

test('잘못된 평가 값은 거부한다', () => {
  assert.throws(() => applyRating(sched(), newCard(T0), 0, T0));
  assert.throws(() => applyRating(sched(), newCard(T0), 5, T0));
});

test('목표 기억률이 높을수록 간격이 짧다(범위 밖 값은 0.7~0.97 로 제한)', () => {
  const card = applyRating(sched(), newCard(T0), Rating.Easy, T0).card;
  const low = applyRating(makeScheduler({ retention: 0.8, fuzz: false }), card, Rating.Good, new Date(card.due)).card;
  const high = applyRating(makeScheduler({ retention: 0.95, fuzz: false }), card, Rating.Good, new Date(card.due)).card;
  assert.ok(high.scheduled_days < low.scheduled_days, `${high.scheduled_days} < ${low.scheduled_days}`);
  assert.doesNotThrow(() => makeScheduler({ retention: 5 }));
  assert.doesNotThrow(() => makeScheduler({ retention: NaN }));
});

test('간격 표시', () => {
  assert.equal(formatInterval(T0, at(minutes(10))), '10분');
  assert.equal(formatInterval(T0, at(minutes(180))), '3시간');
  assert.equal(formatInterval(T0, at(days(4))), '4일');
  assert.equal(formatInterval(T0, at(days(76))), '2.5개월');
  assert.equal(formatInterval(T0, at(days(400))), '1.1년');
  assert.equal(formatInterval(T0, at(-1000)), '지금');
  assert.equal(formatInterval(T0, at(20 * 1000)), '1분 안');
});

test('오늘의 복습 차례: 급한 순서, 새 용어는 하루 한도만큼', () => {
  const s = sched();
  const reviewCard = (offsetDays) => {
    const c = applyRating(s, newCard(T0), Rating.Easy, T0).card;
    return { ...c, due: at(days(offsetDays)).toISOString() };
  };
  const terms = [
    { id: 'a', card: reviewCard(-1) },
    { id: 'b', card: reviewCard(-3) },
    { id: 'c', card: reviewCard(+2) },                      // 아직 아님
    ...['n1', 'n2', 'n3', 'n4', 'n5'].map((id, i) => ({ id, card: newCard(T0), createdAt: `2026-11-0${i + 1}` })),
    { id: 'broken', card: { due: 'x' } },
  ];
  const q = buildQueue(terms, { now: T0, newPerDay: 2 });
  assert.deepEqual(q.due.map((t) => t.id), ['b', 'a']);
  assert.deepEqual(q.fresh.map((t) => t.id), ['n1', 'n2']);
  assert.equal(q.freshTotal, 5);
  assert.deepEqual(buildQueue(terms, { now: T0, newPerDay: 2, newStartedToday: 1 }).fresh.map((t) => t.id), ['n1']);
  assert.deepEqual(buildQueue(terms, { now: T0, newPerDay: 2, newStartedToday: 5 }).fresh, []);
  assert.equal(nextDueAt(terms, T0), at(days(2)).toISOString());
});

test('시간을 앞당기면 복습할 카드가 생긴다', () => {
  const s = sched();
  const card = applyRating(s, applyRating(s, newCard(T0), Rating.Good, T0).card, Rating.Good, at(minutes(10))).card;
  const terms = [{ id: 'x', card }];
  assert.equal(buildQueue(terms, { now: at(minutes(11)) }).due.length, 0, '방금 복습한 카드는 바로 나오지 않는다');
  assert.equal(buildQueue(terms, { now: new Date(new Date(card.due).getTime() + 1000) }).due.length, 1, '복습 날짜가 지나면 나온다');
});
