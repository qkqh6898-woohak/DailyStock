// journal.js — 투자 일지 (#/journal, #/journal/new, #/journal/edit/:id, #/journal/:id)
//
// 일지는 이 기기의 IndexedDB 에만 저장한다. 이 파일에는 네트워크로 보내는 코드가 없고,
// 다른 기기로 옮기는 방법은 설정의 "백업 내보내기 → 가져오기"뿐이다.

import {
  html, setHtml, kstDate, formatDateKo, addMonths, isValidYmd, parseInputNumber, formatValue, uuid, toast, diffDays,
} from './util.js';
import * as db from './db.js';
import { loadGlossary } from './lessons.js';
import { termLabel } from './render.js';
import { confirmDialog, openTermCard } from './popup.js';
import { listSaved } from './terms.js';

export const ACTIONS = Object.freeze({ buy: '매수', sell: '매도', watch: '관심' });
export const VERDICTS = Object.freeze({ right: '맞음', partial: '일부 맞음', wrong: '틀림' });
export const REASON_MIN = 20;

/** 회고 대기 = 다시 볼 날이 됐고 아직 회고를 쓰지 않은 일지. */
export function dueEntries(entries, today = kstDate()) {
  return entries.filter((e) => e && isValidYmd(e.revisitAt) && e.revisitAt <= today && !e.review);
}

export async function countDueJournal(today = kstDate()) {
  return dueEntries(await db.getAll('journal'), today).length;
}

/** 양식 값을 검사한다. 문제가 없으면 빈 객체. */
export function validateEntry(v) {
  const errors = {};
  if (!isValidYmd(v.date)) errors.date = '날짜를 확인해 주세요.';
  if (!v.name || !v.name.trim()) errors.name = '종목명을 적어 주세요.';
  if (!ACTIONS[v.action]) errors.action = '행동을 골라 주세요.';
  if (v.price !== null && (!(v.price >= 0) || !Number.isFinite(v.price))) errors.price = '가격은 0 이상의 숫자여야 해요.';
  if (v.qty !== null && (!(v.qty >= 0) || !Number.isFinite(v.qty))) errors.qty = '수량은 0 이상의 숫자여야 해요.';
  const reasonLen = [...(v.reason ?? '').trim()].length;
  if (reasonLen < REASON_MIN) errors.reason = `이유를 ${REASON_MIN}자 이상 적어 주세요(지금 ${reasonLen}자). 나중에 돌아볼 때 가장 중요한 부분이에요.`;
  if (!isValidYmd(v.revisitAt)) errors.revisitAt = '다시 볼 날을 정해 주세요.';
  else if (isValidYmd(v.date) && v.revisitAt <= v.date) errors.revisitAt = '다시 볼 날은 작성일보다 뒤여야 해요.';
  return errors;
}

function priceText(e) {
  if (e.price === null || e.price === undefined) return '';
  const unit = e.currency === 'USD' ? '달러' : '원';
  const price = formatValue(e.price, unit, { digits: e.currency === 'USD' ? 2 : 0 });
  return e.qty ? `${price} · ${formatValue(e.qty, '주')}` : price;
}

function reviewState(e, today) {
  if (e.review) return { cls: 'done', text: `회고 완료 · ${VERDICTS[e.review.verdict] ?? ''}` };
  if (isValidYmd(e.revisitAt) && e.revisitAt <= today) return { cls: 'due', text: '회고 대기' };
  if (isValidYmd(e.revisitAt)) return { cls: 'wait', text: `다시 볼 날 ${formatDateKo(e.revisitAt, { year: true, withWeekday: false })} (${diffDays(today, e.revisitAt)}일 뒤)` };
  return { cls: 'wait', text: '' };
}

async function termOptions() {
  const [glossary, saved] = await Promise.all([loadGlossary(), listSaved()]);
  const map = new Map();
  for (const t of glossary.values()) map.set(t.id, termLabel(t));
  for (const t of saved) map.set(t.id, termLabel(t));
  return map;
}

