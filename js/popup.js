// popup.js — 바텀시트(용어 카드·숫자 출처 카드)와 확인 창
//
// 시트가 열려 있을 때 뒤로 가기(안드로이드 뒤로 버튼)를 누르면 화면이 넘어가지 않고 시트만 닫힌다.

import { html, setHtml, formatDateKo, formatExact, formatFact, toast } from './util.js';
import { termLabel } from './render.js';
import * as terms from './terms.js';
import * as tts from './tts.js';
import { cardStatus, formatInterval, STATUS_LABELS } from './srs.js';

let sheetOpen = false;
let sheetHistory = false;     // 시트를 열며 history 에 한 칸을 넣었는지
let backPending = false;      // 시트를 닫으며 부른 history.back() 이 아직 끝나지 않았는지
let pushAfterBack = false;    // back 이 끝난 뒤 새 시트를 위해 한 칸을 다시 넣어야 하는지
let queuedHash = null;        // back 이 끝나기 전에 누른 링크(끝난 뒤 이동한다)
let backTimer = null;
let openFrame = 0;            // 여는 애니메이션 예약(닫으면 취소한다)
let sheetOnClose = null;
let sheetLastFocus = null;
let modalResolve = null;
let modalLastFocus = null;
let wired = false;

const sheetRoot = () => document.getElementById('sheet-root');
const modalRoot = () => document.getElementById('modal-root');

function focusables(container) {
  return [...container.querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.offsetParent !== null);
}

