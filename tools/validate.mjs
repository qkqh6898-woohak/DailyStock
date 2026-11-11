#!/usr/bin/env node
// tools/validate.mjs — 강의 JSON 검증
//
//   node tools/validate.mjs lessons/2026/11/2026-11-30.json   강의 파일 하나(여러 개 가능)
//   node tools/validate.mjs --all                             전체 강의 + 커리큘럼 + 용어 사전 + 목록 일관성
//
// 실패하면 종료 코드 1 과 함께 위치·이유를 한국어로 출력한다.
//   예) body[1]: 숫자 "52,300"이 facts 참조 없이 쓰였습니다

import path from 'node:path';
import { TERM_ID_RE, splitTokens, termLabel, toPlainText, makeContext } from '../js/render.js';
import { isValidYmd } from '../js/util.js';
import { checkCalcQuiz, checkDerived } from './calc-check.mjs';
import {
  ROOT, LESSON_PATH_RE, isMain, lessonPathFor, loadLessons, readJson, readJsonIfExists, relPath,
} from './common.mjs';

export const SCHEMA_VERSION = 1;
export const QUIZ_TYPES = ['concept', 'calc', 'case'];
export const SHORT_MAX = 40;
export const BODY_GUIDE = { min: 800, max: 1200, hardMin: 500, hardMax: 1800 };

