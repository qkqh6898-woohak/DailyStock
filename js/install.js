// install.js — 홈 화면 설치 도우미
// Android Chrome 은 설치 조건을 갖추면 beforeinstallprompt 이벤트를 보낸다. 이 이벤트를 붙잡아 두었다가
// 오늘 화면·설정 화면의 [설치] 버튼에서 띄운다. iPhone Safari 는 이 이벤트가 없어 안내 문구로 대신한다.

let deferred = null;
const listeners = new Set();
const DISMISS_KEY = 'ss-install-dismissed';

function notify() {
  for (const fn of listeners) {
    try { fn(); } catch { /* 화면이 이미 사라졌을 수 있다 */ }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
}

/** 지금 [설치] 버튼을 띄울 수 있는지(Android Chrome 등). */
export function canInstall() {
  return Boolean(deferred);
}

/** 홈 화면 앱으로 실행 중인지. */
export function isStandalone() {
  if (typeof window === 'undefined') return false;
  return Boolean(window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone);
}

/** 'ios' | 'android' | 'other' */
export function platform() {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'other';
}

export function onInstallChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 설치 창을 띄운다. 결과: 'accepted' | 'dismissed' | 'unavailable' | 'error' */
export async function promptInstall() {
  if (!deferred) return 'unavailable';
  const e = deferred;
  deferred = null;
  try {
    await e.prompt();
    const choice = await e.userChoice;
    notify();
    return choice?.outcome ?? 'dismissed';
  } catch {
    return 'error';
  }
}

export function isDismissed() {
  try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
}

export function dismiss() {
  try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* 저장하지 못해도 이번 화면에서는 숨긴다 */ }
}
