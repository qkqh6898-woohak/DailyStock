// backup.js — 백업 파일 만들기·검사·병합 (순수 함수, DOM·IndexedDB 를 쓰지 않는다)
//
// 형식
//   { "app": "DailyStockStudy", "backup_version": 1, "exported_at": "...",
//     "terms": [...], "reviewLogs": [...], "quizResults": [...], "progress": [...], "journal": [...], "settings": [...] }
// 파일 이름: DailyStock-backup-YYYY-MM-DD.json
// 병합 규칙: 같은 항목은 updatedAt(없으면 answeredAt) 이 더 최신인 쪽을 남긴다.

import { DEFAULT_SETTINGS } from './db.js';
import { isValidCard, newCard } from './srs.js';
import { isValidYmd, kstDate } from './util.js';

export const APP_ID = 'DailyStockStudy';
export const BACKUP_VERSION = 1;
export const BACKUP_STORES = ['terms', 'reviewLogs', 'quizResults', 'progress', 'journal', 'settings'];
const MAX_RECORDS = 100000;

export function backupFileName(now = new Date()) {
  return `DailyStock-backup-${kstDate(now)}.json`;
}

/** 저장소별 레코드 배열 → 백업 객체 */
export function buildBackup(data, now = new Date()) {
  const out = { app: APP_ID, backup_version: BACKUP_VERSION, exported_at: now.toISOString() };
  for (const name of BACKUP_STORES) out[name] = Array.isArray(data?.[name]) ? data[name] : [];
  return out;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 5000) => (typeof v === 'string' ? v.slice(0, max) : '');
const isoOrNull = (v) => (typeof v === 'string' && !Number.isNaN(new Date(v).getTime()) ? v : null);

const CLEANERS = {
  terms(r) {
    if (!isObj(r) || typeof r.id !== 'string' || !r.id || r.id.length > 80 || typeof r.ko !== 'string' || !r.ko.trim()) return null;
    const now = new Date().toISOString();
    return {
      id: r.id,
      ko: str(r.ko, 120), en: str(r.en, 200), label: typeof r.label === 'string' ? str(r.label, 60) : undefined,
      short: str(r.short, 200), long: str(r.long), formula: str(r.formula, 300), example: str(r.example, 400),
      related: Array.isArray(r.related) ? r.related.filter((x) => typeof x === 'string').slice(0, 20) : undefined,
      track: typeof r.track === 'string' ? r.track.slice(0, 8) : null,
      firstLesson: Number.isInteger(r.firstLesson) ? r.firstLesson : null,
      firstDate: isValidYmd(r.firstDate) ? r.firstDate : null,
      card: isValidCard(r.card) ? r.card : newCard(new Date()),
      custom: r.custom === true,
      createdAt: isoOrNull(r.createdAt) ?? now,
      updatedAt: isoOrNull(r.updatedAt) ?? now,
    };
  },
  reviewLogs(r) {
    if (!isObj(r) || typeof r.termId !== 'string' || !isoOrNull(r.reviewedAt)) return null;
    return {
      termId: r.termId.slice(0, 80),
      rating: [1, 2, 3, 4].includes(r.rating) ? r.rating : 3,
      state: [0, 1, 2, 3].includes(r.state) ? r.state : 0,
      due: isoOrNull(r.due),
      reviewedAt: r.reviewedAt,
    };
  },
  quizResults(r) {
    if (!isObj(r) || typeof r.key !== 'string' || !r.key || r.key.length > 80) return null;
    const out = {
      key: r.key,
      type: str(r.type, 20),
      correct: r.correct === true,
      chosen: Number.isInteger(r.chosen) ? r.chosen : null,
      answeredAt: isoOrNull(r.answeredAt) ?? new Date().toISOString(),
      attempts: Number.isInteger(r.attempts) ? r.attempts : 1,
      wrongCount: Number.isInteger(r.wrongCount) ? r.wrongCount : (r.correct === true ? 0 : 1),
    };
    if (isValidYmd(r.date)) out.date = r.date;
    if (Number.isInteger(r.index)) out.index = r.index;
    if (typeof r.kind === 'string') out.kind = r.kind.slice(0, 20);
    if (isValidYmd(r.weekId)) out.weekId = r.weekId;
    if (typeof r.q === 'string' && Array.isArray(r.choices) && Number.isInteger(r.answer)) {
      out.q = str(r.q, 1000);
      out.choices = r.choices.filter((c) => typeof c === 'string').slice(0, 6).map((c) => c.slice(0, 500));
      out.answer = r.answer;
      out.explain = str(r.explain, 2000);
    }
    return out;
  },
  progress(r) {
    if (!isObj(r) || !Number.isInteger(r.lesson_no) || r.lesson_no < 1) return null;
    return {
      lesson_no: r.lesson_no,
      date: isValidYmd(r.date) ? r.date : null,
      readAt: isoOrNull(r.readAt),
      quizDoneAt: isoOrNull(r.quizDoneAt),
      updatedAt: isoOrNull(r.updatedAt) ?? isoOrNull(r.quizDoneAt) ?? isoOrNull(r.readAt) ?? new Date().toISOString(),
    };
  },
  journal(r) {
    if (!isObj(r) || typeof r.id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(r.id) || !isValidYmd(r.date) || typeof r.name !== 'string') return null;
    const now = new Date().toISOString();
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
    let review = null;
    if (isObj(r.review) && ['right', 'partial', 'wrong'].includes(r.review.verdict)) {
      review = { verdict: r.review.verdict, note: str(r.review.note), learned: str(r.review.learned), reviewedAt: isoOrNull(r.review.reviewedAt) ?? now };
    }
    return {
      id: r.id,
      date: r.date,
      name: str(r.name, 80),
      action: ['buy', 'sell', 'watch'].includes(r.action) ? r.action : 'watch',
      price: num(r.price),
      currency: r.currency === 'USD' ? 'USD' : 'KRW',
      qty: num(r.qty),
      reason: str(r.reason), metrics: str(r.metrics), risks: str(r.risks),
      revisitAt: isValidYmd(r.revisitAt) ? r.revisitAt : null,
      review,
      tags: Array.isArray(r.tags) ? r.tags.filter((x) => typeof x === 'string').slice(0, 30) : [],
      createdAt: isoOrNull(r.createdAt) ?? now,
      updatedAt: isoOrNull(r.updatedAt) ?? now,
    };
  },
  settings(r) {
    if (!isObj(r) || typeof r.key !== 'string' || !(r.key in DEFAULT_SETTINGS)) return null;
    const def = DEFAULT_SETTINGS[r.key];
    const v = r.value;
    const okType = def === null ? (v === null || typeof v === 'string') : typeof v === typeof def;
    if (!okType) return null;
    return { key: r.key, value: typeof v === 'string' ? v.slice(0, 300) : v, updatedAt: isoOrNull(r.updatedAt) ?? new Date().toISOString() };
  },
};