/* ───────────────────────── 금지 표현 ───────────────────────── */
// 교육용 앱이므로 매수·매도 권유, 목표가 제시, 수익 보장처럼 읽히는 표현을 막는다.
// "목표주가"라는 개념 자체의 설명은 허용하되, 구체적인 금액을 제시하는 문장은 막는다.
export const BANNED = [
  { label: '매수 추천', re: /매수\s*추천/ },
  { label: '매도 추천', re: /매도\s*추천/ },
  { label: '강력 추천', re: /강력\s*추천|강추/ },
  { label: '목표가', re: /목표가/ },
  { label: '목표주가 금액 제시', re: /목표\s*주가[는은가를이]?\s*(?:약\s*)?(?:\d|\{\{f:)/ },
  { label: '적정주가 금액 제시', re: /적정\s*주가[는은가를이]?\s*(?:약\s*)?(?:\d|\{\{f:)/ },
  { label: '지금 사', re: /지금\s*(?:이\s*)?(?:사야|사면|사도|사라|사세요|사둬|사두|사\s두|사는\s*게|사는\s*것이|매수|담아야|들어가야)|지금\s*사(?![가-힣])/ },
  { label: '지금이 기회', re: /지금이\s*(?:매수|매도)?\s*(?:기회|타이밍|적기)/ },
  { label: '무조건 오른', re: /무조건\s*(?:오른|오릅|오를|상승|수익)/ },
  { label: '반드시 오른', re: /반드시\s*(?:오른|오릅|오를)/ },
  { label: '매수·매도 지시', re: /(?:매수|매도)\s*하(?:세요|십시오|시길|시기 바랍)/ },
  { label: '사세요/파세요', re: /(?<![가-힣])(?:사세요|파세요)/ },
  { label: '꼭 사야', re: /꼭\s*사야|사야\s*할\s*(?:종목|주식)/ },
  { label: '수익 보장', re: /(?:수익|수익률|원금)(?:을|이)?\s*보장(?:합니다|한다|해\s*드|됩니다|된다)/ },
  { label: '급등 예고', re: /급등주|급등\s*(?:예상|임박|확실)/ },
  { label: '추천 종목', re: /추천\s*종목|추천주/ },
];

/** 글에서 금지 표현을 찾는다. */
export function findBanned(text) {
  const hits = [];
  if (typeof text !== 'string') return hits;
  for (const { label, re } of BANNED) {
    const m = text.match(re);
    if (m) hits.push({ label, match: m[0] });
  }
  return hits;
}

/* ───────────────────────── 본문 직접 숫자 ───────────────────────── */
// 본문의 숫자는 facts 에서만 와야 한다. 다만 아래는 예외로 허용한다.
//   연도(2026년), 날짜·시각(11월 30일, 15시 30분), 분기(3분기), 강의 번호(21강),
//   한두 자리 수 + 세는 말(3가지, 2개, 10년, 1주, 52주, 2차전지 …),
//   고유 이름(S&P500, 코스피200, NCM811, 코로나19, 5G),
//   그리고 강의 파일의 allow_numbers 에 적은 고유명사 숫자(예: "4680").

const NAMED_NUMBER_RE = /(?:S&P|KOSPI|KOSDAQ|KRX|NASDAQ|Nasdaq|Russell|MSCI|FTSE|Nikkei|코스피|코스닥|나스닥|러셀|닛케이|니케이|다우|항셍)\s?\d{2,4}|코로나\s?19|COVID-?19|(?<![A-Za-z0-9])(?:5G|6G|3D|2D)(?![A-Za-z0-9])/g;
const NUM_RE = /\d[\d,]*(?:\.\d+)?/g;
const UNIT_WORDS = '(?:원|달러|엔|위안|유로|%|퍼센트|배|조|억|만|천|bp|포인트|pt)';
const UNIT_DIRECT = new RegExp(`^${UNIT_WORDS}`);
const UNIT_SPACED = new RegExp(`^\\s${UNIT_WORDS}(.?)`);

/** 숫자 바로 뒤에 금액·비율 단위가 오는지. "4680 배터리"의 '배'처럼 다른 낱말의 첫 글자는 단위로 보지 않는다. */
function unitFollows(after) {
  if (UNIT_DIRECT.test(after)) return true;
  const m = after.match(UNIT_SPACED);
  if (!m) return false;
  const next = m[1];
  if (!next || !/[가-힣]/.test(next)) return true;      // "12 배." "12 원)"
  return /[은는이가을를의에도로과와]/.test(next);         // "12 배가", "12 원을"
}
const COUNTER = '(?:가지|단계|번째|종류|줄|문제|개월|개|번|차|위|등|명|곳|주일|주|년|분기|반기|시간|분|시|월|일|회차|회|세대|대|인|건|강|장|편|쪽|부|권|세)';
const COUNTER_AFTER = new RegExp(`^\\s?${COUNTER}`);
const RANGE_AFTER = new RegExp(`^\\s?[~∼\\-–·,]\\s?\\d{1,2}\\s?${COUNTER}`);

function isAllowedNumber(token, before, after, allowSet) {
  const plain = token.replace(/,/g, '');
  const isInt = /^\d+$/.test(plain);
  const unitAfter = unitFollows(after);
  if (/[A-Za-z&]$/.test(before) && !unitAfter) return true;                                  // NCM811, T3, M2, G20
  if (isInt && /^(?:19|20)\d{2}$/.test(plain) && /^\s?(?:년|회계연도)/.test(after)) return true;  // 2026년
  if (isInt && plain.length <= 2 && COUNTER_AFTER.test(after)) return true;                    // 3가지, 10년, 52주
  if (isInt && plain.length <= 3 && /^\s?강/.test(after)) return true;                         // 21강
  if (isInt && plain.length <= 2 && RANGE_AFTER.test(after)) return true;                      // 1~2개
  if (isInt && plain.length <= 2 && /제$/.test(before)) return true;                           // 제2의
  if (isInt && plain.length <= 2 && /^\s*$/.test(before) && /^[.)]\s/.test(after)) return true; // "1. " 목록
  if (allowSet.has(token) && !unitAfter) return true;                                          // allow_numbers
  return false;
}

/**
 * 글(마크업을 푼 순수 글자)에서 facts 참조 없이 직접 쓰인 숫자를 찾는다.
 * @param {string} plain
 * @param {string[]} [allow] 강의별 예외(allow_numbers)
 * @returns {string[]} 문제가 되는 숫자 토큰
 */
export function findBareNumbers(plain, allow = []) {
  const allowSet = new Set(allow);
  const masked = String(plain ?? '').replace(NAMED_NUMBER_RE, (m) => '§'.repeat(m.length));
  const found = [];
  let m;
  NUM_RE.lastIndex = 0;
  while ((m = NUM_RE.exec(masked)) !== null) {
    const token = m[0];
    const before = masked.slice(Math.max(0, m.index - 12), m.index);
    const after = masked.slice(m.index + token.length, m.index + token.length + 12);
    if (!isAllowedNumber(token, before, after, allowSet)) found.push(token);
  }
  return found;
}

/* ───────────────────────── 작은 검사 도구 ───────────────────────── */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

export function isHttpsUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname.includes('.');
  } catch {
    return false;
  }
}

/** 강의 번호 → 커리큘럼 항목. 68강을 넘으면 2회차로 보고 같은 순서를 다시 돈다. */
export function curriculumEntryFor(curriculum, lessonNo) {
  const list = curriculum?.lessons;
  if (!Array.isArray(list) || list.length === 0 || !Number.isInteger(lessonNo) || lessonNo < 1) return null;
  const total = list.length;
  const base = ((lessonNo - 1) % total) + 1;
  const entry = list.find((l) => l.no === base);
  if (!entry) return null;
  return { entry, round: Math.floor((lessonNo - 1) / total) + 1, base, total };
}

/** 값 안의 모든 문자열을 모은다(금지 표현 검사용). URL·id 칸은 건너뛴다. */
function collectStrings(value, pathLabel, out) {
  if (typeof value === 'string') { out.push([pathLabel, value]); return; }
  if (Array.isArray(value)) { value.forEach((v, i) => collectStrings(v, `${pathLabel}[${i}]`, out)); return; }
  if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'url' || k === 'source_url' || k === 'id' || k === 'related' || k === 'derived' || k === 'expr') continue;
      collectStrings(v, pathLabel ? `${pathLabel}.${k}` : k, out);
    }
  }
}

