// glossary.js — 용어장 화면 (#/glossary)
// 내 용어장(⭐ 저장한 용어): 검색·트랙·정렬·상태 필터, 뜻 수정, 삭제, 직접 추가
// 전체 사전(지금까지 강의에 나온 모든 용어): 찾아보고 ⭐ 저장

import { html, setHtml, toast, debounce, formatDateKo } from './util.js';
import { loadCurriculum, loadGlossary, trackOf } from './lessons.js';
import { termLabel } from './render.js';
import * as terms from './terms.js';
import { cardStatus, formatInterval, STATUS_LABELS, State } from './srs.js';
import { closeSheet, closeSheetAndGo, confirmDialog, openSheet, openTermCard } from './popup.js';

const SORTS = [['recent', '최근 저장순'], ['due', '복습 임박순'], ['alpha', '가나다순']];
const STATUSES = [['all', '모든 상태'], ['new', '새 용어'], ['learning', '학습 중'], ['mature', '익힘']];

function matches(term, q) {
  if (!q) return true;
  const hay = `${term.ko ?? ''} ${term.en ?? ''} ${term.short ?? ''} ${term.id ?? ''}`.toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}

function termForm(term, { isNew }) {
  return html`
    <header class="sheet-head">
      <h2>${isNew ? '용어 직접 추가' : '뜻 수정'}</h2>
      <button type="button" class="icon-btn" data-sheet-close aria-label="닫기">✕</button>
    </header>
    <form class="form" data-role="term-form" novalidate>
      <label class="field"><span>용어 <small>(필수)</small></span>
        <input type="text" name="ko" value="${term.ko ?? ''}" maxlength="60" placeholder="예) 안전마진" data-autofocus autocomplete="off"></label>
      <label class="field"><span>영어 표현 <small>(선택)</small></span>
        <input type="text" name="en" value="${term.en ?? ''}" maxlength="80" placeholder="예) margin of safety" lang="en" autocomplete="off"></label>
      <label class="field"><span>한 줄 뜻 <small>(필수)</small></span>
        <input type="text" name="short" value="${term.short ?? ''}" maxlength="80" placeholder="예) 가치보다 충분히 싸게 사서 남기는 여유" autocomplete="off"></label>
      <label class="field"><span>자세한 설명 <small>(선택)</small></span>
        <textarea name="long" rows="3">${term.long ?? ''}</textarea></label>
      <label class="field"><span>공식 <small>(선택)</small></span>
        <input type="text" name="formula" value="${term.formula ?? ''}" maxlength="120" autocomplete="off"></label>
      <label class="field"><span>예시 <small>(선택)</small></span>
        <input type="text" name="example" value="${term.example ?? ''}" maxlength="160" autocomplete="off"></label>
      <p class="field-error" data-error role="alert"></p>
      <div class="form-actions">
        <button type="button" class="btn ghost" data-sheet-close>취소</button>
        <button type="submit" class="btn primary">저장</button>
      </div>
    </form>`;
}

function readForm(form) {
  const f = form.elements;
  return {
    ko: f.ko.value.trim(), en: f.en.value.trim(), short: f.short.value.trim(),
    long: f.long.value.trim(), formula: f.formula.value.trim(), example: f.example.value.trim(),
  };
}

