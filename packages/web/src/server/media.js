// Image thumbnails (sharp) for chat previews, and on-demand video transcoding (ffmpeg)
// for formats the browser cannot play. Both are cached under the cache dir and limited
// in concurrency.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VIDEO_CACHE_MAX = 20 * 1024 ** 3;

export const THUMB_EDGE = 720; // long edge, px
const THUMB_QUALITY = 75;
const THUMB_TYPES = new Set(['.jpg', '.jpeg', '.jfif', '.png', '.webp', '.avif', '.tif', '.tiff']);
const THUMB_MAX_INPUT = 64 * 1024 * 1024;
const SMALL_MEMO = 50000; // remembered originals that need no thumbnail
const DAY = 24 * 3600 * 1000;

class Limiter {
  constructor(n) {
    this.n = n;
    this.active = 0;
    this.queue = [];
  }
  async run(fn) {
    if (this.active >= this.n) await new Promise((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

const keyOf = (...parts) => crypto.createHash('sha1').update(parts.join('\0')).digest('hex');
const fmtBytes = (n) => (n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + ' GB' : (n / 1024 ** 2).toFixed(1) + ' MB');

/**
 * WebP thumbnails, long edge 720 px, made on first view and cached under <cache>/thumbs.
 * Originals whose long edge is already 720 px or less are served as they are. The cache
 * has a size limit (MDV_THUMB_CACHE_GB); past it, the least recently viewed thumbnails go.
 * Recency survives restarts through the files' modification times, refreshed at most
 * once a day per file when it is viewed.
 */
export class Thumbs {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.dir = path.join(cfg.cacheDir, 'thumbs');
    this.max = cfg.thumbCacheBytes;
    this.limit = new Limiter(2);
    this.sharp = null;
    this.index = new Map(); // "ab/<key>.webp" -> size, least recently viewed first
    this.total = 0;
    this.scanned = false;
    this.small = new Map();
    this.jobs = new Map();
    this.evicting = null;
    this.seq = 0;
  }

  async init() {
    if (!this.max) {
      this.log.info('缩略图已关闭（MDV_THUMB_CACHE_GB=0），图片按原图提供');
      return false;
    }
    try {
      this.sharp = (await import('sharp')).default;
      this.sharp.concurrency(1);
      this.sharp.cache(false);
    } catch {
      this.sharp = null;
      this.log.warn('图像库 sharp 不可用：图片按原图提供');
      return false;
    }
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
    } catch (e) {
      this.sharp = null;
      this.log.warn(`缓存目录不可写（${e.code || e.message}）：图片按原图提供`);
      return false;
    }
    this.scanning = this.scan().catch((e) => this.log.warn('读取缩略图缓存失败：' + e.message));
    return true;
  }

  get available() {
    return !!this.sharp;
  }

  stats() {
    return { files: this.index.size, bytes: this.total, maxBytes: this.max, scanned: this.scanned };
  }

  /** Learn what the cache already holds, oldest first; eviction waits for this. */
  async scan() {
    const found = [];
    for (const sub of await fs.promises.readdir(this.dir)) {
      if (!/^[0-9a-f]{2}$/.test(sub)) continue;
      const d = path.join(this.dir, sub);
      for (const n of await fs.promises.readdir(d)) {
        const p = path.join(d, n);
        try {
          const s = await fs.promises.stat(p);
          if (n.endsWith('.webp')) found.push([sub + '/' + n, s.size, s.mtimeMs]);
          else if (n.endsWith('.tmp') && Date.now() - s.mtimeMs > 3600 * 1000) await fs.promises.unlink(p); // left by a crash
        } catch {
          /* gone meanwhile */
        }
      }
      await new Promise((r) => setImmediate(r));
    }
    found.sort((a, b) => a[2] - b[2]);
    const added = this.index; // made while scanning: the most recent
    this.index = new Map();
    this.total = 0;
    for (const [rel, size] of found) {
      if (added.has(rel)) continue;
      this.index.set(rel, size);
      this.total += size;
    }
    for (const [rel, size] of added) {
      this.index.set(rel, size);
      this.total += size;
    }
    this.scanned = true;
    this.log.info(`缩略图缓存：${this.index.size} 个，${fmtBytes(this.total)}，上限 ${fmtBytes(this.max)}`);
    this.maybeEvict();
  }

  /** { file, st } of the thumbnail for abs (stat st), made if needed; null to serve the original. */
  async get(abs, st) {
    if (!this.sharp) return null;
    if (!THUMB_TYPES.has(path.extname(abs).toLowerCase()) || st.size > THUMB_MAX_INPUT) return null;
    const key = keyOf(abs, st.size, Math.floor(st.mtimeMs), THUMB_EDGE, THUMB_QUALITY);
    if (this.small.has(key)) return null;
    const rel = key.slice(0, 2) + '/' + key + '.webp';
    const out = path.join(this.dir, rel);
    const cached = await this.hit(rel, out);
    if (cached) return cached;
    if (this.jobs.has(rel)) return this.jobs.get(rel);
    const job = this.limit.run(() => this.make(abs, st, key, rel, out)).finally(() => this.jobs.delete(rel));
    this.jobs.set(rel, job);
    return job;
  }

  async hit(rel, out) {
    let tst;
    try {
      tst = await fs.promises.stat(out);
    } catch {
      return null;
    }
    if (this.index.has(rel)) {
      const size = this.index.get(rel);
      this.index.delete(rel);
      this.index.set(rel, size);
    } else if (this.scanned) {
      this.index.set(rel, tst.size);
      this.total += tst.size;
    }
    if (Date.now() - tst.mtimeMs > DAY) {
      const now = new Date();
      fs.promises.utimes(out, now, now).catch(() => {});
    }
    return { file: out, st: tst };
  }

  markSmall(key) {
    this.small.set(key, true);
    if (this.small.size > SMALL_MEMO) this.small.delete(this.small.keys().next().value);
  }

  async make(abs, st, key, rel, out) {
    const again = await this.hit(rel, out);
    if (again) return again;
    let img;
    let meta;
    try {
      const input = await fs.promises.readFile(abs);
      img = this.sharp(input, { failOn: 'none', limitInputPixels: 2 ** 28 });
      meta = await img.metadata();
    } catch {
      this.markSmall(key); // unreadable here: let the browser try the original
      return null;
    }
    if (!meta.width || !meta.height || Math.max(meta.width, meta.height) <= THUMB_EDGE) {
      this.markSmall(key);
      return null;
    }
    await fs.promises.mkdir(path.dirname(out), { recursive: true });
    const tmp = `${out}.${process.pid}.${++this.seq}.tmp`;
    try {
      await img
        .rotate()
        .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: THUMB_QUALITY })
        .toFile(tmp);
      const tst = await fs.promises.stat(tmp);
      if (tst.size >= st.size) {
        // no smaller than the original: not worth keeping
        await fs.promises.unlink(tmp).catch(() => {});
        this.markSmall(key);
        return null;
      }
      await fs.promises.rename(tmp, out);
      this.index.set(rel, tst.size);
      this.total += tst.size;
      this.maybeEvict();
      return { file: out, st: tst };
    } catch {
      await fs.promises.unlink(tmp).catch(() => {});
      return null;
    }
  }

