// expr.js — 안전한 사칙연산 계산기
// eval / new Function 을 쓰지 않고 직접 파싱한다. 브라우저(주간 퀴즈)와 Node(검증 도구)가 함께 쓴다.
//
// 지원: 숫자(정수·소수), 변수(영문자·숫자·밑줄), + - * / ^, 괄호, 단항 +/-
//       보기 좋게 쓴 × ÷ − 도 받아들인다.
// 우선순위: 괄호 > ^(오른쪽 결합) > 단항 부호 > * / > + -
//   예) -2^2 = -4,  2^-1 = 0.5,  2^3^2 = 512

export class ExprError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExprError';
  }
}

const MAX_LENGTH = 300;
const MAX_DEPTH = 50;

const ALIASES = { '×': '*', '÷': '/', '−': '-', '–': '-', '·': '*' };

/** 식을 토큰 배열로 나눈다. */
export function tokenize(src) {
  if (typeof src !== 'string') throw new ExprError('식은 문자열이어야 합니다');
  if (src.length > MAX_LENGTH) throw new ExprError(`식이 너무 깁니다(최대 ${MAX_LENGTH}자)`);
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    let ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') { i += 1; continue; }
    if (ALIASES[ch]) ch = ALIASES[ch];
    if ('+-*/^()'.includes(ch)) {
      tokens.push({ type: 'op', value: ch, pos: i });
      i += 1;
      continue;
    }
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      let j = i;
      let seenDot = false;
      let digits = 0;
      while (j < src.length) {
        const c = src[j];
        if (c >= '0' && c <= '9') { digits += 1; j += 1; }
        else if (c === '.' && !seenDot) { seenDot = true; j += 1; }
        else break;
      }
      if (digits === 0) throw new ExprError(`${i + 1}번째 글자: 숫자 형식이 잘못됐습니다`);
      tokens.push({ type: 'num', value: Number(src.slice(i, j)), pos: i });
      i = j;
      continue;
    }
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ type: 'id', value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    throw new ExprError(`${i + 1}번째 글자 "${ch}"는 쓸 수 없습니다`);
  }
  return tokens;
}

/** 식에 쓰인 변수 이름 목록(중복 제거, 등장 순서). */
export function variablesIn(src) {
  const seen = new Set();
  for (const t of tokenize(src)) if (t.type === 'id') seen.add(t.value);
  return [...seen];
}

/**
 * 식을 계산한다.
 * @param {string} src   예) "price / eps"
 * @param {Record<string, number>} vars  변수 값
 * @returns {number}
 * @throws {ExprError} 문법 오류, 모르는 변수, 0으로 나누기, 결과가 유한하지 않을 때
 */
export function evaluate(src, vars = {}) {
  const tokens = tokenize(src);
  if (tokens.length === 0) throw new ExprError('식이 비어 있습니다');
  let pos = 0;
  let depth = 0;

  const peek = () => tokens[pos];
  const isOp = (v) => peek() && peek().type === 'op' && peek().value === v;

  function parseExpr() {
    let left = parseTerm();
    while (isOp('+') || isOp('-')) {
      const op = tokens[pos++].value;
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseTerm() {
    let left = parseUnary();
    while (isOp('*') || isOp('/')) {
      const op = tokens[pos++].value;
      const right = parseUnary();
      if (op === '/') {
        if (right === 0) throw new ExprError('0으로 나눌 수 없습니다');
        left /= right;
      } else {
        left *= right;
      }
    }
    return left;
  }

  function parseUnary() {
    if (isOp('+')) { pos += 1; return guard(parseUnary); }
    if (isOp('-')) { pos += 1; return -guard(parseUnary); }
    return parsePower();
  }

  function parsePower() {
    const base = parsePrimary();
    if (isOp('^')) {
      pos += 1;
      const exp = guard(parseUnary);
      const out = base ** exp;
      if (!Number.isFinite(out)) throw new ExprError('거듭제곱 결과가 유한한 수가 아닙니다');
      return out;
    }
    return base;
  }

  function parsePrimary() {
    const t = tokens[pos];
    if (!t) throw new ExprError('식이 중간에 끝났습니다');
    if (t.type === 'num') { pos += 1; return t.value; }
    if (t.type === 'id') {
      pos += 1;
      if (!Object.prototype.hasOwnProperty.call(vars, t.value)) {
        throw new ExprError(`변수 "${t.value}"의 값이 없습니다`);
      }
      const v = vars[t.value];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new ExprError(`변수 "${t.value}"의 값이 숫자가 아닙니다`);
      }
      return v;
    }
    if (t.type === 'op' && t.value === '(') {
      pos += 1;
      const v = guard(parseExpr);
      if (!isOp(')')) throw new ExprError('닫는 괄호 ")"가 없습니다');
      pos += 1;
      return v;
    }
    throw new ExprError(`${t.pos + 1}번째 글자 "${t.value}"의 위치가 잘못됐습니다`);
  }

  function guard(fn) {
    depth += 1;
    if (depth > MAX_DEPTH) throw new ExprError('식이 너무 깊게 중첩됐습니다');
    const v = fn();
    depth -= 1;
    return v;
  }

  const result = parseExpr();
  if (pos < tokens.length) {
    const t = tokens[pos];
    throw new ExprError(`${t.pos + 1}번째 글자 "${t.value}"의 위치가 잘못됐습니다`);
  }
  if (!Number.isFinite(result)) throw new ExprError('계산 결과가 유한한 수가 아닙니다');
  return result;
}
