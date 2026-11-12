// curriculum.js — 진도 화면 (#/curriculum)
// 트랙 8개의 진행률과 강의 목록(완료 ✓ / 올라옴 / 예정)을 보여 준다.

import { html, setHtml, kstDate } from './util.js';
import { loadCurriculum, loadIndex } from './lessons.js';
import * as progress from './progress.js';

export async function render(page) {
  const [curriculum, index, progressMap, streak] = await Promise.all([
    loadCurriculum(), loadIndex(), progress.getProgressMap(), progress.getStreak(kstDate()),
  ]);
  const total = curriculum.lessons.length;
  if (total === 0) {
    setHtml(page, html`<section class="empty"><h1>커리큘럼을 불러오지 못했어요</h1>
      <p>인터넷 연결을 확인한 뒤 다시 열어 주세요.</p><p><a class="btn primary" href="#/today">오늘의 강의로</a></p></section>`);
    return;
  }

  // 강의 번호 → 올라온 날짜(1회차 기준, 샘플은 따로)
  const published = new Map();
  const samples = new Map();
  for (const it of [...index.items].reverse()) {
    if (it.sample) { if (!samples.has(it.lesson_no)) samples.set(it.lesson_no, it.date); }
    else if (it.lesson_no <= total && !published.has(it.lesson_no)) published.set(it.lesson_no, it.date);
  }

  const percent = progress.overallPercent(progressMap, total);
  const doneCount = curriculum.lessons.filter((l) => progress.isComplete(progressMap.get(l.no))).length;
  const perTrack = progress.trackProgress(curriculum, progressMap);
  const nextLesson = curriculum.lessons.find((l) => !progress.isComplete(progressMap.get(l.no)));
  const openTrack = nextLesson?.track ?? curriculum.tracks[0]?.id;
  const remaining = total - doneCount;

  setHtml(page, html`
    <nav class="crumb"><a href="#/today" class="back-link">← 오늘</a></nav>
    <h1>🗺 진도</h1>
    <section class="card">
      <div class="overall">
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-label="전체 진도">
          <span style="width:${percent}%"></span></div>
        <span class="overall-text">${percent}%</span>
      </div>
      <p><strong class="num">${doneCount} / ${total}강</strong> 완료${streak > 0 ? html` · 🔥 연속 ${streak}일` : ''}</p>
      <p class="hint">${remaining > 0
        ? `평일마다 1강씩 들으면 약 ${Math.ceil(remaining / 5)}주 뒤에 끝나요. 강의는 끝까지 읽고 퀴즈를 풀면 완료로 기록됩니다.`
        : '1회차를 모두 마쳤어요! 2회차는 같은 주제를 실제 기업 사례로 깊게 다룹니다.'}</p>
    </section>
    ${curriculum.tracks.map((t) => {
      const p = perTrack.get(t.id) ?? { done: 0, total: 0 };
      const w = p.total ? Math.round((p.done / p.total) * 100) : 0;
      const lessons = curriculum.lessons.filter((l) => l.track === t.id);
      return html`<details class="card track-card" style="--track:${t.color}" ${t.id === openTrack ? 'open' : ''}>
        <summary>
          <span class="track-name"><i class="track-dot" aria-hidden="true"></i>${t.id} ${t.name}</span>
          <span class="track-count">${p.done} / ${p.total}</span>
          <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${w}" aria-label="${t.name} 진행률"><span style="width:${w}%"></span></div>
        </summary>
        <ul class="lesson-list">
          ${lessons.map((l) => {
            const rec = progressMap.get(l.no);
            const date = published.get(l.no);
            const sampleDate = samples.get(l.no);
            const done = progress.isComplete(rec);
            const body = html`<span class="no">${l.no}</span>
              <span><strong>${l.title}</strong><br><span class="goal">${l.goal}</span></span>`;
            if (date) {
              return html`<li class="${done ? 'done' : 'open'}"><a class="item" href="#/lesson/${date}">${body}
                <span class="mark">${done ? '✓ 완료' : rec?.readAt ? '퀴즈 남음' : rec?.quizDoneAt ? '읽기 남음' : '읽지 않음'}</span></a></li>`;
            }
            if (sampleDate) {
              return html`<li class="todo"><a class="item" href="#/lesson/${sampleDate}">${body}<span class="mark">샘플 보기</span></a></li>`;
            }
            return html`<li class="todo"><div class="item">${body}<span class="mark">예정</span></div></li>`;
          })}
        </ul>
      </details>`;
    })}
    <p class="disclaimer">강의 순서와 제목은 조금씩 조정될 수 있어요.</p>`);
}
