// archive.js — 지난 강의 (#/archive)
// 날짜(월)·트랙별로 걸러서 다시 본다.

import { html, setHtml, formatDateKo } from './util.js';
import * as db from './db.js';
import { cachedLessonDates, loadCurriculum, loadIndex, trackOf } from './lessons.js';
import * as progress from './progress.js';

export async function render(page, params = {}, query = {}) {
  const [index, curriculum, progressMap, cached, quizRows] = await Promise.all([
    loadIndex(), loadCurriculum(), progress.getProgressMap(), cachedLessonDates(), db.getAll('quizResults'),
  ]);
  const months = [...new Set(index.items.map((it) => it.date.slice(0, 7)))];
  const state = {
    track: curriculum.tracks.some((t) => t.id === query.track) ? query.track : 'all',
    month: months.includes(query.month) ? query.month : 'all',
  };

  const quizByDate = new Map();
  for (const r of quizRows) {
    if (!r || typeof r.date !== 'string' || r.type === 'weekly') continue;
    const slot = quizByDate.get(r.date) ?? { answered: 0, correct: 0 };
    slot.answered += 1;
    if (r.correct) slot.correct += 1;
    quizByDate.set(r.date, slot);
  }

  function drawList() {
    const list = index.items.filter((it) => (state.track === 'all' || it.track === state.track)
      && (state.month === 'all' || it.date.startsWith(state.month)));
    const box = page.querySelector('[data-role="list"]');
    if (list.length === 0) {
      setHtml(box, html`<section class="empty small"><div class="empty-emoji" aria-hidden="true">🗂</div>
        <p>${index.items.length === 0 ? '아직 올라온 강의가 없어요.' : '조건에 맞는 강의가 없어요.'}</p></section>`);
      return;
    }
    setHtml(box, html`<p class="hint">${list.length}개${index.offline ? ' · 오프라인(💾 표시가 있는 강의만 열 수 있어요)' : ''}</p>
      <ul class="list">${list.map((it) => {
        const track = trackOf(curriculum, it.track);
        const rec = it.sample ? null : progressMap.get(it.lesson_no);
        const quiz = quizByDate.get(it.date);
        const status = it.sample ? '샘플'
          : progress.isComplete(rec) && rec.date === it.date ? '✓ 완료'
          : quiz ? `퀴즈 ${quiz.correct}/${quiz.answered}` : '읽지 않음';
        return html`<li><a class="row" href="#/lesson/${it.date}">
          <div class="row-top">
            <span class="track-chip" style="--track:${track.color}">${track.id}</span>
            <strong class="row-title">${it.title}</strong>
          </div>
          <div class="row-foot">
            <span>${formatDateKo(it.date, { year: true })}</span><span>· ${it.lesson_no}강</span>
            <span class="${status.startsWith('✓') ? 'state done' : ''}">· ${status}</span>
            ${cached.has(it.date) ? html`<span title="기기에 저장됨">💾</span>` : ''}
          </div>
        </a></li>`;
      })}</ul>`);
  }

  setHtml(page, html`
    <nav class="crumb"><a href="#/today" class="back-link">← 오늘</a></nav>
    <h1>🗂 지난 강의</h1>
    <div class="toolbar">
      <select name="month" aria-label="달">
        <option value="all">전체 기간</option>
        ${months.map((m) => html`<option value="${m}" ${state.month === m ? 'selected' : ''}>${m.slice(0, 4)}년 ${Number(m.slice(5, 7))}월</option>`)}
      </select>
      <select name="track" aria-label="트랙">
        <option value="all">전체 트랙</option>
        ${curriculum.tracks.map((t) => html`<option value="${t.id}" ${state.track === t.id ? 'selected' : ''}>${t.id} ${t.name}</option>`)}
      </select>
    </div>
    <div data-role="list"></div>`);
  drawList();

  page.addEventListener('change', (e) => {
    if (e.target.name === 'month' || e.target.name === 'track') {
      state[e.target.name] = e.target.value;
      drawList();
    }
  });
}
