// sw.js — 서비스 워커: 앱 화면(셸)을 기기에 저장해 두어 오프라인에서도 열리게 한다.
//
//   셸(HTML·CSS·JS·아이콘)             설치할 때 미리 저장 → 저장본 우선
//   강의·목록·사전·커리큘럼(JSON)       네트워크 우선 → 실패하면 저장본
//
// 셸 파일을 고치면 `node tools/sw-version.mjs` 를 실행해 BUILD 값을 갱신한다.
// (빠뜨리면 tests/sw.test.mjs 가 실패한다.) BUILD 가 바뀌면 앱이 "새 버전이 있어요"를 띄운다.
// 모든 경로는 상대 경로다 — GitHub Pages 의 /DailyStock/ 아래에서 그대로 동작한다.

const BUILD = 'a6b78d4c1290';
const SHELL_CACHE = `ss-shell-v1-${BUILD}`;
const DATA_CACHE = 'ss-data-v1';

// <shell>
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/archive.js',
  'js/backup.js',
  'js/calc.js',
  'js/curriculum.js',
  'js/db.js',
  'js/expr.js',
  'js/glossary.js',
  'js/install.js',
  'js/journal.js',
  'js/lesson.js',
  'js/lessons.js',
  'js/main.js',
  'js/popup.js',
  'js/progress.js',
  'js/quiz.js',
  'js/render.js',
  'js/review.js',
  'js/settings.js',
  'js/srs.js',
  'js/terms.js',
  'js/theme-init.js',
  'js/tts.js',
  'js/util.js',
  'vendor/ts-fsrs.umd.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];
// </shell>

const DATA_PRELOAD = ['lessons/index.json', 'glossary/terms.json', 'curriculum/curriculum.json'];
const DATA_DIRS = ['lessons/', 'glossary/', 'curriculum/'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })));
    try {
      const data = await caches.open(DATA_CACHE);
      await Promise.all(DATA_PRELOAD.map(async (url) => {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res.ok) await data.put(url, res);
      }));
    } catch {
      // 데이터는 앱을 열 때 다시 받으므로 여기서 실패해도 괜찮다.
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('ss-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/** 서비스 워커 범위 안의 상대 경로. 범위 밖이면 null. */
function scopePath(url) {
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return null;
  return url.pathname.slice(scope.pathname.length);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const rel = scopePath(url);
  if (rel === null) return;                       // 다른 사이트·범위 밖 요청은 건드리지 않는다

  if (req.mode === 'navigate') {
    event.respondWith(appShell(req));
  } else if (DATA_DIRS.some((dir) => rel.startsWith(dir))) {
    event.respondWith(networkFirst(req, rel));
  } else {
    event.respondWith(cacheFirst(req));
  }
});

/** 화면 이동: 저장해 둔 index.html (해시 라우팅이라 페이지는 하나뿐이다). */
async function appShell(req) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match('index.html');
  if (cached) return cached;
  try {
    return await fetch(req);
  } catch {
    return new Response('<!doctype html><meta charset="utf-8"><title>오프라인</title><p style="font-family:sans-serif;padding:24px">오프라인이에요. 인터넷에 연결한 뒤 다시 열어 주세요.</p>', {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

/** 강의 데이터: 네트워크 우선, 실패하면 저장본. 저장본도 없으면 오류를 그대로 넘긴다(앱이 기기 사본을 쓴다). */
async function networkFirst(req, rel) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(rel, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(rel);
    if (cached) return cached;
    throw err;
  }
}

/** 셸 파일: 저장본 우선, 없으면 네트워크. */
async function cacheFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });
  if (cached) return cached;
  return fetch(req);
}
