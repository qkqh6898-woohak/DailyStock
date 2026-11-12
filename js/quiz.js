// quiz.js — 강의 퀴즈(#/quiz/:date) · 주간 퀴즈(#/quiz/weekly) · 오답 노트(#/quiz/wrong)
//
// 주간 퀴즈는 서버 없이 앱이 스스로 만든다.
//   그 주 용어 10개(뜻 고르기) + 그 주에 틀린 문제 다시 풀기 + 계산 문제 2개(그 주 강의의 계산식에 숫자만 바꿔서)

import {
  html, setHtml, toast, kstDate, mondayOf, addDays, weekday, formatDateKo, fmtNum, roundTo, seededRng, shuffle, isValidYmd,
} from './util.js';
import * as db from './db.js';
import { evaluate } from './expr.js';
import { loadGlossary, loadIndex, loadLesson, weekItems } from './lessons.js';
import { makeContext, toPlainText } from './render.js';
import * as progress from './progress.js';

export const TYPE_LABELS = Object.freeze({ concept: '개념', calc: '계산', case: '사례', term: '용어', retry: '다시 풀기' });
const MARKS = ['①', '②', '③', '④'];
const WEEKLY_TERMS = 10;
const WEEKLY_CALCS = 2;

export const resultKey = (date, i) => `${date}#${i}`;
export const weeklyKey = (weekId, i) => `weekly#${weekId}#${i}`;

/* ───────────────────────── 문제 만들기(순수 함수) ───────────────────────── */

function decimalsOf(n) {
  const s = String(n);
  if (s.includes('e')) return 0;
  const i = s.indexOf('.');
  return i === -1 ? 0 : Math.min(6, s.length - i - 1);
}

function roundSig(n, sig) {
  if (n === 0) return 0;
  const mag = Math.floor(Math.log10(Math.abs(n)));
  return roundTo(n, sig - 1 - mag);
}

function sigDigits(n) {
  const s = String(Math.abs(n)).replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
  return Math.max(1, s.length);
}

/** 숫자 하나를 "비슷하지만 다른, 보기 좋은 값"으로 바꾼다. */
export function varyNumber(x, rng) {
  if (typeof x !== 'number' || !Number.isFinite(x) || x === 0) return x;
  const sign = Math.sign(x);
  const abs = Math.abs(x);
  if (Number.isInteger(abs) && abs <= 12) {
    for (let i = 0; i < 10; i += 1) {
      const v = abs + Math.floor(rng() * 5) - 2;
      if (v >= 1 && v !== abs) return sign * v;
    }
    return sign * (abs + 1);
  }
  const decimals = decimalsOf(abs);
  const sig = Math.min(4, Math.max(2, sigDigits(abs)));
  for (let i = 0; i < 10; i += 1) {
    const factor = 0.8 + rng() * 0.45;                 // 0.8 ~ 1.25
    const v = roundTo(roundSig(abs * factor, sig), decimals);
    if (v > 0 && v !== abs) return sign * v;
  }
  return sign * roundTo(abs * 1.1, decimals);
}

function formatAnswer(value, calc) {
  const unit = typeof calc.unit === 'string' ? calc.unit : '';
  const digits = Number.isInteger(calc.digits) ? calc.digits : (unit === '원' || unit === '주' ? 0 : 1);
  return `${fmtNum(value, digits)}${unit}`;
}

