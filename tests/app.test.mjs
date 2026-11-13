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

test('자동 업데이트: 새 서비스 워커가 바로 넘겨받고, 앱은 누를 것 없이 화면 이동 때 새 버전을 연다', async () => {
  const sw = await read('sw.js');
  const install = sw.slice(sw.indexOf("addEventListener('install'"), sw.indexOf("addEventListener('activate'"));
  assert.match(install, /self\.skipWaiting\(\)/, '설치가 끝나면 기다리지 않고 넘겨받아야 한다');
  assert.match(sw, /GET_VERSION/, '설정 화면이 버전을 물을 수 있어야 한다');
  assert.match(sw, /clients\.claim\(\)/);

  const update = await read('js/update.js');
  assert.match(update, /controllerchange/);
  assert.match(update, /registration\.update\(\)/, '앱으로 돌아올 때 직접 새 버전을 확인해야 한다(홈 화면 앱은 오래 켜 둔다)');
  const main = await read('js/main.js');
  assert.match(main, /isUpdatePending\(\)\) applyUpdate\(\)/, '화면을 옮길 때 기다리던 새 버전을 적용해야 한다');
  assert.doesNotMatch(main + update, /새 버전이 있어요/, '사용자에게 [새로고침]을 누르라고 하지 않는다');
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

test('개인 정보: 앱 코드에서 네트워크를 쓰는 곳은 공개 강의 파일 읽기(GET)뿐이다', async () => {
  const files = (await readdir(path.join(ROOT, 'js'))).filter((f) => f.endsWith('.js'));
  const fetchers = ['lessons.js', 'boot.js'];      // 강의 목록·강의·사전·커리큘럼만 읽는다
  for (const f of files) {
    const src = await read(`js/${f}`);
    assert.doesNotMatch(src, /XMLHttpRequest|sendBeacon|WebSocket|EventSource|navigator\.share\(\{[^}]*url/, `${f}`);
    if (!fetchers.includes(f)) assert.doesNotMatch(src, /\bfetch\(/, `${f} 에서 fetch 를 쓰면 안 됩니다`);
  }
  for (const f of fetchers) {
    const src = await read(`js/${f}`);
    assert.doesNotMatch(src, /method:\s*['"](POST|PUT|PATCH|DELETE)/i, f);
    assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /fetch\(\s*['"`]https?:/, `${f}: 다른 서버 주소로 요청하면 안 됩니다`);
  }
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

/* ───────────── PWA 점검표(개인용 6가지) ───────────── */

test('서비스 워커가 쓰는 모든 앱 코드가 첫 화면에서 한꺼번에 내려받아지도록 등록돼 있다(modulepreload)', async () => {
  const htmlText = await read('index.html');
  const preloaded = new Set([...htmlText.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]));
  const modules = (await readdir(path.join(ROOT, 'js'))).filter((f) => f.endsWith('.js') && f !== 'boot.js').map((f) => `js/${f}`);
  for (const m of [...modules, 'vendor/ts-fsrs.umd.js']) assert.ok(preloaded.has(m), `${m} 의 modulepreload 가 없습니다`);
  assert.match(htmlText, /<script src="js\/boot\.js"><\/script>/, 'boot.js 는 head 에서 일반 스크립트로 먼저 실행돼야 합니다');
});

/** CSS 의 색 변수(--name: #hex)를 읽는다. */
function cssVars(block) {
  const out = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)) out[m[1]] = m[2].toLowerCase();
  return out;
}

function luminance(hex) {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** color-mix(in srgb, a p%, b) 와 같은 섞은 색. */
function mix(a, b, p) {
  const ca = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const cb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `#${ca.map((v, i) => Math.round(v * p + cb[i] * (1 - p)).toString(16).padStart(2, '0')).join('')}`;
}

test('색 대비: 라이트·다크 모두 글자와 바탕의 대비가 4.5:1 이상이다', async () => {
  const css = await read('css/app.css');
  const light = cssVars(css.match(/:root \{([\s\S]*?)\n\}/)[1]);
  const dark = { ...light, ...cssVars(css.match(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/)[1]) };
  const systemDark = { ...light, ...cssVars(css.match(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n  \}/)[1]) };
  assert.deepEqual(systemDark, dark, '기기 다크 모드와 직접 고른 다크 모드의 색이 같아야 합니다');
  const pairs = [
    ['text', 'bg'], ['text', 'surface'], ['text-2', 'bg'], ['text-2', 'surface'], ['text-2', 'surface-2'],
    ['primary', 'surface'], ['primary', 'bg'], ['primary-ink', 'primary'], ['primary', 'primary-soft'],
    ['term', 'term-bg'], ['up', 'surface'], ['up', 'bg'], ['down', 'surface'], ['down', 'bg'],
    ['ok', 'ok-bg'], ['ok', 'surface'], ['warn-ink', 'warn-bg'], ['danger', 'danger-bg'], ['danger', 'surface'],
  ];
  for (const [name, theme] of [['라이트', light], ['다크', dark]]) {
    for (const [fg, bg] of pairs) {
      const r = contrast(theme[fg], theme[bg]);
      assert.ok(r >= 4.5, `${name}: --${fg}(${theme[fg]}) / --${bg}(${theme[bg]}) 대비 ${r.toFixed(2)} < 4.5`);
    }
    // 매수·매도 배지: 옅게 섞은 바탕(14%) 위의 글자
    for (const fg of ['up', 'down']) {
      const bg = mix(theme[fg], theme.surface, 0.14);
      const r = contrast(theme[fg], bg);
      assert.ok(r >= 4.5, `${name}: 배지 --${fg} / 섞은 바탕 ${bg} 대비 ${r.toFixed(2)} < 4.5`);
    }
  }
  assert.ok(contrast('#ffffff', light.up) >= 4.5, '빨간 숫자 배지 위 흰 글자');
});

test('터치 영역: 버튼·입력칸의 최소 높이는 48px 변수(--tap)를 쓴다', async () => {
  const css = await read('css/app.css');
  assert.match(css, /--tap: 48px;/);
  for (const sel of ['.btn {', '.icon-btn {', '#tabbar a {', '.back-link {']) {
    const rule = css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)));
    assert.match(rule, /var\(--tap\)/, `${sel} 가 --tap 을 쓰지 않습니다`);
  }
  assert.doesNotMatch(css, /min-height:\s*(?:[0-3]?\d|4[0-3])px/, '44px 보다 작은 최소 높이가 남아 있습니다');
});

/** 주석을 지운 소스(주석 속 설명 문장 때문에 오탐하지 않게). */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

test('보안: 외부 입력을 innerHTML 로 그대로 넣지 않는다(자동 이스케이프 setHtml 한 곳만 사용)', async () => {
  const files = (await readdir(path.join(ROOT, 'js'))).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    const src = stripComments(await read(`js/${f}`));
    assert.doesNotMatch(src, /insertAdjacentHTML|outerHTML\s*=|document\.write|\beval\s*\(|new Function\s*\(/, f);
    const uses = [...src.matchAll(/\.innerHTML\s*=/g)].length;
    if (f === 'util.js') {
      assert.equal(uses, 1, 'util.js 의 setHtml 한 곳만 innerHTML 을 쓴다');
      assert.match(src, /innerHTML = safe instanceof SafeHtml \? safe\.value : escapeHtml\(safe\)/);
    } else {
      assert.equal(uses, 0, `${f} 에서 innerHTML 을 직접 쓰면 안 됩니다(html\`\` 과 setHtml 사용)`);
    }
  }
});

test('보안: 저장소에 API 키·토큰·비밀 키처럼 보이는 문자열이 없다', async () => {
  const patterns = [
    /ghp_[A-Za-z0-9]{30,}/, /github_pat_[A-Za-z0-9_]{30,}/, /gho_[A-Za-z0-9]{30,}/,
    /AKIA[0-9A-Z]{16}/, /AIza[0-9A-Za-z_-]{35}/, /sk-(?:ant-)?[A-Za-z0-9_-]{24,}/, /xox[abprs]-[A-Za-z0-9-]{10,}/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /(?:api[_-]?key|secret|access[_-]?token|crtfc_key)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i,
  ];
  const skipDirs = new Set(['.git', 'node_modules', 'icons']);
  const textExt = /\.(?:js|mjs|json|md|html|css|yml|yaml|webmanifest|txt)$/;
  async function walk(dir) {
    const out = [];
    for (const ent of await readdir(path.join(ROOT, dir), { withFileTypes: true })) {
      if (skipDirs.has(ent.name)) continue;
      const rel = dir ? `${dir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) out.push(...await walk(rel));
      else if (textExt.test(ent.name)) out.push(rel);
    }
    return out;
  }
  const files = await walk('');
  assert.ok(files.length > 30);
  for (const rel of files) {
    const text = await read(rel);
    for (const re of patterns) assert.doesNotMatch(text, re, `${rel} 에 비밀 값처럼 보이는 문자열이 있습니다`);
  }
});

test('설치 조건: HTTPS 배포용 상대 경로·매니페스트 필수 항목·아이폰 아이콘', async () => {
  const m = JSON.parse(await read('manifest.webmanifest'));
  for (const key of ['name', 'short_name', 'start_url', 'display', 'theme_color', 'background_color', 'id', 'icons']) assert.ok(m[key], key);
  assert.equal(m.display, 'standalone');
  const htmlText = await read('index.html');
  assert.match(htmlText, /<link rel="apple-touch-icon" href="icons\/apple-touch-icon\.png">/);
  assert.match(htmlText, /<meta name="viewport" content="width=device-width, initial-scale=1/);
  assert.doesNotMatch(htmlText, /(?:href|src)="http:\/\//, 'http:// 자원은 HTTPS 페이지에서 막힙니다');
});