function wire() {
  if (wired) return;
  wired = true;
  document.addEventListener('keydown', (e) => {
    const modalBox = modalResolve ? modalRoot().querySelector('.modal') : null;
    const sheetBox = !modalBox && sheetOpen ? sheetRoot().querySelector('.sheet') : null;
    const box = modalBox ?? sheetBox;
    if (!box) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (modalBox) closeModal(false);
      else closeSheet();
      return;
    }
    if (e.key === 'Tab') {
      const list = focusables(box);
      if (!list.length) { e.preventDefault(); return; }
      const first = list[0];
      const last = list[list.length - 1];
      if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  window.addEventListener('popstate', () => {
    if (backPending) { finishBack(); return; }
    if (sheetHistory) {
      sheetHistory = false;
      hideSheet();
    }
  });
  // 시트를 닫은 직후(뒤로 가기 처리 중)에 누른 링크는 처리가 끝난 뒤에 이동한다.
  // 그러지 않으면 늦게 도착한 '뒤로 가기'가 방금 연 화면을 다시 닫아 버린다.
  document.addEventListener('click', (e) => {
    if (!backPending) return;
    const link = e.target.closest('a[href^="#"]');
    if (!link) return;
    e.preventDefault();
    queuedHash = link.getAttribute('href');
  }, true);
  sheetRoot().addEventListener('click', (e) => {
    if (e.target.closest('[data-sheet-close]')) closeSheet();
  });
}

/* ───────────────────────── 바텀시트 ───────────────────────── */

/**
 * 바텀시트를 연다. 이미 열려 있으면 내용만 바꾼다.
 * @param {import('./util.js').SafeHtml} content
 * @param {{ label?: string, onClose?: Function }} [opts]
 * @returns {HTMLElement} 내용이 들어간 요소(.sheet-content)
 */
export function openSheet(content, { label = '자세히 보기', onClose } = {}) {
  wire();
  const root = sheetRoot();
  if (!sheetOpen) {
    sheetLastFocus = document.activeElement;
    setHtml(root, html`
      <div class="sheet-backdrop" data-sheet-close></div>
      <section class="sheet" role="dialog" aria-modal="true" aria-label="${label}">
        <div class="sheet-grip" aria-hidden="true"></div>
        <div class="sheet-content"></div>
      </section>`);
    sheetOpen = true;
    document.documentElement.classList.add('no-scroll');
    cancelAnimationFrame(openFrame);
    openFrame = requestAnimationFrame(() => {
      openFrame = 0;
      if (sheetOpen) root.classList.add('open');   // 그 사이에 닫혔으면 열지 않는다(보이지 않는 막이 남는 것 방지)
    });
    if (!sheetHistory) {
      if (backPending) pushAfterBack = true;     // 앞 시트의 '뒤로'가 끝난 뒤에 넣는다
      else pushSheetState();
    }
  } else {
    root.querySelector('.sheet').setAttribute('aria-label', label);
  }
  sheetOnClose = onClose ?? null;
  const box = root.querySelector('.sheet-content');
  setHtml(box, content);
  box.scrollTop = 0;
  const target = box.querySelector('[data-autofocus]') ?? box.querySelector('button, a[href]');
  if (target) target.focus({ preventScroll: true });
  return box;
}

function pushSheetState() {
  try {
    history.pushState({ ssSheet: true }, '');
    sheetHistory = true;
  } catch { /* 일부 환경에서는 history 를 쓸 수 없다 */ }
}

function finishBack() {
  clearTimeout(backTimer);
  backTimer = null;
  backPending = false;
  document.documentElement.removeAttribute('data-sheet-back');
  if (pushAfterBack) {
    pushAfterBack = false;
    if (sheetOpen) pushSheetState();
  }
  if (queuedHash) {
    const hash = queuedHash;
    queuedHash = null;
    location.hash = hash;
  }
}

function hideSheet() {
  if (!sheetOpen) return;
  pushAfterBack = false;
  sheetOpen = false;
  tts.stop();
  cancelAnimationFrame(openFrame);
  openFrame = 0;
  const root = sheetRoot();
  root.classList.remove('open');
  document.documentElement.classList.remove('no-scroll');
  const cb = sheetOnClose;
  sheetOnClose = null;
  setTimeout(() => { if (!sheetOpen) root.replaceChildren(); }, 220);
  if (sheetLastFocus && document.contains(sheetLastFocus)) sheetLastFocus.focus({ preventScroll: true });
  sheetLastFocus = null;
  if (cb) cb();
}

/** 시트를 닫는다. */
export function closeSheet() {
  if (!sheetOpen) return;
  hideSheet();
  if (sheetHistory) {
    sheetHistory = false;
    backPending = true;
    document.documentElement.setAttribute('data-sheet-back', '');
    history.back();
    backTimer = setTimeout(() => { if (backPending) finishBack(); }, 800);   // popstate 가 오지 않는 환경 대비
  }
}

/** 시트를 닫고 다른 화면으로 이동한다(시트가 history 에 넣은 칸을 새 화면으로 바꿔 쓴다). */
export function closeSheetAndGo(hash) {
  const hadHistory = sheetHistory;
  sheetHistory = false;
  hideSheet();
  if (hadHistory) location.replace(hash);
  else location.hash = hash;
}

export function isSheetOpen() {
  return sheetOpen;
}

/* ───────────────────────── 확인 창 ───────────────────────── */

function closeModal(result) {
  const resolve = modalResolve;
  if (!resolve) return;
  modalResolve = null;
  modalRoot().replaceChildren();
  if (modalLastFocus && document.contains(modalLastFocus)) modalLastFocus.focus({ preventScroll: true });
  modalLastFocus = null;
  resolve(result);
}

/**
 * 확인 창을 띄운다.
 * @param {{ title: string, message?: string, confirmText?: string, cancelText?: string, danger?: boolean }} opts
 * @returns {Promise<boolean>} 확인을 누르면 true
 */
export function confirmDialog({ title, message = '', confirmText = '확인', cancelText = '취소', danger = false }) {
  wire();
  if (modalResolve) closeModal(false);
  modalLastFocus = document.activeElement;
  const root = modalRoot();
  setHtml(root, html`
    <div class="modal-backdrop"></div>
    <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="modal-title">
      <h2 id="modal-title">${title}</h2>
      ${message ? html`<p class="modal-message">${message}</p>` : ''}
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-modal="cancel">${cancelText}</button>
        <button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-modal="ok">${confirmText}</button>
      </div>
    </div>`);
  return new Promise((resolve) => {
    modalResolve = resolve;
    root.querySelector('[data-modal="cancel"]').addEventListener('click', () => closeModal(false));
    root.querySelector('[data-modal="ok"]').addEventListener('click', () => closeModal(true));
    root.querySelector('.modal-backdrop').addEventListener('click', () => closeModal(false));
    root.querySelector(danger ? '[data-modal="cancel"]' : '[data-modal="ok"]').focus();
  });
}

/* ───────────────────────── 용어 카드 ───────────────────────── */

function notifyTermsChanged() {
  document.dispatchEvent(new CustomEvent('ss:terms-changed'));
}

/**
 * 용어 카드를 연다. 관련 용어를 누르면 카드가 그 용어로 바뀌고 ← 로 돌아온다.
 * @param {string} id
 * @param {{ lesson?: object }} [ctx]  강의에서 열었으면 그 강의(용어 정의·처음 나온 강의 기록에 쓴다)
 */
export async function openTermCard(id, ctx = {}) {
  const stack = [];
  const lessonTerms = ctx.lesson?.terms;

  async function show(termId) {
    const found = await terms.resolveTerm(termId, lessonTerms);
    if (!found) {
      toast('용어 정보를 찾을 수 없어요');
      return false;
    }
    const { term } = found;
    let saved = found.saved;

    const related = [];
    for (const rid of Array.isArray(term.related) ? term.related : []) {
      if (rid === termId) continue;
      const r = await terms.resolveTerm(rid, lessonTerms);
      if (r) related.push({ id: rid, label: termLabel(r.term) });
    }

    const view = () => {
      const canSpeak = tts.isSupported() && Boolean(term.en);
      const status = saved
        ? html`<p class="term-status">⭐ 내 용어장 · ${STATUS_LABELS[cardStatus(saved.card)]}${
          saved.card && saved.card.state !== 0 ? html` · 다음 복습 ${formatInterval(new Date(), saved.card.due)}` : ''}</p>`
        : '';
      return html`
        <header class="sheet-head">
          ${stack.length ? html`<button type="button" class="icon-btn" data-act="back" aria-label="이전 용어로">←</button>` : ''}
          <h2 class="term-title">${term.ko}</h2>
          ${canSpeak ? html`<button type="button" class="icon-btn" data-act="speak" aria-label="영어 발음 듣기">🔊</button>` : ''}
          <button type="button" class="icon-btn star ${saved ? 'on' : ''}" data-act="star" aria-pressed="${saved ? 'true' : 'false'}"
            aria-label="${saved ? '용어장에서 빼기' : '용어장에 저장'}">${saved ? '⭐' : '☆'}</button>
          <button type="button" class="icon-btn" data-sheet-close data-autofocus aria-label="닫기">✕</button>
        </header>
        ${term.en ? html`<p class="term-en" lang="en">${term.en}</p>` : ''}
        <p class="term-short">${term.short}</p>
        ${term.formula ? html`<p class="term-formula"><span aria-hidden="true">📐</span> ${term.formula}</p>` : ''}
        ${term.example ? html`<p class="term-example">예) ${term.example}</p>` : ''}
        ${term.long ? html`<details class="term-more"><summary>더 보기</summary><p>${term.long}</p></details>` : ''}
        ${related.length ? html`<div class="term-related"><span class="label">관련</span>
          ${related.map((r) => html`<button type="button" class="chip" data-related="${r.id}">${r.label}</button>`)}</div>` : ''}
        ${status}`;
    };

    const box = openSheet(view(), { label: `${term.ko} 용어 카드` });
    box.onclick = async (e) => {
      const relatedBtn = e.target.closest('[data-related]');
      if (relatedBtn) {
        stack.push(termId);
        const ok = await show(relatedBtn.dataset.related);
        if (!ok) stack.pop();
        return;
      }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'back') {
        const prev = stack.pop();
        if (prev) await show(prev);
      } else if (act === 'speak') {
        tts.speak(String(term.en).replace(/\s*\(.*?\)\s*/g, ' ').trim() || term.en);
      } else if (act === 'star') {
        if (saved) {
          if (saved.card && saved.card.reps > 0) {
            const ok = await confirmDialog({
              title: '용어장에서 뺄까요?',
              message: '이 용어의 복습 일정이 함께 사라집니다.',
              confirmText: '빼기',
              danger: true,
            });
            if (!ok) return;
          }
          await terms.removeTerm(termId);
          saved = null;
          toast('용어장에서 뺐어요');
        } else {
          const origin = ctx.lesson && lessonTerms?.some((t) => t.id === termId) && ctx.lesson.sample !== true
            ? { track: ctx.lesson.track, lessonNo: ctx.lesson.lesson_no, date: ctx.lesson.date }
            : { track: term.track ?? ctx.lesson?.track, lessonNo: term.first_lesson ?? term.firstLesson, date: term.first_date ?? term.firstDate ?? ctx.lesson?.date };
          saved = (await terms.saveTerm(term, origin)).record;
          toast('용어장에 저장했어요 ⭐');
        }
        notifyTermsChanged();
        if (sheetOpen) {
          setHtml(box, view());
          box.querySelector('[data-act="star"]')?.focus({ preventScroll: true });
        }
      }
    };
    return true;
  }

  return show(id);
}

