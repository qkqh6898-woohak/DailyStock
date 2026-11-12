// settings.js — 설정 (#/settings)
//   발음 · 읽기 · 복습 · 계산기 · 데이터(백업/복원/전체 삭제) · 설치 방법 · 앱 정보 · 고지 전문

import { html, setHtml, toast, formatDateTimeKo, kstDateOf, diffDays, kstDate, parseInputNumber } from './util.js';
import * as db from './db.js';
import * as tts from './tts.js';
import { confirmDialog } from './popup.js';
import { BACKUP_STORES, backupFileName, buildBackup, mergeBackup, parseBackup } from './backup.js';
import { canInstall, isStandalone, onInstallChange, platform, promptInstall } from './install.js';

export const APP_VERSION = '1.0.0';
export const REPO_URL = 'https://github.com/qkqh6898-woohak/DailyStock';
const BACKUP_REMIND_DAYS = 14;
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

export const DISCLAIMER_FULL = [
  'Daily Stock Study는 개인 학습을 위한 교육용 앱입니다. 강의·용어·사례·퀴즈·계산 결과는 정보 제공을 목적으로 하며, 특정 종목의 매수·매도 권유나 투자 자문이 아닙니다.',
  '강의에 쓰인 숫자는 표시된 기준일과 출처를 바탕으로 하며, 이후 달라지거나 오류가 있을 수 있습니다. 투자 판단 전에는 전자공시(DART) 등 원자료를 직접 확인하세요.',
  '세금·제도 정보는 작성 시점 기준이며 바뀔 수 있습니다. 투자에 따른 손익과 책임은 투자자 본인에게 있습니다.',
];

const THEMES = [['system', '기기 설정'], ['light', '라이트'], ['dark', '다크']];
const FONT_SCALES = [[0.9, '작게'], [1, '보통'], [1.12, '크게'], [1.25, '아주 크게']];
const RETENTIONS = [[0.85, '0.85 · 복습 적게'], [0.9, '0.90 · 기본'], [0.93, '0.93'], [0.95, '0.95 · 복습 많이']];

/* ───────────────────────── 화면 모양(테마·글자 크기) ───────────────────────── */

const FORCED_THEME_COLOR = { light: '#2f5bea', dark: '#10141f' };

/** 테마·글자 크기를 바로 적용하고, 다음 실행 때 깜빡이지 않도록 localStorage 에도 적어 둔다. */
export function applyAppearance(settings) {
  const root = document.documentElement;
  const theme = settings?.theme;
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
  const raw = Number(settings?.fontScale);
  const scale = raw >= 0.8 && raw <= 1.5 ? raw : 1;
  root.style.setProperty('--font-scale', String(scale));
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    if (!meta.dataset.original) meta.dataset.original = meta.getAttribute('content') ?? '';
    meta.setAttribute('content', FORCED_THEME_COLOR[theme] ?? meta.dataset.original);
  }
  try {
    if (theme === 'light' || theme === 'dark') localStorage.setItem('ss-theme', theme);
    else localStorage.removeItem('ss-theme');
    localStorage.setItem('ss-font-scale', String(scale));
  } catch { /* localStorage 를 못 써도 이번 실행에는 적용된다 */ }
}

/* ───────────────────────── 백업 ───────────────────────── */

async function collectData() {
  const data = {};
  for (const name of BACKUP_STORES) data[name] = await db.getAll(name);
  return data;
}