/**
 * 백업 파일 내용을 검사하고 쓸 수 있는 레코드만 골라낸다.
 * @returns {{ ok: true, data: Record<string, any[]>, counts: Record<string, number>, exportedAt: string|null, skipped: number }
 *          | { ok: false, error: string }}
 */
export function parseBackup(obj) {
  if (!isObj(obj)) return { ok: false, error: '백업 파일 형식이 아닙니다.' };
  if (obj.app !== APP_ID) return { ok: false, error: '이 앱(Daily Stock Study)의 백업 파일이 아닙니다.' };
  if (!Number.isInteger(obj.backup_version) || obj.backup_version < 1) return { ok: false, error: '백업 버전 정보가 없습니다.' };
  if (obj.backup_version > BACKUP_VERSION) return { ok: false, error: '더 새로운 버전의 앱에서 만든 백업입니다. 앱을 최신으로 업데이트한 뒤 다시 시도해 주세요.' };
  const data = {};
  const counts = {};
  let skipped = 0;
  for (const name of BACKUP_STORES) {
    const rows = Array.isArray(obj[name]) ? obj[name] : [];
    if (rows.length > MAX_RECORDS) return { ok: false, error: `${name} 항목이 너무 많습니다.` };
    const cleaned = [];
    for (const row of rows) {
      const c = CLEANERS[name](row);
      if (c) cleaned.push(c);
      else skipped += 1;
    }
    data[name] = cleaned;
    counts[name] = cleaned.length;
  }
  return { ok: true, data, counts, exportedAt: isoOrNull(obj.exported_at), skipped };
}

const newer = (a, b) => String(a ?? '') > String(b ?? '');

function mergeByKey(current, incoming, keyOf, stampOf) {
  const map = new Map(current.map((r) => [keyOf(r), r]));
  for (const r of incoming) {
    const k = keyOf(r);
    const mine = map.get(k);
    if (!mine || newer(stampOf(r), stampOf(mine))) map.set(k, r);
  }
  return [...map.values()];
}

const earliest = (a, b) => (a && b ? (a < b ? a : b) : (a ?? b ?? null));

/**
 * 지금 기기의 데이터와 백업 데이터를 합친다(같은 항목은 더 최신 것을 남긴다).
 * 삭제는 전파되지 않는다: 한쪽에서 지운 항목이 다른 쪽에 남아 있으면 다시 생긴다.
 */
export function mergeBackup(current, incoming) {
  const cur = (name) => (Array.isArray(current?.[name]) ? current[name] : []);
  const inc = (name) => (Array.isArray(incoming?.[name]) ? incoming[name] : []);

  const progressMap = new Map(cur('progress').map((r) => [r.lesson_no, r]));
  for (const r of inc('progress')) {
    const mine = progressMap.get(r.lesson_no);
    if (!mine) { progressMap.set(r.lesson_no, r); continue; }
    const base = newer(r.updatedAt, mine.updatedAt) ? r : mine;
    progressMap.set(r.lesson_no, {
      ...base,
      readAt: earliest(mine.readAt, r.readAt),
      quizDoneAt: earliest(mine.quizDoneAt, r.quizDoneAt),
    });
  }

  const sig = (l) => `${l.termId}|${l.reviewedAt}|${l.rating}`;
  const seen = new Set(cur('reviewLogs').map(sig));
  const logs = [...cur('reviewLogs')];
  for (const l of inc('reviewLogs')) {
    if (seen.has(sig(l))) continue;
    seen.add(sig(l));
    const { id, ...rest } = l;       // 번호는 이 기기에서 새로 매긴다
    logs.push(rest);
  }

  return {
    terms: mergeByKey(cur('terms'), inc('terms'), (r) => r.id, (r) => r.updatedAt),
    journal: mergeByKey(cur('journal'), inc('journal'), (r) => r.id, (r) => r.updatedAt),
    quizResults: mergeByKey(cur('quizResults'), inc('quizResults'), (r) => r.key, (r) => r.answeredAt),
    settings: mergeByKey(cur('settings'), inc('settings'), (r) => r.key, (r) => r.updatedAt),
    progress: [...progressMap.values()],
    reviewLogs: logs,
  };
}
