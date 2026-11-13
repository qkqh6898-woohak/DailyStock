#!/usr/bin/env node
// tools/serve.mjs — 개발·테스트용 정적 파일 서버 (의존성 없음)
//
//   node tools/serve.mjs            http://localhost:8080
//   node tools/serve.mjs 3000       포트 지정
//
// 서비스 워커와 ES 모듈은 file:// 로는 동작하지 않으므로, 내 컴퓨터에서 볼 때 이 서버를 쓴다.

import http from 'node:http';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { readFile, stat } from 'node:fs/promises';
import { ROOT, isMain } from './common.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.md', '.txt']);
const gzCache = new Map();

/**
 * 정적 서버를 띄운다.
 * @param {{ port?: number, root?: string, host?: string }} [opts]  port 0 이면 빈 포트를 자동 선택
 * @returns {Promise<{ server: http.Server, port: number, url: string, close: () => Promise<void> }>}
 */
export function startServer({ port = 8080, root = ROOT, host = '127.0.0.1' } = {}) {
  const base = path.resolve(root);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';
      const file = path.resolve(base, `.${pathname}`);
      if (file !== base && !file.startsWith(base + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('403');
        return;
      }
      const info = await stat(file);
      if (info.isDirectory()) {
        res.writeHead(302, { Location: `${url.pathname}/` });
        res.end();
        return;
      }
      const ext = path.extname(file).toLowerCase();
      let body = await readFile(file);
      const headers = {
        'Content-Type': TYPES[ext] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
        Vary: 'Accept-Encoding',
      };
      // GitHub Pages 처럼 글자 파일은 gzip 으로 압축해 보낸다(실제 배포와 비슷한 속도로 확인).
      if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
        const key = `${file}:${info.mtimeMs}`;
        if (!gzCache.has(key)) gzCache.set(key, gzipSync(body));
        body = gzCache.get(key);
        headers['Content-Encoding'] = 'gzip';
      }
      headers['Content-Length'] = body.length;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({
        server,
        port: actual,
        url: `http://localhost:${actual}/`,
        close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }),
      });
    });
  });
}

if (isMain(import.meta.url)) {
  const port = Number(process.argv[2]) || 8080;
  startServer({ port }).then(
    ({ url }) => { console.log(`Daily Stock Study 개발 서버: ${url}  (끝내려면 Ctrl+C)`); },
    (err) => { console.error(`서버를 시작할 수 없습니다: ${err.message}`); process.exitCode = 1; },
  );
}
