#!/usr/bin/env node
// tools/sw-version.mjs — 서비스 워커의 BUILD 값을 셸 파일 내용으로 갱신한다
//
//   node tools/sw-version.mjs          BUILD 갱신(셸 파일을 고친 뒤 실행)
//   node tools/sw-version.mjs --check  갱신이 필요하면 실패(테스트·CI 용)
//
// BUILD = 셸 파일들의 SHA-256 앞 12자리. 셸 파일이 하나라도 바뀌면 값이 달라져
// 브라우저가 새 서비스 워커를 설치하고 앱이 "새 버전이 있어요"를 띄운다.

import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, isMain } from './common.mjs';

const BUILD_RE = /const BUILD = '([0-9a-f]{12})';/;

/** sw.js 의 SHELL 목록(// <shell> … // </shell> 사이의 문자열들). */
export function shellList(swText) {
  const m = swText.match(/\/\/ <shell>([\s\S]*?)\/\/ <\/shell>/);
  if (!m) throw new Error('sw.js 에서 // <shell> … // </shell> 표시를 찾을 수 없습니다');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** 셸 파일 내용으로 BUILD 값을 계산한다. './' 는 index.html 과 같으므로 건너뛴다. */
export async function computeBuild(files, root = ROOT) {
  const hash = createHash('sha256');
  for (const rel of [...files].filter((f) => f !== './').sort()) {
    hash.update(rel);
    hash.update('\0');
    hash.update(await readFile(path.join(root, rel)));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}

async function filesIn(dir, ext, root) {
  try {
    return (await readdir(path.join(root, dir))).filter((f) => f.endsWith(ext)).map((f) => `${dir}/${f}`);
  } catch {
    return [];
  }
}

/**
 * sw.js 를 점검한다.
 * @returns {{ ok: boolean, errors: string[], build: string|null, expected: string|null }}
 */
export async function checkSw(root = ROOT) {
  const errors = [];
  const swText = await readFile(path.join(root, 'sw.js'), 'utf8');
  const list = shellList(swText);
  const build = swText.match(BUILD_RE)?.[1] ?? null;
  if (!build) errors.push("sw.js 에 const BUILD = '…12자리…'; 줄이 없습니다");

  const required = [
    'index.html', 'manifest.webmanifest',
    ...(await filesIn('js', '.js', root)),
    ...(await filesIn('css', '.css', root)),
    ...(await filesIn('vendor', '.js', root)),
  ];
  for (const rel of required) if (!list.includes(rel)) errors.push(`셸 목록에 ${rel} 이(가) 빠졌습니다`);
  let expected = null;
  const missing = [];
  for (const rel of list) {
    if (rel === './') continue;
    try {
      await readFile(path.join(root, rel));
    } catch {
      missing.push(rel);
    }
  }
  for (const rel of missing) errors.push(`셸 목록의 ${rel} 파일이 없습니다`);
  if (missing.length === 0) {
    expected = await computeBuild(list, root);
    if (build && build !== expected) errors.push(`BUILD 값이 오래됐습니다(${build} → ${expected}). node tools/sw-version.mjs 를 실행하세요`);
  }
  return { ok: errors.length === 0, errors, build, expected };
}

async function main(argv) {
  const file = path.join(ROOT, 'sw.js');
  if (argv.includes('--check')) {
    const r = await checkSw();
    if (r.ok) {
      console.log(`✓ sw.js BUILD ${r.build} — 최신`);
      return 0;
    }
    for (const e of r.errors) console.error(`✗ ${e}`);
    return 1;
  }
  const text = await readFile(file, 'utf8');
  const build = await computeBuild(shellList(text));
  if (!BUILD_RE.test(text)) throw new Error("sw.js 에 const BUILD = '…'; 줄이 없습니다");
  const next = text.replace(BUILD_RE, `const BUILD = '${build}';`);
  if (next !== text) await writeFile(file, next, 'utf8');
  console.log(`sw.js BUILD ${next !== text ? '갱신' : '변경 없음'}: ${build}`);
  return 0;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { console.error(`sw-version 오류: ${err.message}`); process.exitCode = 1; },
  );
}
