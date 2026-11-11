#!/usr/bin/env node
// tools/calc-check.mjs — 계산 문제·계산값(derived) 검산
//
//   node tools/calc-check.mjs lessons/2026/11/2026-11-30.json
//
// 강의의 계산 퀴즈(quiz[type=calc].calc)와 facts[].derived 를 안전한 사칙연산 계산기로
// 직접 계산해, 적힌 값과 ±1% 안에서 맞는지 확인한다. eval 은 쓰지 않는다.

import { evaluate, ExprError, variablesIn } from '../js/expr.js';
import { isMain, readJson } from './common.mjs';

export const TOLERANCE = 0.01;

const MAJOR = { 조: 1e12, 억: 1e8, 만: 1e4 };
const MINOR = { 천: 1e3, 백: 1e2, 십: 1e1 };

/**
 * 한국식 숫자 표기에서 값을 읽는다. 읽을 숫자가 없으면 null.
 *   "12.5배" → 12.5      "3,870만 원" → 38700000     "1억 2,000만 원" → 120000000
 *   "9조6,434억원" → 9643400000000     "5천 원" → 5000     "-5%" → -5     "▼3.2%" → -3.2
 */
export function parseKoreanNumber(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  if (typeof text !== 'string') return null;
  const s = text.replace(/\s+/g, '');
  const run = s.match(/([-−▼+▲])?((?:\d[\d,]*(?:\.\d+)?(?:천|백|십)?(?:조|억|만)?)+)/);
  if (!run) return null;
  const sign = run[1] === '-' || run[1] === '−' || run[1] === '▼' ? -1 : 1;
  let total = 0;
  const partRe = /(\d[\d,]*(?:\.\d+)?)(천|백|십)?(조|억|만)?/g;
  let m;
  while ((m = partRe.exec(run[2])) !== null) {
    const n = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n)) return null;
    total += n * (m[2] ? MINOR[m[2]] : 1) * (m[3] ? MAJOR[m[3]] : 1);
  }
  return sign * total;
}

/**
 * 보기 문장에서 값을 읽는다. calc.unit 이 있으면 그 단위를 떼고 읽는다.
 *   ("150억 원", "억 원") → 150      ("92,020원", "원") → 92020      ("3,870만 원", "원") → 38700000
 */
export function parseChoice(choice, unit) {
  let s = String(choice ?? '').replace(/\s+/g, '');
  if (typeof unit === 'string' && unit.trim()) {
    const u = unit.replace(/\s+/g, '');
    if (s.endsWith(u)) s = s.slice(0, -u.length);
  }
  return parseKoreanNumber(s);
}

/** a 와 b 가 허용 오차(기본 ±1%) 안에서 같은지. 기준은 b(계산값). */
export function withinTolerance(a, b, tol = TOLERANCE) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (a === b) return true;
  const scale = Math.max(Math.abs(b), 1e-12);
  return Math.abs(a - b) <= tol * scale + 1e-12;
}

/**
 * 계산 퀴즈 한 문제를 검산한다.
 * @returns {{ errors: string[], warnings: string[], result: number|null }}
 */
export function checkCalcQuiz(quiz) {
  const errors = [];
  const warnings = [];
  const calc = quiz?.calc;
  if (!calc || typeof calc !== 'object' || Array.isArray(calc)) {
    return { errors: ['calc: 계산 문제에는 calc { vars, expr } 가 필요합니다'], warnings, result: null };
  }
  const { vars, expr } = calc;
  if (!vars || typeof vars !== 'object' || Array.isArray(vars) || Object.keys(vars).length === 0) {
    errors.push('calc.vars: 변수(이름 → 숫자)가 1개 이상 있어야 합니다');
  } else {
    for (const [name, value] of Object.entries(vars)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) errors.push(`calc.vars.${name}: 변수 이름은 영문자·숫자·밑줄만 쓸 수 있습니다`);
      if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`calc.vars.${name}: 값이 숫자가 아닙니다`);
    }
  }
  if (typeof expr !== 'string' || !expr.trim()) errors.push('calc.expr: 계산식(문자열)이 필요합니다');
  if (errors.length) return { errors, warnings, result: null };

  let result;
  try {
    result = evaluate(expr, vars);
  } catch (err) {
    const why = err instanceof ExprError ? err.message : String(err);
    return { errors: [`calc.expr: "${expr}" 를 계산할 수 없습니다 — ${why}`], warnings, result: null };
  }

  try {
    const used = new Set(variablesIn(expr));
    for (const name of Object.keys(vars)) {
      if (!used.has(name)) warnings.push(`calc.vars.${name}: 계산식에서 쓰이지 않습니다`);
    }
  } catch { /* evaluate 가 이미 통과했으므로 여기 올 일은 없다 */ }

  const choices = Array.isArray(quiz.choices) ? quiz.choices : [];
  const answer = quiz.answer;
  if (!Number.isInteger(answer) || answer < 0 || answer >= choices.length) {
    errors.push('answer: 정답 번호가 보기 범위를 벗어났습니다');
    return { errors, warnings, result };
  }
  const stated = parseChoice(choices[answer], calc.unit);
  if (stated === null) {
    errors.push(`choices[${answer}]: 정답 보기 "${choices[answer]}" 에서 숫자를 읽을 수 없습니다`);
  } else if (!withinTolerance(stated, result)) {
    errors.push(`calc: 계산 결과 ${trim(result)} 와 정답 보기 "${choices[answer]}"(${trim(stated)}) 가 ±1% 안에서 맞지 않습니다`);
  }
  choices.forEach((choice, i) => {
    if (i === answer) return;
    const other = parseChoice(choice, calc.unit);
    if (other !== null && withinTolerance(other, result)) {
      errors.push(`choices[${i}]: 오답 보기 "${choice}" 도 계산 결과 ${trim(result)} 와 ±1% 안에서 같습니다(정답이 2개)`);
    }
  });

  if (calc.template !== undefined) {
    if (typeof calc.template !== 'string' || !calc.template.trim()) {
      errors.push('calc.template: 문자열이어야 합니다');
    } else {
      const names = [...calc.template.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]);
      for (const name of names) {
        if (!Object.prototype.hasOwnProperty.call(vars, name)) errors.push(`calc.template: {${name}} 에 해당하는 변수가 vars 에 없습니다`);
      }
      for (const name of Object.keys(vars)) {
        if (!names.includes(name)) warnings.push(`calc.template: 변수 ${name} 이(가) 문장에 나오지 않습니다`);
      }
    }
  }
  if (calc.unit !== undefined && typeof calc.unit !== 'string') errors.push('calc.unit: 문자열이어야 합니다');
  if (calc.digits !== undefined && !(Number.isInteger(calc.digits) && calc.digits >= 0 && calc.digits <= 6)) {
    errors.push('calc.digits: 0~6 사이 정수여야 합니다');
  }
  return { errors, warnings, result };
}

