// terms.js — 내 용어장(IndexedDB 'terms') 다루기와 용어 찾기
// 화면 코드는 없다. 용어 카드·용어장·복습·일지가 함께 쓴다.

import * as db from './db.js';
import { loadGlossary } from './lessons.js';
import { isDue, isValidCard, newCard, State } from './srs.js';
import { uuid } from './util.js';

const COPY_FIELDS = ['ko', 'en', 'label', 'short', 'long', 'formula', 'example', 'related'];

export function listSaved() {
  return db.getAll('terms');
}

export function getSaved(id) {
  return db.get('terms', id);
}

/**
 * 용어를 내 용어장에 저장한다(⭐). 이미 있으면 그대로 둔다(중복 없음).
 * @param {object} term     강의·사전의 용어
 * @param {{ track?: string, lessonNo?: number, date?: string }} [origin]  처음 나온 강의
 * @returns {Promise<{ record: object, created: boolean }>}
 */
export async function saveTerm(term, origin = {}) {
  const existing = await db.get('terms', term.id);
  if (existing) return { record: existing, created: false };
  const now = new Date().toISOString();
  const record = { id: term.id };
  for (const key of COPY_FIELDS) if (term[key] !== undefined) record[key] = structuredClone(term[key]);
  record.track = origin.track ?? term.track ?? null;
  record.firstLesson = origin.lessonNo ?? term.first_lesson ?? null;
  record.firstDate = origin.date ?? term.first_date ?? null;
  record.card = newCard(new Date());
  record.custom = false;
  record.createdAt = now;
  record.updatedAt = now;
  await db.put('terms', record);
  return { record, created: true };
}

/** 내 용어장에서 뺀다(복습 일정도 함께 사라진다). */
export function removeTerm(id) {
  return db.del('terms', id);
}

/** 뜻·설명을 고친다. */
export async function updateTerm(id, patch) {
  const current = await db.get('terms', id);
  if (!current) return null;
  const next = { ...current };
  for (const key of ['ko', 'en', 'short', 'long', 'formula', 'example', 'track']) {
    if (patch[key] !== undefined) next[key] = typeof patch[key] === 'string' ? patch[key].trim() : patch[key];
  }
  next.updatedAt = new Date().toISOString();
  await db.put('terms', next);
  return next;
}

/** 복습 결과(새 카드 상태)를 저장한다. */
export async function saveCard(id, card) {
  const current = await db.get('terms', id);
  if (!current) return null;
  const next = { ...current, card, updatedAt: new Date().toISOString() };
  await db.put('terms', next);
  return next;
}

/** 직접 추가. id 는 custom-… 으로 자동 생성한다. */
export async function addCustomTerm({ ko, en = '', short, long = '', formula = '', example = '', track = null }) {
  const now = new Date().toISOString();
  const record = {
    id: `custom-${uuid().slice(0, 8)}`,
    ko: String(ko).trim(),
    en: String(en).trim(),
    short: String(short).trim(),
    long: String(long).trim(),
    formula: String(formula).trim(),
    example: String(example).trim(),
    track,
    firstLesson: null,
    firstDate: null,
    card: newCard(new Date()),
    custom: true,
    createdAt: now,
    updatedAt: now,
  };
  await db.put('terms', record);
  return record;
}

/**
 * 용어를 찾는다. 순서: 지금 보는 강의의 terms → 내 용어장(내가 고친 뜻 우선) → 누적 사전.
 * @param {string} id
 * @param {Array} [lessonTerms]
 * @returns {Promise<{ term: object, saved: object|null } | null>}
 */
export async function resolveTerm(id, lessonTerms) {
  const saved = (await db.get('terms', id)) ?? null;
  const fromLesson = Array.isArray(lessonTerms) ? lessonTerms.find((t) => t && t.id === id) : null;
  if (fromLesson) return { term: fromLesson, saved };
  if (saved) return { term: saved, saved };
  const glossary = await loadGlossary();
  const fromGlossary = glossary.get(id);
  if (fromGlossary) return { term: fromGlossary, saved: null };
  return null;
}

/** 지금 복습할 용어 수(배지용): 복습 시각이 된 것 + 오늘 시작할 수 있는 새 용어. */
export async function reviewCounts(now = new Date()) {
  const [terms, settings, startedToday] = await Promise.all([listSaved(), db.getSettings(), newStartedToday(now)]);
  let due = 0;
  let fresh = 0;
  for (const t of terms) {
    if (!isValidCard(t.card)) continue;
    if (t.card.state === State.New) fresh += 1;
    else if (isDue(t.card, now)) due += 1;
  }
  const room = Math.max(0, (Number(settings.newPerDay) || 0) - startedToday);
  return { due, fresh: Math.min(fresh, room), freshTotal: fresh, total: terms.length };
}

/** 오늘(한국 날짜) 처음 복습을 시작한 새 용어 수. */
export async function newStartedToday(now = new Date()) {
  const logs = await db.getAll('reviewLogs');
  const today = new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const seen = new Set();
  for (const l of logs) {
    if (l.state !== State.New || !l.reviewedAt) continue;
    const day = new Date(new Date(l.reviewedAt).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    if (day === today) seen.add(l.termId);
  }
  return seen.size;
}
