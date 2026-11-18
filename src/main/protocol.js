// Custom protocols:
//   mdvapp://app/...   the bundled renderer (dist/renderer)
//   mdvfile://local/D:/...  read-only access to local files for images/media,
//                            with HTTP Range support so video/audio can seek.

import { protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { APP_SCHEME, LOCAL_SCHEME, localResourceUrlToPath } from '../../packages/core/src/shared/paths.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

export function mimeOf(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

export function registerPrivilegedSchemes() {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
    { scheme: LOCAL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  ]);
}

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
}

async function serveFile(filePath, request) {
  let st;
  try {
    st = await fs.promises.stat(filePath);
  } catch {
    return notFound();
  }
  if (!st.isFile()) return notFound();
  const size = st.size;
  const type = mimeOf(filePath);
  const range = request.headers.get('range');
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
      let end = m[1] !== '' && m[2] !== '' ? Number(m[2]) : size - 1;
      end = Math.min(end, size - 1);
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });
      }
      const stream = fs.createReadStream(filePath, { start, end });
      return new Response(Readable.toWeb(stream), {
        status: 206,
        headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
      });
    }
  }
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers: { ...base, 'Content-Length': String(size) } });
  return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
    status: 200,
    headers: { ...base, 'Content-Length': String(size) },
  });
}

export function registerProtocolHandlers(rendererDir) {
  const root = path.resolve(rendererDir);
  protocol.handle(APP_SCHEME, (request) => {
    const u = new URL(request.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    const p = path.resolve(root, rel);
    if (!p.startsWith(root + path.sep) && p !== root) return notFound();
    return serveFile(p, request);
  });
  protocol.handle(LOCAL_SCHEME, (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    let p;
    try {
      p = localResourceUrlToPath(request.url);
    } catch {
      return notFound();
    }
    return serveFile(p, request);
  });
}
