// progress.js — 진도(강의 완료)와 연속 학습일
//
// 강의 완료 = 끝까지 읽음(readAt) + 퀴즈 완료(quizDoneAt).
// 샘플 강의는 맛보기라서 진도에 넣지 않는다.

import * as db from './db.js';
import { addDays, kstDate, kstDateOf, weekday } from './util.js';

export function isComplete(rec) {
  return Boolean(rec && rec.readAt && rec.quizDoneAt);
}

/** 진도 기록 전체: lesson_no → 기록 */
export async function getProgressMap() {
  const rows = await db.getAll('progress');
  return new Map(rows.map((r) => [r.lesson_no, r]));
}

async function mark(lesson, field) {
  if (!lesson || lesson.sample === true || !Number.isInteger(lesson.lesson_no)) return { changed: false, completedNow: false, record: null };
  const now = new Date().toISOString();
  const prev = (await db.get('progress', lesson.lesson_no)) ?? { lesson_no: lesson.lesson_no, date: lesson.date, readAt: null, quizDoneAt: null };
  if (prev[field]) return { changed: false, completedNow: false, record: prev };
  const wasComplete = isComplete(prev);
  const record = { ...prev, date: lesson.date, [field]: now, updatedAt: now };
  await db.put('progress', record);
  return { changed: true, completedNow: !wasComplete && isComplete(record), record };
}

/** 끝까지 읽었음을 기록한다. */
export const markRead = (lesson) => mark(lesson, 'readAt');

/** 퀴즈를 모두 풀었음을 기록한다. */
export const markQuizDone = (lesson) => mark(lesson, 'quizDoneAt');

/** 전체 진도(%) — 1회차 기준. */
export function overallPercent(progressMap, total) {
  if (!total) return 0;
  let complete = 0;
  for (const [no, rec] of progressMap) if (no >= 1 && no <= total && isComplete(rec)) complete += 1;
  return Math.round((complete / total) * 100);
}

/** 트랙별 완료 수: trackId → { done, total } */
export function trackProgress(curriculum, progressMap) {
  const out = new Map();
  for (const t of curriculum.tracks ?? []) out.set(t.id, { done: 0, total: 0 });
  for (const l of curriculum.lessons ?? []) {
    const slot = out.get(l.track);
    if (!slot) continue;
    slot.total += 1;
    if (isComplete(progressMap.get(l.no))) slot.done += 1;
  }
  return out;
}

/** 공부한 날(한국 날짜)의 집합 — 강의 읽기, 퀴즈, 복습 중 하나라도 한 날. */
export async function studyDays() {
  const days = new Set();
  const add = (iso) => { if (iso) { const d = kstDateOf(iso); if (d) days.add(d); } };
  const [progress, quiz, logs] = await Promise.all([db.getAll('progress'), db.getAll('quizResults'), db.getAll('reviewLogs')]);
  for (const p of progress) { add(p.readAt); add(p.quizDoneAt); }
  for (const q of quiz) add(q.answeredAt);
  for (const l of logs) add(l.reviewedAt);
  return days;
}

/**
 * 연속 학습일. 오늘 아직 공부하지 않았어도 어제까지의 기록은 유지하고,
 * 주말(토·일)은 쉬어도 끊기지 않는다(공부했다면 하루로 센다).
 * @param {Set<string>} days  공부한 날
 * @param {string} today      오늘(YYYY-MM-DD)
 */
export function computeStreak(days, today = kstDate()) {
  let d = today;
  if (!days.has(d)) d = addDays(d, -1);
  let streak = 0;
  for (let i = 0; i < 3660; i += 1) {
    if (days.has(d)) streak += 1;
    else {
      const wd = weekday(d);
      if (wd !== 0 && wd !== 6) break;
    }
    d = addDays(d, -1);
  }
  return streak;
}

export async function getStreak(today = kstDate()) {
  return computeStreak(await studyDays(), today);
}