function prettyCalc(expr, vars) {
  return expr
    .replace(/[A-Za-z_][A-Za-z0-9_]*/g, (name) => (Object.prototype.hasOwnProperty.call(vars, name) ? fmtNum(vars[name], 6) : name))
    .replace(/\*/g, '×').replace(/\//g, '÷').replace(/\s+/g, ' ').trim();
}

/**
 * 계산 문제의 숫자만 바꿔 새 문제를 만든다. 만들 수 없으면 null.
 * @param {{ q:string, calc:{ vars:object, expr:string, template?:string, unit?:string, digits?:number } }} quiz
 * @param {() => number} rng
 */
export function varyCalcQuestion(quiz, rng) {
  const calc = quiz?.calc;
  if (!calc || typeof calc.expr !== 'string' || !calc.vars || typeof calc.vars !== 'object') return null;
  let original;
  try {
    original = evaluate(calc.expr, calc.vars);
  } catch {
    return null;
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const vars = {};
    for (const [name, value] of Object.entries(calc.vars)) vars[name] = varyNumber(value, rng);
    let result;
    try {
      result = evaluate(calc.expr, vars);
    } catch {
      continue;
    }
    if (Math.sign(result) !== Math.sign(original) || result === 0) continue;
    const ratio = Math.abs(result / original);
    if (ratio < 0.2 || ratio > 5 || Math.abs(ratio - 1) < 0.03) continue;

    const right = formatAnswer(result, calc);
    const seen = new Set([right]);
    const wrongs = [];
    for (const f of shuffle([0.5, 0.8, 1.25, 2, 1.5, 0.67, 1.1, 0.9, 3, 0.4], rng)) {
      const text = formatAnswer(result * f, calc);
      if (seen.has(text)) continue;
      seen.add(text);
      wrongs.push(text);
      if (wrongs.length === 3) break;
    }
    if (wrongs.length < 3) continue;
    const choices = shuffle([right, ...wrongs], rng);
    const q = typeof calc.template === 'string' && calc.template.trim()
      ? calc.template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? fmtNum(vars[name], 6) : m))
      : `숫자를 바꿔 다시 계산해 보세요. ${Object.entries(vars).map(([k, v]) => `${k} = ${fmtNum(v, 6)}`).join(', ')} 일 때, "${quiz.q}"와 같은 방법으로 구한 값은?`;
    return {
      kind: 'calc',
      q,
      choices,
      answer: choices.indexOf(right),
      explain: `${prettyCalc(calc.expr, vars)} = ${right}`,
      vars,
      expr: calc.expr,
    };
  }
  return null;
}

/** 용어 뜻 고르기 문제. 보기를 만들 다른 용어가 모자라면 null. */
export function makeTermQuestion(term, pool, rng) {
  const others = [];
  const seen = new Set([String(term.short).trim()]);
  for (const t of shuffle(pool, rng)) {
    if (!t || t.id === term.id || !t.short) continue;
    const text = String(t.short).trim();
    if (seen.has(text)) continue;
    seen.add(text);
    others.push(text);
    if (others.length === 3) break;
  }
  if (others.length < 2) return null;
  const right = String(term.short).trim();
  const choices = shuffle([right, ...others], rng);
  return {
    kind: 'term',
    termId: term.id,
    q: `'${term.ko}'의 뜻으로 알맞은 것은?`,
    choices,
    answer: choices.indexOf(right),
    explain: `${term.ko}: ${right}${term.formula ? ` (${term.formula})` : ''}`,
  };
}

/** 강의 퀴즈 문제를 화면용 글자로 바꾼다(마크업을 풀고 숫자를 채운다). */
export function plainQuestion(lesson, index, glossaryLookup) {
  const q = lesson.quiz[index];
  const ctx = makeContext(lesson, glossaryLookup);
  return {
    kind: q.type,
    q: toPlainText(q.q, ctx),
    choices: q.choices.map((c) => toPlainText(c, ctx)),
    answer: q.answer,
    explain: toPlainText(q.explain, ctx),
  };
}

/**
 * 주간 퀴즈를 만든다. 같은 주(weekId)는 같은 순서가 나오도록 씨앗을 고정한다.
 * @param {{ weekId: string, lessons: object[], results: Map<string, object>, glossaryTerms: object[] }} input
 */