  maybeEvict() {
    if (!this.scanned || this.total <= this.max || this.evicting) return;
    this.evicting = this.evict().finally(() => (this.evicting = null));
  }

  /** Remove the least recently viewed thumbnails until the cache is at 90% of its limit. */
  async evict() {
    const target = this.max * 0.9;
    let n = 0;
    let freed = 0;
    for (const [rel, size] of this.index) {
      if (this.total <= target) break;
      if (this.jobs.has(rel)) continue;
      this.index.delete(rel);
      this.total -= size;
      freed += size;
      n++;
      await fs.promises.unlink(path.join(this.dir, rel)).catch(() => {});
    }
    this.log.info(`缩略图缓存超过上限 ${fmtBytes(this.max)}：删掉最久没看的 ${n} 个（${fmtBytes(freed)}）`);
  }
}

function run(cmd, args, { timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let p;
    try {
      p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, out, err: String(e) });
    }
    const t = timeoutMs ? setTimeout(() => p.kill('SIGKILL'), timeoutMs) : null;
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    p.on('error', (e) => resolve({ code: -1, out, err: String(e) }));
    p.on('close', (code) => {
      if (t) clearTimeout(t);
      resolve({ code, out, err });
    });
  });
}

export class Transcoder {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.dir = path.join(cfg.cacheDir, 'video');
    this.mode = 'off'; // 'hw' (VAAPI / Quick Sync) | 'sw' | 'off'
    this.jobs = new Map();
    this.limit = new Limiter(1);
    this.device = '/dev/dri/renderD128';
  }

  async init() {
    if (this.cfg.transcode === 'off') return (this.mode = 'off');
    const enc = await run(this.cfg.ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 15000 });
    if (enc.code !== 0) {
      this.log.warn('没有找到 ffmpeg：浏览器不能播放的视频只提供下载');
      return (this.mode = 'off');
    }
    const hasVaapi = /h264_vaapi/.test(enc.out) && fs.existsSync(this.device);
    const hasX264 = /libx264/.test(enc.out);
    if (hasVaapi && (await this.probeVaapi())) {
      this.mode = 'hw';
      this.limit = new Limiter(2);
    } else if (hasX264) this.mode = 'sw';
    else this.mode = 'off';
    this.log.info(`视频转码：${{ hw: '硬件（VAAPI / Quick Sync）', sw: '软件（libx264）', off: '不可用' }[this.mode]}`);
    return this.mode;
  }

  /** A one-second synthetic encode tells whether the GPU path really works in this container. */
  async probeVaapi() {
    const r = await run(
      this.cfg.ffmpeg,
      ['-hide_banner', '-v', 'error', '-vaapi_device', this.device, '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=1', '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-f', 'null', '-'],
      { timeoutMs: 20000 },
    );
    if (r.code !== 0) this.log.warn('VAAPI 不可用，改用软件转码：' + r.err.trim().split('\n').pop());
    return r.code === 0;
  }

  get available() {
    return this.mode !== 'off';
  }

  outFor(abs, st) {
    const key = keyOf(abs, st.size, Math.floor(st.mtimeMs));
    return path.join(this.dir, key + '.mp4');
  }

  async cached(abs, st) {
    try {
      await fs.promises.access(this.outFor(abs, st));
      return true;
    } catch {
      return false;
    }
  }

  args(input, output, mode) {
    const audio = ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'];
    const tail = ['-movflags', '+faststart', '-map_metadata', '-1', '-f', 'mp4', output];
    if (mode === 'hw') {
      return ['-hide_banner', '-v', 'error', '-y', '-hwaccel', 'vaapi', '-hwaccel_device', this.device, '-hwaccel_output_format', 'vaapi', '-i', input, '-map', '0:v:0', '-map', '0:a?', '-vf', "scale_vaapi=w=-2:h='min(ih,1080)':format=nv12", '-c:v', 'h264_vaapi', '-qp', '24', ...audio, ...tail];
    }
    return ['-hide_banner', '-v', 'error', '-y', '-threads', '2', '-i', input, '-map', '0:v:0', '-map', '0:a?', '-vf', "scale=-2:'min(ih,1080)'", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', ...audio, ...tail];
  }

  /** Resolve to the transcoded file path, or throw. Concurrent callers share one job. */
  transcode(abs, st) {
    const out = this.outFor(abs, st);
    if (this.jobs.has(out)) return this.jobs.get(out);
    const job = this.limit
      .run(async () => {
        try {
          await fs.promises.access(out);
          return out;
        } catch {
          /* not yet */
        }
        await fs.promises.mkdir(this.dir, { recursive: true });
        const tmp = out + '.' + process.pid + '.tmp';
        const t0 = Date.now();
        let r = await run(this.cfg.ffmpeg, this.args(abs, tmp, this.mode), { timeoutMs: 30 * 60 * 1000 });
        if (r.code !== 0 && this.mode === 'hw') {
          // some sources (10-bit, odd sizes) fail on the GPU path: retry in software
          r = await run(this.cfg.ffmpeg, this.args(abs, tmp, 'sw'), { timeoutMs: 30 * 60 * 1000 });
        }
        if (r.code !== 0) {
          await fs.promises.unlink(tmp).catch(() => {});
          throw Object.assign(new Error('transcode failed'), { detail: r.err.trim().split('\n').pop() });
        }
        await fs.promises.rename(tmp, out);
        this.log.info(`视频转码完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
        this.prune().catch(() => {});
        return out;
      })
      .finally(() => this.jobs.delete(out));
    this.jobs.set(out, job);
    return job;
  }

  async prune() {
    const ents = [];
    for (const n of await fs.promises.readdir(this.dir)) {
      if (!n.endsWith('.mp4')) continue;
      const p = path.join(this.dir, n);
      const s = await fs.promises.stat(p);
      ents.push({ p, size: s.size, t: s.atimeMs || s.mtimeMs });
    }
    let total = ents.reduce((a, e) => a + e.size, 0);
    for (const e of ents.sort((a, b) => a.t - b.t)) {
      if (total <= VIDEO_CACHE_MAX) break;
      await fs.promises.unlink(e.p).catch(() => {});
      total -= e.size;
    }
  }
}