/* ───────────────────────── 태그 편집기 ───────────────────────── */

function mountTagEditor(box, initial, options) {
  let tags = [...new Set(initial ?? [])];
  const listId = `tag-options-${uuid().slice(0, 8)}`;
  const draw = () => {
    setHtml(box, html`
      <div class="chips" data-role="tags">
        ${tags.map((id) => html`<span class="chip removable">${options.get(id) ?? id}
          <button type="button" class="chip-x" data-remove="${id}" aria-label="${options.get(id) ?? id} 태그 빼기">✕</button></span>`)}
        ${tags.length === 0 ? html`<span class="hint">아직 태그가 없어요.</span>` : ''}
      </div>
      <div class="tag-add">
        <input type="text" list="${listId}" placeholder="용어 이름 (예: PER)" aria-label="추가할 용어" autocomplete="off">
        <button type="button" class="btn ghost small" data-act="add-tag">추가</button>
        <datalist id="${listId}">${[...options].map(([, label]) => html`<option value="${label}"></option>`)}</datalist>
      </div>`);
  };
  const add = () => {
    const input = box.querySelector('input');
    const text = input.value.trim().toLowerCase();
    if (!text) return;
    let found = null;
    for (const [id, label] of options) {
      if (label.toLowerCase() === text || id === text) { found = id; break; }
    }
    if (!found) {
      for (const [id, label] of options) {
        if (label.toLowerCase().includes(text)) { found = id; break; }
      }
    }
    if (!found) { toast('사전에 없는 용어예요. 용어장에서 직접 추가할 수 있어요.'); return; }
    if (!tags.includes(found)) tags.push(found);
    draw();
    box.querySelector('input').focus();
  };
  box.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) { tags = tags.filter((t) => t !== rm.dataset.remove); draw(); return; }
    if (e.target.closest('[data-act="add-tag"]')) add();
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); add(); }
  });
  draw();
  return () => [...tags];
}

/* ───────────────────────── 목록 ───────────────────────── */

const FILTERS = [['all', '전체'], ['buy', '매수'], ['sell', '매도'], ['watch', '관심'], ['due', '회고 대기']];

export async function render(page, params = {}, query = {}) {
  const today = kstDate();
  const all = (await db.getAll('journal')).sort((a, b) => (
    a.date === b.date ? String(b.createdAt).localeCompare(String(a.createdAt)) : (a.date < b.date ? 1 : -1)));
  const due = dueEntries(all, today);
  let filter = FILTERS.some(([k]) => k === query.f) ? query.f : 'all';

  const draw = () => {
    const list = filter === 'all' ? all : filter === 'due' ? due : all.filter((e) => e.action === filter);
    setHtml(page, html`
      <header class="page-head">
        <h1>📒 투자 일지</h1>
        <a class="btn primary" href="#/journal/new">+ 새 일지</a>
      </header>
      <p class="notice private">🔒 이 일지는 이 기기에만 저장됩니다. 인터넷으로 전송되지 않아요.</p>
      <div class="segmented" role="group" aria-label="일지 걸러 보기">
        ${FILTERS.map(([key, label]) => html`<button type="button" class="${filter === key ? 'on' : ''}" data-filter="${key}"
          aria-pressed="${filter === key ? 'true' : 'false'}">${label}${key === 'due' && due.length ? html` <span class="pill">${due.length}</span>` : ''}</button>`)}
      </div>
      ${list.length === 0 ? html`
        <section class="empty small">
          <div class="empty-emoji" aria-hidden="true">📝</div>
          <p>${all.length === 0
            ? '아직 일지가 없어요. "왜 샀는지"를 적어 두고, 몇 달 뒤 그 이유가 맞았는지 확인해 보세요.'
            : '이 조건에 맞는 일지가 없어요.'}</p>
        </section>` : html`
        <ul class="list journal-list">
          ${list.map((e) => {
            const st = reviewState(e, today);
            return html`<li><a class="row" href="#/journal/${e.id}">
              <div class="row-top">
                <span class="badge action-${e.action}">${ACTIONS[e.action] ?? ''}</span>
                <strong class="row-title">${e.name}</strong>
                <span class="row-date">${formatDateKo(e.date, { withWeekday: false })}</span>
              </div>
              ${priceText(e) ? html`<div class="row-sub num">${priceText(e)}</div>` : ''}
              <p class="row-text clamp">${e.reason}</p>
              <div class="row-foot"><span class="state ${st.cls}">${st.text}</span></div>
            </a></li>`;
          })}
        </ul>`}
      <p class="disclaimer">일지는 내 판단을 돌아보기 위한 기록입니다. 설정 › 데이터에서 백업해 두세요.</p>`);
  };
  draw();
  page.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    filter = btn.dataset.filter;
    draw();
  });
}