export function buildWeeklyQuiz({ weekId, lessons, results, glossaryTerms }) {
  const rng = seededRng(`weekly:${weekId}`);
  const questions = [];

  const weekTerms = new Map();
  for (const lesson of lessons) for (const t of lesson.terms ?? []) if (t?.id && t.short && !weekTerms.has(t.id)) weekTerms.set(t.id, t);
  const pool = new Map(weekTerms);
  for (const t of glossaryTerms ?? []) if (t?.id && t.short && !pool.has(t.id)) pool.set(t.id, t);
  const poolList = [...pool.values()];
  for (const term of shuffle([...weekTerms.values()], rng).slice(0, WEEKLY_TERMS)) {
    const q = makeTermQuestion(term, poolList, rng);
    if (q) questions.push(q);
  }

  const lookup = (id) => pool.get(id);
  for (const lesson of lessons) {
    (lesson.quiz ?? []).forEach((_, i) => {
      const rec = results.get(resultKey(lesson.date, i));
      if (!rec || !(rec.wrongCount > 0 || rec.correct === false)) return;
      const base = plainQuestion(lesson, i, lookup);
      const order = shuffle(base.choices.map((_c, k) => k), rng);
      questions.push({
        kind: 'retry',
        source: { date: lesson.date, index: i },
        q: base.q,
        choices: order.map((k) => base.choices[k]),
        answer: order.indexOf(base.answer),
        explain: base.explain,
      });
    });
  }

  const calcs = lessons.flatMap((l) => (l.quiz ?? []).filter((q) => q.type === 'calc' && q.calc));
  if (calcs.length) {
    const picked = shuffle(calcs, rng);
    for (let i = 0; i < WEEKLY_CALCS; i += 1) {
      const made = varyCalcQuestion(picked[i % picked.length], rng);
      if (made && !questions.some((x) => x.kind === 'calc' && x.q === made.q)) questions.push(made);
    }
  }
  return questions;
}

/* ───────────────────────── 문제 풀이 화면(공용) ───────────────────────── */

/**
 * @param {HTMLElement} page
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.backHref
 * @param {string} opts.backLabel
 * @param {Array} opts.questions            [{ kind, q, choices, answer, explain }]
 * @param {(i:number, chosen:number, correct:boolean) => Promise<void>} opts.onAnswer
 * @param {(score:{ correct:number, total:number }) => Promise<void>} [opts.onFinish]
 * @param {import('./util.js').SafeHtml} [opts.note]
 * @param {import('./util.js').SafeHtml} [opts.extraActions]
 */
