#!/usr/bin/env node
// tests/smoke.spec.mjs — 실제 브라우저(Chromium)로 사용 흐름 전체를 확인한다
//
//   node tests/smoke.spec.mjs                     (Playwright 가 설치돼 있어야 한다)
//   SMOKE_SHOTS=/tmp/shots node tests/smoke.spec.mjs   화면 사진도 저장
//   SMOKE_CHANNEL=chrome node tests/smoke.spec.mjs     설치된 Google Chrome 으로 실행(CI)
//
// 두 화면 크기(폰 390×844, 노트북 1280×800)에서 차례로:
//   강의 → 용어 카드(관련 용어·뒤로) → ⭐ 저장 → 출처 카드 → 퀴즈 → 복습(FSRS) → 일지 작성(XSS 문자열)
//   → 회고 대기 표시 → 회고 → 계산기 → 백업 내보내기 → 전체 삭제 → 가져오기 → 오프라인 → 가로 넘침 검사

import { createRequire } from 'node:module';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../tools/serve.mjs';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.log('Playwright 를 찾을 수 없어 스모크 테스트를 건너뜁니다. (npm i -D playwright && npx playwright install chromium)');
  process.exit(0);
}

const SHOTS = process.env.SMOKE_SHOTS || '';
const LESSON_DATE = '2026-11-11';
const XSS_NAME = '<img src=x onerror="window.__xss=1">LG에너지솔루션';
const failures = [];

function check(cond, message) {
  if (!cond) throw new Error(message);
}

let currentPage = null;

/** 실패했을 때 화면 상태를 알려 준다(원인 찾기용). */
async function diagnose(page) {
  if (!page) return '';
  try {
    return await page.evaluate(() => {
      const sheet = document.getElementById('sheet-root');
      const modal = document.getElementById('modal-root');
      return JSON.stringify({
        hash: location.hash,
        htmlClass: document.documentElement.className,
        sheetBack: document.documentElement.hasAttribute('data-sheet-back'),
        sheetRoot: `${sheet.className}|children=${sheet.children.length}`,
        modal: modal.children.length,
        scrollY: window.scrollY,
        active: document.activeElement?.outerHTML.slice(0, 80),
        view: document.querySelector('#view')?.innerText.slice(0, 120),
      });
    });
  } catch (err) {
    return `진단 실패: ${err.message}`;
  }
}

async function step(label, fn) {
  const started = Date.now();
  try {
    await fn();
    console.log(`  ✓ ${label} (${Date.now() - started}ms)`);
  } catch (err) {
    const detail = err.message.split('\n').filter((l) => l.trim()).slice(0, 8).join('\n    ');
    console.log(`  ✗ ${label}\n    ${detail}\n    상태: ${await diagnose(currentPage)}`);
    failures.push(`${label}: ${err.message.split('\n')[0]}`);
    throw err;
  }
}

async function noHorizontalScroll(page, where) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  check(sw <= iw + 1, `${where}: 가로로 넘칩니다(scrollWidth ${sw} > ${iw})`);
}

async function shot(page, name) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}

async function go(page, hash) {
  // 시트를 닫으며 시작된 '뒤로 가기' 처리가 끝난 뒤에 이동한다(사람이 누르는 링크는 앱이 알아서 기다려 준다).
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-sheet-back'));
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForFunction((h) => location.hash === h, hash);
  await page.waitForSelector('#view .page:not(:has(.loading))', { timeout: 10000 });
}

/** 확인 창의 [확인]을 누르고, 그 창이 닫힐 때까지(또는 다음 확인 창으로 바뀔 때까지) 기다린다. */
async function confirmModal(page) {
  const title = await page.locator('#modal-root .modal h2').innerText();
  await page.locator('#modal-root [data-modal="ok"]').click();
  await page.waitForFunction((prev) => {
    const m = document.querySelector('#modal-root .modal');
    return !m || m.querySelector('h2')?.textContent !== prev;
  }, title);
}