const KNOWN_KEYS = new Set([
  'schema', 'date', 'lesson_no', 'track', 'title', 'summary', 'body', 'formula', 'news_case',
  'facts', 'english', 'terms', 'quiz', 'disclaimer', 'sample', 'allow_numbers',
]);

/* ───────────────────────── 강의 검증 ───────────────────────── */

/**
 * 강의 JSON 하나를 검증한다.
 * @param {object} lesson
 * @param {object} [ctx]
 * @param {object} [ctx.curriculum]      curriculum.json 내용
 * @param {Iterable<string>} [ctx.glossaryIds]  누적 사전에 있는 용어 id
 * @param {(id:string)=>object} [ctx.lookupGlossary] 누적 사전 조회(표시 이름 확인용)
 * @param {string} [ctx.filePath]        저장소 기준 상대 경로(날짜와 일치하는지 확인)
 * @param {number|null} [ctx.prevLessonNo] 직전(샘플 제외) 강의 번호. 없으면 null, 검사를 건너뛰려면 undefined
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateLesson(lesson, ctx = {}) {
  const errors = [];
  const warnings = [];
  const E = (where, msg) => errors.push(`${where}: ${msg}`);
  const W = (where, msg) => warnings.push(`${where}: ${msg}`);

  if (!isObj(lesson)) return { errors: ['강의 파일의 최상위는 객체({ … })여야 합니다'], warnings };

  for (const key of Object.keys(lesson)) {
    if (!KNOWN_KEYS.has(key)) W(key, '알 수 없는 필드입니다(오타가 아닌지 확인하세요)');
  }

  if (lesson.schema !== SCHEMA_VERSION) E('schema', `${SCHEMA_VERSION} 이어야 합니다`);
  if (lesson.disclaimer !== true) E('disclaimer', 'true 여야 합니다(교육용 고지)');
  if (lesson.sample !== undefined && typeof lesson.sample !== 'boolean') E('sample', 'true/false 여야 합니다');

  /* 날짜·경로 */
  const dateOk = isValidYmd(lesson.date);
  if (!dateOk) E('date', 'YYYY-MM-DD 형식의 올바른 날짜여야 합니다');
  if (ctx.filePath !== undefined) {
    const rel = String(ctx.filePath).split(path.sep).join('/');
    const m = rel.match(LESSON_PATH_RE);
    if (!m) E('파일 경로', `lessons/YYYY/MM/YYYY-MM-DD.json 형식이어야 합니다(현재 ${rel})`);
    else if (dateOk && (m[3] !== lesson.date || rel !== lessonPathFor(lesson.date))) {
      E('date', `파일 경로(${rel})와 날짜(${lesson.date})가 일치하지 않습니다`);
    }
  }

  /* 강의 번호·트랙 */
  const tracks = new Set((ctx.curriculum?.tracks ?? []).map((t) => t.id));
  if (!isStr(lesson.track)) E('track', '트랙 id(예: "T3")가 필요합니다');
  else if (ctx.curriculum && !tracks.has(lesson.track)) E('track', `커리큘럼에 없는 트랙입니다(${lesson.track})`);

  let curEntry = null;
  if (!Number.isInteger(lesson.lesson_no) || lesson.lesson_no < 1) {
    E('lesson_no', '1 이상의 정수여야 합니다');
  } else if (ctx.curriculum) {
    curEntry = curriculumEntryFor(ctx.curriculum, lesson.lesson_no);
    if (!curEntry) E('lesson_no', `커리큘럼에 없는 강의 번호입니다(${lesson.lesson_no})`);
    else if (isStr(lesson.track) && curEntry.entry.track !== lesson.track) {
      E('track', `${lesson.lesson_no}강의 트랙은 ${curEntry.entry.track} 입니다(현재 ${lesson.track})`);
    }
    if (lesson.sample !== true && ctx.prevLessonNo !== undefined) {
      const expected = (ctx.prevLessonNo ?? 0) + 1;
      if (lesson.lesson_no !== expected) {
        E('lesson_no', ctx.prevLessonNo === null
          ? `첫 강의는 1번이어야 합니다(현재 ${lesson.lesson_no})`
          : `직전 강의(${ctx.prevLessonNo}강)의 다음 번호인 ${expected} 이어야 합니다(현재 ${lesson.lesson_no})`);
      }
    }
  }

  /* 용어 사전 */
  const ownTerms = new Map();
  if (!Array.isArray(lesson.terms)) {
    E('terms', '배열이어야 합니다(새 용어가 없으면 빈 배열)');
  } else {
    lesson.terms.forEach((t, i) => {
      const at = `terms[${i}]`;
      if (!isObj(t)) { E(at, '객체여야 합니다'); return; }
      if (typeof t.id !== 'string' || !TERM_ID_RE.test(t.id)) E(`${at}.id`, `영문 소문자·숫자·하이픈만 쓸 수 있습니다(현재 ${JSON.stringify(t.id)})`);
      else if (ownTerms.has(t.id)) E(`${at}.id`, `"${t.id}" 가 중복됐습니다`);
      else ownTerms.set(t.id, t);
      for (const key of ['ko', 'en', 'short']) if (!isStr(t[key])) E(`${at}.${key}`, '필수 항목입니다');
      if (isStr(t.short) && [...t.short].length > SHORT_MAX) E(`${at}.short`, `${SHORT_MAX}자 이내여야 합니다(현재 ${[...t.short].length}자)`);
      for (const key of ['long', 'formula', 'example', 'label']) {
        if (t[key] !== undefined && typeof t[key] !== 'string') E(`${at}.${key}`, '문자열이어야 합니다');
      }
      if (t.related !== undefined && !Array.isArray(t.related)) E(`${at}.related`, '배열이어야 합니다');
    });
  }
  const glossaryIds = new Set(ctx.glossaryIds ?? []);
  const knows = (id) => ownTerms.has(id) || glossaryIds.has(id);
  (Array.isArray(lesson.terms) ? lesson.terms : []).forEach((t, i) => {
    if (!isObj(t) || !Array.isArray(t.related)) return;
    t.related.forEach((rid, j) => {
      if (typeof rid !== 'string' || !knows(rid)) E(`terms[${i}].related[${j}]`, `용어 "${rid}" 가 이 강의 terms 에도 누적 사전에도 없습니다`);
      else if (rid === t.id) E(`terms[${i}].related[${j}]`, '자기 자신을 관련 용어로 둘 수 없습니다');
    });
  });

  /* 숫자(facts) */
  const factIds = new Set();
  if (!Array.isArray(lesson.facts)) {
    E('facts', '배열이어야 합니다(숫자가 없으면 빈 배열)');
  } else {
    lesson.facts.forEach((f, i) => {
      const at = `facts[${i}]`;
      if (!isObj(f)) { E(at, '객체여야 합니다'); return; }
      if (!Number.isInteger(f.id) || f.id < 0) E(`${at}.id`, '0 이상의 정수여야 합니다');
      else if (factIds.has(f.id)) E(`${at}.id`, `${f.id} 가 중복됐습니다`);
      else factIds.add(f.id);
      if (!isStr(f.label)) E(`${at}.label`, '필수 항목입니다(무엇의 숫자인지)');
      if (typeof f.value !== 'number' || !Number.isFinite(f.value)) E(`${at}.value`, '숫자여야 합니다(문자열·콤마 불가)');
      if (!isStr(f.unit)) E(`${at}.unit`, '필수 항목입니다(예: "원", "%", "배")');
      if (!isValidYmd(f.asof)) E(`${at}.asof`, '기준일(YYYY-MM-DD)이 필요합니다');
      else if (dateOk && f.asof > lesson.date) E(`${at}.asof`, `기준일(${f.asof})이 강의 날짜(${lesson.date})보다 미래입니다`);
      if (f.source_url === undefined || f.source_url === null || f.source_url === '') E(`${at}.source_url`, '출처 주소가 없습니다');
      else if (!isHttpsUrl(f.source_url)) E(`${at}.source_url`, 'https:// 로 시작하는 올바른 주소여야 합니다');
      if (f.digits !== undefined && !(Number.isInteger(f.digits) && f.digits >= 0 && f.digits <= 6)) E(`${at}.digits`, '0~6 사이 정수여야 합니다');
      if (f.change !== undefined && typeof f.change !== 'boolean') E(`${at}.change`, 'true/false 여야 합니다');
      if (f.note !== undefined && typeof f.note !== 'string') E(`${at}.note`, '문자열이어야 합니다');
    });
    errors.push(...checkDerived(lesson.facts));
  }

  /* 마크업을 쓰는 글 */
  const allow = [];
  if (lesson.allow_numbers !== undefined) {
    if (!Array.isArray(lesson.allow_numbers) || lesson.allow_numbers.some((s) => typeof s !== 'string' || !/^\d[\d,]*(?:\.\d+)?$/.test(s))) {
      E('allow_numbers', '숫자 문자열의 배열이어야 합니다(예: ["4680"])');
    } else {
      allow.push(...lesson.allow_numbers);
    }
  }
  const renderCtx = makeContext({ terms: lesson.terms ?? [], facts: Array.isArray(lesson.facts) ? lesson.facts : [] }, ctx.lookupGlossary);
  const usedFacts = new Set();

  /** 마크업 참조 확인. checkNumbers=true 이면 직접 쓴 숫자도 검사한다. */
  function checkMarkup(where, text, checkNumbers) {
    if (typeof text !== 'string') return;
    let plainForNumbers = '';
    for (const tok of splitTokens(text)) {
      if (tok.type === 'text') {
        if (/\[\[|\]\]|\{\{|\}\}/.test(tok.value)) E(where, '마크업 형식이 잘못됐습니다([[용어id]] · [[용어id|표시]] · {{f:번호}} 만 가능, id는 영문 소문자)');
        plainForNumbers += tok.value;
      } else if (tok.type === 'term') {
        if (!knows(tok.id)) E(where, `용어 "[[${tok.id}]]" 가 이 강의 terms 에도 누적 사전에도 없습니다`);
        plainForNumbers += tok.label ?? termLabel(renderCtx.lookupTerm(tok.id)) ?? '';
      } else {
        usedFacts.add(tok.id);
        if (!factIds.has(tok.id)) E(where, `{{f:${tok.id}}} 에 해당하는 facts 항목이 없습니다`);
        plainForNumbers += '□';
      }
    }
    if (checkNumbers) {
      for (const n of findBareNumbers(plainForNumbers, allow)) {
        E(where, `숫자 "${n}"이 facts 참조 없이 쓰였습니다(facts 에 넣고 {{f:번호}} 로 쓰세요. 고유명사라면 allow_numbers 에 추가)`);
      }
    }
  }
  function noMarkup(where, text) {
    if (typeof text === 'string' && /\[\[|\{\{f:/.test(text)) E(where, '이 칸에는 마크업([[ ]], {{ }})을 쓸 수 없습니다');
  }

  if (!isStr(lesson.title)) E('title', '필수 항목입니다');
  else {
    noMarkup('title', lesson.title);
    if ([...lesson.title].length > 60) E('title', '60자 이내여야 합니다');
    for (const n of findBareNumbers(lesson.title, allow)) E('title', `숫자 "${n}"이 facts 참조 없이 쓰였습니다`);
  }

  if (!Array.isArray(lesson.summary) || lesson.summary.length !== 3 || lesson.summary.some((s) => !isStr(s))) {
    E('summary', '한 줄 요약 3개(문자열)가 필요합니다');
  } else {
    lesson.summary.forEach((s, i) => checkMarkup(`summary[${i}]`, s, true));
  }

  if (!Array.isArray(lesson.body) || lesson.body.some((s) => !isStr(s))) {
    E('body', '문단(문자열) 배열이어야 합니다');
  } else {
    if (lesson.body.length < 3 || lesson.body.length > 7) E('body', `문단은 3~7개여야 합니다(현재 ${lesson.body.length}개)`);
    lesson.body.forEach((s, i) => checkMarkup(`body[${i}]`, s, true));
    const length = lesson.body.reduce((sum, s) => sum + [...toPlainText(s, renderCtx)].length, 0);
    if (length < BODY_GUIDE.hardMin || length > BODY_GUIDE.hardMax) {
      E('body', `본문 길이가 ${length}자입니다(${BODY_GUIDE.min}~${BODY_GUIDE.max}자 권장, ${BODY_GUIDE.hardMin}~${BODY_GUIDE.hardMax}자를 벗어나면 실패)`);
    } else if (length < BODY_GUIDE.min || length > BODY_GUIDE.max) {
      W('body', `본문 길이가 ${length}자입니다(${BODY_GUIDE.min}~${BODY_GUIDE.max}자 권장)`);
    }
  }

  if (lesson.formula !== undefined && lesson.formula !== null) {
    if (!isObj(lesson.formula) || !isStr(lesson.formula.text)) E('formula', '{ text, terms } 형식이어야 합니다(공식이 없으면 생략)');
    else {
      noMarkup('formula.text', lesson.formula.text);
      if (lesson.formula.terms !== undefined) {
        if (!Array.isArray(lesson.formula.terms)) E('formula.terms', '용어 id 배열이어야 합니다');
        else lesson.formula.terms.forEach((id, i) => { if (!knows(id)) E(`formula.terms[${i}]`, `용어 "${id}" 가 사전에 없습니다`); });
      }
    }
  }

  const nc = lesson.news_case;
  if (!isObj(nc)) {
    E('news_case', '필수 항목입니다({ headline, explain, sources })');
  } else {
    if (!isStr(nc.headline)) E('news_case.headline', '필수 항목입니다');
    else checkMarkup('news_case.headline', nc.headline, true);
    if (!Array.isArray(nc.explain) || nc.explain.length < 1 || nc.explain.some((s) => !isStr(s))) E('news_case.explain', '설명 문단(문자열)이 1개 이상 필요합니다');
    else nc.explain.forEach((s, i) => checkMarkup(`news_case.explain[${i}]`, s, true));
    if (!Array.isArray(nc.sources) || nc.sources.length < 1) {
      E('news_case.sources', '출처가 1개 이상 필요합니다');
    } else {
      nc.sources.forEach((s, i) => {
        if (!isObj(s)) { E(`news_case.sources[${i}]`, '{ name, url } 형식이어야 합니다'); return; }
        if (!isStr(s.name)) E(`news_case.sources[${i}].name`, '매체 이름이 필요합니다');
        if (!isHttpsUrl(s.url)) E(`news_case.sources[${i}].url`, 'https:// 로 시작하는 올바른 주소여야 합니다');
      });
    }
    if (nc.kind !== undefined && !['news', 'review'].includes(nc.kind)) E('news_case.kind', '"news" 또는 "review" 여야 합니다');
    if (nc.date !== undefined && !isValidYmd(nc.date)) E('news_case.date', 'YYYY-MM-DD 형식이어야 합니다');
  }

  if (!Array.isArray(lesson.english) || lesson.english.length < 1) {
    E('english', '영어 문장이 1개 이상 필요합니다');
  } else {
    lesson.english.forEach((e, i) => {
      if (!isObj(e) || !isStr(e.en) || !isStr(e.ko)) E(`english[${i}]`, '{ en, ko } 가 모두 필요합니다');
      else { noMarkup(`english[${i}].en`, e.en); noMarkup(`english[${i}].ko`, e.ko); }
    });
    if (lesson.english.length !== 2) W('english', `영어 문장은 2개를 권장합니다(현재 ${lesson.english.length}개)`);
  }

  /* 퀴즈 */
  if (!Array.isArray(lesson.quiz) || lesson.quiz.length !== 3) {
    E('quiz', `정확히 3문제여야 합니다(현재 ${Array.isArray(lesson.quiz) ? lesson.quiz.length : 0}개)`);
  } else {
    const counts = Object.fromEntries(QUIZ_TYPES.map((t) => [t, 0]));
    lesson.quiz.forEach((q, i) => {
      const at = `quiz[${i}]`;
      if (!isObj(q)) { E(at, '객체여야 합니다'); return; }
      if (!QUIZ_TYPES.includes(q.type)) E(`${at}.type`, `concept · calc · case 중 하나여야 합니다(현재 ${JSON.stringify(q.type)})`);
      else counts[q.type] += 1;
      if (!isStr(q.q)) E(`${at}.q`, '문제 문장이 필요합니다');
      else checkMarkup(`${at}.q`, q.q, false);
      if (!isStr(q.explain)) E(`${at}.explain`, '해설이 필요합니다');
      else checkMarkup(`${at}.explain`, q.explain, false);
      let choicesOk = false;
      if (!Array.isArray(q.choices) || q.choices.length !== 4 || q.choices.some((c) => !isStr(c))) {
        E(`${at}.choices`, '보기는 정확히 4개(문자열)여야 합니다');
      } else {
        choicesOk = true;
        q.choices.forEach((c, j) => checkMarkup(`${at}.choices[${j}]`, c, false));
        if (new Set(q.choices.map((c) => c.trim())).size !== 4) E(`${at}.choices`, '보기 4개가 서로 달라야 합니다');
      }
      if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer > 3) E(`${at}.answer`, '0~3 사이 정수여야 합니다');
      if (q.type === 'calc' && choicesOk) {
        const r = checkCalcQuiz(q);
        errors.push(...r.errors.map((e) => `${at}.${e}`));
        warnings.push(...r.warnings.map((w) => `${at}.${w}`));
      }
    });
    const bad = QUIZ_TYPES.filter((t) => counts[t] !== 1);
    if (bad.length) {
      const now = QUIZ_TYPES.map((t) => `${t} ${counts[t]}개`).join(', ');
      E('quiz', `type 은 concept · calc · case 가 각각 1개여야 합니다(현재 ${now})`);
    }
  }

  /* 금지 표현 */
  const strings = [];
  collectStrings(lesson, '', strings);
  for (const [where, text] of strings) {
    for (const hit of findBanned(text)) E(where, `금지 표현 "${hit.match}" (${hit.label}) — 투자 권유로 읽힐 수 있습니다`);
  }

  /* 안내(경고) */
  if (Array.isArray(lesson.facts)) {
    for (const f of lesson.facts) {
      if (isObj(f) && Number.isInteger(f.id) && !usedFacts.has(f.id)) W(`facts(id ${f.id})`, '본문 어디에서도 쓰이지 않습니다');
    }
  }
  if (curEntry && Array.isArray(curEntry.entry.key_terms)) {
    for (const id of curEntry.entry.key_terms) {
      if (!knows(id)) W('terms', `커리큘럼 핵심 용어 "${id}" 가 이 강의 terms 에도 누적 사전에도 없습니다`);
    }
  }

  return { errors, warnings };
}

/* ───────────────────────── 커리큘럼·사전 검증 ───────────────────────── */

export function validateCurriculum(cur) {
  const errors = [];
  const warnings = [];
  const E = (where, msg) => errors.push(`${where}: ${msg}`);
  if (!isObj(cur)) return { errors: ['curriculum.json 의 최상위는 객체여야 합니다'], warnings };
  if (cur.version !== 1) E('version', '1 이어야 합니다');

  const trackIds = [];
  if (!Array.isArray(cur.tracks) || cur.tracks.length === 0) E('tracks', '트랙 배열이 필요합니다');
  else {
    cur.tracks.forEach((t, i) => {
      if (!isObj(t)) { E(`tracks[${i}]`, '객체여야 합니다'); return; }
      if (typeof t.id !== 'string' || !/^T\d+$/.test(t.id)) E(`tracks[${i}].id`, '"T1" 형식이어야 합니다');
      else if (trackIds.includes(t.id)) E(`tracks[${i}].id`, `${t.id} 가 중복됐습니다`);
      else trackIds.push(t.id);
      if (!isStr(t.name)) E(`tracks[${i}].name`, '필수 항목입니다');
      if (typeof t.color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(t.color)) E(`tracks[${i}].color`, '"#RRGGBB" 형식이어야 합니다');
    });
  }

  if (!Array.isArray(cur.lessons) || cur.lessons.length === 0) E('lessons', '강의 배열이 필요합니다');
  else {
    let lastTrackIndex = -1;
    cur.lessons.forEach((l, i) => {
      const at = `lessons[${i}]`;
      if (!isObj(l)) { E(at, '객체여야 합니다'); return; }
      if (l.no !== i + 1) E(`${at}.no`, `순서대로 ${i + 1} 이어야 합니다(현재 ${l.no})`);
      const ti = trackIds.indexOf(l.track);
      if (ti === -1) E(`${at}.track`, `tracks 에 없는 트랙입니다(${l.track})`);
      else if (ti < lastTrackIndex) E(`${at}.track`, '강의는 트랙 순서대로 묶여 있어야 합니다');
      else lastTrackIndex = ti;
      if (!isStr(l.title)) E(`${at}.title`, '필수 항목입니다');
      if (!isStr(l.goal)) E(`${at}.goal`, '필수 항목입니다');
      if (!Array.isArray(l.key_terms) || l.key_terms.length < 1) E(`${at}.key_terms`, '핵심 용어 id 가 1개 이상 필요합니다');
      else l.key_terms.forEach((id, j) => { if (typeof id !== 'string' || !TERM_ID_RE.test(id)) E(`${at}.key_terms[${j}]`, `용어 id 형식이 잘못됐습니다(${JSON.stringify(id)})`); });
      if (l.calc !== undefined && (!Array.isArray(l.calc) || l.calc.some((c) => !['compound', 'valuation', 'dividend', 'avgcost'].includes(c)))) {
        E(`${at}.calc`, 'compound · valuation · dividend · avgcost 로 이루어진 배열이어야 합니다');
      }
    });
    for (const id of trackIds) {
      if (!cur.lessons.some((l) => l.track === id)) E('tracks', `${id} 트랙에 강의가 없습니다`);
    }
    if (cur.lessons.length < 63 || cur.lessons.length > 73) warnings.push(`lessons: 강의 수가 ${cur.lessons.length}개입니다(계획은 68 ± 5)`);
  }
  return { errors, warnings };
}

export function validateGlossary(glo) {
  const errors = [];
  const warnings = [];
  const E = (where, msg) => errors.push(`${where}: ${msg}`);
  if (!isObj(glo)) return { errors: ['glossary/terms.json 의 최상위는 객체여야 합니다'], warnings };
  if (glo.version !== 1) E('version', '1 이어야 합니다');
  if (!Array.isArray(glo.terms)) { E('terms', '배열이어야 합니다'); return { errors, warnings }; }
  const ids = new Set();
  glo.terms.forEach((t, i) => {
    const at = `terms[${i}]`;
    if (!isObj(t)) { E(at, '객체여야 합니다'); return; }
    if (typeof t.id !== 'string' || !TERM_ID_RE.test(t.id)) E(`${at}.id`, '영문 소문자·숫자·하이픈만 쓸 수 있습니다');
    else if (ids.has(t.id)) E(`${at}.id`, `"${t.id}" 가 중복됐습니다`);
    else ids.add(t.id);
    for (const key of ['ko', 'en', 'short']) if (!isStr(t[key])) E(`${at}.${key}`, '필수 항목입니다');
    if (isStr(t.short) && [...t.short].length > SHORT_MAX) E(`${at}.short`, `${SHORT_MAX}자 이내여야 합니다`);
  });
  glo.terms.forEach((t, i) => {
    if (!isObj(t) || !Array.isArray(t.related)) return;
    t.related.forEach((rid, j) => { if (!ids.has(rid)) E(`terms[${i}].related[${j}]`, `용어 "${rid}" 가 사전에 없습니다`); });
  });
  const strings = [];
  collectStrings(glo.terms, 'terms', strings);
  for (const [where, text] of strings) {
    for (const hit of findBanned(text)) E(where, `금지 표현 "${hit.match}" (${hit.label})`);
  }
  return { errors, warnings };
}

/** 강의 목록에서 index.json 항목을 만든다(최신 날짜가 먼저). */
export function buildIndexItems(lessons) {
  return lessons
    .map(({ rel, lesson }) => {
      const item = { date: lesson.date, lesson_no: lesson.lesson_no, track: lesson.track, title: lesson.title, path: rel };
      if (lesson.sample === true) item.sample = true;
      return item;
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/* ───────────────────────── 파일 단위 실행 ───────────────────────── */

async function loadShared(root) {
  const curriculum = await readJson(path.join(root, 'curriculum', 'curriculum.json'));
  const glossary = await readJsonIfExists(path.join(root, 'glossary', 'terms.json'), { version: 1, terms: [] });
  const byId = new Map((glossary.terms ?? []).map((t) => [t.id, t]));
  return { curriculum, glossary, glossaryIds: new Set(byId.keys()), lookupGlossary: (id) => byId.get(id) };
}

/** 강의 파일 하나를 검증한다(직전 강의 번호까지 확인). */
export async function validateFile(file, { root = ROOT } = {}) {
  const rel = relPath(file, root);
  let lesson;
  try {
    lesson = await readJson(file);
  } catch (err) {
    return { file: rel, errors: [err.message], warnings: [] };
  }
  const shared = await loadShared(root);
  const all = await loadLessons(root);
  const earlier = all.filter((x) => x.lesson?.sample !== true && typeof x.lesson?.date === 'string' && x.lesson.date < (lesson?.date ?? ''));
  const prevLessonNo = earlier.length ? earlier[earlier.length - 1].lesson.lesson_no : null;
  const r = validateLesson(lesson, { ...shared, filePath: rel, prevLessonNo });
  return { file: rel, ...r };
}

/** 저장소 전체를 검증한다. */
export async function validateAll({ root = ROOT } = {}) {
  const reports = [];
  let shared;
  try {
    shared = await loadShared(root);
  } catch (err) {
    return { ok: false, reports: [{ file: 'curriculum/curriculum.json', errors: [err.message], warnings: [] }] };
  }
  reports.push({ file: 'curriculum/curriculum.json', ...validateCurriculum(shared.curriculum) });
  reports.push({ file: 'glossary/terms.json', ...validateGlossary(shared.glossary) });

  let lessons = [];
  try {
    lessons = await loadLessons(root);
  } catch (err) {
    reports.push({ file: 'lessons/', errors: [err.message], warnings: [] });
  }
  let prevLessonNo = null;
  for (const { rel, lesson } of lessons) {
    const r = validateLesson(lesson, { ...shared, filePath: rel, prevLessonNo });
    for (const t of Array.isArray(lesson?.terms) ? lesson.terms : []) {
      if (t && typeof t.id === 'string' && !shared.glossaryIds.has(t.id)) {
        r.errors.push(`terms: "${t.id}" 가 glossary/terms.json 에 없습니다 → node tools/merge-terms.mjs ${rel}`);
      }
    }
    reports.push({ file: rel, ...r });
    if (lesson?.sample !== true && Number.isInteger(lesson?.lesson_no)) prevLessonNo = lesson.lesson_no;
  }

  const indexFile = path.join(root, 'lessons', 'index.json');
  const indexReport = { file: 'lessons/index.json', errors: [], warnings: [] };
  const index = await readJsonIfExists(indexFile, null).catch((err) => { indexReport.errors.push(err.message); return null; });
  if (!index) {
    if (!indexReport.errors.length) indexReport.errors.push('파일이 없습니다 → node tools/build-index.mjs');
  } else if (JSON.stringify(index.items ?? null) !== JSON.stringify(buildIndexItems(lessons))) {
    indexReport.errors.push('강의 파일과 목록이 다릅니다 → node tools/build-index.mjs');
  }
  reports.push(indexReport);

  return { ok: reports.every((r) => r.errors.length === 0), reports };
}

function printReport(report) {
  for (const w of report.warnings) console.warn(`  ⚠ ${report.file} — ${w}`);
  if (report.errors.length === 0) {
    console.log(`✓ ${report.file}`);
  } else {
    console.error(`✗ ${report.file}`);
    for (const e of report.errors) console.error(`  ${e}`);
  }
}

async function main(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log('사용법:\n  node tools/validate.mjs <강의.json> [...]\n  node tools/validate.mjs --all');
    return argv.length === 0 ? 2 : 0;
  }
  let reports;
  if (argv.includes('--all')) {
    reports = (await validateAll()).reports;
  } else {
    reports = [];
    for (const file of argv) reports.push(await validateFile(file));
  }
  reports.forEach(printReport);
  const failed = reports.filter((r) => r.errors.length > 0).length;
  const warned = reports.reduce((n, r) => n + r.warnings.length, 0);
  if (failed) {
    console.error(`\n검증 실패: ${failed}개 파일에 오류가 있습니다.`);
    return 1;
  }
  console.log(`\n검증 통과: ${reports.length}개 파일${warned ? ` (경고 ${warned}건)` : ''}`);
  return 0;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { console.error(`검증 도구 오류: ${err.message}`); process.exitCode = 1; },
  );
}