/** 백업 파일을 만든다. share=true 이고 기기가 지원하면 공유 창(드라이브·메일 등)으로 보낸다. */
async function exportBackup({ share = false } = {}) {
  const backup = buildBackup(await collectData());
  const text = JSON.stringify(backup, null, 2);
  const name = backupFileName();
  if (share) {
    const file = new File([text], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Daily Stock Study 백업' });
      } catch (err) {
        if (err && err.name === 'AbortError') return false;
        throw err;
      }
      await db.setSetting('lastBackupAt', backup.exported_at);
      return true;
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  await db.setSetting('lastBackupAt', backup.exported_at);
  return true;
}

function describeCounts(counts) {
  return `용어 ${counts.terms}개 · 투자 일지 ${counts.journal}개 · 복습 기록 ${counts.reviewLogs}개 · 퀴즈 결과 ${counts.quizResults}개 · 진도 ${counts.progress}개`;
}

/** 백업 파일을 가져온다. mode: 'merge'(병합) | 'replace'(덮어쓰기) */
async function importBackup(file, mode) {
  if (file.size > MAX_IMPORT_BYTES) throw new Error('파일이 너무 커요(최대 20MB).');
  let obj;
  try {
    obj = JSON.parse(await file.text());
  } catch {
    throw new Error('JSON 파일을 읽을 수 없어요. 이 앱에서 내보낸 백업 파일인지 확인해 주세요.');
  }
  const parsed = parseBackup(obj);
  if (!parsed.ok) throw new Error(parsed.error);

  const when = parsed.exportedAt ? formatDateTimeKo(parsed.exportedAt) : '날짜 미상';
  const ok = await confirmDialog({
    title: mode === 'replace' ? '덮어쓰기로 가져올까요?' : '백업을 합쳐서 가져올까요?',
    message: `${when}에 만든 백업 — ${describeCounts(parsed.counts)}.${parsed.skipped ? ` 읽을 수 없는 항목 ${parsed.skipped}개는 건너뜁니다.` : ''} `
      + (mode === 'replace'
        ? '지금 이 기기의 기록은 모두 지워지고 백업 내용으로 바뀝니다.'
        : '같은 항목은 더 최근에 고친 쪽을 남깁니다.'),
    confirmText: mode === 'replace' ? '덮어쓰기' : '가져오기',
    danger: mode === 'replace',
  });
  if (!ok) return false;

  const data = mode === 'replace' ? parsed.data : mergeBackup(await collectData(), parsed.data);
  await db.replaceStores(data, { clearFirst: true });
  db.resetSettingsCache();
  applyAppearance(await db.getSettings());
  for (const name of ['ss:terms-changed', 'ss:journal-changed', 'ss:review-changed', 'ss:progress-changed']) {
    document.dispatchEvent(new CustomEvent(name));
  }
  return true;
}

async function wipeAll() {
  const first = await confirmDialog({
    title: '모든 기록을 지울까요?',
    message: '용어장, 복습 기록, 퀴즈 결과, 진도, 투자 일지, 설정이 이 기기에서 모두 지워집니다. 먼저 백업해 두는 것을 권해요.',
    confirmText: '계속',
    danger: true,
  });
  if (!first) return false;
  const second = await confirmDialog({
    title: '정말 모두 지울까요?',
    message: '지운 기록은 되돌릴 수 없어요. 백업 파일이 있으면 나중에 다시 가져올 수 있어요.',
    confirmText: '모두 지우기',
    danger: true,
  });
  if (!second) return false;
  await db.wipeUserData();
  for (const row of await db.getAll('cache')) {
    if (typeof row.key === 'string' && row.key.startsWith('weekly:')) await db.del('cache', row.key);
  }
  try {
    for (const key of ['ss-theme', 'ss-font-scale', 'ss-install-dismissed']) localStorage.removeItem(key);
  } catch { /* 무시 */ }
  await db.setSetting('firstUseAt', new Date().toISOString());
  applyAppearance(await db.getSettings());
  for (const name of ['ss:terms-changed', 'ss:journal-changed', 'ss:review-changed', 'ss:progress-changed']) {
    document.dispatchEvent(new CustomEvent(name));
  }
  return true;
}

/* ───────────────────────── 화면 ───────────────────────── */

function segmented(name, options, current, label) {
  return html`<div class="segmented" role="radiogroup" aria-label="${label}">
    ${options.map(([value, text]) => html`<label class="${String(current) === String(value) ? 'on' : ''}">
      <input type="radio" name="${name}" value="${value}" ${String(current) === String(value) ? 'checked' : ''}>${text}</label>`)}
  </div>`;
}

async function storageInfo() {
  const out = { persisted: null, usage: null };
  try {
    if (navigator.storage?.persisted) out.persisted = await navigator.storage.persisted();
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      if (Number.isFinite(est.usage)) out.usage = est.usage;
    }
  } catch { /* 지원하지 않는 브라우저 */ }
  return out;
}