/* ───────────────────────── 숫자 출처 카드 ───────────────────────── */

function prettyExpr(expr) {
  return String(expr).replace(/\*/g, '×').replace(/\//g, '÷').replace(/\s+/g, ' ').trim();
}

/** 본문 숫자 옆 ⓘ 를 눌렀을 때: 무엇의 숫자인지, 기준일, 출처. */
export function openFactCard(fact, lesson) {
  if (!fact) return;
  let host = '';
  let safeUrl = '';
  try {
    const u = new URL(fact.source_url);
    if (u.protocol === 'https:') { safeUrl = u.href; host = u.hostname.replace(/^www\./, ''); }
  } catch { /* 주소가 올바르지 않으면 링크를 만들지 않는다 */ }

  const shown = formatFact(fact).text;
  const exact = formatExact(fact.value, fact.unit);
  const parts = [];
  if (fact.derived) {
    const ids = [...new Set([...String(fact.derived).matchAll(/f(\d+)/g)].map((m) => Number(m[1])))];
    for (const fid of ids) {
      const f = (lesson?.facts ?? []).find((x) => x.id === fid);
      if (f) parts.push({ key: `f${fid}`, label: f.label, value: formatFact(f).text });
    }
  }

  openSheet(html`
    <header class="sheet-head">
      <h2 class="fact-title">${fact.label}</h2>
      <button type="button" class="icon-btn" data-sheet-close data-autofocus aria-label="닫기">✕</button>
    </header>
    <p class="fact-value num">${shown}</p>
    ${exact !== shown ? html`<p class="fact-exact num">정확한 값 ${exact}</p>` : ''}
    <dl class="fact-meta">
      <div><dt>기준일</dt><dd>${formatDateKo(fact.asof, { year: true })}</dd></div>
      ${fact.derived ? html`<div><dt>계산식</dt><dd class="num">${prettyExpr(fact.derived)}</dd></div>` : ''}
      ${parts.map((p) => html`<div><dt class="num">${p.key}</dt><dd>${p.label} <span class="num">${p.value}</span></dd></div>`)}
      ${fact.note ? html`<div><dt>참고</dt><dd>${fact.note}</dd></div>` : ''}
    </dl>
    ${fact.derived ? html`<p class="hint">출처의 숫자로 직접 계산한 값입니다.</p>` : ''}
    ${safeUrl
      ? html`<a class="btn primary block" href="${safeUrl}" target="_blank" rel="noopener noreferrer">출처 열기 <span class="muted-on-primary">${host}</span> ↗</a>`
      : html`<p class="hint">출처 주소를 열 수 없습니다.</p>`}
    <p class="hint">숫자는 기준일 시점의 값이며 이후 달라질 수 있습니다.</p>`, { label: `${fact.label} 출처` });
}
