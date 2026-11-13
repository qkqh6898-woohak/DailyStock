// update.js — 새 버전 자동 적용
//
// main 에 반영되면 GitHub Pages 가 1분 안에 다시 배포한다. 그 뒤 기기에서는:
//   1) 앱을 열 때 브라우저가 sw.js 가 바뀌었는지 확인한다. 홈 화면 앱은 며칠씩 켜 둔 채로 쓰므로
//      앱으로 돌아올 때(10분 이상 지났으면)·인터넷이 다시 연결될 때도 여기서 확인한다.
//   2) 바뀌었으면 새 서비스 워커가 새 파일을 받아 두고 곧바로 넘겨받는다(sw.js 의 skipWaiting).
//   3) 보고 있던 화면은 그대로 둔다. 다음에 다른 화면으로 옮길 때 새로고침해 새 버전을 띄운다.
//      일지를 쓰거나 퀴즈를 푸는 도중에 화면이 바뀌면 안 되기 때문이다.
//   4) 새로고침한 뒤 "새 버전으로 업데이트했어요"를 잠깐 띄운다.
// 설정 › 앱 정보의 [지금 확인]은 기다리지 않고 바로 확인하고, 새 버전이 있으면 바로 적용한다.

import { toast } from './util.js';

const CHECK_EVERY_MS = 10 * 60 * 1000;
const FLAG = 'ss-updated';

let enabled = false;     // 서비스 워커를 쓰는 중(지원하지 않거나 ?nosw 면 false)
let registration = null;
let pending = false;     // 새 버전이 넘겨받았고, 화면만 아직 예전 것
let applyNow = false;    // [지금 확인]을 눌러 기다리지 않고 바로 적용
let lastCheck = 0;

function markPending() {
  pending = true;
  document.documentElement.dataset.update = 'pending';
}

/** 새 버전이 넘겨받아, 다음 화면 이동 때 새로고침해야 하는지. */
export function isUpdatePending() {
  return pending;
}

/** 새로고침해 새 버전을 띄운다. 주소(#/…)가 그대로라 보던 화면으로 돌아온다. */
export function applyUpdate() {
  try { sessionStorage.setItem(FLAG, '1'); } catch { /* 안내를 못 띄워도 새로고침은 한다 */ }
  location.reload();
}

/** 새 버전으로 새로고침한 직후라면 안내를 띄운다. */
export function announceUpdate() {
  let updated = false;
  try {
    updated = sessionStorage.getItem(FLAG) === '1';
    sessionStorage.removeItem(FLAG);
  } catch { /* 저장소를 못 쓰면 안내만 건너뛴다 */ }
  if (updated) toast('새 버전으로 업데이트했어요');
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (new URLSearchParams(location.search).has('nosw')) return;
  enabled = true;

  let controlled = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!controlled) { controlled = true; return; }   // 처음 설치될 때는 업데이트가 아니다
    markPending();
    if (applyNow) applyUpdate();
  });

  navigator.serviceWorker.register('./sw.js').then((reg) => {
    registration = reg;
    lastCheck = Date.now();   // 앱을 열 때 브라우저가 이미 한 번 확인했다
    // 예전 버전(넘겨받기 전에 [새로고침]을 눌러야 하던 때)이 남긴 대기 중인 새 버전
    if (reg.waiting && navigator.serviceWorker.controller) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
  }).catch((err) => console.warn('서비스 워커 등록 실패', err));

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkForUpdate().catch(() => {});
  });
  window.addEventListener('online', () => { checkForUpdate().catch(() => {}); });
  setInterval(() => { if (!document.hidden) checkForUpdate().catch(() => {}); }, CHECK_EVERY_MS);
}

/**
 * 새 버전이 있는지 확인한다.
 * @param {{ now?: boolean }} [opts] now: 간격과 상관없이 확인하고, 새 버전이 있으면 바로 적용한다.
 * @returns {Promise<'found'|'latest'|'offline'|'unsupported'|'skipped'>}
 */
export async function checkForUpdate({ now = false } = {}) {
  if (!enabled) return 'unsupported';
  // 등록이 끝나기 전에 눌렀다면 이미 있는 등록을 찾아 쓴다.
  if (!registration) registration = (await navigator.serviceWorker.getRegistration()) ?? null;
  if (!registration) return 'unsupported';
  if (!navigator.onLine) return 'offline';
  if (!now && Date.now() - lastCheck < CHECK_EVERY_MS) return 'skipped';
  lastCheck = Date.now();
  if (pending) {
    if (now) applyUpdate();
    return 'found';
  }
  if (now) applyNow = true;
  try {
    await registration.update();
  } catch (err) {
    if (now) applyNow = false;
    throw err;
  }
  const found = pending || Boolean(registration.installing || registration.waiting);
  if (!found && now) applyNow = false;
  return found ? 'found' : 'latest';
}

/** 지금 이 화면을 맡고 있는 서비스 워커의 버전(sw.js 의 BUILD). 모르면 null. */
export function currentBuild() {
  const worker = typeof navigator !== 'undefined' ? navigator.serviceWorker?.controller : null;
  if (!worker) return Promise.resolve(null);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 2000);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(typeof e.data?.build === 'string' ? e.data.build : null);
    };
    worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
  });
}
