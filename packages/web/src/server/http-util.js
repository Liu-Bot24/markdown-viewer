// Small HTTP helpers: security headers, JSON, conditional requests, byte ranges, compression.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
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
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

export const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

// Shown inline from /raw. svg only through <img> (the sandbox CSP stops scripts when opened directly).
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif', 'image/x-icon', 'image/svg+xml', 'video/mp4', 'video/quicktime', 'video/webm', 'video/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/ogg', 'audio/flac', 'application/pdf', 'text/plain; charset=utf-8', 'text/markdown; charset=utf-8']);
export const isInlineType = (t) => INLINE_TYPES.has(t);

export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: http: data: blob:",
  "media-src 'self' https: http: data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function baseHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

export function sendJson(req, res, status, obj, extra = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  sendCompressed(req, res, body);
}

export function sendError(req, res, status, code, extra) {
  sendJson(req, res, status, { ok: false, code, ...extra });
}

export function sendCompressed(req, res, body) {
  const ae = String(req.headers['accept-encoding'] || '');
  if (body.length > 1024 && /\bbr\b/.test(ae)) {
    body = zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
    res.setHeader('Content-Encoding', 'br');
  } else if (body.length > 1024 && /\bgzip\b/.test(ae)) {
    body = zlib.gzipSync(body, { level: 6 });
    res.setHeader('Content-Encoding', 'gzip');
  }
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('Content-Length', body.length);
  res.end(req.method === 'HEAD' ? undefined : body);
}

export async function readBody(req, limit = 70 * 1024 * 1024) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw Object.assign(new Error('body too large'), { status: 413, code: 'ETOOBIG' });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limit) {
  const b = await readBody(req, limit);
  try {
    return JSON.parse(b.toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('bad json'), { status: 400, code: 'EBADJSON' });
  }
}

export const weakEtag = (st) => `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;

export function notModified(req, etag, mtimeMs) {
  const inm = req.headers['if-none-match'];
  if (inm) return inm.split(',').some((t) => t.trim() === etag);
  const ims = req.headers['if-modified-since'];
  if (ims) {
    const t = Date.parse(ims);
    return Number.isFinite(t) && Math.floor(mtimeMs / 1000) <= Math.floor(t / 1000);
  }
  return false;
}

/** Content-Disposition with a UTF-8 file name. */
export function disposition(kind, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Stream a file with Range support. headers: extra headers. Returns when the response ends.
 */
export function sendFile(req, res, file, st, { type, headers = {}, cache = 'private, max-age=0, must-revalidate' } = {}) {
  const etag = weakEtag(st);
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', new Date(st.mtimeMs).toUTCString());
  res.setHeader('Cache-Control', cache);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', type || mimeOf(file));
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (notModified(req, etag, st.mtimeMs)) {
    res.statusCode = 304;
    return res.end();
  }
  const size = st.size;
  let start = 0;
  let end = size - 1;
  const range = req.headers.range;
  const ifRange = req.headers['if-range'];
  if (range && (!ifRange || ifRange === etag)) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === '' && m[2] === '')) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.end();
    }
    if (m[1] === '') {
      start = Math.max(0, size - Number(m[2]));
    } else {
      start = Number(m[1]);
      if (m[2] !== '') end = Math.min(size - 1, Number(m[2]));
    }
    if (start > end || start >= size) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.end();
    }
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  } else res.statusCode = 200;
  res.setHeader('Content-Length', size === 0 ? 0 : end - start + 1);
  if (req.method === 'HEAD' || size === 0) return res.end();
  return new Promise((resolve) => {
    const s = fs.createReadStream(file, { start, end });
    s.on('error', () => {
      res.destroy();
      resolve();
    });
    res.on('close', () => {
      s.destroy();
      resolve();
    });
    s.pipe(res);
  });
}
