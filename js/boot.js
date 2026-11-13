// boot.js — 화면이 그려지기 전에 가장 먼저 실행되는 작은 스크립트(모듈이 아닌 일반 스크립트)
//   1) 테마·글자 크기를 먼저 적용해 깜빡임을 막는다. (설정 화면이 localStorage 에도 적어 둔 값)
//   2) 앱 코드(모듈)를 내려받는 동안 강의 목록·용어 사전·커리큘럼·첫 화면 강의를 미리 요청해 둔다.
//      lessons.js 가 같은 주소를 처음 요청할 때 이 응답을 이어받으므로 첫 화면이 빨리 뜬다.
//      같은 출처(GitHub Pages)의 공개 강의 파일만 GET 으로 읽는다. 개인 기록은 보내지 않는다.
(function () {
  var root = document.documentElement;
  try {
    var theme = localStorage.getItem('ss-theme');
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
    var scale = Number(localStorage.getItem('ss-font-scale'));
    if (scale >= 0.8 && scale <= 1.5) root.style.setProperty('--font-scale', String(scale));
  } catch (e) {
    /* localStorage 를 쓸 수 없으면 기본값 그대로 */
  }

  if (typeof fetch !== 'function' || typeof Promise === 'undefined') return;
  var early = {};
  window.__ssEarly = early;

  function get(url) {
    var p = fetch(url, { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
    p.catch(function () { /* 실패하면 앱이 기기에 저장된 사본을 쓴다 */ });
    early[url] = p;
    return p;
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function kstToday() {
    var d = new Date(Date.now() + 9 * 3600 * 1000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  function lessonPath(date) {
    return 'lessons/' + date.slice(0, 4) + '/' + date.slice(5, 7) + '/' + date + '.json';
  }

  try {
    var hash = location.hash;
    var index = get('lessons/index.json');
    get('glossary/terms.json');
    get('curriculum/curriculum.json');
    var m = hash.match(/^#\/(?:lesson|quiz)\/(\d{4}-\d{2}-\d{2})$/);
    if (m) {
      get(lessonPath(m[1]));
    } else if (hash === '' || hash === '#' || /^#\/today\/?$/.test(hash)) {
      // 오늘 화면에 보일 강의(오늘 이전의 가장 최근 정식 강의, 없으면 가장 최근 샘플)를 목록이 오자마자 요청한다.
      index.then(function (data) {
        var today = kstToday();
        var items = ((data && data.items) || []).filter(function (it) {
          return it && typeof it.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(it.date) && it.date <= today;
        });
        items.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
        var pick = null;
        for (var i = 0; i < items.length; i += 1) {
          if (!items[i].sample) { pick = items[i]; break; }
        }
        if (!pick && items.length) pick = items[0];
        if (pick) get(lessonPath(pick.date));
      }, function () {});
    }
  } catch (e) {
    /* 미리 받기에 실패해도 앱은 평소대로 동작한다 */
  }
})();