/**
 * facts 중 derived(계산값)가 있는 항목을 다시 계산해 value 와 ±1% 안에서 맞는지 확인한다.
 * 식에서는 다른 항목을 f0, f1 … 로 가리킨다. 예) "f0 / f1"
 * @returns {string[]} 오류 문장(앞에 facts[i].derived: 가 붙는다)
 */
export function checkDerived(facts) {
  const errors = [];
  if (!Array.isArray(facts)) return errors;
  const vars = {};
  for (const f of facts) {
    if (f && Number.isInteger(f.id) && typeof f.value === 'number' && Number.isFinite(f.value)) vars[`f${f.id}`] = f.value;
  }
  facts.forEach((f, i) => {
    if (!f || f.derived === undefined) return;
    if (typeof f.derived !== 'string' || !f.derived.trim()) {
      errors.push(`facts[${i}].derived: 계산식(문자열)이어야 합니다`);
      return;
    }
    let used;
    try {
      used = variablesIn(f.derived);
    } catch (err) {
      errors.push(`facts[${i}].derived: "${f.derived}" — ${err.message}`);
      return;
    }
    if (used.includes(`f${f.id}`)) {
      errors.push(`facts[${i}].derived: 자기 자신(f${f.id})을 참조할 수 없습니다`);
      return;
    }
    let result;
    try {
      result = evaluate(f.derived, vars);
    } catch (err) {
      const why = err instanceof ExprError ? err.message : String(err);
      errors.push(`facts[${i}].derived: "${f.derived}" 를 계산할 수 없습니다 — ${why}`);
      return;
    }
    if (typeof f.value === 'number' && !withinTolerance(f.value, result)) {
      errors.push(`facts[${i}].derived: "${f.derived}" = ${trim(result)} 인데 value 는 ${trim(f.value)} 입니다(±1% 초과)`);
    }
  });
  return errors;
}

function trim(n) {
  if (!Number.isFinite(n)) return String(n);
  return String(Number(n.toPrecision(8)));
}

/** 강의 한 개의 계산 문제·계산값을 모두 검산한다. */
export function checkLessonCalcs(lesson) {
  const errors = [];
  const warnings = [];
  (lesson?.quiz ?? []).forEach((q, i) => {
    if (q?.type !== 'calc') return;
    const r = checkCalcQuiz(q);
    errors.push(...r.errors.map((e) => `quiz[${i}].${e}`));
    warnings.push(...r.warnings.map((w) => `quiz[${i}].${w}`));
  });
  errors.push(...checkDerived(lesson?.facts));
  return { errors, warnings };
}

async function main(argv) {
  if (argv.length === 0) {
    console.error('사용법: node tools/calc-check.mjs <강의.json> [...]');
    return 2;
  }
  let failed = 0;
  for (const file of argv) {
    let lesson;
    try {
      lesson = await readJson(file);
    } catch (err) {
      console.error(`✗ ${file}\n  ${err.message}`);
      failed += 1;
      continue;
    }
    const { errors, warnings } = checkLessonCalcs(lesson);
    for (const w of warnings) console.warn(`  ⚠ ${w}`);
    if (errors.length) {
      failed += 1;
      console.error(`✗ ${file}`);
      for (const e of errors) console.error(`  ${e}`);
    } else {
      console.log(`✓ ${file} — 계산 검산 통과`);
    }
  }
  return failed ? 1 : 0;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
