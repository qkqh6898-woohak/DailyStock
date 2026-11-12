// lessons.js — 강의 목록·강의 파일·용어 사전·커리큘럼 불러오기와 간이 검증
//
//   lessons/index.json        네트워크 우선 (실패하면 기기에 저장된 사본)
//   lessons/YYYY/MM/날짜.json  기기 사본 우선 (없으면 네트워크, 뒤에서 조용히 최신본 확인)
//   glossary/terms.json       네트워크 우선
//   curriculum/curriculum.json 네트워크 우선
//
// 강의 내용에는 개인 정보가 없다. 이 파일은 같은 출처(GitHub Pages)에서 읽기만 한다.

import * as db from './db.js';
import { addDays, isValidYmd, kstDate } from './util.js';

const INDEX_URL = 'lessons/index.json';
const GLOSSARY_URL = 'glossary/terms.json';
const CURRICULUM_URL = 'curriculum/curriculum.json';
const LESSON_PATH_RE = /^lessons\/\d{4}\/\d{2}\/(\d{4}-\d{2}-\d{2})\.json$/;

const FRESH_MS = 60 * 1000;
let indexMem = null;
let glossaryMem = null;
let curriculumMem = null;
const revalidated = new Set();

/** boot.js 가 미리 요청해 둔 응답이 있으면 한 번만 이어받는다(같은 주소를 두 번 받지 않게). */
function takeEarly(url) {
  const early = typeof window !== 'undefined' ? window.__ssEarly : null;
  if (!early || !early[url]) return null;
  const p = early[url];
  delete early[url];
  return p;
}

