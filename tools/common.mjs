// tools/common.mjs — 도구 공통 함수 (Node 전용)
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 저장소 최상위 폴더 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const LESSON_PATH_RE = /^lessons\/(\d{4})\/(\d{2})\/(\d{4}-\d{2}-\d{2})\.json$/;

/** 저장소 기준 상대 경로(항상 / 구분자). */
export function relPath(file, root = ROOT) {
  return path.relative(root, path.resolve(file)).split(path.sep).join('/');
}

/** 날짜 → 강의 파일 상대 경로. '2026-11-30' → 'lessons/2026/11/2026-11-30.json' */
export function lessonPathFor(date) {
  const [y, m] = date.split('-');
  return `lessons/${y}/${m}/${date}.json`;
}

export async function readJson(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw new Error(`파일을 읽을 수 없습니다: ${file} (${err.code ?? err.message})`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON 형식이 잘못됐습니다: ${file} — ${err.message}`);
  }
}

export async function readJsonIfExists(file, fallback) {
  try {
    return await readJson(file);
  } catch (err) {
    if (/읽을 수 없습니다/.test(err.message)) return fallback;
    throw err;
  }
}

export async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/** lessons/YYYY/MM/YYYY-MM-DD.json 파일 목록(날짜 오름차순, 절대 경로). */
export async function listLessonFiles(root = ROOT) {
  const out = [];
  const base = path.join(root, 'lessons');
  let years = [];
  try {
    years = await readdir(base, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const y of years) {
    if (!y.isDirectory() || !/^\d{4}$/.test(y.name)) continue;
    const months = await readdir(path.join(base, y.name), { withFileTypes: true });
    for (const m of months) {
      if (!m.isDirectory() || !/^\d{2}$/.test(m.name)) continue;
      const files = await readdir(path.join(base, y.name, m.name), { withFileTypes: true });
      for (const f of files) {
        if (f.isFile() && /^\d{4}-\d{2}-\d{2}\.json$/.test(f.name)) {
          out.push(path.join(base, y.name, m.name, f.name));
        }
      }
    }
  }
  return out.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

/** 모든 강의를 읽어 [{ file, rel, lesson }] 로 돌려준다(날짜 오름차순). */
export async function loadLessons(root = ROOT) {
  const files = await listLessonFiles(root);
  const out = [];
  for (const file of files) {
    out.push({ file, rel: relPath(file, root), lesson: await readJson(file) });
  }
  return out;
}

/** 이 파일이 `node 파일` 로 직접 실행됐는지. */
export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && metaUrl === pathToFileURL(path.resolve(process.argv[1])).href;
}
