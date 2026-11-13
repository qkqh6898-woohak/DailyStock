# CLAUDE.md — Daily Stock Study 작업 규칙

개인용 주식 공부 PWA입니다. 빌드 도구가 없습니다(순수 HTML/CSS/JS). 구조와 명령어는 README.md, 설계는 plan.md 에 있습니다.

## 배포 절차

main 에 반영되면 GitHub Pages 가 1분 안에 배포하고, 기기의 앱은 새 버전을 스스로 적용합니다(js/update.js).
main 반영(PR 생성·병합)은 사용자가 요청했을 때 합니다. 예) "고쳐서 main 까지 반영해줘"

1. 작업 브랜치에서 고친 뒤 `npm run check`(강의 검증·BUILD·단위 테스트)와 `npm run smoke`(실제 브라우저)를 통과시킨다.
2. 작업 브랜치에 푸시하고 GitHub Actions 의 `validate`·`smoke` 가 통과했는지 확인한다.
3. (요청받았으면) main 으로 PR 을 만들고 병합한다. CI 가 실패했으면 병합하지 않는다.
4. Actions 의 `pages build and deployment` 가 성공했는지 확인한다 → https://qkqh6898-woohak.github.io/DailyStock/

- 셸 파일(`js/`, `css/`, `index.html`, `manifest.webmanifest`, `icons/`, `vendor/`)을 고치면 `node tools/sw-version.mjs` 로 BUILD 를 갱신한다. 빠뜨리면 기기에 새 버전이 전달되지 않는다(테스트가 잡아 준다).
- 새 js 파일은 `sw.js` 의 SHELL 목록과 `index.html` 의 modulepreload 에 넣는다(테스트가 잡아 준다).
- 강의(`lessons/`)는 예약 작업이 올린다(`prompts/daily-task.md`). 코드 변경과 섞지 않는다.

## 지켜야 할 것

- 교육용 앱이다. 특정 종목의 매수·매도 권유나 목표 주가를 쓰지 않는다(검증 도구가 금지 표현을 잡는다).
- 강의 본문의 숫자는 `facts` 에서만 나온다(`{{f:n}}`). 용어는 `[[id]]`. `node tools/validate.mjs --all` 통과가 필수다.
- 개인 데이터(용어장·복습·일지)는 기기 밖으로 보내지 않는다. 네트워크는 같은 사이트의 GET 만 쓴다(테스트가 검사).
- HTML 은 `util.js` 의 `html`/`setHtml` 로만 넣는다(`innerHTML` 직접 사용 금지).
- 이메일 주소·API 키 같은 비밀은 커밋하지 않는다.
