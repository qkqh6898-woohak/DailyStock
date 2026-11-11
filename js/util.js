// util.js — KST 날짜, 숫자 포맷(원·%·배), HTML 이스케이프, 토스트 등 공통 도구
// Node 테스트에서도 불러오므로 파일 최상위에서는 DOM을 건드리지 않는다.

/* ───────────────────────── 날짜 (KST 기준) ───────────────────────── */

export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const WEEKDAYS_KO = ['일', '월', '화', '수', '목', '금', '토'];

/** 지금(또는 주어진 시각)의 한국 날짜 'YYYY-MM-DD'. 기기 시간대와 무관하다. */
export function kstDate(now = new Date()) {
  return new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 한국 시각의 시(0~23). */
export function kstHour(now = new Date()) {
  return new Date(now.getTime() + KST_OFFSET_MS).getUTCHours();
}

/** '2026-11-30T19:50:00+09:00' 형식의 한국 시각 문자열. */
export function kstIso(now = new Date()) {
  return new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 19) + '+09:00';
}

/** ISO 시각 문자열(또는 Date)이 한국 날짜로 며칠인지. */
export function kstDateOf(isoOrDate) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return null;
  return kstDate(d);
}

export function isValidYmd(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = parseYmd(s);
  return !Number.isNaN(d.getTime()) && toYmd(d) === s;
}

/** 'YYYY-MM-DD' → UTC 자정 Date (날짜 계산 전용). */
export function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function toYmd(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(ymd, n) {
  const d = parseYmd(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return toYmd(d);
}

/** 달을 더한다. 말일을 넘으면 그 달의 마지막 날로 맞춘다(1/31 + 1개월 = 2/28). */
export function addMonths(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, lastDay));
  return toYmd(first);
}

/** 요일 번호 0(일)~6(토). */
export function weekday(ymd) {
  return parseYmd(ymd).getUTCDay();
}

/** b - a (일 수). */
export function diffDays(a, b) {
  return Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
}

/** 그 주의 월요일(월~일을 한 주로 본다). */
export function mondayOf(ymd) {
  const wd = weekday(ymd);
  return addDays(ymd, wd === 0 ? -6 : 1 - wd);
}

/** "11월 30일 (월)" / year=true 이면 "2026년 11월 30일 (월)". */
export function formatDateKo(ymd, { year = false, withWeekday = true } = {}) {
  if (!isValidYmd(ymd)) return String(ymd ?? '');
  const [y, m, d] = ymd.split('-').map(Number);
  let out = `${m}월 ${d}일`;
  if (year) out = `${y}년 ${out}`;
  if (withWeekday) out += ` (${WEEKDAYS_KO[weekday(ymd)]})`;
  return out;
}

/** ISO 시각 → "11월 30일 (월) 19:50" (한국 시각). */
export function formatDateTimeKo(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const k = new Date(d.getTime() + KST_OFFSET_MS);
  const hh = String(k.getUTCHours()).padStart(2, '0');
  const mm = String(k.getUTCMinutes()).padStart(2, '0');
  return `${formatDateKo(toYmd(k))} ${hh}:${mm}`;
}

/* ───────────────────────── 숫자 포맷 ───────────────────────── */

/** 소수 자릿수 반올림(1.005 → 1.01 처럼 사람이 기대하는 방식). */
export function roundTo(value, digits = 0) {
  if (!Number.isFinite(value)) return value;
  const s = String(value);
  if (s.includes('e')) return Number(value.toFixed(Math.min(Math.max(digits, 0), 20)));
  const shifted = Math.round(Number(`${s}e${digits}`));
  return Number(`${shifted}e${-digits}`);
}

/** 천 단위 콤마 + 소수 자릿수(최대 maxFrac, 최소 minFrac). */
export function fmtNum(value, maxFrac = 2, minFrac = 0) {
  if (!Number.isFinite(value)) return '–';
  const rounded = roundTo(value, maxFrac);
  const neg = rounded < 0;
  let [intPart, fracPart = ''] = Math.abs(rounded).toFixed(maxFrac).split('.');
  fracPart = fracPart.replace(/0+$/, '');
  while (fracPart.length < minFrac) fracPart += '0';
  intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + intPart + (fracPart ? `.${fracPart}` : '');
}

const TEN_K_UNITS = new Set(['명', '주', '대', '개', '건', '가구', '계좌', '곳']);

/**
 * 값과 단위를 화면용 문자열로 바꾼다.
 *   52300, '원'            → "52,300원"
 *   9643400000000, '원'    → "9조 6,434억 원"
 *   756000000000, '원'     → "7,560억 원"
 *   12.5, '배'             → "12.5배"      (배는 소수 첫째 자리까지 항상 표시)
 *   4.49, '배'             → "4.49배"      (10배 미만은 둘째 자리까지)
 *   7.84, '%'              → "7.84%"
 *   7971242, '명'          → "797만 명"
 * opts.digits 로 소수 자릿수를 직접 지정할 수 있다(큰 수 축약에는 적용하지 않음).
 */
