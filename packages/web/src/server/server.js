// The web edition's HTTP server: static front end, JSON API, /raw media, thumbnails,
// video transcoding, optional login and the search index.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHref, isMarkdownPath, basename, mediaKind } from '../../../core/src/shared/paths.js';
import { hashBytes } from '../../../core/src/node/textfile.js';
import { Auth } from './auth.js';
import { APP_CSP, baseHeaders, disposition, isInlineType, mimeOf, readJson, sendCompressed, sendError, sendFile, sendJson } from './http-util.js';
import { Thumbs, Transcoder } from './media.js';
import { Roots } from './roots.js';
import { PathError, resolveVirtual, splitVirtual } from './vpath.js';
import { confirmSentence, overwrite } from './write.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'package.json'), 'utf8'));
export const VERSION = PKG.version;
const MAX_READ_BYTES = 64 * 1024 * 1024;
const LIST_PAGE = 2000;
const LIST_CACHE_MS = 5000;
const NAME_ORDER = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const MEDIA_PROBE = 300; // entries looked at to tell a media folder

/** fn over items with at most n running at once; results in order. */
async function mapLimited(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

export class Activity {
  constructor() {
    this.last = 0;
  }
  touch() {
    this.last = Date.now();
  }
  /** A foreground request in the last `ms` milliseconds. */
  busy(ms = 2000) {
    return Date.now() - this.last < ms;
  }
}

export function makeLogger(quiet = false) {
  const stamp = () => new Date().toISOString();
  return {
    info: (m) => !quiet && console.log(`${stamp()} ${m}`),
    warn: (m) => !quiet && console.warn(`${stamp()} ${m}`),
    error: (m) => console.error(`${stamp()} ${m}`),
  };
}

export class WebServer {
  constructor(cfg, { log = makeLogger(), staticDir, searchFactory } = {}) {
    this.cfg = cfg;
    this.log = log;
    this.staticDir = cfg.staticDir || staticDir || path.resolve(HERE, '..', '..', 'dist', 'public');
    this.roots = new Roots(cfg);
    this.auth = new Auth(cfg, log);
    this.video = new Transcoder(cfg, log);
    this.thumbs = new Thumbs(cfg, log);
    this.activity = new Activity();
    this.listCache = new Map();
    this.mediaDirCache = new Map();
    this.searchFactory = searchFactory;
    this.search = null;
    this.settingsFile = path.join(cfg.stateDir, 'settings.json');
    this.settings = {};
  }

  async init() {
    fs.mkdirSync(this.cfg.stateDir, { recursive: true });
    const rel = path.relative(this.cfg.rootsDir, this.cfg.cacheDir);
    if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      // generated files never go into a content folder
      this.log.error(`缓存目录 ${this.cfg.cacheDir} 在内容目录 ${this.cfg.rootsDir} 里面：不生成缩略图，也不转码视频`);
      this.cfg = { ...this.cfg, thumbCacheBytes: 0, transcode: 'off' };
      this.thumbs = new Thumbs(this.cfg, this.log);
      this.video = new Transcoder(this.cfg, this.log);
    } else {
      try {
        fs.mkdirSync(this.cfg.cacheDir, { recursive: true });
      } catch {
        /* optional */
      }
    }
    try {
      this.settings = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
    } catch {
      this.settings = {};
    }
    this.auth.init();
    await this.roots.discover();
    await this.video.init();
    await this.thumbs.init();
    const roots = this.roots.list;
    if (!roots.length) this.log.warn(`还没有挂载任何目录：把文件夹映射到 ${this.cfg.rootsDir}/<名称>`);
    for (const r of roots) this.log.info(`根「${r.name}」：${r.writable ? '可写' : '只读'}`);
    if (this.cfg.auth === 'off') this.log.warn('未启用登录（MDV_AUTH=off）：能访问这个端口的人都能看到全部内容');
    if (this.searchFactory && !this.cfg.noIndex) {
      this.search = await this.searchFactory(this);
      this.search.start();
    }
  }

  listen() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.keepAliveTimeout = 65000;
    return new Promise((resolve) => this.server.listen(this.cfg.port, this.cfg.host, () => resolve(this.server.address())));
  }

  async close() {
    if (this.search) await this.search.close();
    if (this.server) await new Promise((r) => this.server.close(() => r()));
  }

  clientIp(req) {
    const remote = req.socket.remoteAddress || '';
    if (this.cfg.trustedProxy.includes(remote.replace(/^::ffff:/, ''))) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xff) return xff;
    }
    return remote.replace(/^::ffff:/, '');
  }

  /** POST and friends must come from this site's own pages. */
  sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return req.headers['sec-fetch-site'] === 'same-origin';
    let o;
    try {
      o = new URL(origin);
    } catch {
      return false;
    }
    if (o.host === req.headers.host) return true;
    if (this.cfg.publicUrl) {
      try {
        return new URL(this.cfg.publicUrl).host === o.host;
      } catch {
        return false;
      }
    }
    return false;
  }

  async handle(req, res) {
    baseHeaders(res);
    let url;
    try {
      // URL parsing would quietly resolve "." and ".." segments: refuse them as sent
      if (hasDotSegment(String(req.url).split(/[?#]/)[0])) return sendError(req, res, 400, 'EBADPATH');
      url = new URL(req.url, 'http://local');
    } catch {
      return sendError(req, res, 400, 'EBADURL');
    }
    const p = url.pathname;
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD' && !this.sameOrigin(req)) return sendError(req, res, 403, 'EORIGIN');
      if (p === '/api/auth') return this.apiAuth(req, res);
      if (p === '/api/login' || p === '/api/setup') return this.apiLogin(req, res, p === '/api/setup');
      if (p === '/login') return this.serveStatic(req, res, 'login.html');
      if (p.startsWith('/assets/login')) return this.serveStatic(req, res, p.slice(1));
      const session = this.auth.check(req);
      if (!session) {
        if (p.startsWith('/api/') || p.startsWith('/raw/') || p.startsWith('/thumb/') || p.startsWith('/video/')) return sendError(req, res, 401, 'EAUTH');
        res.statusCode = 302;
        res.setHeader('Location', '/login?next=' + encodeURIComponent(p + url.search));
        return res.end();
      }
      if (p.startsWith('/api/')) {
        // status polls and the page's own change checks are not someone reading
        if (!p.startsWith('/api/index') && !p.startsWith('/api/jobs') && p !== '/api/stats') this.activity.touch();
        return await this.api(req, res, p, url);
      }
      this.activity.touch();
      if (p.startsWith('/raw/')) return await this.raw(req, res, decodeVirtual(p.slice(4)), url);
      if (p.startsWith('/thumb/')) return await this.thumb(req, res, decodeVirtual(p.slice(6)));
      if (p.startsWith('/video/')) return await this.videoFile(req, res, decodeVirtual(p.slice(6)));
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(req, res, 405, 'EMETHOD');
      if (p === '/' || p.startsWith('/view/') || p === '/search') {
        if (this.search) this.search.touch();
        return this.serveStatic(req, res, 'index.html');
      }
      return this.serveStatic(req, res, p.slice(1));
    } catch (e) {
      if (e instanceof PathError) return sendError(req, res, e.status, e.code);
      if (e && e.status) return sendError(req, res, e.status, e.code || 'EREQ');
      this.log.error(`请求出错 ${req.method} ${p}: ${e && e.stack ? e.stack.split('\n')[0] : e}`);
      if (!res.headersSent) return sendError(req, res, 500, 'EINTERNAL');
      res.destroy();
    }
  }

  async serveStatic(req, res, rel) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(req, res, 405, 'EMETHOD');
    const segs = rel.split('/');
    if (segs.some((s) => s === '..' || s.includes('\\') || s.includes('\0'))) return sendError(req, res, 400, 'EBADPATH');
    const file = path.join(this.staticDir, ...segs);
    let st;
    try {
      st = await fs.promises.stat(file);
      if (!st.isFile()) throw new Error('not a file');
    } catch {
      return sendError(req, res, 404, 'ENOENT');
    }
    const isHtml = file.endsWith('.html');
    if (isHtml) res.setHeader('Content-Security-Policy', APP_CSP);
    const hashed = /-[A-Z0-9]{8}\.(js|css|woff2?|ttf)$/.test(file);
    return sendFile(req, res, file, st, { cache: hashed ? 'public, max-age=31536000, immutable' : 'no-cache' });
  }

  // ---------- auth ----------
  apiAuth(req, res) {
    const a = this.auth;
    sendJson(req, res, 200, { enabled: a.enabled, needsSetup: a.needsSetup, loggedIn: !!a.check(req) });
  }

  async apiLogin(req, res, setup) {
    if (req.method !== 'POST') return sendError(req, res, 405, 'EMETHOD');
    if (!this.auth.enabled) return sendJson(req, res, 200, { ok: true });
    const body = await readJson(req, 64 * 1024);
    const ip = this.clientIp(req);
    const r = setup ? this.auth.setup(body.code, body.password, ip) : this.auth.login(body.password, ip);
    if (!r.ok) return sendJson(req, res, r.status, { ok: false, code: r.code, wait: r.wait || 0 }, r.wait ? { 'Retry-After': String(r.wait) } : {});
    sendJson(req, res, 200, { ok: true }, { 'Set-Cookie': this.auth.cookie(r.token) });
  }

  // ---------- API ----------
  async api(req, res, p, url) {
    const q = url.searchParams;
    const GET = req.method === 'GET' || req.method === 'HEAD';
    switch (p) {
      case '/api/state':
        if (GET) return sendJson(req, res, 200, this.state());
        return this.patchSettings(req, res);
      case '/api/logout':
      case '/api/logout-all':
        if (GET) break;
        this.auth.logout(req, p === '/api/logout-all');
        return sendJson(req, res, 200, { ok: true }, { 'Set-Cookie': this.auth.clearCookie() });
      case '/api/list':
        if (GET) return this.apiList(req, res, q);
        break;
      case '/api/stat':
        if (GET) return sendJson(req, res, 200, await this.statOne(q.get('path')));
        break;
      case '/api/neighbors':
        if (GET) return this.apiNeighbors(req, res, q.get('path'));
        break;
      case '/api/stats': {
        if (GET) break;
        const body = await readJson(req, 1024 * 1024);
        const out = {};
        for (const v of (body.paths || []).slice(0, 200)) out[v] = await this.statOne(v);
        return sendJson(req, res, 200, { ok: true, results: out });
      }
      case '/api/file':
        if (GET) return this.apiFile(req, res, q.get('path'));
        break;
      case '/api/resolve': {
        if (GET) break;
        const body = await readJson(req, 64 * 1024);
        return sendJson(req, res, 200, await this.resolveLink(body.base, body.href));
      }
      case '/api/write':
        if (GET) break;
        return this.apiWrite(req, res);
      case '/api/video':
        if (GET) return this.apiVideo(req, res, q.get('path'));
        break;
      default:
        if (this.search && (p.startsWith('/api/search') || p.startsWith('/api/index') || p.startsWith('/api/jobs') || p === '/api/senders')) return this.search.handle(req, res, p, url);
        if (p.startsWith('/api/search') || p.startsWith('/api/index')) return sendError(req, res, 503, 'ENOINDEX');
        return sendError(req, res, 404, 'ENOAPI');
    }
    return sendError(req, res, 405, 'EMETHOD');
  }

  state() {
    const writable = this.roots.list.some((r) => r.writable);
    return {
      version: VERSION,
      auth: this.cfg.auth,
      roots: this.roots.public(),
      caps: {
        overwrite: writable && !this.cfg.disableWrite,
        search: !!this.search,
        transcode: this.video.available,
        transcodeMode: this.video.mode,
        thumbs: this.thumbs.available,
      },
      thumbCache: this.thumbs.available ? this.thumbs.stats() : null,
      settings: { selfIds: Array.isArray(this.settings.selfIds) ? this.settings.selfIds : [] },
    };
  }

  async patchSettings(req, res) {
    const body = await readJson(req, 256 * 1024);
    const s = body.settings || {};
    if (Array.isArray(s.selfIds)) this.settings.selfIds = [...new Set(s.selfIds.filter((x) => typeof x === 'string' && x.length < 200))].slice(0, 50);
    const tmp = this.settingsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.settings));
    fs.renameSync(tmp, this.settingsFile);
    return sendJson(req, res, 200, { ok: true });
  }

  async statOne(v) {
    try {
      const r = await resolveVirtual(this.roots, String(v || ''));
      if (r.top) return { ok: true, isFile: false, isDir: true, size: 0, mtimeMs: 0 };
      const st = await fs.promises.stat(r.abs);
      return { ok: true, isFile: st.isFile(), isDir: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs };
    } catch (e) {
      return { ok: false, code: e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 'ENOENT' : e.code || 'EIO' };
    }
  }

  async apiList(req, res, q) {
    const v = q.get('path') || '/';
    const all = q.get('all') === '1';
    const hideMedia = q.get('hideMedia') === '1';
    const offset = Math.max(0, Number(q.get('offset')) || 0);
    const limit = Math.min(LIST_PAGE, Math.max(1, Number(q.get('limit')) || LIST_PAGE));
    const r = await resolveVirtual(this.roots, v);
    if (r.top) {
      await this.roots.discover();
      const entries = this.roots.list.map((x) => ({ name: x.name, path: '/' + x.name, isDir: true, isMd: false, root: true, writable: x.writable }));
      return sendJson(req, res, 200, { ok: true, entries, total: entries.length, more: false, paged: true });
    }
    const st = await fs.promises.stat(r.abs);
    if (!st.isDirectory()) return sendError(req, res, 400, 'ENOTDIR');
    let entries = await this.listing(r, st, all);
    if (hideMedia) {
      const media = await mapLimited(entries, 8, (e) => (e.isDir ? this.isMediaDir(path.join(r.abs, e.name)) : false));
      entries = entries.filter((_, i) => !media[i]);
    }
    const page = entries.slice(offset, offset + limit);
    return sendJson(req, res, 200, { ok: true, entries: page, total: entries.length, more: offset + limit < entries.length, offset, paged: true });
  }

  /**
   * A folder of media only: no Markdown, and mostly images, video or audio. Judged from the
   * first entries so a folder of a hundred thousand photos costs no more than a small one;
   * cached by the folder's modification time.
   */
  async isMediaDir(abs) {
    let st;
    try {
      st = await fs.promises.stat(abs);
    } catch {
      return false;
    }
    const hit = this.mediaDirCache.get(abs);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.media;
    let media = 0;
    let other = 0;
    let seen = 0;
    let md = false;
    try {
      for await (const d of await fs.promises.opendir(abs)) {
        if (++seen > MEDIA_PROBE) break;
        if (d.name.startsWith('.') || d.isDirectory()) continue;
        if (isMarkdownPath(d.name)) {
          md = true;
          break;
        }
        if (mediaKind(d.name)) media++;
        else other++;
      }
    } catch {
      return false;
    }
    const result = !md && media > 0 && media >= other;
    this.mediaDirCache.set(abs, { mtimeMs: st.mtimeMs, media: result });
    if (this.mediaDirCache.size > 20000) this.mediaDirCache.delete(this.mediaDirCache.keys().next().value);
    return result;
  }

  /** The previous and next Markdown file beside v, in the order the tree lists them. */
  async apiNeighbors(req, res, v) {
    const segs = splitVirtual(String(v || ''));
    if (segs.length < 2) return sendJson(req, res, 200, { ok: true, prev: null, next: null });
    const r = await resolveVirtual(this.roots, '/' + segs.slice(0, -1).join('/'));
    const st = await fs.promises.stat(r.abs);
    if (!st.isDirectory()) return sendError(req, res, 400, 'ENOTDIR');
    const files = (await this.listing(r, st, false)).filter((e) => e.isMd);
    const name = segs[segs.length - 1];
    const i = files.findIndex((e) => e.name === name);
    if (i === -1) return sendJson(req, res, 200, { ok: true, prev: null, next: null });
    return sendJson(req, res, 200, { ok: true, prev: files[i - 1]?.path || null, next: files[i + 1]?.path || null, index: i, total: files.length });
  }

  /** A folder's entries in tree order (folders first, natural name order), cached by mtime. */
  async listing(r, st, all) {
    const key = r.abs + '\0' + all;
    let c = this.listCache.get(key);
    if (!c || c.mtimeMs !== st.mtimeMs || Date.now() - c.t > LIST_CACHE_MS) {
      const ents = await fs.promises.readdir(r.abs, { withFileTypes: true });
      const out = [];
      for (const d of ents) {
        if (d.name.startsWith('.')) continue;
        let isDir = d.isDirectory();
        if (d.isSymbolicLink()) {
          try {
            const real = await fs.promises.realpath(path.join(r.abs, d.name));
            if (real !== r.root.real && !real.startsWith(r.root.real + path.sep)) continue; // points outside the root
            isDir = (await fs.promises.stat(real)).isDirectory();
          } catch {
            continue;
          }
        }
        const isMd = !isDir && isMarkdownPath(d.name);
        if (!isDir && !isMd && !all) continue;
        out.push({ name: d.name, path: r.vpath + '/' + d.name, isDir, isMd });
      }
      out.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : NAME_ORDER.compare(a.name, b.name)));
      c = { mtimeMs: st.mtimeMs, t: Date.now(), entries: out };
      this.listCache.set(key, c);
      if (this.listCache.size > 500) this.listCache.delete(this.listCache.keys().next().value);
    }
    return c.entries;
  }

  async apiFile(req, res, v) {
    const r = await resolveVirtual(this.roots, String(v || ''));
    if (r.top) return sendError(req, res, 400, 'EISDIR');
    const st = await fs.promises.stat(r.abs);
    if (st.isDirectory()) return sendError(req, res, 400, 'EISDIR');
    if (st.size > MAX_READ_BYTES) return sendJson(req, res, 413, { ok: false, code: 'ETOOBIG', size: st.size });
    const bytes = await fs.promises.readFile(r.abs);
    const hash = hashBytes(bytes);
    if (this.search && isMarkdownPath(r.abs)) this.search.noteOpened(r.vpath, st, bytes);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('ETag', `"${hash}"`);
    res.setHeader('X-Mdv-Hash', hash);
    res.setHeader('X-Mdv-Mtime', String(st.mtimeMs));
    res.setHeader('X-Mdv-Size', String(st.size));
    res.setHeader('X-Mdv-Writable', r.root.writable ? '1' : '0');
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').some((t) => t.trim() === `"${hash}"`)) {
      res.statusCode = 304;
      return res.end();
    }
    return sendCompressed(req, res, bytes);
  }

  async kindOf(v) {
    try {
      const r = await resolveVirtual(this.roots, v);
      if (r.top) return 'dir';
      const st = await fs.promises.stat(r.abs);
      return st.isFile() ? 'file' : st.isDirectory() ? 'dir' : null;
    } catch {
      return null;
    }
  }

  /** Same rules as the desktop edition: a file wins over a directory, '#' splits tried in turn. */
  async resolveLink(base, href) {
    const r = resolveHref(href, base);
    if (r.kind !== 'local') return r;
    const cands = [];
    for (const c of r.candidates) {
      const v = c.path;
      if (!v.startsWith('/') || v.startsWith('//')) continue; // a Windows path is outside every root
      try {
        splitVirtual(v);
      } catch {
        continue;
      }
      cands.push({ path: v, anchor: c.anchor });
    }
    if (!cands.length) return { kind: 'local', path: r.candidates[0].path, anchor: r.candidates[0].anchor, exists: false, isDir: false, outside: true };
    for (const c of cands) if ((await this.kindOf(c.path)) === 'file') return { kind: 'local', ...c, exists: true, isDir: false };
    for (const c of [...cands].reverse()) if ((await this.kindOf(c.path)) === 'dir') return { kind: 'local', ...c, exists: true, isDir: true };
    const first = cands[0];
    const known = this.roots.get(first.path.split('/')[1]);
    return { kind: 'local', ...first, exists: false, isDir: false, outside: !known };
  }

  async apiWrite(req, res) {
    const body = await readJson(req);
    let resolved;
    try {
      resolved = await resolveVirtual(this.roots, String(body.path || ''), { mustExist: true });
    } catch (e) {
      if (e instanceof PathError) return sendJson(req, res, 200, { ok: false, code: e.code === 'ENOENT' ? 'EGONE' : e.code });
      throw e;
    }
    if (resolved.top) return sendJson(req, res, 200, { ok: false, code: 'EISDIR' });
    const r = await overwrite({ cfg: this.cfg, resolved, opts: body, log: this.log });
    if (r.ok && this.search) await this.search.reindexNow(resolved.vpath);
    return sendJson(req, res, 200, r);
  }

  async apiVideo(req, res, v) {
    const r = await resolveVirtual(this.roots, String(v || ''));
    if (r.top) return sendError(req, res, 400, 'EISDIR');
    const st = await fs.promises.stat(r.abs);
    return sendJson(req, res, 200, { ok: true, available: this.video.available, mode: this.video.mode, cached: this.video.available ? await this.video.cached(r.abs, st) : false });
  }

  // ---------- media ----------
  async raw(req, res, v, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(req, res, 405, 'EMETHOD');
    const r = await resolveVirtual(this.roots, v);
    if (r.top) return sendError(req, res, 400, 'EISDIR');
    const st = await fs.promises.stat(r.abs);
    if (!st.isFile()) return sendError(req, res, 400, 'EISDIR');
    const type = mimeOf(r.abs);
    const download = url.searchParams.get('download') === '1';
    const headers = { 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'" };
    if (type === 'application/pdf' && !download) headers['Content-Security-Policy'] = 'sandbox';
    headers['Content-Disposition'] = disposition(download || !isInlineType(type) ? 'attachment' : 'inline', basename(r.abs));
    // anything not on the inline list is served as opaque bytes: never rendered by the browser
    return sendFile(req, res, r.abs, st, { type: download || isInlineType(type) ? type : 'application/octet-stream', headers });
  }

  /** A chat preview: the cached WebP thumbnail, or the original when it is small already. */
  async thumb(req, res, v) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(req, res, 405, 'EMETHOD');
    const r = await resolveVirtual(this.roots, v);
    if (r.top) return sendError(req, res, 400, 'EISDIR');
    const st = await fs.promises.stat(r.abs);
    if (!st.isFile()) return sendError(req, res, 400, 'EISDIR');
    const t = await this.thumbs.get(r.abs, st);
    if (!t) return this.raw(req, res, v, new URL('http://local/'));
    return sendFile(req, res, t.file, { ...t.st, mtimeMs: st.mtimeMs, size: t.st.size }, { type: 'image/webp', headers: { 'Content-Security-Policy': "sandbox; default-src 'none'" } });
  }

  async videoFile(req, res, v) {
    const r = await resolveVirtual(this.roots, v);
    if (r.top) return sendError(req, res, 400, 'EISDIR');
    const st = await fs.promises.stat(r.abs);
    if (!st.isFile()) return sendError(req, res, 400, 'EISDIR');
    if (!this.video.available) return sendError(req, res, 501, 'ENOTRANSCODE');
    let out;
    try {
      out = await this.video.transcode(r.abs, st);
    } catch (e) {
      this.log.warn(`视频转码失败：${v}：${e.detail || e.message}`);
      return sendError(req, res, 422, 'ETRANSCODE');
    }
    if (res.destroyed) return;
    const ost = await fs.promises.stat(out);
    return sendFile(req, res, out, ost, { type: 'video/mp4', headers: { 'Content-Security-Policy': "sandbox; default-src 'none'" } });
  }
}

function hasDotSegment(rawPath) {
  return rawPath.split('/').some((seg) => {
    const d = seg.replace(/%2e/gi, '.');
    return d === '.' || d === '..';
  });
}

function decodeVirtual(s) {
  try {
    return s
      .split('/')
      .map((x) => decodeURIComponent(x))
      .join('/');
  } catch {
    throw new PathError('EBADPATH');
  }
}

export { confirmSentence };
