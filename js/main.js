// main.js — 라우터(해시), 하단 탭, 초기화
//
// 주소 예)  #/today  #/lesson/2026-11-30  #/quiz/2026-11-30  #/quiz/weekly  #/quiz/wrong
//          #/review  #/glossary  #/curriculum  #/archive
//          #/journal  #/journal/new  #/journal/edit/:id  #/journal/:id
//          #/calc  #/calc/compound  #/settings

import { html, kstDate, setHtml, toast } from './util.js';
import * as db from './db.js';
import * as lessonView from './lesson.js';
import * as reviewView from './review.js';
import * as glossaryView from './glossary.js';
import * as quizView from './quiz.js';
import * as curriculumView from './curriculum.js';
import * as journalView from './journal.js';
import * as calcView from './calc.js';
import * as archiveView from './archive.js';
import * as settingsView from './settings.js';
import { reviewCounts } from './terms.js';
import { invalidateIndex, prefetchRecent, resolveToday } from './lessons.js';
import { applyAppearance } from './settings.js';
import { announceUpdate, applyUpdate, isUpdatePending, registerServiceWorker } from './update.js';
import './install.js';

const DATE = '(\\d{4}-\\d{2}-\\d{2})';
const ID = '([A-Za-z0-9-]{1,64})';

const ROUTES = [
  { re: /^\/today$/, tab: 'today', title: '오늘의 강의', view: (p) => lessonView.render(p, {}) },
  { re: new RegExp(`^/lesson/${DATE}$`), tab: 'today', title: '강의', view: (p, a) => lessonView.render(p, { date: a[0] }) },
  { re: new RegExp(`^/quiz/weekly(?:/${DATE})?$`), tab: 'today', title: '주간 퀴즈', view: (p, a) => quizView.renderWeekly(p, { week: a[0] }) },
  { re: /^\/quiz\/wrong$/, tab: 'review', title: '오답 노트', view: (p) => quizView.renderWrong(p) },
  { re: new RegExp(`^/quiz/${DATE}$`), tab: 'today', title: '퀴즈', view: (p, a) => quizView.renderLesson(p, { date: a[0] }) },
  { re: /^\/review$/, tab: 'review', title: '복습', view: (p) => reviewView.render(p) },
  { re: /^\/glossary$/, tab: 'review', title: '용어장', view: (p, a, q) => glossaryView.render(p, {}, q) },
  { re: /^\/curriculum$/, tab: 'today', title: '진도', view: (p) => curriculumView.render(p) },
  { re: /^\/archive$/, tab: 'today', title: '지난 강의', view: (p, a, q) => archiveView.render(p, {}, q) },
  { re: /^\/journal$/, tab: 'journal', title: '투자 일지', view: (p, a, q) => journalView.render(p, {}, q) },
  { re: /^\/journal\/new$/, tab: 'journal', title: '새 일지', view: (p) => journalView.renderForm(p, {}) },
  { re: new RegExp(`^/journal/edit/${ID}$`), tab: 'journal', title: '일지 수정', view: (p, a) => journalView.renderForm(p, { id: a[0] }) },
  { re: new RegExp(`^/journal/${ID}$`), tab: 'journal', title: '일지', view: (p, a) => journalView.renderDetail(p, { id: a[0] }) },
  { re: /^\/calc(?:\/(compound|valuation|dividend|avgcost))?$/, tab: 'calc', title: '계산기', view: (p, a) => calcView.render(p, { kind: a[0] }) },
  { re: /^\/settings$/, tab: 'settings', title: '설정', view: (p, a, q) => settingsView.render(p, {}, q) },
];

let navToken = 0;
let cleanup = null;
let firstRoute = true;
let prefetchScheduled = false;
let todayKey = null;     // 오늘 화면에 띄운 강의 — 앱으로 돌아왔을 때 새 강의가 생겼는지 비교한다
let hiddenAt = 0;
const RESUME_REFRESH_MS = 60 * 1000;

/** 첫 화면이 뜬 뒤 한가할 때 최근 강의를 미리 받아 둔다(오프라인 대비). */
function schedulePrefetch() {
  if (prefetchScheduled) return;
  prefetchScheduled = true;
  const run = () => { prefetchRecent(7).catch(() => {}); };
  if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 5000 });
  else setTimeout(run, 3000);
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/today';
  const [path, queryString = ''] = raw.split('?');
  const query = {};
  for (const [k, v] of new URLSearchParams(queryString)) query[k] = v;
  return { path: path.replace(/\/+$/, '') || '/today', query };
}