/* ───────────────────────── 작성·수정 ───────────────────────── */

export async function renderForm(page, params = {}) {
  const today = kstDate();
  const editing = params.id ? await db.get('journal', params.id) : null;
  if (params.id && !editing) {
    setHtml(page, html`<section class="empty"><h1>일지를 찾을 수 없어요</h1><p><a class="btn primary" href="#/journal">목록으로</a></p></section>`);
    return;
  }
  const options = await termOptions();
  const e = editing ?? {
    date: today, name: '', action: 'buy', price: null, currency: 'KRW', qty: null,
    reason: '', metrics: '', risks: '', revisitAt: addMonths(today, 3), tags: [],
  };
  const presetOf = (entry) => {
    for (const m of [1, 3, 6]) if (entry.revisitAt === addMonths(entry.date, m)) return String(m);
    return 'custom';
  };
  const preset = presetOf(e);

  setHtml(page, html`
    <nav class="crumb"><a href="${editing ? `#/journal/${editing.id}` : '#/journal'}" class="back-link">← ${editing ? '일지' : '투자 일지'}</a></nav>
    <h1>${editing ? '일지 수정' : '새 일지'}</h1>
    <p class="notice private">🔒 이 기기에만 저장됩니다.</p>
    <form class="form" novalidate>
      <div class="field-row">
        <label class="field"><span>날짜</span>
          <input type="date" name="date" value="${e.date}" max="${today}" required></label>
        <fieldset class="field"><legend>행동</legend>
          <div class="segmented">
            ${Object.entries(ACTIONS).map(([key, label]) => html`<label class="${e.action === key ? 'on' : ''}">
              <input type="radio" name="entryAction" value="${key}" ${e.action === key ? 'checked' : ''}>${label}</label>`)}
          </div>
        </fieldset>
      </div>
      <label class="field"><span>종목명</span>
        <input type="text" name="stockName" value="${e.name}" maxlength="60" placeholder="예) LG에너지솔루션" required autocomplete="off"></label>
      <p class="field-error" data-error="name" role="alert"></p>
      <div class="field-row">
        <label class="field grow"><span>가격 <small>(선택)</small></span>
          <input type="text" inputmode="decimal" name="price" value="${e.price ?? ''}" placeholder="예) 412,000" autocomplete="off"></label>
        <label class="field"><span>통화</span>
          <select name="currency">
            <option value="KRW" ${e.currency !== 'USD' ? 'selected' : ''}>원</option>
            <option value="USD" ${e.currency === 'USD' ? 'selected' : ''}>달러</option>
          </select></label>
        <label class="field"><span>수량 <small>(선택)</small></span>
          <input type="text" inputmode="decimal" name="qty" value="${e.qty ?? ''}" placeholder="예) 10" autocomplete="off"></label>
      </div>
      <p class="field-error" data-error="price" role="alert"></p>
      <p class="field-error" data-error="qty" role="alert"></p>

      <label class="field"><span>이유 <small>(필수, ${REASON_MIN}자 이상)</small></span>
        <textarea name="reason" rows="4" placeholder="예) 배터리 수주잔고가 늘고 PER이 업종 평균보다 낮아서" required>${e.reason}</textarea></label>
      <p class="field-hint"><span data-role="reason-count">0</span>자 · 투자 아이디어를 한두 문장으로 적어 보세요.</p>
      <p class="field-error" data-error="reason" role="alert"></p>

      <label class="field"><span>확인할 지표 <small>(선택)</small></span>
        <textarea name="metrics" rows="2" placeholder="예) 다음 분기 영업이익률">${e.metrics ?? ''}</textarea></label>
      <label class="field"><span>예상 위험 <small>(선택)</small></span>
        <textarea name="risks" rows="2" placeholder="예) 리튬 가격 하락 시 판가 하락">${e.risks ?? ''}</textarea></label>

      <fieldset class="field"><legend>다시 볼 날</legend>
        <div class="segmented">
          ${[['1', '1개월'], ['3', '3개월'], ['6', '6개월'], ['custom', '직접']].map(([key, label]) => html`<label class="${preset === key ? 'on' : ''}">
            <input type="radio" name="revisitPreset" value="${key}" ${preset === key ? 'checked' : ''}>${label}</label>`)}
        </div>
        <input type="date" name="revisitAt" value="${e.revisitAt}" aria-label="다시 볼 날짜" ${preset === 'custom' ? '' : 'hidden'}>
        <p class="field-hint" data-role="revisit-text"></p>
      </fieldset>
      <p class="field-error" data-error="revisitAt" role="alert"></p>

      <fieldset class="field"><legend>관련 용어 태그 <small>(선택)</small></legend>
        <div data-role="tag-editor"></div>
      </fieldset>

      <div class="form-actions">
        <a class="btn ghost" href="${editing ? `#/journal/${editing.id}` : '#/journal'}">취소</a>
        <button type="submit" class="btn primary">저장</button>
      </div>
    </form>`);

  const form = page.querySelector('form');
  const getTags = mountTagEditor(page.querySelector('[data-role="tag-editor"]'), e.tags, options);
  const count = page.querySelector('[data-role="reason-count"]');
  const revisitText = page.querySelector('[data-role="revisit-text"]');

  const syncSegments = () => {
    for (const label of form.querySelectorAll('.segmented label')) label.classList.toggle('on', label.querySelector('input').checked);
  };
  const f = form.elements;
  const syncRevisit = () => {
    const presetNow = f.revisitPreset.value;
    const date = f.date.value;
    if (presetNow !== 'custom' && isValidYmd(date)) f.revisitAt.value = addMonths(date, Number(presetNow));
    f.revisitAt.hidden = presetNow !== 'custom';
    revisitText.textContent = isValidYmd(f.revisitAt.value)
      ? `${formatDateKo(f.revisitAt.value, { year: true })}에 오늘 화면에서 알려 드려요.` : '';
  };
  const syncCount = () => { count.textContent = String([...f.reason.value.trim()].length); };
  syncRevisit();
  syncCount();
  form.addEventListener('input', (ev) => {
    if (ev.target.name === 'reason') syncCount();
    if (ev.target.name === 'date' || ev.target.name === 'revisitAt') syncRevisit();
  });
  form.addEventListener('change', (ev) => {
    if (ev.target.type === 'radio') syncSegments();
    if (ev.target.name === 'revisitPreset') syncRevisit();
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const priceRaw = f.price.value.trim();
    const qtyRaw = f.qty.value.trim();
    const values = {
      date: f.date.value,
      name: f.stockName.value.trim(),
      action: f.entryAction.value,
      price: priceRaw === '' ? null : (parseInputNumber(priceRaw) ?? NaN),
      currency: f.currency.value === 'USD' ? 'USD' : 'KRW',
      qty: qtyRaw === '' ? null : (parseInputNumber(qtyRaw) ?? NaN),
      reason: f.reason.value.trim(),
      metrics: f.metrics.value.trim(),
      risks: f.risks.value.trim(),
      revisitAt: f.revisitAt.value,
      tags: getTags(),
    };
    const errors = validateEntry(values);
    for (const slot of form.querySelectorAll('[data-error]')) slot.textContent = errors[slot.dataset.error] ?? '';
    const firstKey = Object.keys(errors)[0];
    if (firstKey) {
      const fieldName = { name: 'stockName', action: 'entryAction' }[firstKey] ?? firstKey;
      const field = f[fieldName];
      if (field && typeof field.focus === 'function' && !field.hidden) field.focus();
      toast('입력한 내용을 확인해 주세요');
      return;
    }
    const now = new Date().toISOString();
    const record = {
      ...(editing ?? { id: uuid(), createdAt: now, review: null }),
      ...values,
      updatedAt: now,
    };
    await db.put('journal', record);
    document.dispatchEvent(new CustomEvent('ss:journal-changed'));
    toast(editing ? '일지를 고쳤어요' : '일지를 저장했어요');
    location.hash = `#/journal/${record.id}`;
  });
}

