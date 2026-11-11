// srs.js — FSRS 간격 반복 래퍼 (ts-fsrs 5.4.2, vendor/ts-fsrs.umd.js)
//
// 카드는 IndexedDB·백업 JSON 에 그대로 넣을 수 있도록 날짜를 ISO 문자열로 보관한다.
// 모든 함수는 now 를 인자로 받아 시간을 앞당긴 테스트가 가능하다.

import '../vendor/ts-fsrs.umd.js';

const lib = globalThis.FSRS;
if (!lib || typeof lib.fsrs !== 'function') {
  throw new Error('ts-fsrs 를 불러오지 못했습니다(vendor/ts-fsrs.umd.js)');
}

export const Rating = Object.freeze({ Again: 1, Hard: 2, Good: 3, Easy: 4 });
export const State = Object.freeze({ New: 0, Learning: 1, Review: 2, Relearning: 3 });
export const RATING_LABELS = Object.freeze({ 1: '다시', 2: '어려움', 3: '알맞음', 4: '쉬움' });

/** 이 간격(일) 이상이면 '익힘'으로 본다. */
export const MATURE_DAYS = 21;
/** 복습 중 이 시간 안에 다시 볼 카드는 같은 자리에서 한 번 더 보여 준다. */
export const SESSION_WINDOW_MS = 20 * 60 * 1000;

/**
 * 스케줄러를 만든다.
 * @param {{ retention?: number, fuzz?: boolean }} [opts]  retention: 목표 기억률(0.7~0.97)
 */
export function makeScheduler({ retention = 0.9, fuzz = true } = {}) {
  const r = Number.isFinite(retention) ? Math.min(0.97, Math.max(0.7, retention)) : 0.9;
  return lib.fsrs({ request_retention: r, enable_fuzz: fuzz });
}

const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);

/** ts-fsrs 카드 → 저장용(날짜는 ISO 문자열). */
export function serializeCard(card) {
  const out = {
    due: iso(card.due),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps ?? 0,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
  };
  if (card.last_review) out.last_review = iso(card.last_review);
  return out;
}

/** 새 카드(아직 한 번도 복습하지 않은 상태). */
export function newCard(now = new Date()) {
  return serializeCard(lib.createEmptyCard(now));
}

/** 저장된 카드가 쓸 수 있는 모양인지. */
export function isValidCard(card) {
  return Boolean(card && typeof card === 'object' && card.due && !Number.isNaN(new Date(card.due).getTime())
    && Number.isFinite(card.stability) && Number.isFinite(card.difficulty) && Number.isInteger(card.state));
}

/**
 * 평가(1 다시 · 2 어려움 · 3 알맞음 · 4 쉬움)를 적용한다. 원본 카드는 바꾸지 않는다.
 * @returns {{ card: object, log: { rating:number, state:number, due:string, reviewedAt:string } }}
 */
export function applyRating(scheduler, card, rating, now = new Date()) {
  if (![1, 2, 3, 4].includes(rating)) throw new Error('평가는 1~4 여야 합니다');
  const result = scheduler.next(card, now, rating);
  return {
    card: serializeCard(result.card),
    log: { rating, state: result.log.state, due: iso(result.card.due), reviewedAt: iso(now) },
  };
}

/** 네 가지 평가를 눌렀을 때 각각 다음 복습까지의 간격을 미리 본다. */
export function previewRatings(scheduler, card, now = new Date()) {
  const all = scheduler.repeat(card, now);
  const out = {};
  for (const r of [1, 2, 3, 4]) {
    const due = all[r].card.due;
    out[r] = { due: iso(due), label: formatInterval(now, due) };
  }
  return out;
}

/** 두 시각 사이를 "10분", "3시간", "4일", "2.5개월", "1.2년" 처럼 표시한다. */
export function formatInterval(from, to) {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return '지금';
  const min = ms / 60000;
  if (min < 1) return '1분 안';
  if (min < 60) return `${Math.round(min)}분`;
  const hours = min / 60;
  if (hours < 24) return `${Math.round(hours)}시간`;
  const days = hours / 24;
  if (days < 31) return `${Math.round(days)}일`;
  if (days < 365) return `${trimZero((days / 30.44).toFixed(1))}개월`;
  return `${trimZero((days / 365.25).toFixed(1))}년`;
}

const trimZero = (s) => s.replace(/\.0$/, '');

export function isDue(card, now = new Date()) {
  return new Date(card.due).getTime() <= new Date(now).getTime();
}

/** 카드 상태: new(새 용어) | learning(학습 중) | mature(익힘) */
export function cardStatus(card) {
  if (!card || card.state === State.New) return 'new';
  if (card.state === State.Review && card.scheduled_days >= MATURE_DAYS) return 'mature';
  return 'learning';
}

export const STATUS_LABELS = Object.freeze({ new: '새 용어', learning: '학습 중', mature: '익힘' });

/**
 * 오늘 복습할 차례를 만든다.
 *   due   — 이미 배운 용어 중 복습 시각이 된 것(급한 순)
 *   fresh — 새 용어(하루 한도에서 오늘 이미 시작한 수를 뺀 만큼, 먼저 저장한 순)
 * @param {Array<{ id:string, card:object, createdAt?:string }>} terms
 * @param {{ now?: Date, newPerDay?: number, newStartedToday?: number }} [opts]
 */
export function buildQueue(terms, { now = new Date(), newPerDay = 15, newStartedToday = 0 } = {}) {
  const due = [];
  const fresh = [];
  for (const t of terms) {
    if (!isValidCard(t.card)) continue;
    if (t.card.state === State.New) fresh.push(t);
    else if (isDue(t.card, now)) due.push(t);
  }
  due.sort((a, b) => new Date(a.card.due) - new Date(b.card.due));
  fresh.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
  const room = Math.max(0, Math.floor(newPerDay) - Math.max(0, newStartedToday));
  return { due, fresh: fresh.slice(0, room), freshTotal: fresh.length };
}

/** 가장 가까운 다음 복습 시각(복습할 것이 없을 때 안내용). 없으면 null. */
export function nextDueAt(terms, now = new Date()) {
  let best = null;
  for (const t of terms) {
    if (!isValidCard(t.card) || t.card.state === State.New) continue;
    const at = new Date(t.card.due).getTime();
    if (at > new Date(now).getTime() && (best === null || at < best)) best = at;
  }
  return best === null ? null : new Date(best).toISOString();
}
