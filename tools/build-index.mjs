#!/usr/bin/env node
// tools/build-index.mjs — lessons/index.json 재생성
//
//   node tools/build-index.mjs
//
// lessons/YYYY/MM/YYYY-MM-DD.json 을 모두 읽어 목록을 만든다(최신 날짜가 먼저).
// 내용이 그대로면 updated 시각을 바꾸지 않아 쓸데없는 변경이 생기지 않는다.

import path from 'node:path';
import { kstIso } from '../js/util.js';
import { ROOT, isMain, loadLessons, readJsonIfExists, writeJson } from './common.mjs';
import { buildIndexItems } from './validate.mjs';

export async function buildIndex({ root = ROOT, now = new Date() } = {}) {
  const lessons = await loadLessons(root);
  const items = buildIndexItems(lessons);
  const file = path.join(root, 'lessons', 'index.json');
  const previous = await readJsonIfExists(file, null);
  const unchanged = previous && JSON.stringify(previous.items) === JSON.stringify(items);
  const index = { updated: unchanged && previous.updated ? previous.updated : kstIso(now), items };
  if (!unchanged) await writeJson(file, index);
  return { index, changed: !unchanged, file };
}

if (isMain(import.meta.url)) {
  buildIndex().then(
    ({ index, changed }) => {
      const real = index.items.filter((i) => !i.sample).length;
      const sample = index.items.length - real;
      console.log(`lessons/index.json ${changed ? '갱신' : '변경 없음'} — 강의 ${real}개${sample ? `, 샘플 ${sample}개` : ''}`);
    },
    (err) => { console.error(`목록 생성 실패: ${err.message}`); process.exitCode = 1; },
  );
}
