#!/usr/bin/env node
// tools/next-lesson.mjs — 오늘 만들 강의 정보를 JSON 으로 알려준다(예약 작업용)
//
//   node tools/next-lesson.mjs                    오늘(KST) 기준
//   node tools/next-lesson.mjs --date 2026-11-30  날짜를 지정
//
// 규칙
//   - 강의 번호 = 샘플을 뺀 가장 최근 강의 번호 + 1 (강의가 없으면 1)
//   - 생성에 실패한 날은 번호가 넘어가지 않는다(파일이 없으므로 다음 날 같은 번호).
//   - 68강을 넘으면 2회차(69~)로 같은 순서를 다시 돌며 심화 사례를 쓴다.

import path from 'node:path';
import { isValidYmd, kstDate, WEEKDAYS_KO, weekday } from '../js/util.js';
import { ROOT, isMain, lessonPathFor, loadLessons, readJson, readJsonIfExists } from './common.mjs';
import { curriculumEntryFor } from './validate.mjs';

export async function nextLesson({ root = ROOT, date = kstDate() } = {}) {
  if (!isValidYmd(date)) throw new Error(`날짜 형식이 잘못됐습니다: ${date}`);
  const curriculum = await readJson(path.join(root, 'curriculum', 'curriculum.json'));
  const glossary = await readJsonIfExists(path.join(root, 'glossary', 'terms.json'), { version: 1, terms: [] });
  const lessons = await loadLessons(root);

  const real = lessons.filter((x) => x.lesson?.sample !== true);
  const existing = lessons.find((x) => x.lesson?.date === date);
  const before = real.filter((x) => x.lesson.date < date);
  const after = real.filter((x) => x.lesson.date > date);
  const prev = before.length ? before[before.length - 1].lesson : null;

  const lessonNo = (prev?.lesson_no ?? 0) + 1;
  const found = curriculumEntryFor(curriculum, lessonNo);
  if (!found) throw new Error(`커리큘럼에서 ${lessonNo}강을 찾을 수 없습니다`);
  const { entry, round, base, total } = found;
  const track = curriculum.tracks.find((t) => t.id === entry.track);
  const glossaryIds = new Set((glossary.terms ?? []).map((t) => t.id));
  const wd = weekday(date);

  return {
    date,
    weekday: WEEKDAYS_KO[wd],
    is_weekend: wd === 0 || wd === 6,
    is_friday: wd === 5,
    path: lessonPathFor(date),
    already_exists: Boolean(existing),
    existing_is_sample: existing ? existing.lesson.sample === true : false,
    has_later_lessons: after.length > 0,
    lesson_no: lessonNo,
    round,
    curriculum_no: base,
    total_lessons: total,
    track: entry.track,
    track_name: track?.name ?? entry.track,
    title: entry.title,
    goal: entry.goal,
    key_terms: entry.key_terms,
    key_terms_in_glossary: entry.key_terms.filter((id) => glossaryIds.has(id)),
    key_terms_to_define: entry.key_terms.filter((id) => !glossaryIds.has(id)),
    glossary_ids: [...glossaryIds].sort(),
    previous: prev ? { date: prev.date, lesson_no: prev.lesson_no, title: prev.title } : null,
    note: round > 1
      ? `${round}회차 심화: 같은 주제를 실제 기업 1곳을 깊게 분석하는 방식으로 다룹니다.`
      : (existing ? '이 날짜의 강의 파일이 이미 있습니다. 새로 만들지 마세요(샘플이면 날짜가 겹치지 않게 확인).' : ''),
  };
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--date');
  const date = i >= 0 ? argv[i + 1] : undefined;
  nextLesson(date ? { date } : {}).then(
    (info) => { console.log(JSON.stringify(info, null, 2)); },
    (err) => { console.error(`다음 강의 확인 실패: ${err.message}`); process.exitCode = 1; },
  );
}