export function formatValue(value, unit = '', opts = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '–';
  const { digits } = opts;
  const hasDigits = Number.isInteger(digits) && digits >= 0;
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  let body;

  if (unit === '%' || unit === '%p') {
    body = fmtNum(abs, hasDigits ? digits : 2, hasDigits ? digits : 0) + unit;
  } else if (unit === '배') {
    const max = hasDigits ? digits : (abs < 10 ? 2 : 1);
    body = `${fmtNum(abs, max, hasDigits ? digits : 1)}배`;
  } else if (abs >= 1e12) {
    const jo = Math.floor(abs / 1e12);
    let eok = Math.round((abs - jo * 1e12) / 1e8);
    let joOut = jo;
    if (eok >= 10000) { joOut += 1; eok = 0; }
    body = `${fmtNum(joOut, 0)}조${eok > 0 ? ` ${fmtNum(eok, 0)}억` : ''} ${unit}`.trimEnd();
  } else if (abs >= 1e8) {
    const eok = abs / 1e8;
    body = `${fmtNum(eok, eok >= 100 ? 0 : 1)}억 ${unit}`.trimEnd();
  } else if (abs >= 1e6 && TEN_K_UNITS.has(unit)) {
    const man = abs / 1e4;
    body = `${fmtNum(man, man >= 1000 ? 0 : 1)}만 ${unit}`;
  } else {
    const max = hasDigits ? digits : (unit === '원' ? 0 : 2);
    body = fmtNum(abs, max, hasDigits ? digits : 0) + unit;
  }
  return sign + body;
}

/** 축약하지 않은 정확한 값(출처 카드용). 예) "9,643,400,000,000원" */
export function formatExact(value, unit = '') {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '–';
  return fmtNum(value, 6) + unit;
}

/**
 * facts 항목을 화면용으로 바꾼다.
 * change: true 인 항목은 ▲▼ 와 방향(dir)을 함께 돌려준다(국내 관례: 상승 빨강 / 하락 파랑).
 */
export function formatFact(fact) {
  if (!fact || typeof fact.value !== 'number') return { text: '–', dir: null };
  const opts = { digits: fact.digits };
  if (fact.change === true) {
    if (fact.value > 0) return { text: `▲${formatValue(fact.value, fact.unit, opts)}`, dir: 'up' };
    if (fact.value < 0) return { text: `▼${formatValue(-fact.value, fact.unit, opts)}`, dir: 'down' };
    return { text: `${formatValue(0, fact.unit, opts)}(보합)`, dir: 'flat' };
  }
  return { text: formatValue(fact.value, fact.unit, opts), dir: null };
}

/** 입력창 문자열 → 숫자. 콤마·공백을 허용하고, 비어 있거나 숫자가 아니면 null. */
export function parseInputNumber(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/[,\s]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/* ───────────────────────── HTML ───────────────────────── */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** 이미 안전한 HTML임을 표시하는 래퍼. html`` 안에서 다시 이스케이프되지 않는다. */
export class SafeHtml {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}

export function raw(value) {
  return new SafeHtml(String(value ?? ''));
}

function interpolate(v) {
  if (v === null || v === undefined || v === false || v === true) return '';
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(interpolate).join('');
  return escapeHtml(v);
}

/**
 * 자동 이스케이프 템플릿. 끼워 넣는 값은 모두 이스케이프되고,
 * html`` 결과나 raw() 로 감싼 값만 그대로 들어간다.
 *   html`<p>${userText}</p>`  → userText 안의 <script> 는 글자로 보인다.
 */
export function html(strings, ...values) {
  let out = '';
  for (let i = 0; i < strings.length; i += 1) {
    out += strings[i];
    if (i < values.length) out += interpolate(values[i]);
  }
  return new SafeHtml(out);
}

/* ───────────────────────── 기타 ───────────────────────── */

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function uuid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 문자열 → 32비트 해시(난수 씨앗용). */
export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 씨앗이 같으면 같은 순서를 내는 난수 생성기(주간 퀴즈가 새로고침해도 같도록). */
export function seededRng(seed) {
  let a = (typeof seed === 'string' ? hashString(seed) : seed) >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(list, rng = Math.random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function debounce(fn, ms = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** 요소의 내용을 html`` 결과로 바꾼다. */
export function setHtml(element, safe) {
  element.innerHTML = safe instanceof SafeHtml ? safe.value : escapeHtml(safe);
}

/**
 * 화면 아래쪽에 잠깐 뜨는 알림.
 * @param {string} message
 * @param {{ action?: string, onAction?: Function, duration?: number }} [opts]
 */
export function toast(message, opts = {}) {
  if (typeof document === 'undefined') return null;
  const root = document.getElementById('toast-root');
  if (!root) return null;
  const { action, onAction, duration = action ? 8000 : 2600 } = opts;
  const node = document.createElement('div');
  node.className = 'toast';
  node.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = message;
  node.append(text);
  let timer = null;
  const close = () => {
    clearTimeout(timer);
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 200);
  };
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action;
    btn.addEventListener('click', () => { close(); if (onAction) onAction(); });
    node.append(btn);
  }
  root.append(node);
  if (duration > 0) timer = setTimeout(close, duration);
  return close;
}
