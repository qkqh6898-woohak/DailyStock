#!/usr/bin/env node
// tools/merge-terms.mjs — 강의 용어 → glossary/terms.json 병합
//
//   node tools/merge-terms.mjs lessons/2026/11/2026-11-30.json [...]
//   node tools/merge-terms.mjs --all            모든 강의의 용어를 다시 병합
//   node tools/merge-terms.mjs <파일> --update  이미 있는 용어의 설명도 이 강의 내용으로 바꾼다
//
// 기본 동작은 "새 용어만 추가"다. 이미 사전에 있는 용어는 처음 정의를 그대로 둔다.

import path from 'node:path';
import { kstIso } from '../js/util.js';
import { ROOT, isMain, loadLessons, readJson, readJsonIfExists, writeJson } from './common.mjs';

const TERM_FIELDS = ['id', 'ko', 'en', 'label', 'short', 'long', 'formula', 'example', 'related'];

function pick(term) {
  const out = {};
  for (const key of TERM_FIELDS) {
    if (term[key] !== undefined && term[key] !== null && term[key] !== '') out[key] = term[key];
  }
  return out;
}

/**
 * 강의들의 용어를 사전에 합친다(순수 함수 — 파일을 쓰지 않는다).
 * @returns {{ glossary: object, added: string[], updated: string[], kept: string[] }}
 */
export function mergeTerms(glossary, lessons, { update = false, now = new Date() } = {}) {
  const byId = new Map((glossary?.terms ?? []).map((t) => [t.id, t]));
  const added = [];
  const updated = [];
  const kept = [];
  for (const lesson of lessons) {
    for (const term of Array.isArray(lesson?.terms) ? lesson.terms : []) {
      if (!term || typeof term.id !== 'string') continue;
      const existing = byId.get(term.id);
      if (!existing) {
        byId.set(term.id, { ...pick(term), track: lesson.track, first_lesson: lesson.lesson_no, first_date: lesson.date });
        added.push(term.id);
      } else if (update) {
        byId.set(term.id, {
          ...pick(term),
          track: existing.track ?? lesson.track,
          first_lesson: existing.first_lesson ?? lesson.lesson_no,
          first_date: existing.first_date ?? lesson.date,
        });
        updated.push(term.id);
      } else {
        kept.push(term.id);
      }
    }
  }
  const terms = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const changed = added.length > 0 || updated.length > 0;
  return {
    glossary: { version: 1, updated: changed || !glossary?.updated ? kstIso(now) : glossary.updated, terms },
    added,
    updated,
    kept,
    changed,
  };
}

async function main(argv) {
  const update = argv.includes('--update');
  const all = argv.includes('--all');
  const files = argv.filter((a) => !a.startsWith('--'));
  if (!all && files.length === 0) {
    console.error('사용법: node tools/merge-terms.mjs <강의.json> [...] [--update]\n        node tools/merge-terms.mjs --all');
    return 2;
  }
  const lessons = all ? (await loadLessons(ROOT)).map((x) => x.lesson) : await Promise.all(files.map((f) => readJson(f)));
  const file = path.join(ROOT, 'glossary', 'terms.json');
  const current = await readJsonIfExists(file, { version: 1, terms: [] });
  const result = mergeTerms(current, lessons, { update });
  if (result.changed || !current.updated) await writeJson(file, result.glossary);
  console.log(`glossary/terms.json — 추가 ${result.added.length}개${result.added.length ? ` (${result.added.join(', ')})` : ''}`
    + `, 갱신 ${result.updated.length}개, 유지 ${result.kept.length}개, 전체 ${result.glossary.terms.length}개`);
  return 0;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { console.error(`용어 병합 실패: ${err.message}`); process.exitCode = 1; },
  );
}
