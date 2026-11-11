// render.js — 강의 본문 마크업 → HTML / 읽을 글 / 순수 글자
//
//   [[id]]        용어(사전의 이름으로 표시)      → <button class="term" data-term="id">
//   [[id|표시]]   용어(본문에서 다르게 표시)
//   {{f:n}}       facts[n] 의 숫자                → 포맷된 숫자 + <button class="fact-info" data-fact="n">ⓘ</button>
//
// 원문은 먼저 모두 이스케이프하고, 위 세 가지 마크업만 HTML로 바꾼다(XSS 방지).
// 이 파일은 DOM을 쓰지 않으므로 Node 테스트와 검증 도구에서도 그대로 불러 쓴다.

import { escapeHtml, formatFact, formatValue } from './util.js';

export const TERM_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

// 용어: [[id]] 또는 [[id|표시]]   숫자: {{f:n}}
const TOKEN_SRC = '\\[\\[([a-z][a-z0-9-]*)(?:\\|([^\\[\\]|]+))?\\]\\]|\\{\\{f:(\\d+)\\}\\}';

function tokenRe() {
  return new RegExp(TOKEN_SRC, 'g');
}

/** 용어를 본문에 표시할 짧은 이름. "PER(주가수익비율)" → "PER" */
export function termLabel(term) {
  if (!term) return '';
  if (typeof term.label === 'string' && term.label.trim()) return term.label.trim();
  const ko = String(term.ko ?? '');
  const short = ko.replace(/\s*[(（][^()（）]*[)）]\s*$/, '').trim();
  return short || ko;
}

/** facts 배열을 id → 항목 Map 으로. */
export function factMap(facts) {
  const map = new Map();
  if (Array.isArray(facts)) {
    for (const f of facts) if (f && Number.isInteger(f.id)) map.set(f.id, f);
  }
  return map;
}

/**
 * 렌더링에 필요한 문맥을 만든다.
 * @param {object} lesson             강의 JSON
 * @param {(id: string) => object|undefined} [lookupExtra]  강의 밖 사전(누적 사전·내 용어장) 조회
 */
export function makeContext(lesson, lookupExtra) {
  const own = new Map();
  for (const t of lesson?.terms ?? []) if (t && typeof t.id === 'string') own.set(t.id, t);
  return {
    facts: factMap(lesson?.facts),
    lookupTerm(id) {
      return own.get(id) ?? (lookupExtra ? lookupExtra(id) : undefined);
    },
  };
}

/** 글 한 덩어리를 마크업 조각으로 나눈다. */
export function splitTokens(text) {
  const out = [];
  const src = String(text ?? '');
  const re = tokenRe();
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push({ type: 'text', value: src.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ type: 'term', id: m[1], label: m[2] });
    else out.push({ type: 'fact', id: Number(m[3]) });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ type: 'text', value: src.slice(last) });
  return out;
}

/** 글에서 참조한 용어 id·숫자 id 목록. */
export function extractRefs(text) {
  const termIds = [];
  const factIds = [];
  for (const t of splitTokens(text)) {
    if (t.type === 'term') termIds.push(t.id);
    else if (t.type === 'fact') factIds.push(t.id);
  }
  return { termIds, factIds };
}

/**
 * 본문 한 문단 → 안전한 HTML 문자열.
 * 사전에 없는 용어는 버튼 없이 글자로만, 없는 숫자는 "?"로 표시한다.
 */
export function renderInline(text, ctx) {
  let out = '';
  for (const t of splitTokens(text)) {
    if (t.type === 'text') {
      out += escapeHtml(t.value);
    } else if (t.type === 'term') {
      const term = ctx?.lookupTerm ? ctx.lookupTerm(t.id) : undefined;
      const label = t.label ?? (term ? termLabel(term) : t.id);
      if (term) {
        out += `<button type="button" class="term" data-term="${escapeHtml(t.id)}">${escapeHtml(label)}</button>`;
      } else {
        out += escapeHtml(label);
      }
    } else {
      const fact = ctx?.facts?.get(t.id);
      if (!fact) {
        out += '<span class="fact fact-missing" title="숫자 정보를 찾을 수 없습니다">?</span>';
      } else {
        const { text: shown, dir } = formatFact(fact);
        const cls = dir ? ` ${dir}` : '';
        const aria = escapeHtml(`${fact.label ?? '숫자'} 출처 보기`);
        out += `<span class="fact num${cls}">${escapeHtml(shown)}`
          + `<button type="button" class="fact-info" data-fact="${t.id}" aria-label="${aria}">ⓘ</button></span>`;
      }
    }
  }
  return out;
}

/**
 * 마크업을 풀어 순수 글자로 바꾼다(퀴즈 문장, 글자 수 세기, 검색용).
 * 숫자는 포맷된 값으로, 용어는 표시 이름으로 바뀐다.
 */
export function toPlainText(text, ctx) {
  let out = '';
  for (const t of splitTokens(text)) {
    if (t.type === 'text') {
      out += t.value;
    } else if (t.type === 'term') {
      const term = ctx?.lookupTerm ? ctx.lookupTerm(t.id) : undefined;
      out += t.label ?? (term ? termLabel(term) : t.id);
    } else {
      const fact = ctx?.facts?.get(t.id);
      out += fact ? formatFact(fact).text : '';
    }
  }
  return out;
}

const SPEECH_UNITS = [
  [/%p/g, '퍼센트포인트'],
  [/%/g, '퍼센트'],
  [/▲/g, '상승 '],
  [/▼/g, '하락 '],
  [/÷/g, ' 나누기 '],
  [/×/g, ' 곱하기 '],
  [/→/g, ', '],
  [/ⓘ/g, ''],
];

/** 본문 듣기용 문장. 마크업을 풀고 기호를 읽을 수 있는 말로 바꾼다. */
export function toSpeechText(text, ctx) {
  let out = '';
  for (const t of splitTokens(text)) {
    if (t.type === 'text') {
      out += t.value;
    } else if (t.type === 'term') {
      const term = ctx?.lookupTerm ? ctx.lookupTerm(t.id) : undefined;
      out += t.label ?? (term ? termLabel(term) : '');
    } else {
      const fact = ctx?.facts?.get(t.id);
      if (fact) {
        if (fact.change === true && fact.value !== 0) {
          out += `${formatValue(Math.abs(fact.value), fact.unit, { digits: fact.digits })} ${fact.value > 0 ? '상승' : '하락'}`;
        } else {
          out += formatValue(fact.value, fact.unit, { digits: fact.digits });
        }
      }
    }
  }
  for (const [re, word] of SPEECH_UNITS) out = out.replace(re, word);
  return out.replace(/\s+/g, ' ').trim();
}

/** 본문 듣기용: 긴 글을 문장 단위로 나눈다(브라우저가 긴 글을 중간에 끊는 문제 방지). */
export function splitSentences(text, maxLen = 180) {
  const parts = String(text ?? '').split(/(?<=[.!?。？！])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (p.length <= maxLen) { out.push(p); continue; }
    let rest = p;
    while (rest.length > maxLen) {
      let cut = rest.lastIndexOf(',', maxLen);
      if (cut < maxLen * 0.4) cut = rest.lastIndexOf(' ', maxLen);
      if (cut < maxLen * 0.4) cut = maxLen;
      out.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}
