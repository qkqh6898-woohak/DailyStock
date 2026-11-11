// review.js — 복습 화면 (#/review)
// 저장한 용어를 FSRS 일정대로 복습한다. 버튼 4개(다시·어려움·알맞음·쉬움)와 다음 간격을 보여 준다.
// 모드: 용어→뜻(기본) / 뜻→용어 / 영어→한국어

import { html, setHtml, toast, kstDate, mondayOf, addDays, weekday } from './util.js';
import * as db from './db.js';
import * as terms from './terms.js';
import * as tts from './tts.js';
import { termLabel } from './render.js';
import {
  applyRating, buildQueue, makeScheduler, nextDueAt, previewRatings, formatInterval,
  RATING_LABELS, SESSION_WINDOW_MS, State,
} from './srs.js';

const MODES = [['term', '용어 → 뜻'], ['meaning', '뜻 → 용어'], ['english', '영어 → 한국어']];
const RATE_CLASS = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' };

export async function render(page) {
  const settings = await db.getSettings();
  let mode = MODES.some(([k]) => k === settings.reviewMode) ? settings.reviewMode : 'term';
  const scheduler = makeScheduler({ retention: Number(settings.retention) || 0.9 });
  const all = await terms.listSaved();
  const startedToday = await terms.newStartedToday();
  const built = buildQueue(all, { now: new Date(), newPerDay: Number(settings.newPerDay) || 0, newStartedToday: startedToday });

  const queue = [...built.due, ...built.fresh];
  const later = [];                    // 이번 복습 안에 다시 볼 카드(방금 '다시'를 누른 것 등)
  const leftDue = new Set(built.due.map((t) => t.id));       // 아직 끝내지 못한 '오늘 복습'
  const leftFresh = new Set(built.fresh.map((t) => t.id));   // 아직 시작하지 않은 '새 용어'
  let reviewed = 0;
  let current = null;
  let revealed = false;

  const today = kstDate();
  const wd = weekday(today);
  const weeklyHref = wd === 6 || wd === 0 ? '#/quiz/weekly' : `#/quiz/weekly/${addDays(mondayOf(today), -7)}`;
  const weeklyLabel = wd === 6 || wd === 0 ? '이번 주 주간 퀴즈' : '지난주 주간 퀴즈';

  function takeNext() {
    const now = Date.now();
    if (queue.length === 0 && later.length) {
      later.sort((a, b) => new Date(a.card.due) - new Date(b.card.due));
      const ready = later.filter((t) => new Date(t.card.due).getTime() <= now);
      const batch = ready.length ? ready : [...later];     // 기다릴 카드만 남았으면 바로 이어서 본다
      for (const t of batch) later.splice(later.indexOf(t), 1);
      queue.push(...batch);
    }
    current = queue.shift() ?? null;
    revealed = false;
  }

  function effectiveMode(term) {
    if (mode === 'english' && !term.en) return 'term';
    return mode;
  }

  function cardFaces(term) {
    const m = effectiveMode(term);
    if (m === 'meaning') {
      return {
        label: '이 뜻에 해당하는 용어는?',
        front: html`<p class="card-front long">${term.short}</p>${term.formula ? html`<p class="card-sub num">📐 ${term.formula}</p>` : ''}`,
        back: html`<p class="answer">${term.ko}</p>${term.en ? html`<p class="card-sub" lang="en">${term.en}</p>` : ''}
          ${term.example ? html`<p class="hint">예) ${term.example}</p>` : ''}`,
      };
    }
    if (m === 'english') {
      return {
        label: '이 영어 표현의 뜻은?',
        front: html`<p class="card-front" lang="en">${term.en}</p>`,
        back: html`<p class="answer">${term.ko}</p><p>${term.short}</p>
          ${term.formula ? html`<p class="hint num">📐 ${term.formula}</p>` : ''}`,
      };
    }
    return {
      label: '이 용어의 뜻은?',
      front: html`<p class="card-front">${termLabel(term) || term.ko}</p>${term.en ? html`<p class="card-sub" lang="en">${term.en}</p>` : ''}`,
      back: html`<p class="answer">${term.short}</p>
        ${term.formula ? html`<p class="num">📐 ${term.formula}</p>` : ''}
        ${term.example ? html`<p class="hint">예) ${term.example}</p>` : ''}
        ${term.long ? html`<details class="term-more"><summary>더 보기</summary><p>${term.long}</p></details>` : ''}`,
    };
  }

  function header() {
    return html`
      <header class="page-head"><h1>🔁 복습</h1></header>
      <div class="stat-row">
        <div class="stat"><b data-stat="due">${leftDue.size}</b><span>오늘 복습</span></div>
        <div class="stat"><b data-stat="fresh">${leftFresh.size}</b><span>새 용어</span></div>
        <div class="stat"><b>${all.length}</b><span>내 용어장</span></div>
      </div>
      <div class="link-row">
        <a class="btn ghost" href="#/glossary">📚 용어장</a>
        <a class="btn ghost" href="#/curriculum">🗺 진도</a>
        <a class="btn ghost" href="#/quiz/wrong">📝 오답 노트</a>
      </div>`;
  }

  function draw() {
    if (all.length === 0) {
      setHtml(page, html`${header()}
        <section class="empty">
          <div class="empty-emoji" aria-hidden="true">⭐</div>
          <h2>아직 저장한 용어가 없어요</h2>
          <p>강의 본문에서 용어를 누르고 ⭐ 를 누르면 여기서 간격을 두고 복습할 수 있어요.</p>
          <p><a class="btn primary" href="#/today">오늘의 강의로</a></p>
        </section>
        <a class="card link-card" href="${weeklyHref}"><span>🗓 ${weeklyLabel}</span><span aria-hidden="true">›</span></a>`);
      return;
    }
    if (!current) {
      const nextAt = nextDueAt([...all.map((t) => t), ...later], new Date());
      const waiting = built.freshTotal - built.fresh.length;
      setHtml(page, html`${header()}
        <section class="empty">
          <div class="empty-emoji" aria-hidden="true">🎉</div>
          <h2>${reviewed > 0 ? `복습 ${reviewed}개를 마쳤어요` : '지금 복습할 용어가 없어요'}</h2>
          ${nextAt ? html`<p>다음 복습은 ${formatInterval(new Date(), nextAt)} 뒤예요.</p>` : ''}
          ${waiting > 0 ? html`<p>새 용어 ${waiting}개는 내일 시작해요(하루 ${Number(settings.newPerDay) || 0}개까지).</p>` : ''}
          <p><a class="btn primary" href="#/today">오늘의 강의로</a></p>
        </section>
        <a class="card link-card" href="${weeklyHref}"><span>🗓 ${weeklyLabel}</span><span aria-hidden="true">›</span></a>`);
      return;
    }
    const term = current;
    const faces = cardFaces(term);
    const previews = revealed ? previewRatings(scheduler, term.card, new Date()) : null;
    const left = queue.length + later.length + 1;
    setHtml(page, html`${header()}
      <div class="segmented" role="group" aria-label="복습 방식">
        ${MODES.map(([key, label]) => html`<button type="button" class="${mode === key ? 'on' : ''}" data-mode="${key}"
          aria-pressed="${mode === key ? 'true' : 'false'}">${label}</button>`)}
      </div>
      <p class="review-progress">남은 카드 ${left}개 · 완료 ${reviewed}개${term.card.state === State.New ? ' · 새 용어' : ''}</p>
      <section class="card flashcard" aria-live="polite">
        <p class="card-label">${faces.label}</p>
        ${faces.front}
        ${tts.isSupported() && term.en ? html`<p><button type="button" class="icon-btn" data-act="speak" aria-label="영어 발음 듣기">🔊</button></p>` : ''}
        ${revealed ? html`<div class="card-back">${faces.back}</div>` : ''}
      </section>
      ${revealed ? html`
        <div class="rating-row" role="group" aria-label="얼마나 잘 기억났나요?">
          ${[1, 2, 3, 4].map((r) => html`<button type="button" class="rate ${RATE_CLASS[r]}" data-rate="${r}">
            <span>${RATING_LABELS[r]}</span><span class="interval">${previews[r].label}</span></button>`)}
        </div>
        <p class="hint" style="text-align:center">버튼 아래는 다음에 다시 볼 때까지의 간격이에요.</p>`
        : html`<button type="button" class="btn primary block" data-act="reveal">정답 보기</button>`}`);
  }

  async function rate(rating) {
    if (!current || !revealed) return;
    const term = current;
    const now = new Date();
    let result;
    try {
      result = applyRating(scheduler, term.card, rating, now);
    } catch (err) {
      console.error(err);
      toast('복습 일정을 계산하지 못했어요');
      return;
    }
    term.card = result.card;
    await terms.saveCard(term.id, result.card);
    await db.put('reviewLogs', { termId: term.id, rating, state: result.log.state, due: result.log.due, reviewedAt: result.log.reviewedAt });
    leftFresh.delete(term.id);
    if (new Date(result.card.due).getTime() - now.getTime() <= SESSION_WINDOW_MS) {
      later.push(term);                 // 곧 다시 볼 카드: 이번 복습 안에서 한 번 더
    } else {
      reviewed += 1;
      leftDue.delete(term.id);
    }
    document.dispatchEvent(new CustomEvent('ss:review-changed'));
    takeNext();
    draw();
  }

  takeNext();
  draw();

  page.addEventListener('click', async (e) => {
    const modeBtn = e.target.closest('[data-mode]');
    if (modeBtn) {
      mode = modeBtn.dataset.mode;
      revealed = false;
      await db.setSetting('reviewMode', mode);
      draw();
      return;
    }
    const rateBtn = e.target.closest('[data-rate]');
    if (rateBtn) { await rate(Number(rateBtn.dataset.rate)); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'reveal') {
      revealed = true;
      draw();
      page.querySelector('.rating-row')?.scrollIntoView({ block: 'nearest' });
      page.querySelector('[data-rate="3"]')?.focus({ preventScroll: true });
    } else if (act === 'speak' && current) {
      tts.speak(String(current.en).replace(/\s*\(.*?\)\s*/g, ' ').trim() || current.en);
    }
  });

  // 키보드: Space·Enter = 정답 보기, 1~4 = 평가
  const onKey = (e) => {
    if (e.target.closest('input, textarea, select, [role="dialog"], [role="alertdialog"]')) return;
    if (!current) return;
    if (!revealed && (e.key === ' ' || e.key === 'Enter') && !e.target.closest('button, a')) {
      e.preventDefault();
      revealed = true;
      draw();
    } else if (revealed && ['1', '2', '3', '4'].includes(e.key)) {
      e.preventDefault();
      rate(Number(e.key));
    }
  };
  document.addEventListener('keydown', onKey);

  return () => {
    tts.stop();
    document.removeEventListener('keydown', onKey);
  };
}