/* ───────────────────────── 상세 + 회고 ───────────────────────── */

export async function renderDetail(page, params = {}) {
  const today = kstDate();
  let e = await db.get('journal', params.id);
  if (!e) {
    setHtml(page, html`<section class="empty"><h1>일지를 찾을 수 없어요</h1><p><a class="btn primary" href="#/journal">목록으로</a></p></section>`);
    return;
  }
  const options = await termOptions();
  let editingReview = false;
  let getReviewTags = null;

  const draw = () => {
    const st = reviewState(e, today);
    const isDue = st.cls === 'due';
    const showForm = editingReview || (isDue && !e.review);
    const r = e.review ?? { verdict: '', note: '', learned: '' };
    setHtml(page, html`
      <nav class="crumb"><a href="#/journal" class="back-link">← 투자 일지</a></nav>
      <header class="journal-head">
        <span class="badge action-${e.action}">${ACTIONS[e.action] ?? ''}</span>
        <h1>${e.name}</h1>
      </header>
      <p class="meta-line">${formatDateKo(e.date, { year: true })}${priceText(e) ? html` · <span class="num">${priceText(e)}</span>` : ''}</p>
      <p class="state ${st.cls}">${st.text}</p>

      <section class="card">
        <h2>이유</h2>
        <p class="pre">${e.reason}</p>
        ${e.metrics ? html`<h2>확인할 지표</h2><p class="pre">${e.metrics}</p>` : ''}
        ${e.risks ? html`<h2>예상 위험</h2><p class="pre">${e.risks}</p>` : ''}
        ${e.tags?.length ? html`<h2>관련 용어</h2><div class="chips">${e.tags.map((id) => html`<button type="button" class="chip" data-tag="${id}">${options.get(id) ?? id}</button>`)}</div>` : ''}
      </section>

      <section class="card review-box ${isDue && !e.review ? 'attention' : ''}">
        <h2>회고</h2>
        ${e.review && !editingReview ? html`
          <p><span class="badge verdict-${e.review.verdict}">${VERDICTS[e.review.verdict] ?? ''}</span>
            <span class="hint">${formatDateKo(kstDateOfSafe(e.review.reviewedAt), { year: true })}에 작성</span></p>
          ${e.review.note ? html`<h3>결과 메모</h3><p class="pre">${e.review.note}</p>` : ''}
          ${e.review.learned ? html`<h3>배운 점</h3><p class="pre">${e.review.learned}</p>` : ''}
          <button type="button" class="btn ghost small" data-act="edit-review">회고 고치기</button>` : ''}
        ${!e.review && !showForm ? html`
          <p class="hint">다시 볼 날이 되면 오늘 화면에서 알려 드려요. 미리 써도 괜찮아요.</p>
          <button type="button" class="btn ghost small" data-act="edit-review">지금 회고 쓰기</button>` : ''}
        ${showForm ? html`
          <form class="form" data-role="review-form" novalidate>
            <fieldset class="field"><legend>그때 이유가 맞았나요?</legend>
              <div class="segmented">
                ${Object.entries(VERDICTS).map(([key, label]) => html`<label class="${r.verdict === key ? 'on' : ''}">
                  <input type="radio" name="verdict" value="${key}" ${r.verdict === key ? 'checked' : ''}>${label}</label>`)}
              </div>
            </fieldset>
            <p class="field-error" data-error="verdict" role="alert"></p>
            <label class="field"><span>결과 메모</span>
              <textarea name="note" rows="3" placeholder="예) 영업이익률은 예상대로 올랐지만 주가는 금리 때문에 내렸다">${r.note ?? ''}</textarea></label>
            <label class="field"><span>배운 점</span>
              <textarea name="learned" rows="3" placeholder="예) 실적만 보지 말고 금리 환경도 함께 확인하자">${r.learned ?? ''}</textarea></label>
            <fieldset class="field"><legend>관련 용어 태그</legend><div data-role="review-tags"></div></fieldset>
            <div class="form-actions">
              ${e.review || !isDue ? html`<button type="button" class="btn ghost" data-act="cancel-review">취소</button>` : ''}
              <button type="submit" class="btn primary">회고 저장</button>
            </div>
          </form>` : ''}
      </section>

      <div class="form-actions">
        <button type="button" class="btn danger ghost" data-act="delete">삭제</button>
        <a class="btn ghost" href="#/journal/edit/${e.id}">수정</a>
      </div>`);
    const tagBox = page.querySelector('[data-role="review-tags"]');
    getReviewTags = tagBox ? mountTagEditor(tagBox, e.tags, options) : null;
  };
  draw();

  page.addEventListener('change', (ev) => {
    if (ev.target.type !== 'radio') return;
    for (const label of ev.target.closest('.segmented').querySelectorAll('label')) label.classList.toggle('on', label.querySelector('input').checked);
  });

  page.addEventListener('click', async (ev) => {
    const tag = ev.target.closest('[data-tag]');
    if (tag) { openTermCard(tag.dataset.tag); return; }
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (act === 'edit-review') { editingReview = true; draw(); page.querySelector('[data-role="review-form"] input')?.focus(); }
    else if (act === 'cancel-review') { editingReview = false; draw(); }
    else if (act === 'delete') {
      const ok = await confirmDialog({ title: '이 일지를 삭제할까요?', message: '삭제하면 되돌릴 수 없어요.', confirmText: '삭제', danger: true });
      if (!ok) return;
      await db.del('journal', e.id);
      document.dispatchEvent(new CustomEvent('ss:journal-changed'));
      toast('일지를 삭제했어요');
      location.hash = '#/journal';
    }
  });

  page.addEventListener('submit', async (ev) => {
    const form = ev.target.closest('[data-role="review-form"]');
    if (!form) return;
    ev.preventDefault();
    const fields = form.elements;
    const verdict = fields.verdict.value;
    const slot = form.querySelector('[data-error="verdict"]');
    if (!VERDICTS[verdict]) { slot.textContent = '맞음 · 일부 맞음 · 틀림 중 하나를 골라 주세요.'; return; }
    const now = new Date().toISOString();
    e = {
      ...e,
      review: { verdict, note: fields.note.value.trim(), learned: fields.learned.value.trim(), reviewedAt: now },
      tags: getReviewTags ? getReviewTags() : e.tags,
      updatedAt: now,
    };
    await db.put('journal', e);
    editingReview = false;
    document.dispatchEvent(new CustomEvent('ss:journal-changed'));
    toast('회고를 저장했어요');
    draw();
  });
}

function kstDateOfSafe(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? kstDate() : kstDate(d);
}