function runQuiz(page, opts) {
  const { questions } = opts;
  const answers = new Array(questions.length).fill(null);
  let idx = 0;

  const head = () => html`
    <nav class="crumb"><a href="${opts.backHref}" class="back-link">← ${opts.backLabel}</a></nav>
    <h1>${opts.title}</h1>
    ${opts.note ?? ''}`;

  function drawQuestion() {
    const q = questions[idx];
    const picked = answers[idx];
    const done = picked !== null;
    const percent = Math.round(((idx + (done ? 1 : 0)) / questions.length) * 100);
    setHtml(page, html`<div class="quiz">
      ${head()}
      <div class="quiz-progress">
        <span class="num">${idx + 1} / ${questions.length}</span>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-label="퀴즈 진행"><span style="width:${percent}%"></span></div>
        <span class="badge">${TYPE_LABELS[q.kind] ?? '문제'}</span>
      </div>
      <p class="question" id="quiz-question" tabindex="-1">${q.q}</p>
      <div class="choices" role="group" aria-labelledby="quiz-question">
        ${q.choices.map((c, i) => {
          const cls = !done ? '' : i === q.answer ? 'correct' : i === picked ? 'wrong' : '';
          return html`<button type="button" class="choice ${cls}" data-choice="${i}" ${done ? 'disabled' : ''}>
            <span class="mark">${MARKS[i] ?? i + 1}</span><span>${c}</span></button>`;
        })}
      </div>
      ${done ? html`
        <section class="card explain ${picked === q.answer ? 'right' : 'miss'}" aria-live="polite">
          <p class="verdict">${picked === q.answer ? '정답이에요 ✅' : `아쉬워요 ❌ 정답은 ${MARKS[q.answer] ?? q.answer + 1}`}</p>
          <p>${q.explain}</p>
        </section>
        <button type="button" class="btn primary block" data-act="next">${idx === questions.length - 1 ? '결과 보기' : '다음 문제'}</button>` : ''}
    </div>`);
    if (done) page.querySelector('[data-act="next"]').focus({ preventScroll: true });
  }

  function drawResult() {
    const correct = answers.filter((a, i) => a === questions[i].answer).length;
    setHtml(page, html`<div class="quiz">
      ${head()}
      <section class="card">
        <p class="score">${correct} / ${questions.length}</p>
        <p style="text-align:center">${correct === questions.length ? '모두 맞혔어요! 🎉' : correct === 0 ? '괜찮아요. 해설을 읽고 다시 풀어 보세요.' : '잘했어요. 틀린 문제는 오답 노트에 모았어요.'}</p>
        <ul class="result-list">
          ${questions.map((q, i) => html`<li><span aria-hidden="true">${answers[i] === q.answer ? '✅' : '❌'}</span>
            <span><span class="badge">${TYPE_LABELS[q.kind] ?? ''}</span> ${q.q}</span></li>`)}
        </ul>
      </section>
      <div class="form-actions">
        <button type="button" class="btn ghost" data-act="again">다시 풀기</button>
        ${correct < questions.length ? html`<a class="btn ghost" href="#/quiz/wrong">오답 노트</a>` : ''}
        <a class="btn primary" href="${opts.backHref}">${opts.backLabel}</a>
      </div>
      ${opts.extraActions ?? ''}
    </div>`);
  }

  page.addEventListener('click', async (e) => {
    const choice = e.target.closest('[data-choice]');
    if (choice && answers[idx] === null) {
      const chosen = Number(choice.dataset.choice);
      answers[idx] = chosen;
      const ok = chosen === questions[idx].answer;
      try {
        await opts.onAnswer(idx, chosen, ok);
      } catch (err) {
        console.error(err);
      }
      drawQuestion();
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'next') {
      if (idx < questions.length - 1) {
        idx += 1;
        drawQuestion();
        page.querySelector('#quiz-question')?.focus({ preventScroll: true });
        window.scrollTo(0, 0);
      } else {
        const correct = answers.filter((a, i) => a === questions[i].answer).length;
        if (opts.onFinish) await opts.onFinish({ correct, total: questions.length });
        drawResult();
        window.scrollTo(0, 0);
      }
    } else if (act === 'again') {
      answers.fill(null);
      idx = 0;
      drawQuestion();
      window.scrollTo(0, 0);
    }
  });

  drawQuestion();
}

async function saveResult(key, base, chosen, correct) {
  const prev = await db.get('quizResults', key);
  await db.put('quizResults', {
    ...base,
    key,
    chosen,
    correct,
    answeredAt: new Date().toISOString(),
    attempts: (prev?.attempts ?? 0) + 1,
    wrongCount: (prev?.wrongCount ?? 0) + (correct ? 0 : 1),
  });
}

/* ───────────────────────── 강의 퀴즈 ───────────────────────── */

export async function renderLesson(page, { date }) {
  const lesson = await loadLesson(date);
  if (!lesson || !Array.isArray(lesson.quiz) || lesson.quiz.length === 0) {
    setHtml(page, html`<section class="empty"><h1>퀴즈를 불러오지 못했어요</h1>
      <p><a class="btn primary" href="#/today">오늘의 강의로</a></p></section>`);
    return;
  }
  const glossary = await loadGlossary();
  const lookup = (id) => glossary.get(id);
  const questions = lesson.quiz.map((_, i) => plainQuestion(lesson, i, lookup));
  const backHref = `#/lesson/${lesson.date}`;

  runQuiz(page, {
    title: `📝 ${lesson.title}`,
    backHref,
    backLabel: '강의로 돌아가기',
    questions,
    note: lesson.sample === true ? html`<p class="notice sample">샘플 강의의 퀴즈예요. 결과는 저장되지만 진도에는 포함되지 않아요.</p>` : undefined,
    onAnswer: (i, chosen, correct) => saveResult(resultKey(lesson.date, i), { date: lesson.date, index: i, type: questions[i].kind }, chosen, correct),
    onFinish: async () => {
      const r = await progress.markQuizDone(lesson);
      if (r.completedNow) toast('오늘 강의 완료! 🔥');
      document.dispatchEvent(new CustomEvent('ss:progress-changed'));
    },
  });
}

/* ───────────────────────── 주간 퀴즈 ───────────────────────── */