async function fetchJson(url) {
  const early = takeEarly(url);
  if (early) return early;
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 네트워크에서 먼저 받고, 실패하면 기기에 저장해 둔 사본을 쓴다. */
async function networkFirst(key, url, isValid) {
  try {
    const data = await fetchJson(url);
    if (isValid && !isValid(data)) throw new Error('형식이 올바르지 않습니다');
    db.put('cache', { key, value: data, savedAt: new Date().toISOString() }).catch(() => {});
    return { data, offline: false };
  } catch (err) {
    const cached = await db.get('cache', key).catch(() => null);
    if (cached && (!isValid || isValid(cached.value))) return { data: cached.value, offline: true, savedAt: cached.savedAt };
    throw err;
  }
}

/** 강의 경로. 목록에 적힌 경로를 그대로 믿지 않고 날짜에서 직접 만든다. */
export function lessonPath(date) {
  return `lessons/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.json`;
}

function cleanIndex(data) {
  const items = [];
  for (const it of Array.isArray(data?.items) ? data.items : []) {
    if (!it || !isValidYmd(it.date) || typeof it.title !== 'string' || !Number.isInteger(it.lesson_no)) continue;
    const m = typeof it.path === 'string' ? it.path.match(LESSON_PATH_RE) : null;
    if (!m || m[1] !== it.date) continue;
    items.push({ date: it.date, lesson_no: it.lesson_no, track: String(it.track ?? ''), title: it.title, sample: it.sample === true });
  }
  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { updated: typeof data?.updated === 'string' ? data.updated : null, items };
}

/**
 * 강의 목록(최신 날짜가 먼저).
 * @returns {Promise<{ items: Array, updated: string|null, offline: boolean, error?: boolean }>}
 */
export async function loadIndex({ force = false } = {}) {
  if (!force && indexMem && Date.now() - indexMem.at < FRESH_MS) return indexMem.value;
  try {
    const { data, offline } = await networkFirst('index', INDEX_URL, (d) => Array.isArray(d?.items));
    const value = { ...cleanIndex(data), offline };
    indexMem = { at: offline ? 0 : Date.now(), value };
    return value;
  } catch {
    return { items: [], updated: null, offline: true, error: true };
  }
}

export function invalidateIndex() {
  indexMem = null;
}

/** 간이 검증 — 화면에 그릴 수 있는 최소한의 모양인지. (엄격한 검증은 tools/validate.mjs) */
export function quickCheck(lesson) {
  const strArr = (v, min = 0) => Array.isArray(v) && v.length >= min && v.every((s) => typeof s === 'string');
  return Boolean(
    lesson && typeof lesson === 'object'
    && lesson.schema === 1
    && isValidYmd(lesson.date)
    && Number.isInteger(lesson.lesson_no)
    && typeof lesson.title === 'string' && lesson.title.trim()
    && strArr(lesson.body, 1)
    && strArr(lesson.summary)
    && Array.isArray(lesson.terms)
    && Array.isArray(lesson.facts)
    && Array.isArray(lesson.quiz)
    && lesson.news_case && typeof lesson.news_case === 'object'
    && Array.isArray(lesson.news_case.sources),
  );
}

async function fetchLesson(date) {
  const lesson = await fetchJson(lessonPath(date));
  if (!quickCheck(lesson) || lesson.date !== date) throw new Error('강의 형식이 올바르지 않습니다');
  await db.put('lessonCache', { date, lesson, savedAt: new Date().toISOString() }).catch(() => {});
  return lesson;
}

/**
 * 강의 하나. 기기에 사본이 있으면 바로 돌려주고, 뒤에서 한 번 최신본을 확인해 사본을 갱신한다.
 * @returns {Promise<object|null>} 없거나 깨졌으면 null
 */
export async function loadLesson(date) {
  if (!isValidYmd(date)) return null;
  const cached = await db.get('lessonCache', date).catch(() => null);
  if (cached && quickCheck(cached.lesson)) {
    if (!revalidated.has(date)) {
      revalidated.add(date);
      fetchLesson(date).catch(() => {});
    }
    return cached.lesson;
  }
  try {
    revalidated.add(date);
    return await fetchLesson(date);
  } catch {
    return null;
  }
}

/**
 * 최근 강의를 미리 받아 기기에 저장한다. 열어 보지 않은 강의도 오프라인(지하철·비행기)에서 볼 수 있게 한다.
 * 오프라인이거나 데이터 절약 모드면 건너뛴다. 이미 저장된 강의는 다시 받지 않는다.
 * @returns {Promise<number>} 새로 저장한 강의 수
 */
export async function prefetchRecent(limit = 7) {
  if (typeof navigator !== 'undefined') {
    if (navigator.onLine === false) return 0;
    if (navigator.connection && navigator.connection.saveData) return 0;
  }
  const index = await loadIndex();
  if (index.error || index.offline) return 0;
  const have = await cachedLessonDates();
  let saved = 0;
  for (const it of index.items.slice(0, limit)) {
    if (have.has(it.date)) continue;
    try {
      await fetchLesson(it.date);
      revalidated.add(it.date);
      saved += 1;
    } catch {
      /* 다음에 다시 시도한다 */
    }
  }
  return saved;
}

/** 기기에 사본이 있는 강의 날짜 목록(오프라인 표시용). */
export async function cachedLessonDates() {
  const rows = await db.getAll('lessonCache').catch(() => []);
  return new Set(rows.map((r) => r.date));
}

/** 누적 용어 사전: id → 용어. */
export async function loadGlossary({ force = false } = {}) {
  if (!force && glossaryMem && Date.now() - glossaryMem.at < 5 * FRESH_MS) return glossaryMem.map;
  let terms = [];
  try {
    const { data } = await networkFirst('glossary', GLOSSARY_URL, (d) => Array.isArray(d?.terms));
    terms = data.terms;
  } catch { /* 사전을 못 불러와도 강의 자체의 terms 로 동작한다 */ }
  const map = new Map();
  for (const t of terms) if (t && typeof t.id === 'string' && typeof t.ko === 'string') map.set(t.id, t);
  glossaryMem = { at: Date.now(), map };
  return map;
}

export async function loadCurriculum() {
  if (curriculumMem) return curriculumMem;
  try {
    const { data } = await networkFirst('curriculum', CURRICULUM_URL, (d) => Array.isArray(d?.tracks) && Array.isArray(d?.lessons));
    curriculumMem = data;
    return data;
  } catch {
    return { version: 1, tracks: [], lessons: [] };
  }
}

/** 강의 번호 → 커리큘럼 항목(68강을 넘으면 2회차). */
export function curriculumEntry(curriculum, lessonNo) {
  const total = curriculum?.lessons?.length ?? 0;
  if (!total || !Number.isInteger(lessonNo) || lessonNo < 1) return null;
  const base = ((lessonNo - 1) % total) + 1;
  const entry = curriculum.lessons.find((l) => l.no === base);
  if (!entry) return null;
  return { entry, base, total, round: Math.floor((lessonNo - 1) / total) + 1 };
}

export function trackOf(curriculum, trackId) {
  return curriculum?.tracks?.find((t) => t.id === trackId) ?? { id: trackId, name: trackId, color: '#64748B' };
}

/**
 * 오늘 화면에 보여 줄 강의를 고른다.
 *   kind: 'today'(오늘 강의) | 'latest'(오늘 강의가 아직 없어 최근 강의) | 'sample'(정식 강의가 없어 샘플) | 'empty'
 */
export async function resolveToday(today = kstDate()) {
  const index = await loadIndex();
  const past = index.items.filter((i) => i.date <= today);
  const real = past.filter((i) => !i.sample);
  const todays = real.find((i) => i.date === today);
  if (todays) return { item: todays, kind: 'today', index };
  if (real.length) return { item: real[0], kind: 'latest', index };
  const samples = past.filter((i) => i.sample);
  if (samples.length) return { item: samples[0], kind: 'sample', index };
  return { item: null, kind: 'empty', index };
}

/** 목록에서 이전(더 옛날)·다음(더 최근) 강의. */
export function neighbors(items, date) {
  const i = items.findIndex((it) => it.date === date);
  if (i === -1) return { prev: null, next: null };
  return { prev: items[i + 1] ?? null, next: items[i - 1] ?? null };
}

/** 월요일부터 일요일까지 그 주의 강의(날짜 오름차순). */
export function weekItems(items, monday) {
  const end = addDays(monday, 6);
  return items.filter((it) => it.date >= monday && it.date <= end).sort((a, b) => (a.date < b.date ? -1 : 1));
}