function setActiveTab(tab) {
  for (const link of document.querySelectorAll('#tabbar a')) {
    const on = link.dataset.tab === tab;
    link.classList.toggle('active', on);
    if (on) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

async function route() {
  const { path, query } = parseHash();
  let match = null;
  let args = [];
  for (const r of ROUTES) {
    const m = path.match(r.re);
    if (m) { match = r; args = m.slice(1); break; }
  }
  if (!match) { location.replace('#/today'); return; }

  navToken += 1;
  const mine = navToken;
  if (typeof cleanup === 'function') { try { cleanup(); } catch (err) { console.error(err); } }
  cleanup = null;

  const view = document.getElementById('view');
  const page = document.createElement('div');
  page.className = 'page';
  setHtml(page, html`<p class="loading" role="status">불러오는 중…</p>`);
  view.replaceChildren(page);
  setActiveTab(match.tab);
  document.title = `${match.title} · Daily Stock Study`;
  window.scrollTo(0, 0);

  try {
    const result = await match.view(page, args, query);
    if (mine !== navToken) {
      if (typeof result === 'function') result();
      return;
    }
    cleanup = typeof result === 'function' ? result : null;
    if (!firstRoute) view.focus({ preventScroll: true });
    firstRoute = false;
    schedulePrefetch();
    todayKey = null;
    if (path === '/today') todayKeyNow().then((key) => { if (mine === navToken) todayKey = key; }).catch(() => {});
  } catch (err) {
    console.error(err);
    if (mine !== navToken) return;
    setHtml(page, html`
      <section class="empty">
        <div class="empty-emoji" aria-hidden="true">⚠️</div>
        <h1>화면을 표시하지 못했어요</h1>
        <p>잠시 뒤 다시 시도해 주세요. 문제가 계속되면 설정 › 데이터에서 백업한 뒤 앱을 다시 열어 보세요.</p>
        <p><button type="button" class="btn primary" data-act="retry">다시 시도</button></p>
      </section>`);
    page.querySelector('[data-act="retry"]').addEventListener('click', route);
  }
  updateBadges();
}

/** 하단 탭의 숫자 배지(복습할 용어 · 회고할 일지). */
async function updateBadges() {
  try {
    const [counts, dueJournal] = await Promise.all([reviewCounts(), journalView.countDueJournal()]);
    setBadge('review', counts.due + counts.fresh);
    setBadge('journal', dueJournal);
  } catch (err) {
    console.error(err);
  }
}

function setBadge(tab, n) {
  const badge = document.querySelector(`#tabbar a[data-tab="${tab}"] .tab-badge`);
  if (!badge) return;
  badge.hidden = !(n > 0);
  badge.textContent = n > 99 ? '99+' : String(n);
  const link = badge.closest('a');
  const base = link.dataset.label;
  link.setAttribute('aria-label', n > 0 ? `${base} (${n}개)` : base);
}

/* ───────────────────────── 화면 이동 · 앱으로 돌아오기 ───────────────────────── */

/** 화면 이동. 새 버전이 넘겨받아 기다리는 중이면 이때 새로고침해 새 버전으로 연다(update.js). */
function onHashChange() {
  if (isUpdatePending()) applyUpdate();
  else route();
}

/** 오늘 화면이 무엇을 보여 줘야 하는지(날짜·강의). 바뀌었으면 다시 그린다. */
async function todayKeyNow() {
  const { kind, item } = await resolveToday();
  return `${kstDate()}|${kind}|${item?.date ?? ''}`;
}

/** 오늘 화면을 켜 둔 채 나갔다가 돌아왔을 때 새 강의가 올라왔거나 날짜가 바뀌었으면 새로 그린다. */
async function refreshTodayIfChanged() {
  if (!todayKey || parseHash().path !== '/today') return;
  invalidateIndex();
  const key = await todayKeyNow();
  if (key === todayKey || parseHash().path !== '/today') return;
  if (isUpdatePending()) applyUpdate();
  else route();
}

function onVisibilityChange() {
  if (document.hidden) {
    hiddenAt = Date.now();
    return;
  }
  updateBadges();
  if (hiddenAt && Date.now() - hiddenAt >= RESUME_REFRESH_MS) refreshTodayIfChanged().catch(() => {});
}

/* ───────────────────────── 시작 ───────────────────────── */

async function init() {
  await db.openDb();
  const settings = await db.getSettings();
  applyAppearance(settings);
  if (!settings.firstUseAt) await db.setSetting('firstUseAt', new Date().toISOString());
  db.requestPersist();

  window.addEventListener('hashchange', onHashChange);
  for (const name of ['ss:terms-changed', 'ss:journal-changed', 'ss:review-changed']) {
    document.addEventListener(name, updateBadges);
  }
  window.addEventListener('offline', () => toast('오프라인이에요. 저장된 내용으로 계속 볼 수 있어요.'));
  window.addEventListener('online', () => { prefetchRecent(7).catch(() => {}); });
  document.addEventListener('visibilitychange', onVisibilityChange);

  if (!location.hash || location.hash === '#') location.replace('#/today');
  else route();
  registerServiceWorker();
  announceUpdate();
}

init().catch((err) => {
  console.error(err);
  const view = document.getElementById('view');
  if (view) {
    view.textContent = '앱을 시작하지 못했어요. 페이지를 새로고침해 주세요.';
    view.className = 'boot-error';
  }
});
