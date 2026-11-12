// tests/app.test.mjs — 앱 파일 구성·설치 조건·개인 정보 보호 점검

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../tools/common.mjs';
import { checkSw, shellList } from '../tools/sw-version.mjs';

const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');
const exists = async (rel) => {
  try { await stat(path.join(ROOT, rel)); return true; } catch { return false; }
};

test('서비스 워커: 셸 목록이 빠짐없고 BUILD 값이 최신이다', async () => {
  const r = await checkSw(ROOT);
  assert.deepEqual(r.errors, []);
  const list = shellList(await read('sw.js'));
  assert.ok(list.includes('./') && list.includes('index.html'));
  assert.ok(list.every((p) => !p.startsWith('/') && !p.includes('://')), '모든 경로는 상대 경로여야 한다(GitHub Pages 하위 경로)');
});

test('매니페스트: 설치 조건(이름·아이콘 192/512·standalone·상대 경로)', async () => {
  const m = JSON.parse(await read('manifest.webmanifest'));
  assert.equal(m.name, 'Daily Stock Study');
  assert.equal(m.short_name, '주식공부');
  assert.equal(m.display, 'standalone');
  assert.equal(m.lang, 'ko');
  assert.ok(m.start_url.startsWith('./'));
  assert.equal(m.scope, './');
  const sizes = m.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  for (const icon of m.icons) {
    assert.ok(await exists(icon.src), icon.src);
    const buf = await readFile(path.join(ROOT, icon.src));
    const [w, h] = icon.sizes.split('x').map(Number);
    assert.equal(buf.readUInt32BE(16), w, `${icon.src} 너비`);
    assert.equal(buf.readUInt32BE(20), h, `${icon.src} 높이`);
  }
});

test('index.html: 참조하는 파일이 모두 있고, 다른 서버로 보내지 못하게 막는 보안 정책이 있다', async () => {
  const htmlText = await read('index.html');
  const refs = [...htmlText.matchAll(/(?:href|src)="([^"#:]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 6);
  for (const ref of refs) assert.ok(await exists(ref), `없는 파일: ${ref}`);
  const csp = htmlText.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /connect-src 'self'/, '네트워크 요청은 같은 출처(GitHub Pages)로만');
  assert.match(csp, /script-src 'self'(;|$)/, '외부·인라인 스크립트 금지');
  assert.match(htmlText, /<html lang="ko">/);
  assert.match(htmlText, /name="viewport"/);
  assert.match(htmlText, /apple-touch-icon/);
});

test('개인 정보: 앱 코드에서 네트워크로 보내는 곳은 강의 불러오기(GET) 하나뿐이다', async () => {
  const files = (await readdir(path.join(ROOT, 'js'))).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    const src = await read(`js/${f}`);
    assert.doesNotMatch(src, /XMLHttpRequest|sendBeacon|WebSocket|EventSource|navigator\.share\(\{[^}]*url/, `${f}`);
    if (f !== 'lessons.js') assert.doesNotMatch(src, /\bfetch\(/, `${f} 에서 fetch 를 쓰면 안 됩니다`);
  }
  const lessonsSrc = await read('js/lessons.js');
  assert.doesNotMatch(lessonsSrc, /method:\s*['"](POST|PUT|PATCH|DELETE)/i);
  const journalSrc = await read('js/journal.js');
  assert.doesNotMatch(journalSrc, /fetch|navigator\.share|https?:\/\//, '일지 화면은 외부와 통신하지 않는다');
});

test('저장소에 개인 정보(메일 주소)가 들어 있지 않다', async () => {
  const targets = ['README.md', 'prompts/daily-task.md', 'package.json', 'index.html', 'manifest.webmanifest'];
  for (const rel of targets) {
    if (!(await exists(rel))) continue;
    const text = await read(rel);
    assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@(?!anthropic\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, `${rel} 에 메일 주소처럼 보이는 글자가 있습니다`);
  }
});

test('모든 화면에 교육용 고지가 있다', async () => {
  const lessonSrc = await read('js/lesson.js');
  assert.match(lessonSrc, /교육용 정보이며 투자 권유가 아닙니다/);
  for (const f of ['js/calc.js', 'js/settings.js']) assert.match(await read(f), /투자 권유가 아닙니다/, f);
  assert.match(await read('index.html'), /교육용 정보이며 투자 권유가 아닙니다/);
});
