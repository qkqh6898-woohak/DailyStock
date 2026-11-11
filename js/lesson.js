// lesson.js — 오늘의 강의 화면 (#/today) / 지난 강의 다시 보기 (#/lesson/:date)

import {
  html, raw, setHtml, kstDate, formatDateKo, weekday, mondayOf, toast, diffDays, kstDateOf,
} from './util.js';
import * as db from './db.js';
import {
  loadLesson, loadGlossary, loadCurriculum, loadIndex, resolveToday, neighbors, curriculumEntry, trackOf, weekItems,
} from './lessons.js';
import { makeContext, renderInline, toSpeechText, splitSentences, termLabel, toPlainText } from './render.js';
import { openTermCard, openFactCard } from './popup.js';
import * as tts from './tts.js';
import * as progress from './progress.js';
import * as terms from './terms.js';
import { countDueJournal } from './journal.js';
import { canInstall, dismiss as dismissInstall, isDismissed as installDismissed, isStandalone, promptInstall } from './install.js';

export const DISCLAIMER = '교육용 정보이며 투자 권유가 아닙니다.';
const BACKUP_REMIND_DAYS = 14;
const READ_MIN_MS = 4000;

function safeHttps(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

/** 읽는 데 걸리는 시간(분) — 한글 약 220자를 1분으로 본다. */
function readingMinutes(lesson, ctx) {
  const parts = [...lesson.body, ...(lesson.news_case?.explain ?? [])];
  const chars = parts.reduce((n, p) => n + [...toPlainText(p, ctx)].length, 0);
  return Math.max(2, Math.round(chars / 220));
}

async function backupNotice(today) {
  const settings = await db.getSettings();
  const [termCount, journalCount] = await Promise.all([db.count('terms'), db.count('journal')]);
  if (termCount + journalCount === 0) return null;
  const base = settings.lastBackupAt ?? settings.firstUseAt;
  if (!base) return null;
  const baseDay = kstDateOf(base);
  if (!baseDay) return null;
  const days = diffDays(baseDay, today);
  if (days <= BACKUP_REMIND_DAYS) return null;
  return settings.lastBackupAt ? `마지막 백업 후 ${days}일이 지났어요.` : '아직 백업한 적이 없어요.';
}

function emptyState(index) {
  return html`
    <section class="empty">
      <div class="empty-emoji" aria-hidden="true">📘</div>
      <h1>아직 강의가 없어요</h1>
      <p>${index?.error
        ? '강의 목록을 불러오지 못했어요. 인터넷 연결을 확인한 뒤 다시 열어 주세요.'
        : '첫 강의는 평일 저녁 8시경 올라옵니다.'}</p>
      <p><a class="btn primary" href="#/curriculum">커리큘럼 보기</a></p>
      <p class="disclaimer">${DISCLAIMER}</p>
    </section>`;
}

/**
 * @param {HTMLElement} page
 * @param {{ date?: string }} params
 */
export async function render(page, params = {}) {
  const today = kstDate();
  const isArchive = Boolean(params.date);
  let item;
  let kind;
  let index;

  if (isArchive) {
    index = await loadIndex();
    item = index.items.find((i) => i.date === params.date) ?? { date: params.date, sample: false };
    kind = 'archive';
  } else {
    ({ item, kind, index } = await resolveToday(today));
  }
  if (!item) {
    setHtml(page, emptyState(index));
    return undefined;
  }

  // 강의 파일이 깨졌으면 그보다 이전 강의를 찾아 보여 준다.
  let lesson = await loadLesson(item.date);
  let fallbackFrom = null;
  if (!lesson && !isArchive) {
    const older = index.items.filter((i) => i.date < item.date);
    for (const cand of older) {
      const l = await loadLesson(cand.date);
      if (l) { fallbackFrom = item; item = cand; lesson = l; break; }
    }
  }
  if (!lesson) {
    setHtml(page, html`
      <section class="empty">
        <div class="empty-emoji" aria-hidden="true">⚠️</div>
        <h1>강의를 불러오지 못했어요</h1>
        <p>${formatDateKo(item.date, { year: true })} 강의 파일을 읽을 수 없습니다. 인터넷 연결을 확인하거나 잠시 뒤 다시 시도해 주세요.</p>
        <p><a class="btn primary" href="#/archive">지난 강의 보기</a></p>
      </section>`);
    return undefined;
  }

  const [glossary, curriculum, progressMap, streak, savedList, dueJournal, backupMsg] = await Promise.all([
    loadGlossary(), loadCurriculum(), progress.getProgressMap(), progress.getStreak(today),
    terms.listSaved(), countDueJournal(today), backupNotice(today),
  ]);
  const savedIds = new Set(savedList.map((t) => t.id));
  const ctx = makeContext(lesson, (id) => glossary.get(id));
  const cur = curriculumEntry(curriculum, lesson.lesson_no);
  const track = trackOf(curriculum, lesson.track);
  const total = cur?.total ?? curriculum.lessons.length;
  const percent = progress.overallPercent(progressMap, total);
  const isSample = lesson.sample === true;
  let rec = progressMap.get(lesson.lesson_no) ?? null;
  if (isSample) rec = null;

  const quizResults = await Promise.all(lesson.quiz.map((_, i) => db.get('quizResults', `${lesson.date}#${i}`)));
  const answered = quizResults.filter(Boolean).length;
  const correct = quizResults.filter((r) => r && r.correct).length;

  const { prev, next } = neighbors(index.items, lesson.date);
  const wd = weekday(today);
  const monday = mondayOf(today);
  const weekHasLessons = weekItems(index.items, monday).length > 0;
  const showWeekly = !isArchive && (wd === 6 || wd === 0) && weekHasLessons;

  const notices = [];
  if (db.memoryOnly) notices.push({ tone: 'warn', text: '이 브라우저에서는 저장 기능을 쓸 수 없어요. 용어·일지가 창을 닫으면 사라집니다(사생활 보호 모드라면 일반 창에서 열어 주세요).' });
  if (index.offline) notices.push({ tone: 'info', text: '오프라인 상태예요. 기기에 저장된 내용을 보여 드려요.' });
  if (fallbackFrom) notices.push({ tone: 'warn', text: `${formatDateKo(fallbackFrom.date)} 강의 파일에 문제가 있어 이전 강의를 보여 드려요.` });
  if (kind === 'latest' && !fallbackFrom) {
    notices.push({
      tone: 'info',
      text: wd === 6 || wd === 0
        ? '주말에는 새 강의가 없어요. 아래는 가장 최근 강의예요.'
        : '오늘 강의는 아직 올라오지 않았어요. 다음 강의는 평일 저녁 8시경 올라옵니다. 아래는 가장 최근 강의예요.',
    });
  }
  if (isSample) {
    notices.push({
      tone: 'sample',
      text: kind === 'sample'
        ? '맛보기(샘플) 강의예요. 정식 강의는 평일 저녁 8시경 1강부터 차례로 올라옵니다. 샘플은 진도에 포함되지 않아요.'
        : '맛보기(샘플) 강의예요. 진도에 포함되지 않아요.',
    });
  }

  const paragraphs = lesson.body.map((p) => html`<p>${raw(renderInline(p, ctx))}</p>`);
  const sources = (lesson.news_case.sources ?? [])
    .map((s) => ({ name: s?.name ?? '출처', url: safeHttps(s?.url) }))
    .filter((s) => s.url);
  const formulaTerms = (lesson.formula?.terms ?? []).map((id) => ({ id, term: ctx.lookupTerm(id) })).filter((x) => x.term);
  const roundLabel = cur && cur.round > 1 ? `${cur.round}회차 ` : '';

  setHtml(page, html`
    <div class="lesson" data-date="${lesson.date}">
      ${isArchive
        ? html`<nav class="crumb"><a href="#/archive" class="back-link">← 지난 강의</a><span>${formatDateKo(lesson.date, { year: true })}</span></nav>`
        : html`<header class="today-head">
            <div class="today-date">${formatDateKo(today)}</div>
            ${streak > 0 ? html`<div class="streak" title="연속 학습일">🔥 연속 ${streak}일</div>` : html`<div class="streak muted">오늘도 한 강</div>`}
          </header>`}

      ${notices.map((n) => html`<p class="notice ${n.tone}">${n.text}</p>`)}

      <div class="lesson-meta">
        <span class="track-chip" style="--track:${track.color}">${track.id} ${track.name}</span>
        <span class="meta-text">${roundLabel}${cur ? cur.base : lesson.lesson_no}/${total}강 · 약 ${readingMinutes(lesson, ctx)}분</span>
        ${isSample ? html`<span class="badge sample">샘플</span>` : ''}
        ${!isArchive && kind !== 'today' ? html`<span class="meta-text">· ${formatDateKo(lesson.date)}</span>` : ''}
      </div>
      <h1 class="lesson-title">${lesson.title}</h1>

      <div class="overall">
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-label="전체 진도">
          <span style="width:${percent}%"></span>
        </div>
        <span class="overall-text">전체 진도 ${percent}%</span>
      </div>

      <section class="card summary" aria-labelledby="h-summary">
        <h2 id="h-summary">📌 3줄 요약</h2>
        <ol>${lesson.summary.map((s) => html`<li>${raw(renderInline(s, ctx))}</li>`)}</ol>
      </section>

      ${tts.isSupported() ? html`<button type="button" class="btn ghost listen" data-act="listen" aria-pressed="false">🔊 본문 듣기</button>` : ''}

      <article class="lesson-body">${paragraphs}</article>

      ${lesson.formula?.text ? html`
        <section class="card formula-box" aria-labelledby="h-formula">
          <h2 id="h-formula">📐 공식</h2>
          <p class="formula num">${lesson.formula.text}</p>
          ${formulaTerms.length ? html`<div class="chips">${formulaTerms.map((x) => html`<button type="button" class="chip" data-term-chip="${x.id}">${termLabel(x.term)}</button>`)}</div>` : ''}
        </section>` : ''}

      <section class="card news" aria-labelledby="h-news">
        <h2 id="h-news">${lesson.news_case.kind === 'review' ? '🔁 복습 사례로 보기' : '📰 오늘 뉴스로 보기'}</h2>
        <h3 class="news-headline">${raw(renderInline(lesson.news_case.headline, ctx))}</h3>
        ${(lesson.news_case.explain ?? []).map((p) => html`<p>${raw(renderInline(p, ctx))}</p>`)}
        ${sources.length ? html`
          <div class="sources">
            <span class="label">출처</span>
            <ul>${sources.map((s) => html`<li><a href="${s.url}" target="_blank" rel="noopener noreferrer">${s.name} ↗</a></li>`)}</ul>
          </div>` : ''}
      </section>

      ${lesson.english?.length ? html`
        <section class="card english" aria-labelledby="h-english">
          <h2 id="h-english">🇺🇸 영어로 말하면</h2>
          <ul>${lesson.english.map((e, i) => html`
            <li>
              <div class="en-row">
                <p class="en" lang="en">${e.en}</p>
                ${tts.isSupported() ? html`<button type="button" class="icon-btn" data-speak-en="${i}" aria-label="영어 문장 듣기">🔊</button>` : ''}
              </div>
              <p class="ko">${e.ko}</p>
            </li>`)}</ul>
        </section>` : ''}

      ${lesson.terms.length ? html`
        <section class="card" aria-labelledby="h-terms">
          <h2 id="h-terms">📚 오늘의 용어</h2>
          <div class="chips" data-role="term-chips">
            ${lesson.terms.map((t) => html`<button type="button" class="chip ${savedIds.has(t.id) ? 'saved' : ''}" data-term-chip="${t.id}">
              <span class="star" aria-hidden="true">${savedIds.has(t.id) ? '⭐' : '☆'}</span>${termLabel(t)}</button>`)}
          </div>
          <p class="hint">용어를 누르면 뜻·공식·영어 표현이 나와요. ⭐ 를 누르면 복습에 추가됩니다.</p>
        </section>` : ''}

      <div id="lesson-end" aria-hidden="true"></div>

      <section class="card quiz-entry" aria-labelledby="h-quiz">
        <div>
          <h2 id="h-quiz">📝 퀴즈 <span class="count num">(${answered}/${lesson.quiz.length})</span></h2>
          <p class="hint">${answered === lesson.quiz.length ? `${lesson.quiz.length}문제 중 ${correct}문제를 맞혔어요.` : '개념 · 계산 · 사례 각 1문제'}</p>
        </div>
        <a class="btn primary" href="#/quiz/${lesson.date}">${answered === lesson.quiz.length ? '다시 풀기' : '풀기'}</a>
      </section>

      ${isSample ? '' : html`
        <p class="done-line" data-role="done-line">
          <span class="${rec?.readAt ? 'ok' : ''}" data-step="read">${rec?.readAt ? '✅' : '⬜'} 끝까지 읽기</span>
          <span class="${rec?.quizDoneAt ? 'ok' : ''}" data-step="quiz">${rec?.quizDoneAt ? '✅' : '⬜'} 퀴즈 풀기</span>
          <strong data-step="done" ${progress.isComplete(rec) ? '' : raw('hidden')}>강의 완료!</strong>
        </p>`}

      ${showWeekly ? html`
        <a class="card link-card" href="#/quiz/weekly">
          <span>🗓 이번 주 주간 퀴즈가 열렸어요</span><span aria-hidden="true">›</span>
        </a>` : ''}

      ${dueJournal > 0 ? html`
        <a class="card link-card attention" href="#/journal?f=due">
          <span>🔔 회고할 일지 ${dueJournal}개</span><span aria-hidden="true">›</span>
        </a>` : ''}

      ${backupMsg ? html`
        <a class="card link-card" href="#/settings?s=data">
          <span>💾 ${backupMsg} 백업해 두세요</span><span aria-hidden="true">›</span>
        </a>` : ''}

      ${!isArchive && canInstall() && !isStandalone() && !installDismissed() ? html`
        <div class="card link-card" data-role="install-card">
          <span>📲 홈 화면에 설치하면 앱처럼 쓸 수 있어요</span>
          <span class="inline-actions">
            <button type="button" class="btn primary small" data-act="install">설치</button>
            <button type="button" class="icon-btn" data-act="install-dismiss" aria-label="설치 안내 닫기">✕</button>
          </span>
        </div>` : ''}

      <nav class="lesson-nav" aria-label="강의 이동">
        ${prev ? html`<a class="btn ghost" href="#/lesson/${prev.date}">◀ 이전</a>` : html`<span class="btn ghost disabled" aria-disabled="true">◀ 이전</span>`}
        <a class="btn ghost" href="#/curriculum">진도</a>
        <a class="btn ghost" href="#/archive">지난 강의</a>
        ${next ? html`<a class="btn ghost" href="#/lesson/${next.date}">다음 ▶</a>` : html`<span class="btn ghost disabled" aria-disabled="true">다음 ▶</span>`}
      </nav>

      <p class="disclaimer">${DISCLAIMER}</p>
    </div>`);

  /* ── 누르기 ── */
  let listening = false;
  const listenBtn = page.querySelector('[data-act="listen"]');
  const setListening = (on) => {
    listening = on;
    if (!listenBtn) return;
    listenBtn.textContent = on ? '⏹ 듣기 멈추기' : '🔊 본문 듣기';
    listenBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  };

  page.addEventListener('click', async (e) => {
    const termBtn = e.target.closest('.term[data-term]');
    if (termBtn) { openTermCard(termBtn.dataset.term, { lesson }); return; }
    const chip = e.target.closest('[data-term-chip]');
    if (chip) { openTermCard(chip.dataset.termChip, { lesson }); return; }
    const info = e.target.closest('.fact-info[data-fact]');
    if (info) { openFactCard(ctx.facts.get(Number(info.dataset.fact)), lesson); return; }
    if (e.target.closest('[data-act="install"]')) {
      const outcome = await promptInstall();
      if (outcome === 'accepted') toast('홈 화면에 설치했어요');
      page.querySelector('[data-role="install-card"]')?.remove();
      return;
    }
    if (e.target.closest('[data-act="install-dismiss"]')) {
      dismissInstall();
      page.querySelector('[data-role="install-card"]')?.remove();
      return;
    }
    const speakEn = e.target.closest('[data-speak-en]');
    if (speakEn) {
      setListening(false);
      tts.speak(lesson.english[Number(speakEn.dataset.speakEn)].en);
      return;
    }
    if (e.target.closest('[data-act="listen"]')) {
      if (listening) { tts.stop(); setListening(false); return; }
      const texts = [
        lesson.title,
        ...lesson.body.map((p) => toSpeechText(p, ctx)),
        '오늘 뉴스로 보기.',
        toSpeechText(lesson.news_case.headline, ctx),
        ...(lesson.news_case.explain ?? []).map((p) => toSpeechText(p, ctx)),
      ];
      const sentences = texts.flatMap((t) => splitSentences(t));
      const started = await tts.speakAll(sentences, { lang: 'ko-KR', onEnd: () => setListening(false) });
      if (started) setListening(true);
      else toast('이 기기에서는 듣기를 쓸 수 없어요');
    }
  });

  /* ── 용어를 저장·삭제하면 ⭐ 표시를 맞춘다 ── */
  const onTermsChanged = async () => {
    const ids = new Set((await terms.listSaved()).map((t) => t.id));
    for (const chip of page.querySelectorAll('[data-role="term-chips"] [data-term-chip]')) {
      const on = ids.has(chip.dataset.termChip);
      chip.classList.toggle('saved', on);
      const star = chip.querySelector('.star');
      if (star) star.textContent = on ? '⭐' : '☆';
    }
  };
  document.addEventListener('ss:terms-changed', onTermsChanged);

  /* ── 끝까지 읽으면 기록한다 ── */
  let observer = null;
  let readTimer = null;
  const startedAt = Date.now();
  const end = page.querySelector('#lesson-end');
  const recordRead = async () => {
    const r = await progress.markRead(lesson);
    if (!r.changed) return;
    const line = page.querySelector('[data-role="done-line"]');
    if (line) {
      const step = line.querySelector('[data-step="read"]');
      step.textContent = '✅ 끝까지 읽기';
      step.classList.add('ok');
      if (r.completedNow) line.querySelector('[data-step="done"]').hidden = false;
    }
    if (r.completedNow) toast('오늘 강의 완료! 🔥');
    document.dispatchEvent(new CustomEvent('ss:progress-changed'));
  };
  if (!isSample && !rec?.readAt && end && 'IntersectionObserver' in window) {
    observer = new IntersectionObserver((entries) => {
      if (!entries.some((en) => en.isIntersecting)) { clearTimeout(readTimer); readTimer = null; return; }
      if (readTimer) return;
      const wait = Math.max(0, READ_MIN_MS - (Date.now() - startedAt));
      readTimer = setTimeout(() => { observer?.disconnect(); recordRead(); }, wait);
    }, { threshold: 0 });
    observer.observe(end);
  }

  return () => {
    tts.stop();
    clearTimeout(readTimer);
    observer?.disconnect();
    observer = null;
    document.removeEventListener('ss:terms-changed', onTermsChanged);
  };
}