export async function render(page, params = {}, query = {}) {
  const [curriculum, glossary] = await Promise.all([loadCurriculum(), loadGlossary()]);
  let saved = await terms.listSaved();
  const state = {
    scope: query.scope === 'all' ? 'all' : 'mine',
    q: typeof query.q === 'string' ? query.q : '',
    track: 'all',
    sort: 'recent',
    status: 'all',
  };

  const savedIds = () => new Set(saved.map((t) => t.id));

  function currentList() {
    const q = state.q.trim().toLowerCase();
    const now = new Date();
    let list;
    if (state.scope === 'mine') {
      list = saved.filter((t) => matches(t, q)
        && (state.track === 'all' || t.track === state.track)
        && (state.status === 'all' || cardStatus(t.card) === state.status));
    } else {
      list = [...glossary.values()].filter((t) => matches(t, q) && (state.track === 'all' || t.track === state.track));
    }
    const byAlpha = (a, b) => String(a.ko).localeCompare(String(b.ko), 'ko');
    if (state.sort === 'alpha') list.sort(byAlpha);
    else if (state.sort === 'due' && state.scope === 'mine') {
      const key = (t) => (t.card?.state === State.New ? Number.MAX_SAFE_INTEGER : new Date(t.card?.due ?? now).getTime());
      list.sort((a, b) => key(a) - key(b) || byAlpha(a, b));
    } else if (state.scope === 'mine') {
      list.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
    } else {
      list.sort((a, b) => String(b.first_date ?? '').localeCompare(String(a.first_date ?? '')) || byAlpha(a, b));
    }
    return list;
  }

  function rowHtml(t, ids) {
    const track = t.track ? trackOf(curriculum, t.track) : null;
    if (state.scope === 'mine') {
      const st = cardStatus(t.card);
      const next = t.card && t.card.state !== State.New ? `다음 복습 ${formatInterval(new Date(), t.card.due)}` : '아직 복습 전';
      return html`<li><button type="button" class="row" data-open="${t.id}">
        <div class="row-top"><strong class="row-title">${t.ko}</strong><span class="badge status-${st}">${STATUS_LABELS[st]}</span></div>
        ${t.en ? html`<div class="row-sub" lang="en">${t.en}</div>` : ''}
        <p class="row-text clamp">${t.short}</p>
        <div class="row-foot">${track ? html`<span class="track-chip" style="--track:${track.color}">${track.id}</span>` : ''}
          ${t.custom ? html`<span class="badge">직접 추가</span>` : ''}<span>${next}</span></div>
      </button></li>`;
    }
    return html`<li><button type="button" class="row" data-open="${t.id}">
      <div class="row-top"><strong class="row-title">${t.ko}</strong>${ids.has(t.id) ? html`<span class="badge ok">⭐ 저장됨</span>` : ''}</div>
      ${t.en ? html`<div class="row-sub" lang="en">${t.en}</div>` : ''}
      <p class="row-text clamp">${t.short}</p>
      <div class="row-foot">${track ? html`<span class="track-chip" style="--track:${track.color}">${track.id}</span>` : ''}
        ${t.first_lesson ? html`<span>${t.first_lesson}강에서 처음 등장</span>` : ''}</div>
    </button></li>`;
  }

  function drawList() {
    const list = currentList();
    const ids = savedIds();
    const box = page.querySelector('[data-role="list"]');
    if (list.length === 0) {
      const none = state.scope === 'mine' && saved.length === 0;
      setHtml(box, html`<section class="empty small">
        <div class="empty-emoji" aria-hidden="true">${none ? '⭐' : '🔎'}</div>
        <p>${none ? '아직 저장한 용어가 없어요. 강의에서 용어를 누르고 ⭐ 를 눌러 보세요.' : '조건에 맞는 용어가 없어요.'}</p>
        ${none ? html`<p><button type="button" class="btn ghost" data-act="scope-all">전체 사전 보기</button></p>` : ''}
      </section>`);
    } else {
      setHtml(box, html`<p class="hint">${list.length}개</p><ul class="list">${list.map((t) => rowHtml(t, ids))}</ul>`);
    }
  }

  function draw() {
    setHtml(page, html`
      <nav class="crumb"><a href="#/review" class="back-link">← 복습</a></nav>
      <header class="page-head">
        <h1>📚 용어장</h1>
        <button type="button" class="btn primary" data-act="add">+ 직접 추가</button>
      </header>
      <div class="segmented" role="group" aria-label="보기 범위">
        <button type="button" class="${state.scope === 'mine' ? 'on' : ''}" data-scope="mine" aria-pressed="${state.scope === 'mine' ? 'true' : 'false'}">내 용어장 <span class="num">${saved.length}</span></button>
        <button type="button" class="${state.scope === 'all' ? 'on' : ''}" data-scope="all" aria-pressed="${state.scope === 'all' ? 'true' : 'false'}">전체 사전 <span class="num">${glossary.size}</span></button>
      </div>
      <input type="search" name="q" value="${state.q}" placeholder="용어 · 뜻 · 영어로 검색" aria-label="용어 검색" autocomplete="off">
      <div class="toolbar">
        <select name="track" aria-label="트랙">
          <option value="all">전체 트랙</option>
          ${curriculum.tracks.map((t) => html`<option value="${t.id}" ${state.track === t.id ? 'selected' : ''}>${t.id} ${t.name}</option>`)}
        </select>
        <select name="sort" aria-label="정렬">
          ${SORTS.filter(([k]) => state.scope === 'mine' || k !== 'due').map(([k, label]) => html`<option value="${k}" ${state.sort === k ? 'selected' : ''}>${state.scope === 'all' && k === 'recent' ? '최근 강의순' : label}</option>`)}
        </select>
        ${state.scope === 'mine' ? html`<select name="status" aria-label="상태">
          ${STATUSES.map(([k, label]) => html`<option value="${k}" ${state.status === k ? 'selected' : ''}>${label}</option>`)}
        </select>` : ''}
      </div>
      <div data-role="list"></div>`);
    drawList();
  }

  async function refresh() {
    saved = await terms.listSaved();
  }

  function openSavedDetail(id) {
    const t = saved.find((x) => x.id === id);
    if (!t) return;
    const st = cardStatus(t.card);
    const track = t.track ? trackOf(curriculum, t.track) : null;
    const box = openSheet(html`
      <header class="sheet-head">
        <h2 class="term-title">${t.ko}</h2>
        <button type="button" class="icon-btn" data-sheet-close data-autofocus aria-label="닫기">✕</button>
      </header>
      ${t.en ? html`<p class="term-en" lang="en">${t.en}</p>` : ''}
      <p class="term-short">${t.short}</p>
      ${t.formula ? html`<p class="term-formula"><span aria-hidden="true">📐</span> ${t.formula}</p>` : ''}
      ${t.example ? html`<p class="term-example">예) ${t.example}</p>` : ''}
      ${t.long ? html`<p>${t.long}</p>` : ''}
      <dl class="kv">
        <dt>상태</dt><dd><span class="badge status-${st}">${STATUS_LABELS[st]}</span></dd>
        <dt>다음 복습</dt><dd>${t.card && t.card.state !== State.New ? `${formatInterval(new Date(), t.card.due)} 뒤` : '아직 복습 전'}</dd>
        <dt>복습 횟수</dt><dd class="num">${t.card?.reps ?? 0}회 (잊음 ${t.card?.lapses ?? 0}회)</dd>
        ${track ? html`<dt>트랙</dt><dd>${track.id} ${track.name}</dd>` : ''}
        ${t.createdAt ? html`<dt>저장한 날</dt><dd>${formatDateKo(String(t.createdAt).slice(0, 10), { year: true, withWeekday: false })}</dd>` : ''}
      </dl>
      <div class="form-actions">
        ${t.firstDate ? html`<button type="button" class="btn ghost" data-act="goto">처음 나온 강의</button>` : ''}
        <button type="button" class="btn ghost" data-act="edit">뜻 수정</button>
        <button type="button" class="btn danger ghost" data-act="delete">삭제</button>
      </div>`, { label: `${t.ko} 자세히 보기` });

    box.onclick = async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'goto') closeSheetAndGo(`#/lesson/${t.firstDate}`);
      else if (act === 'edit') openEdit(t);
      else if (act === 'delete') {
        const ok = await confirmDialog({
          title: `'${termLabel(t) || t.ko}'을(를) 삭제할까요?`,
          message: '용어장에서 빠지고 복습 일정도 사라집니다.',
          confirmText: '삭제',
          danger: true,
        });
        if (!ok) return;
        await terms.removeTerm(t.id);
        document.dispatchEvent(new CustomEvent('ss:terms-changed'));
        closeSheet();
        await refresh();
        draw();
        toast('삭제했어요');
      }
    };
    box.onsubmit = null;
  }

  function openEdit(t) {
    const box = openSheet(termForm(t, { isNew: false }), { label: '뜻 수정' });
    box.onclick = null;
    box.onsubmit = async (e) => {
      e.preventDefault();
      const values = readForm(e.target);
      if (!values.ko || !values.short) {
        box.querySelector('[data-error]').textContent = '용어와 한 줄 뜻은 꼭 적어 주세요.';
        return;
      }
      await terms.updateTerm(t.id, values);
      document.dispatchEvent(new CustomEvent('ss:terms-changed'));
      closeSheet();
      await refresh();
      draw();
      toast('고쳤어요');
    };
  }

  function openAdd() {
    const box = openSheet(termForm({}, { isNew: true }), { label: '용어 직접 추가' });
    box.onclick = null;
    box.onsubmit = async (e) => {
      e.preventDefault();
      const values = readForm(e.target);
      if (!values.ko || !values.short) {
        box.querySelector('[data-error]').textContent = '용어와 한 줄 뜻은 꼭 적어 주세요.';
        return;
      }
      const lower = values.ko.toLowerCase();
      if (saved.some((x) => String(x.ko).toLowerCase() === lower)) {
        box.querySelector('[data-error]').textContent = '같은 이름의 용어가 이미 용어장에 있어요.';
        return;
      }
      await terms.addCustomTerm({ ...values, track: state.track === 'all' ? null : state.track });
      document.dispatchEvent(new CustomEvent('ss:terms-changed'));
      closeSheet();
      state.scope = 'mine';
      await refresh();
      draw();
      toast('용어장에 추가했어요');
    };
  }

  draw();

  page.addEventListener('click', (e) => {
    const scopeBtn = e.target.closest('[data-scope]');
    if (scopeBtn) {
      state.scope = scopeBtn.dataset.scope;
      if (state.scope === 'all' && state.sort === 'due') state.sort = 'recent';
      draw();
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'add') { openAdd(); return; }
    if (act === 'scope-all') { state.scope = 'all'; draw(); return; }
    const open = e.target.closest('[data-open]');
    if (open) {
      if (state.scope === 'mine') openSavedDetail(open.dataset.open);
      else openTermCard(open.dataset.open);
    }
  });
  page.addEventListener('change', (e) => {
    if (e.target.name === 'track' || e.target.name === 'sort' || e.target.name === 'status') {
      state[e.target.name] = e.target.value;
      drawList();
    }
  });
  page.addEventListener('input', debounce((e) => {
    if (e.target.name !== 'q') return;
    state.q = e.target.value;
    drawList();
  }, 150));

  // 다른 곳(용어 카드)에서 저장·삭제하면 목록을 맞춘다.
  const onChanged = async () => { await refresh(); if (page.isConnected) drawList(); };
  document.addEventListener('ss:terms-changed', onChanged);
  return () => document.removeEventListener('ss:terms-changed', onChanged);
}
