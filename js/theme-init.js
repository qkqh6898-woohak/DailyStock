// theme-init.js — 화면이 그려지기 전에 테마·글자 크기를 먼저 적용한다(깜빡임 방지).
// 모듈이 아닌 일반 스크립트로 <head> 에서 바로 실행된다. 설정 화면에서 값을 바꾸면 localStorage 에도 함께 적어 둔다.
(function () {
  try {
    var root = document.documentElement;
    var theme = localStorage.getItem('ss-theme');
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
    var scale = Number(localStorage.getItem('ss-font-scale'));
    if (scale >= 0.8 && scale <= 1.5) root.style.setProperty('--font-scale', String(scale));
  } catch (e) {
    /* localStorage 를 쓸 수 없으면 기본값 그대로 */
  }
})();