export async function renderWeekly(page, { week } = {}) {
  const today = kstDate();
  const thisMonday = mondayOf(today);
  const wd = weekday(today);
  const isWeekend = wd === 6 || wd === 0;
  const weekId = isValidYmd(week) ? mondayOf(week) : thisMonday;
  const prevWeek = addDays(thisMonday, -7);
  const range = `${formatDateKo(weekId, { withWeekday: false })} ~ ${formatDateKo(addDays(weekId, 4), { withWeekday: false })}`;

  if (weekId === thisMonday && !isWeekend) {
    const daysLeft = 6 - wd;
    setHtml(page, html`
      <nav class="crumb"><a href="#/review" class="back-link">← 복습</a></nav>
      <section class="empty">
        <div class="empty-emoji" aria-hidden="true">🗓</div>
        <h1>주간 퀴즈는 토요일에 열려요</h1>
        <p>이번 주(${range}) 강의로 만든 퀴즈가 ${daysLeft}일 뒤 토요일에 열립니다.</p>
        <p><a class="btn primary" href="#/quiz/weekly/${prevWeek}">지난주 주간 퀴즈 풀기</a></p>
      </section>`);
    return;
  }
  if (weekId > thisMonday) {
    setHtml(page, html`<section class="empty"><h1>아직 열리지 않은 주예요</h1><p><a class="btn primary" href="#/review">복습으로</a></p></section>`);
    return;
  }

  const index = await loadIndex();
  const items = weekItems(index.items, weekId);
  const lessons = (await Promise.all(items.map((it) => loadLesson(it.date)))).filter(Boolean);
  if (lessons.length === 0) {
    setHtml(page, html`
      <nav class="crumb"><a href="#/review" class="back-link">← 복습</a></nav>
      <section class="empty">
        <div class="empty-emoji" aria-hidden="true">🗓</div>
        <h1>이 주에는 강의가 없어요</h1>
        <p>${range}에 올라온 강의가 없어 주간 퀴즈를 만들 수 없어요.</p>
        <p><a class="btn primary" href="#/archive">지난 강의 보기</a></p>
      </section>`);
    return;
  }

  const cacheKey = `weekly:${weekId}`;
  let stored = await db.get('cache', cacheKey).catch(() => null);
  if (!stored || !Array.isArray(stored.value) || stored.value.length === 0) {
    const [glossary, allResults] = await Promise.all([loadGlossary(), db.getAll('quizResults')]);
    const questions = buildWeeklyQuiz({
      weekId,
      lessons,
      results: new Map(allResults.map((r) => [r.key, r])),
      glossaryTerms: [...glossary.values()],
    });
    stored = { key: cacheKey, value: questions, savedAt: new Date().toISOString() };
    if (questions.length) await db.put('cache', stored).catch(() => {});
  }
  const questions = stored.value;
  if (questions.length === 0) {
    setHtml(page, html`<section class="empty"><h1>주간 퀴즈를 만들 수 없어요</h1><p>이 주 강의에 용어가 부족해요.</p>
      <p><a class="btn primary" href="#/review">복습으로</a></p></section>`);
    return;
  }

  runQuiz(page, {
    title: '🗓 주간 퀴즈',
    backHref: '#/review',
    backLabel: '복습으로',
    questions,
    note: html`<p class="notice">${range} · 강의 ${lessons.length}개 · 용어 뜻 고르기, 틀렸던 문제, 숫자를 바꾼 계산 문제</p>`,
    extraActions: html`<p style="text-align:center"><button type="button" class="btn ghost small" data-act="rebuild">문제 새로 만들기</button></p>`,
    onAnswer: (i, chosen, correct) => saveResult(weeklyKey(weekId, i), {
      type: 'weekly', kind: questions[i].kind, weekId, index: i,
      q: questions[i].q, choices: questions[i].choices, answer: questions[i].answer, explain: questions[i].explain,
    }, chosen, correct),
  });

  page.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-act="rebuild"]')) return;
    await db.del('cache', cacheKey);
    const old = (await db.getAll('quizResults')).filter((r) => typeof r.key === 'string' && r.key.startsWith(`weekly#${weekId}#`));
    for (const r of old) await db.del('quizResults', r.key);
    const fresh = document.createElement('div');
    fresh.className = 'page';
    page.replaceWith(fresh);
    await renderWeekly(fresh, { week: weekId });
  });
}