function bytesText(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export async function render(page, params = {}, query = {}) {
  const settings = await db.getSettings();
  const [termCount, journalCount, logCount, quizCount, progressCount, storage] = await Promise.all([
    db.count('terms'), db.count('journal'), db.count('reviewLogs'), db.count('quizResults'), db.count('progress'), storageInfo(),
  ]);
  const today = kstDate();
  const lastBackupDay = settings.lastBackupAt ? kstDateOf(settings.lastBackupAt) : null;
  const sinceBackup = lastBackupDay ? diffDays(lastBackupDay, today) : null;
  const firstDay = settings.firstUseAt ? kstDateOf(settings.firstUseAt) : null;
  const hasData = termCount + journalCount > 0;
  const backupLate = hasData && (sinceBackup !== null ? sinceBackup > BACKUP_REMIND_DAYS : (firstDay ? diffDays(firstDay, today) > BACKUP_REMIND_DAYS : false));
  const plat = platform();
  const standalone = isStandalone();
  let importMode = 'merge';

  setHtml(page, html`<div class="settings">
    <header class="page-head"><h1>⚙️ 설정</h1></header>
    ${db.memoryOnly ? html`<p class="notice warn">이 브라우저에서는 저장 기능을 쓸 수 없어요(사생활 보호 모드 등). 창을 닫으면 기록이 사라집니다.</p>` : ''}

    <section class="card" aria-labelledby="h-speech">
      <h2 id="h-speech">🔊 발음</h2>
      ${tts.isSupported() ? html`
        <div class="setting">
          <label class="setting-inline"><span class="setting-title">영어 음성</span>
            <select name="ttsVoiceEn"><option value="">자동</option></select></label>
          <button type="button" class="btn ghost small" data-act="test-en">영어 들어 보기</button>
        </div>
        <div class="setting">
          <label class="setting-inline"><span class="setting-title">한국어 음성</span>
            <select name="ttsVoiceKo"><option value="">자동</option></select></label>
          <button type="button" class="btn ghost small" data-act="test-ko">한국어 들어 보기</button>
        </div>
        <div class="setting">
          <span class="setting-title" id="rate-label">읽는 속도</span>
          <div class="range-row">
            <input type="range" name="ttsRate" min="0.7" max="1.3" step="0.1" value="${settings.ttsRate}" aria-labelledby="rate-label">
            <output data-role="rate-out">${Number(settings.ttsRate).toFixed(1)}×</output>
          </div>
        </div>`
        : html`<p class="hint">이 브라우저는 음성 읽기를 지원하지 않아요. Chrome·Safari·Edge 최신 버전에서 쓸 수 있어요.</p>`}
    </section>

    <section class="card" aria-labelledby="h-read">
      <h2 id="h-read">📖 읽기</h2>
      <div class="setting"><span class="setting-title">글자 크기</span>${segmented('fontScale', FONT_SCALES, settings.fontScale, '글자 크기')}</div>
      <div class="setting"><span class="setting-title">화면 테마</span>${segmented('theme', THEMES, settings.theme, '화면 테마')}</div>
    </section>

    <section class="card" aria-labelledby="h-review">
      <h2 id="h-review">🔁 복습</h2>
      <div class="setting">
        <label class="setting-inline"><span class="setting-title">하루 새 용어 수</span>
          <input type="text" inputmode="numeric" name="newPerDay" value="${settings.newPerDay}" style="width:6em;text-align:right" aria-describedby="new-hint"></label>
        <p class="hint" id="new-hint">처음 복습을 시작하는 용어를 하루에 몇 개까지 보여 줄지 정해요(0~50).</p>
      </div>
      <div class="setting">
        <label class="setting-inline"><span class="setting-title">목표 기억률</span>
          <select name="retention">${RETENTIONS.map(([v, t]) => html`<option value="${v}" ${Number(settings.retention) === v ? 'selected' : ''}>${t}</option>`)}</select></label>
        <p class="hint">높일수록 더 자주 복습해서 잘 기억하지만 하루 복습량이 늘어요.</p>
      </div>
    </section>

    <section class="card" aria-labelledby="h-calc">
      <h2 id="h-calc">🧮 계산기</h2>
      <div class="setting">
        <label class="setting-inline"><span class="setting-title">배당 세율 기본값(%)</span>
          <input type="text" inputmode="decimal" name="dividendTaxRate" value="${settings.dividendTaxRate}" style="width:6em;text-align:right"></label>
        <p class="hint">기준: 2026년 국내 배당소득세 15.4%(소득세 14% + 지방소득세 1.4%), 변경될 수 있음.</p>
      </div>
    </section>

    <section class="card" id="s-data" aria-labelledby="h-data">
      <h2 id="h-data">💾 데이터</h2>
      ${backupLate ? html`<p class="notice warn">${sinceBackup !== null ? `마지막 백업 후 ${sinceBackup}일이 지났어요.` : '아직 백업한 적이 없어요.'} 기기를 잃어버리거나 브라우저 데이터를 지우면 기록이 사라질 수 있어요.</p>` : ''}
      <dl class="kv">
        <dt>이 기기의 기록</dt><dd class="num">용어 ${termCount} · 일지 ${journalCount} · 복습 ${logCount} · 퀴즈 ${quizCount} · 진도 ${progressCount}</dd>
        <dt>마지막 백업</dt><dd>${settings.lastBackupAt ? `${formatDateTimeKo(settings.lastBackupAt)} (${sinceBackup}일 전)` : '없음'}</dd>
        <dt>저장 공간 보호</dt><dd>${storage.persisted === null ? '확인 불가' : storage.persisted ? '켜짐 (브라우저가 마음대로 지우지 않아요)' : '꺼짐 (공간이 부족하면 지워질 수 있어요)'}${storage.usage !== null ? ` · 사용 ${bytesText(storage.usage)}` : ''}</dd>
      </dl>
      <div class="setting">
        <span class="setting-title">백업 내보내기</span>
        <p class="hint">용어장·복습 기록·퀴즈 결과·진도·투자 일지·설정을 JSON 파일 하나로 저장해요. 파일에는 개인 기록이 들어 있으니 공개된 곳에 올리지 마세요.</p>
        <div class="toolbar">
          <button type="button" class="btn primary" data-act="export">백업 파일 저장</button>
          ${typeof navigator !== 'undefined' && navigator.canShare ? html`<button type="button" class="btn ghost" data-act="share">공유로 보내기</button>` : ''}
        </div>
      </div>
      <div class="setting">
        <span class="setting-title">백업 가져오기</span>
        ${segmented('importMode', [['merge', '병합(추천)'], ['replace', '덮어쓰기']], importMode, '가져오기 방식')}
        <p class="hint" data-role="mode-hint">지금 기록에 백업을 합쳐요. 같은 항목은 더 최근에 고친 쪽을 남겨요.</p>
        <label class="btn ghost block" for="import-file">백업 파일 고르기…</label>
        <input id="import-file" type="file" accept="application/json,.json" hidden>
        <p class="field-error" data-role="import-error" role="alert"></p>
      </div>
      <div class="setting">
        <span class="setting-title">전체 삭제</span>
        <p class="hint">이 기기에 저장된 모든 기록을 지워요(두 번 확인합니다). 강의 내용은 다시 받을 수 있어요.</p>
        <button type="button" class="btn danger ghost" data-act="wipe">모든 기록 지우기</button>
      </div>
    </section>

    <section class="card" aria-labelledby="h-install">
      <h2 id="h-install">📲 홈 화면에 추가</h2>
      ${standalone ? html`<p class="notice private">홈 화면 앱으로 실행 중이에요.</p>` : ''}
      <div data-role="install-slot"></div>
      <h3>Android (Chrome)</h3>
      <ol class="steps">
        <li>Chrome에서 이 주소를 열어요.</li>
        <li>오른쪽 위 ⋮ 메뉴 → <b>앱 설치</b> 또는 <b>홈 화면에 추가</b>를 눌러요.</li>
        <li>홈 화면의 <b>주식공부</b> 아이콘으로 실행해요.</li>
      </ol>
      <h3>iPhone (Safari)</h3>
      <ol class="steps">
        <li>Safari에서 이 주소를 열어요(다른 브라우저 앱에서는 안 될 수 있어요).</li>
        <li>아래쪽 공유 버튼(□↑) → <b>홈 화면에 추가</b>를 눌러요.</li>
        <li>iPhone은 앱마다 저장 공간이 따로라서, Safari에서 쓰던 기록은 홈 화면 앱으로 자동으로 옮겨지지 않아요. 필요하면 백업 → 가져오기로 옮기세요.</li>
      </ol>
      ${plat === 'ios' ? html`<p class="hint">지금 iPhone·iPad로 보고 있어요. 위의 iPhone 방법을 따라 주세요.</p>` : ''}
    </section>

    <section class="card" aria-labelledby="h-about">
      <h2 id="h-about">ℹ️ 앱 정보</h2>
      <dl class="kv">
        <dt>버전</dt><dd class="num">${APP_VERSION}</dd>
        <dt>저장소</dt><dd><a href="${REPO_URL}" target="_blank" rel="noopener noreferrer">GitHub ↗</a></dd>
        <dt>강의</dt><dd>평일 저녁 8시경 새 강의가 올라와요.</dd>
        <dt>개인 정보</dt><dd>용어장·복습·일지는 이 기기의 브라우저 저장소에만 있고, 서버로 보내지 않아요.</dd>
        <dt>사용한 공개 소프트웨어</dt><dd>ts-fsrs (MIT) — 간격 반복 일정 계산</dd>
      </dl>
      <h3>고지</h3>
      ${DISCLAIMER_FULL.map((p) => html`<p class="hint">${p}</p>`)}
    </section>
    <p class="disclaimer">교육용 정보이며 투자 권유가 아닙니다.</p>
  </div>`);

  /* ── 음성 목록 채우기 ── */
  if (tts.isSupported()) {
    const fill = async (lang, name, current) => {
      const select = page.querySelector(`select[name="${name}"]`);
      if (!select) return;
      const voices = await tts.voicesFor(lang);
      if (!page.isConnected) return;
      setHtml(select, html`<option value="">자동${voices.length ? '' : ' (기기에 음성이 없어요)'}</option>
        ${voices.map((v) => html`<option value="${v.voiceURI}" ${v.voiceURI === current ? 'selected' : ''}>${v.name} (${v.lang})</option>`)}`);
    };
    fill('en', 'ttsVoiceEn', settings.ttsVoiceEn);
    fill('ko', 'ttsVoiceKo', settings.ttsVoiceKo);
  }

  /* ── 설치 버튼 ── */
  const installSlot = page.querySelector('[data-role="install-slot"]');
  const drawInstall = () => {
    if (!installSlot.isConnected) return;
    setHtml(installSlot, canInstall() && !standalone
      ? html`<button type="button" class="btn primary block" data-act="install">지금 홈 화면에 설치</button>`
      : html``);
  };
  drawInstall();
  const offInstall = onInstallChange(drawInstall);

  /* ── 값 바꾸기 ── */
  const syncSegments = (input) => {
    for (const label of input.closest('.segmented').querySelectorAll('label')) label.classList.toggle('on', label.querySelector('input').checked);
  };

  page.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.type === 'radio') syncSegments(el);
    switch (el.name) {
      case 'theme':
        applyAppearance({ ...(await db.getSettings()), theme: el.value });
        await db.setSetting('theme', el.value);
        break;
      case 'fontScale':
        applyAppearance({ ...(await db.getSettings()), fontScale: Number(el.value) });
        await db.setSetting('fontScale', Number(el.value));
        break;
      case 'ttsVoiceEn':
      case 'ttsVoiceKo':
        await db.setSetting(el.name, el.value);
        toast('음성을 바꿨어요');
        break;
      case 'ttsRate':
        await db.setSetting('ttsRate', Number(el.value));
        break;
      case 'retention':
        await db.setSetting('retention', Number(el.value));
        toast('목표 기억률을 바꿨어요. 다음 복습부터 적용돼요');
        break;
      case 'newPerDay': {
        const n = parseInputNumber(el.value);
        if (n === null || !Number.isInteger(n) || n < 0 || n > 50) {
          toast('0~50 사이의 정수로 넣어 주세요');
          el.value = String((await db.getSettings()).newPerDay);
          return;
        }
        await db.setSetting('newPerDay', n);
        document.dispatchEvent(new CustomEvent('ss:review-changed'));
        toast(`하루 새 용어 ${n}개로 바꿨어요`);
        break;
      }
      case 'dividendTaxRate': {
        const n = parseInputNumber(el.value);
        if (n === null || n < 0 || n > 50) {
          toast('0~50 사이의 숫자로 넣어 주세요');
          el.value = String((await db.getSettings()).dividendTaxRate);
          return;
        }
        await db.setSetting('dividendTaxRate', n);
        toast(`배당 세율 기본값을 ${n}%로 바꿨어요`);
        break;
      }
      case 'importMode':
        importMode = el.value === 'replace' ? 'replace' : 'merge';
        page.querySelector('[data-role="mode-hint"]').textContent = importMode === 'replace'
          ? '지금 이 기기의 기록을 모두 지우고 백업 내용으로 바꿔요.'
          : '지금 기록에 백업을 합쳐요. 같은 항목은 더 최근에 고친 쪽을 남겨요.';
        break;
      default:
        break;
    }
    if (el.id === 'import-file') {
      const file = el.files?.[0];
      el.value = '';
      if (!file) return;
      const errorSlot = page.querySelector('[data-role="import-error"]');
      errorSlot.textContent = '';
      try {
        const done = await importBackup(file, importMode);
        if (done) {
          toast('백업을 가져왔어요');
          rerender(page, params, query);
        }
      } catch (err) {
        errorSlot.textContent = err.message || '백업을 가져오지 못했어요.';
      }
    }
  });

  page.addEventListener('input', (e) => {
    if (e.target.name === 'ttsRate') page.querySelector('[data-role="rate-out"]').textContent = `${Number(e.target.value).toFixed(1)}×`;
  });

  page.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'test-en') tts.speak('The stock trades at about fifteen times earnings.');
    else if (act === 'test-ko') tts.speakAll(['주가수익비율, PER은 주가를 주당순이익으로 나눈 값입니다.'], { lang: 'ko-KR' });
    else if (act === 'export' || act === 'share') {
      try {
        const done = await exportBackup({ share: act === 'share' });
        if (done) {
          toast('백업 파일을 만들었어요');
          rerender(page, params, query);
        }
      } catch (err) {
        console.error(err);
        toast('백업 파일을 만들지 못했어요');
      }
    } else if (act === 'wipe') {
      if (await wipeAll()) {
        toast('모든 기록을 지웠어요');
        rerender(page, params, query);
      }
    } else if (act === 'install') {
      const outcome = await promptInstall();
      if (outcome === 'accepted') toast('홈 화면에 설치했어요');
      drawInstall();
    }
  });

  if (query.s === 'data') {
    requestAnimationFrame(() => page.querySelector('#s-data')?.scrollIntoView({ block: 'start' }));
  }

  return () => {
    offInstall();
    tts.stop();
  };
}

/** 같은 자리에 설정 화면을 새로 그린다(이벤트가 겹치지 않도록 새 요소를 쓴다). */
function rerender(page, params, query) {
  if (!page.isConnected) return;
  const fresh = document.createElement('div');
  fresh.className = 'page';
  page.replaceWith(fresh);
  render(fresh, params, { ...query, s: 'data' }).catch((err) => console.error(err));
}