async function run(browser, base, size, tag) {
  console.log(`\n▶ ${tag} (${size.width}×${size.height})`);
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, locale: 'ko-KR', timezoneId: 'Asia/Seoul', acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(Number(process.env.SMOKE_TIMEOUT) || 15000);
  currentPage = page;
  const errors = [];
  let offline = false;
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // 오프라인 시험 중에는 앱이 최신본을 확인하려다 실패한 요청이 콘솔에 찍힌다(앱은 기기 사본을 쓴다). 예상된 동작이다.
    if (offline && /Failed to load resource|ERR_INTERNET_DISCONNECTED|ERR_FAILED/.test(m.text())) return;
    errors.push(`console: ${m.text()}`);
  });
  page.on('dialog', async (d) => { errors.push(`예상하지 못한 대화상자: ${d.message()}`); await d.dismiss(); });

  try {
    await step('강의 화면이 열린다', async () => {
      await page.goto(`${base}#/lesson/${LESSON_DATE}`);
      await page.locator('.lesson-title').waitFor();
      check((await page.locator('.lesson-title').innerText()).includes('PER'), '강의 제목이 다릅니다');
      check(await page.locator('.disclaimer').first().isVisible(), '교육용 고지가 보이지 않습니다');
      await noHorizontalScroll(page, '강의');
      await shot(page, `${tag}-lesson`);
    });

    await step('용어를 누르면 카드가 뜨고, 관련 용어로 이동·뒤로가 된다', async () => {
      await page.locator('.lesson-body .term[data-term="per"]').first().click();
      const title = page.locator('#sheet-root .term-title');
      await title.waitFor();
      check((await title.innerText()).includes('PER'), '용어 카드 제목이 다릅니다');
      check((await page.locator('#sheet-root .term-en').innerText()).includes('P/E'), '영어 표현이 없습니다');
      check(await page.locator('#sheet-root .term-formula').isVisible(), '공식이 없습니다');
      await shot(page, `${tag}-term-card`);
      await page.locator('#sheet-root [data-related="eps"]').click();
      await page.waitForFunction(() => document.querySelector('#sheet-root .term-title')?.textContent.includes('EPS'));
      await page.locator('#sheet-root [data-act="back"]').click();
      await page.waitForFunction(() => document.querySelector('#sheet-root .term-title')?.textContent.includes('PER'));
    });

    await step('⭐ 를 누르면 용어장에 저장된다', async () => {
      await page.locator('#sheet-root [data-act="star"]').click();
      await page.locator('#toast-root .toast', { hasText: '용어장에 저장' }).waitFor();
      await page.waitForFunction(() => document.querySelector('#sheet-root [data-act="star"]')?.getAttribute('aria-pressed') === 'true');
      await page.locator('#sheet-root .sheet [data-sheet-close]').first().click();
      await page.locator('#sheet-root .sheet').waitFor({ state: 'detached' });
      check(await page.locator('[data-term-chip="per"].saved').count() === 1, '오늘의 용어 칩에 저장 표시가 없습니다');
    });

    await step('숫자 ⓘ 를 누르면 출처·기준일이 보인다', async () => {
      await page.locator('.lesson-body .fact-info[data-fact="0"]').click();
      await page.locator('#sheet-root .fact-title').waitFor();
      const text = await page.locator('#sheet-root .sheet-content').innerText();
      check(text.includes('삼성전자 종가') && text.includes('기준일') && text.includes('2026년 11월 11일'), '출처 카드 내용이 다릅니다');
      const href = await page.locator('#sheet-root a.btn.primary').getAttribute('href');
      check(href && href.startsWith('https://'), '출처 링크가 https 가 아닙니다');
      await page.keyboard.press('Escape');
      await page.locator('#sheet-root .sheet').waitFor({ state: 'detached' });
    });

    await step('퀴즈 3문제를 풀고 결과를 본다', async () => {
      await page.locator(`a[href="#/quiz/${LESSON_DATE}"]`).click();
      await page.locator('.question').waitFor();
      for (const answer of [1, 2, 2]) {
        await page.locator(`.choice[data-choice="${answer}"]`).click();
        await page.locator('.explain.right').waitFor();
        await page.locator('[data-act="next"]').click();
      }
      await page.locator('.score').waitFor();
      check((await page.locator('.score').innerText()).replace(/\s/g, '') === '3/3', '점수가 3/3 이 아닙니다');
      await shot(page, `${tag}-quiz-result`);
    });

    await step('복습: 정답 보기 → 4개 버튼(다음 간격 표시) → 평가', async () => {
      await go(page, '#/review');
      check((await page.locator('[data-stat="fresh"]').innerText()).trim() === '1', '새 용어 수가 1이 아닙니다');
      await page.locator('[data-act="reveal"]').click();
      const labels = await page.locator('.rate .interval').allInnerTexts();
      check(labels.length === 4 && labels.every((t) => t.trim()), '다음 간격 표시가 없습니다');
      await shot(page, `${tag}-review`);
      await page.locator('[data-rate="3"]').click();         // 알맞음 → 10분 뒤(이번 복습 안에서 한 번 더)
      await page.locator('[data-act="reveal"]').click();
      await page.locator('[data-rate="4"]').click();         // 쉬움 → 며칠 뒤
      await page.locator('.empty', { hasText: '복습 1개를 마쳤어요' }).waitFor();
      check(!(await page.locator('#tabbar a[data-tab="review"] .tab-badge').isVisible()), '복습 배지가 남아 있습니다');
    });

    await step('용어장에서 검색·상세를 본다', async () => {
      await go(page, '#/glossary');
      await page.locator('.row', { hasText: 'PER' }).first().waitFor();
      await page.locator('input[name="q"]').fill('주가수익');
      await page.waitForTimeout(250);
      check(await page.locator('.list .row').count() === 1, '검색 결과가 1개가 아닙니다');
      await page.locator('.list .row').first().click();
      await page.locator('#sheet-root .kv').waitFor();
      check((await page.locator('#sheet-root .sheet-content').innerText()).includes('학습 중'), '상태가 학습 중이 아닙니다');
      await page.keyboard.press('Escape');
    });

    let journalUrl = '';
    await step('일지 작성: 위험한 글자도 그대로 글자로 저장된다(XSS 무해화)', async () => {
      await go(page, '#/journal/new');
      await page.locator('input[name="date"]').fill('2026-08-03');
      await page.locator('input[name="stockName"]').fill(XSS_NAME);
      await page.locator('label:has(input[name="entryAction"][value="watch"])').click();
      await page.locator('input[name="price"]').fill('412,000');
      await page.locator('textarea[name="reason"]').fill('ESS 수주가 늘고 보조금 없이도 영업이익이 흑자라서 계속 지켜본다');
      await page.locator('label:has(input[name="revisitPreset"][value="1"])').click();
      check((await page.locator('[data-role="revisit-text"]').innerText()).includes('2026년 9월 3일'), '다시 볼 날 계산이 다릅니다');
      await page.locator('form button[type="submit"]').click();
      await page.waitForFunction(() => /^#\/journal\/[0-9a-f-]{36}$/.test(location.hash));
      journalUrl = await page.evaluate(() => location.hash);
      await page.locator('.journal-head h1').waitFor();
      check((await page.locator('.journal-head h1').innerText()) === XSS_NAME, '종목명이 그대로 보이지 않습니다');
      check(await page.evaluate(() => window.__xss === undefined), '스크립트가 실행됐습니다(XSS)');
      check(await page.locator('.journal-head img').count() === 0, 'img 태그가 만들어졌습니다');
    });

    await step('다시 볼 날이 지난 일지는 오늘 화면·탭 배지에 표시된다', async () => {
      await go(page, `#/lesson/${LESSON_DATE}`);
      await go(page, '#/today');
      await page.locator('.link-card', { hasText: '회고할 일지 1개' }).waitFor();
      check((await page.locator('#tabbar a[data-tab="journal"] .tab-badge').innerText()).trim() === '1', '일지 배지가 1이 아닙니다');
    });

    await step('회고를 쓰면 회고 대기에서 빠진다', async () => {
      await go(page, journalUrl);
      await page.locator('[data-role="review-form"]').waitFor();
      await page.locator('label:has(input[name="verdict"][value="partial"])').click();
      await page.locator('textarea[name="note"]').fill('ESS 출하는 늘었지만 순이익은 적자였다');
      await page.locator('textarea[name="learned"]').fill('영업이익과 순이익을 함께 보자');
      await page.locator('[data-role="review-form"] button[type="submit"]').click();
      await page.locator('.state.done').waitFor();
      await page.waitForFunction(() => document.querySelector('#tabbar a[data-tab="journal"] .tab-badge')?.hidden === true);
    });

    await step('계산기: PER 역산과 복리 그래프', async () => {
      await go(page, '#/calc/valuation');
      await page.locator('input[name="price"]').fill('50000');
      await page.locator('input[name="eps"]').fill('4000');
      await page.locator('[data-role="result"]', { hasText: '12.5배' }).waitFor();
      await go(page, '#/calc/dividend');
      await page.locator('input[name="price"]').fill('50,000');
      await page.locator('input[name="dps"]').fill('2,000');
      await page.locator('[data-role="result"]', { hasText: '3.38%' }).waitFor();
      await go(page, '#/calc/avgcost');
      for (const [n, v] of [['qty', '10'], ['avgPrice', '50000'], ['addQty', '10'], ['addPrice', '40000']]) await page.locator(`input[name="${n}"]`).fill(v);
      await page.locator('[data-role="result"]', { hasText: '45,000원' }).waitFor();
      await go(page, '#/calc/compound');
      await page.locator('svg.chart').waitFor();
      check((await page.locator('[data-role="result"]').innerText()).includes('2.6억 원'), '복리 결과가 다릅니다');
      await noHorizontalScroll(page, '계산기');
      await shot(page, `${tag}-calc`);
    });

    let backupPath = '';
    await step('백업 내보내기 → 전체 삭제(2번 확인) → 가져오기 하면 일지까지 그대로 돌아온다', async () => {
      await go(page, '#/settings');
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-act="export"]').click()]);
      check(/^DailyStock-backup-\d{4}-\d{2}-\d{2}\.json$/.test(download.suggestedFilename()), '백업 파일 이름이 다릅니다');
      const dir = await mkdtemp(path.join(os.tmpdir(), 'ss-smoke-'));
      backupPath = path.join(dir, download.suggestedFilename());
      await download.saveAs(backupPath);
      const backup = JSON.parse(await readFile(backupPath, 'utf8'));
      check(backup.app === 'DailyStockStudy' && backup.backup_version === 1, '백업 형식이 다릅니다');
      check(backup.journal.length === 1 && backup.journal[0].name === XSS_NAME && backup.journal[0].review?.verdict === 'partial', '백업에 일지가 없습니다');
      check(backup.terms.length === 1 && backup.terms[0].id === 'per' && backup.terms[0].card.reps === 2, '백업에 용어·복습 상태가 없습니다');
      check(backup.quizResults.length === 3, '백업에 퀴즈 결과가 없습니다');

      await page.locator('[data-act="wipe"]').click();
      await confirmModal(page);
      await confirmModal(page);
      await page.locator('.kv dd', { hasText: '용어 0 · 일지 0' }).waitFor();

      await page.locator('#import-file').setInputFiles(backupPath);
      await page.locator('#modal-root .modal').waitFor();
      check((await page.locator('#modal-root .modal-message').innerText()).includes('투자 일지 1개'), '가져오기 요약이 다릅니다');
      await confirmModal(page);
      await page.locator('.kv dd', { hasText: '용어 1 · 일지 1' }).waitFor();
      await go(page, '#/journal');
      check((await page.locator('.journal-list .row-title').first().innerText()) === XSS_NAME, '가져온 일지가 보이지 않습니다');
      await go(page, '#/review');
      check((await page.locator('.stat b').nth(2).innerText()).trim() === '1', '가져온 용어가 보이지 않습니다');
    });

    await step('설정: 다크 모드·글자 크기가 바로 적용되고 새로고침 뒤에도 유지된다', async () => {
      await go(page, '#/settings');
      await page.locator('label:has(input[name="theme"][value="dark"])').click();
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      await page.locator('label:has(input[name="fontScale"][value="1.12"])').click();
      await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--font-scale') === '1.12');
      await shot(page, `${tag}-settings-dark`);
      await page.reload();
      await page.locator('.settings').waitFor();
      check(await page.evaluate(() => document.documentElement.dataset.theme) === 'dark', '새로고침 뒤 다크 모드가 풀렸습니다');
      await page.locator('label:has(input[name="theme"][value="system"])').click();
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-theme'));
      await page.locator('label:has(input[name="fontScale"][value="1"])').click();
      await page.waitForTimeout(150);
    });

    await step('비행기 모드(오프라인)에서도 열어 본 강의·용어장·일지·계산기·복습이 동작한다', async () => {
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
      await page.reload();
      await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 10000 });
      await context.setOffline(true);
      offline = true;
      try {
        await page.goto(`${base}#/lesson/${LESSON_DATE}`);
        await page.locator('.lesson-title').waitFor({ timeout: 10000 });
        await page.locator('.lesson-body .term[data-term="per"]').first().click();
        await page.locator('#sheet-root .term-title').waitFor();
        await page.keyboard.press('Escape');
        for (const [hash, sel] of [['#/glossary', '.list .row'], ['#/journal', '.journal-list .row'], ['#/calc/compound', 'svg.chart'], ['#/review', '.stat'], ['#/curriculum', '.track-card']]) {
          await go(page, hash);
          await page.locator(sel).first().waitFor({ timeout: 5000 });
        }
        await shot(page, `${tag}-offline-curriculum`);
      } finally {
        await context.setOffline(false);
        await page.waitForTimeout(300);
        offline = false;
      }
    });

    await step('모든 화면이 가로로 넘치지 않는다', async () => {
      for (const hash of ['#/today', '#/review', '#/glossary', '#/curriculum', '#/archive', '#/journal', '#/journal/new', '#/calc/valuation', '#/calc/dividend', '#/calc/avgcost', '#/settings', '#/quiz/wrong', '#/quiz/weekly']) {
        await go(page, hash);
        await noHorizontalScroll(page, hash);
      }
    });

    await step('브라우저 오류(스크립트 오류·콘솔 오류·예상 못 한 대화상자)가 없다', async () => {
      check(errors.length === 0, errors.join(' / '));
    });
  } finally {
    if (errors.length) console.log(`  브라우저 오류:\n    ${errors.join('\n    ')}`);
    await context.close();
  }
}

const server = await startServer({ port: 0 });
const channel = process.env.SMOKE_CHANNEL || undefined;
const browser = await chromium.launch(channel ? { channel } : {});
console.log(`브라우저: ${channel ?? 'Playwright Chromium'} ${browser.version()}`);
let ok = true;
for (const [size, tag] of [[{ width: 390, height: 844 }, 'phone'], [{ width: 1280, height: 800 }, 'laptop']]) {
  try {
    await run(browser, server.url, size, tag);
  } catch {
    ok = false;
  }
}
await browser.close();
await server.close();
if (!ok) {
  console.log(`\n스모크 테스트 실패 (${failures.length}건)`);
  process.exitCode = 1;
} else {
  console.log('\n스모크 테스트 통과');
}