/* ───────────────────────── 오답 노트 ───────────────────────── */

export async function renderWrong(page) {
  const glossary = await loadGlossary();
  const lookup = (id) => glossary.get(id);

  async function collect() {
    const rows = (await db.getAll('quizResults')).filter((r) => r && r.correct === false);
    rows.sort((a, b) => String(b.answeredAt).localeCompare(String(a.answeredAt)));
    const out = [];
    for (const r of rows) {
      if (r.type === 'weekly') {
        if (Array.isArray(r.choices)) out.push({ rec: r, from: '주간 퀴즈', q: { kind: r.kind, q: r.q, choices: r.choices, answer: r.answer, explain: r.explain } });
      } else if (isValidYmd(r.date) && Number.isInteger(r.index)) {
        const lesson = await loadLesson(r.date);
        if (lesson && lesson.quiz[r.index]) {
          out.push({ rec: r, from: `${formatDateKo(r.date, { withWeekday: false })} · ${lesson.title}`, lessonDate: r.date, q: plainQuestion(lesson, r.index, lookup) });
        }
      }
    }
    return out;
  }

  let items = await collect();
  let retrying = null;

  const draw = () => {
    setHtml(page, html`
      <nav class="crumb"><a href="#/review" class="back-link">← 복습</a></nav>
      <h1>📝 오답 노트</h1>
      ${items.length === 0 ? html`
        <section class="empty">
          <div class="empty-emoji" aria-hidden="true">👍</div>
          <p>틀린 문제가 없어요. 퀴즈에서 틀린 문제가 여기에 모입니다.</p>
        </section>` : html`
        <p class="hint">다시 풀어서 맞히면 목록에서 사라져요. (${items.length}문제)</p>
        <div class="list">
          ${items.map((it, n) => {
            const { q, rec } = it;
            const open = retrying === n;
            return html`<section class="card wrong-item">
              <p class="row-foot"><span class="badge">${TYPE_LABELS[q.kind] ?? '문제'}</span><span>${it.from}</span></p>
              <p class="question">${q.q}</p>
              ${open ? html`
                <div class="choices" role="group" aria-label="보기">
                  ${q.choices.map((c, i) => html`<button type="button" class="choice" data-retry="${n}" data-choice="${i}">
                    <span class="mark">${MARKS[i] ?? i + 1}</span><span>${c}</span></button>`)}
                </div>` : html`
                <p class="yours">내 답: ${MARKS[rec.chosen] ?? ''} ${q.choices[rec.chosen] ?? ''}</p>
                <p class="right">정답: ${MARKS[q.answer] ?? ''} ${q.choices[q.answer] ?? ''}</p>
                <p>${q.explain}</p>
                <div class="form-actions">
                  ${it.lessonDate ? html`<a class="btn ghost small" href="#/lesson/${it.lessonDate}">강의 보기</a>` : ''}
                  <button type="button" class="btn ghost small" data-open-retry="${n}">다시 풀기</button>
                </div>`}
            </section>`;
          })}
        </div>`}`);
  };
  draw();

  page.addEventListener('click', async (e) => {
    const openBtn = e.target.closest('[data-open-retry]');
    if (openBtn) { retrying = Number(openBtn.dataset.openRetry); draw(); return; }
    const choice = e.target.closest('[data-retry]');
    if (!choice) return;
    const n = Number(choice.dataset.retry);
    const it = items[n];
    const chosen = Number(choice.dataset.choice);
    const correct = chosen === it.q.answer;
    const { key, ...base } = it.rec;
    await saveResult(key, base, chosen, correct);
    retrying = null;
    if (correct) {
      toast('정답! 오답 노트에서 지웠어요 ✅');
      items = await collect();
    } else {
      it.rec = { ...it.rec, chosen };
      toast('아쉬워요. 해설을 다시 읽어 보세요');
    }
    draw();
  });
}
