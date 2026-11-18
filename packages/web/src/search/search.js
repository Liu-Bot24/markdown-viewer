// Search service on the server's main thread: owns the index writer thread, answers
// queries from the index (read-only connection) and scans files the index does not
// have yet, streams results as NDJSON, and runs slow full scans as background jobs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { decodeText } from '../../../core/src/shared/textformat.js';
import { isMarkdownPath } from '../../../core/src/shared/paths.js';
import { nextScheduled } from '../server/config.js';
import { readJson, sendError, sendJson } from '../server/http-util.js';
import { resolveVirtual } from '../server/vpath.js';
import { openDb, prefixRange } from './db.js';
import { parseMarkdown } from './parse.js';
import { ftsQuery, highlightRanges, matchesText, parseQuery } from './tokenize.js';

const PAGE = 100;
const JOB_KEEP_MS = 7 * 24 * 3600 * 1000;
const SCAN_FOREGROUND_LIMIT = 400; // files a foreground search scans before suggesting a background job

function snippet(text, ranges, width = 70) {
  const s = String(text || '');
  if (!ranges.length) return { text: s.slice(0, width * 2), ranges: [] };
  const [a] = ranges[0];
  const start = Math.max(0, a - width);
  const end = Math.min(s.length, a + width * 2);
  const cut = s.slice(start, end);
  const shift = start > 0 ? 1 : 0;
  return {
    text: (start > 0 ? '…' : '') + cut + (end < s.length ? '…' : ''),
    ranges: ranges.filter((r) => r[0] >= start && r[1] <= end).map((r) => [r[0] - start + shift, r[1] - start + shift]),
  };
}

export async function createSearch(server) {
  const s = new Search(server);
  await s.init();
  return s;
}

export class Search {
  constructor(server) {
    this.server = server;
    this.cfg = server.cfg;
    this.log = server.log;
    this.dir = path.join(this.cfg.stateDir, 'index');
    this.dbFile = path.join(this.dir, 'index.sqlite');
    this.jobsDir = path.join(this.cfg.stateDir, 'jobs');
    this.activityBuf = new SharedArrayBuffer(8);
    this.activity = new BigInt64Array(this.activityBuf);
    this.status = { checking: false, built: false, checked: 0, total: 0, files: 0, lastCheckEnd: 0 };
    this.pending = new Set();
    this.waiters = new Map();
    this.seq = 0;
    this.jobs = new Map();
    this.jobQueue = [];
    this.jobRunning = null;
  }

  async init() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.jobsDir, { recursive: true });
    // the server marks foreground activity; the writer thread reads it to step aside
    const touch = this.server.activity.touch.bind(this.server.activity);
    this.server.activity.touch = () => {
      touch();
      Atomics.store(this.activity, 0, BigInt(Date.now()));
    };
    this.worker = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: { dbFile: this.dbFile, roots: this.rootsForWorker(), activity: this.activityBuf, ...(this.server.indexOptions || {}) },
    });
    this.worker.on('message', (m) => this.onWorker(m));
    this.worker.on('error', (e) => this.log.error('索引线程出错：' + e.message));
    await new Promise((resolve) => {
      this.readyResolve = resolve;
    });
    this.db = openDb(this.dbFile, { readonly: true });
    this.loadJobs();
  }

  rootsForWorker() {
    return this.server.roots.list.map((r) => ({ name: r.name, real: r.real }));
  }

  onWorker(m) {
    if (m.type === 'ready') return this.readyResolve && this.readyResolve();
    if (m.type === 'status') this.status = m.status;
    else if (m.type === 'pending') {
      for (const v of m.add || []) this.pending.add(v);
      for (const v of m.remove || []) this.pending.delete(v);
    } else if (m.type === 'done') {
      const w = this.waiters.get(m.id);
      if (w) {
        this.waiters.delete(m.id);
        w(m.result);
      }
    } else if (m.type === 'log') this.log[m.level] ? this.log[m.level](m.msg) : this.log.info(m.msg);
  }

  /** Check at startup; again on the first visit after MDV_RECHECK_IDLE_HOURS; and on MDV_INDEX_SCHEDULE when set. */
  start() {
    this.recheck('启动');
    this.armSchedule();
  }

  armSchedule() {
    clearTimeout(this.scheduleTimer);
    this.nextScheduled = nextScheduled(this.cfg.indexSchedule);
    if (this.nextScheduled === null || this.closed) return;
    const wake = () => {
      const left = this.nextScheduled - Date.now();
      // setTimeout tops out near 24.8 days: wait in steps until the time comes
      if (left > 0) {
        this.scheduleTimer = setTimeout(wake, Math.min(left, 2 ** 31 - 1));
        this.scheduleTimer.unref();
        return;
      }
      if (!this.status.checking) this.recheck('定时');
      this.armSchedule();
    };
    wake();
  }

  touch() {
    const hours = this.cfg.recheckIdleHours;
    if (!hours || this.status.checking) return;
    const last = this.status.lastCheckEnd || 0;
    if (Date.now() - last > hours * 3600 * 1000) this.recheck('空闲后访问');
  }

  async recheck(reason) {
    await this.server.roots.discover();
    this.worker.postMessage({ cmd: 'roots', roots: this.rootsForWorker() });
    this.status = { ...this.status, checking: true };
    this.log.info(`索引检查开始（${reason}）`);
    this.worker.postMessage({ cmd: 'check' });
  }

  reindex(vpath) {
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      this.worker.postMessage({ cmd: 'reindex', id, vpath });
    });
  }

  /** After an in-app overwrite: the index is updated inside the same request. */
  reindexNow(vpath) {
    return this.reindex(vpath);
  }

  /** Opening a file reads it anyway: if it differs from what the index has, refresh that file. */
  noteOpened(vpath, st) {
    const f = this.db.prepare('SELECT size, mtime FROM files WHERE vpath = ?').get(vpath);
    if (f && f.size === st.size && f.mtime === st.mtimeMs) return;
    this.pending.add(vpath);
    this.reindex(vpath).catch(() => {});
  }

  async close() {
    this.closed = true;
    clearTimeout(this.scheduleTimer);
    for (const j of this.jobQueue) j.cancel = true;
    if (this.jobRunning) this.jobRunning.cancel = true;
    while (this.jobRunning) await new Promise((r) => setTimeout(r, 20));
    if (this.worker) {
      this.worker.postMessage({ cmd: 'stop' });
      await new Promise((r) => {
        this.worker.once('exit', r);
        setTimeout(r, 3000);
      });
    }
    if (this.db) this.db.close();
  }

  statusJson() {
    const st = this.status;
    return {
      ...st,
      pending: this.pending.size,
      job: this.jobRunning ? this.jobRunning.id : null,
      recheckIdleHours: this.cfg.recheckIdleHours,
      schedule: this.cfg.indexSchedule,
      nextScheduled: this.nextScheduled || null,
    };
  }

  // ---------- HTTP ----------
  async handle(req, res, p, url) {
    const GET = req.method === 'GET';
    if (p === '/api/index' && GET) return sendJson(req, res, 200, this.statusJson());
    if (p === '/api/index/recheck' && !GET) {
      this.recheck('手动');
      return sendJson(req, res, 200, { ok: true });
    }
    if (p === '/api/index/rebuild' && !GET) {
      this.pending.clear();
      this.status = { ...this.status, checking: true, built: false };
      this.log.info('重建索引（手动）');
      this.worker.postMessage({ cmd: 'rebuild' });
      return sendJson(req, res, 200, { ok: true });
    }
    if (p === '/api/senders' && GET) return sendJson(req, res, 200, await this.senders(url.searchParams.get('scope') || '/'));
    if (p === '/api/search' && GET) return this.streamSearch(req, res, url.searchParams);
    if (p === '/api/jobs') {
      if (GET) return sendJson(req, res, 200, { ok: true, jobs: this.jobList() });
      const body = await readJson(req, 64 * 1024);
      return sendJson(req, res, 200, this.addJob(body));
    }
    const m = /^\/api\/jobs\/([a-f0-9]{16})$/.exec(p);
    if (m) {
      if (GET) return this.jobResult(req, res, m[1]);
      if (req.method === 'DELETE') return sendJson(req, res, 200, this.deleteJob(m[1]));
    }
    return sendError(req, res, 404, 'ENOAPI');
  }

  scopeOf(v) {
    const scope = String(v || '/').replace(/\/+$/, '') || '/';
    if (scope !== '/') {
      const name = scope.split('/')[1];
      if (!this.server.roots.get(name)) throw Object.assign(new Error('scope'), { status: 400, code: 'ESCOPE' });
    }
    return scope;
  }

  where(scope, f) {
    const cond = [];
    const args = [];
    if (scope !== '/') {
      const [lo, hi] = prefixRange(scope);
      if (/\.(md|markdown|mdown|mkdn?|mdwn)$/i.test(scope)) {
        cond.push('f.vpath = ?');
        args.push(scope);
      } else {
        cond.push('f.vpath >= ? AND f.vpath < ?');
        args.push(lo, hi);
      }
    }
    if (f.from) {
      cond.push('m.ts >= ?');
      args.push(f.from);
    }
    if (f.to) {
      cond.push('m.ts < ?');
      args.push(f.to);
    }
    if (f.sender) {
      cond.push('m.sender = ?');
      args.push(f.sender);
    }
    if (f.type) {
      cond.push('m.type = ?');
      args.push(f.type);
    }
    return { sql: cond.length ? ' AND ' + cond.join(' AND ') : '', args };
  }

  filters(params) {
    // dates: "YYYY-MM" or "YYYY-MM-DD"; "to" is inclusive of that month/day
    const norm = (d, end) => {
      if (!d) return '';
      if (/^\d{4}-\d{2}$/.test(d)) {
        if (!end) return d + '-01';
        const [y, mo] = d.split('-').map(Number);
        return mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`;
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        if (!end) return d;
        const t = new Date(d + 'T00:00:00Z');
        t.setUTCDate(t.getUTCDate() + 1);
        return t.toISOString().slice(0, 10);
      }
      return '';
    };
    return { from: norm(params.get('from'), false), to: norm(params.get('to'), true), sender: params.get('sender') || '', type: params.get('type') || '' };
  }

  async senders(scopeV) {
    const scope = this.scopeOf(scopeV);
    const w = this.where(scope, {});
    const rows = this.db.prepare(`SELECT m.sender AS name, count(*) AS n FROM msgs m JOIN files f ON f.id = m.file_id WHERE m.sender != '' AND f.kind = 'chat'${w.sql} GROUP BY m.sender ORDER BY n DESC LIMIT 300`).all(...w.args);
    const types = this.db.prepare(`SELECT m.type AS name, count(*) AS n FROM msgs m JOIN files f ON f.id = m.file_id WHERE 1${w.sql} GROUP BY m.type ORDER BY n DESC LIMIT 50`).all(...w.args);
    return { ok: true, senders: rows, types };
  }

  hitOf(row, terms, extra) {
    const ranges = highlightRanges(row.text, terms);
    const sn = snippet(row.text, ranges);
    return { path: row.vpath, anchor: row.anchor || '', ts: row.ts || '', sender: row.sender || '', type: row.type || '', title: row.title || '', kind: row.kind, text: sn.text, ranges: sn.ranges, ...extra };
  }

  /** Files in scope the index cannot answer for right now. */
  pendingIn(scope) {
    const out = [];
    const [lo, hi] = prefixRange(scope);
    for (const v of this.pending) if (scope === '/' || v === scope || (v >= lo && v < hi)) out.push(v);
    return out.sort().reverse();
  }

  async streamSearch(req, res, params) {
    const t0 = Date.now();
    const terms = parseQuery(params.get('q') || '');
    const scope = this.scopeOf(params.get('scope'));
    const f = this.filters(params);
    const offset = Math.max(0, Number(params.get('offset')) || 0);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    let closed = false;
    req.on('close', () => (closed = true));
    res.on('close', () => (closed = true));
    const send = (o) => !closed && res.write(JSON.stringify(o) + '\n');
    if (!terms.length) {
      send({ t: 'done', total: 0, more: false, error: 'EEMPTY' });
      return res.end();
    }
    const st = this.statusJson();
    send({ t: 'meta', terms: terms.map((x) => x.text), scope, index: { built: st.built, checking: st.checking, lastCheckEnd: st.lastCheckEnd, checked: st.checked, total: st.total } });

    // 1) the index
    const w = this.where(scope, f);
    const match = ftsQuery(terms);
    let total = 0;
    let rows = [];
    try {
      const pendingList = [...this.pending];
      const excl = pendingList.length && pendingList.length < 5000 ? ` AND f.vpath NOT IN (${pendingList.map(() => '?').join(',')})` : '';
      const exclArgs = excl ? pendingList : [];
      total = this.db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM msgs_fts JOIN msgs m ON m.id = msgs_fts.rowid JOIN files f ON f.id = m.file_id WHERE msgs_fts MATCH ?${w.sql}${excl} LIMIT 10001)`).get(match, ...w.args, ...exclArgs).n;
      rows = this.db
        .prepare(`SELECT m.anchor, m.ts, m.sender, m.type, m.text, f.vpath, f.title, f.kind FROM msgs_fts JOIN msgs m ON m.id = msgs_fts.rowid JOIN files f ON f.id = m.file_id WHERE msgs_fts MATCH ?${w.sql}${excl} ORDER BY m.ts DESC, m.id DESC LIMIT ? OFFSET ?`)
        .all(match, ...w.args, ...exclArgs, PAGE, offset);
    } catch (e) {
      this.log.warn('搜索出错：' + e.message);
      send({ t: 'done', total: 0, more: false, error: 'EQUERY' });
      return res.end();
    }
    const stale = st.checking;
    send({ t: 'hits', source: 'index', hits: rows.map((r) => this.hitOf(r, terms, stale ? { stale: true } : {})), total, capped: total > 10000 });
    let more = offset + rows.length < total;

    // 2) files the index does not have yet (only with the first page)
    let scanned = 0;
    let scanTotal = 0;
    let suggestJob = false;
    if (offset === 0) {
      const todo = this.pendingIn(scope);
      scanTotal = todo.length;
      if (todo.length > SCAN_FOREGROUND_LIMIT) suggestJob = true;
      for (const v of todo.slice(0, SCAN_FOREGROUND_LIMIT)) {
        if (closed) return;
        const hits = await this.scanFile(v, terms, f);
        scanned++;
        if (hits.length) send({ t: 'hits', source: 'scan', hits });
        if (scanned % 20 === 0) send({ t: 'progress', scanned, scanTotal });
      }
    }
    send({ t: 'done', total, more, scanned, scanTotal, suggestJob: suggestJob || !st.built, elapsedMs: Date.now() - t0 });
    res.end();
  }

  /** Match one file directly from disk with the same rules as the index. */
  async scanFile(v, terms, f) {
    let r;
    try {
      r = await resolveVirtual(this.server.roots, v);
      if (r.top || !isMarkdownPath(r.abs)) return [];
    } catch {
      return [];
    }
    let bytes;
    try {
      bytes = await fs.promises.readFile(r.abs);
    } catch {
      return [];
    }
    const parsed = parseMarkdown(decodeText(bytes).text);
    const out = [];
    for (const row of parsed.rows) {
      if (f.from && row.ts < f.from) continue;
      if (f.to && row.ts >= f.to) continue;
      if (f.sender && row.sender !== f.sender) continue;
      if (f.type && row.type !== f.type) continue;
      if (!matchesText(row.text, terms)) continue;
      out.push(this.hitOf({ ...row, vpath: v, title: parsed.title, kind: parsed.kind }, terms, { scan: true }));
    }
    return out.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  }

  // ---------- background jobs: full scans of a scope from disk ----------
  loadJobs() {
    const now = Date.now();
    for (const n of fs.readdirSync(this.jobsDir)) {
      if (!n.endsWith('.json')) continue;
      const file = path.join(this.jobsDir, n);
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (now - (j.created || 0) > JOB_KEEP_MS) {
          fs.unlinkSync(file);
          continue;
        }
        if (j.state === 'running' || j.state === 'queued') j.state = 'interrupted';
        delete j.hits;
        this.jobs.set(j.id, j);
      } catch {
        /* skip a broken file */
      }
    }
  }

  jobList() {
    return [...this.jobs.values()].sort((a, b) => b.created - a.created).map(({ hits, ...j }) => j);
  }

  addJob(body) {
    const terms = parseQuery(body.q || '');
    if (!terms.length) return { ok: false, code: 'EEMPTY' };
    const scope = this.scopeOf(body.scope);
    const id = crypto.randomBytes(8).toString('hex');
    const job = { id, q: String(body.q), scope, filters: { from: body.from || '', to: body.to || '', sender: body.sender || '', type: body.type || '' }, created: Date.now(), state: 'queued', scanned: 0, total: 0, found: 0 };
    this.jobs.set(id, job);
    this.jobQueue.push(job);
    this.saveJob(job, []);
    this.runJobs();
    return { ok: true, id };
  }

  saveJob(job, hits) {
    const file = path.join(this.jobsDir, job.id + '.json');
    try {
      fs.writeFileSync(file + '.tmp', JSON.stringify({ ...job, hits }));
      fs.renameSync(file + '.tmp', file);
    } catch (e) {
      this.server.log.warn(`后台搜索结果无法保存：${e.message}`);
    }
  }

  deleteJob(id) {
    const j = this.jobs.get(id);
    if (!j) return { ok: false, code: 'ENOENT' };
    j.cancel = true;
    this.jobs.delete(id);
    this.jobQueue = this.jobQueue.filter((x) => x.id !== id);
    fs.rmSync(path.join(this.jobsDir, id + '.json'), { force: true });
    return { ok: true };
  }

  jobResult(req, res, id) {
    const j = this.jobs.get(id);
    if (!j) return sendError(req, res, 404, 'ENOENT');
    let hits = [];
    try {
      hits = JSON.parse(fs.readFileSync(path.join(this.jobsDir, id + '.json'), 'utf8')).hits || [];
    } catch {
      /* none yet */
    }
    const { hits: _h, cancel, ...meta } = j;
    return sendJson(req, res, 200, { ok: true, job: meta, hits });
  }

  async runJobs() {
    if (this.jobRunning) return;
    while (this.jobQueue.length) {
      const job = this.jobQueue.shift();
      if (job.cancel) continue;
      this.jobRunning = job;
      job.state = 'running';
      const terms = parseQuery(job.q);
      const params = new URLSearchParams(Object.entries(job.filters).filter(([, v]) => v));
      const f = this.filters(params);
      const hits = [];
      try {
        const files = await this.listMarkdown(job.scope, job);
        job.total = files.length;
        let lastSave = Date.now();
        for (const v of files) {
          if (job.cancel) break;
          while (this.server.activity.busy(2000)) await new Promise((r) => setTimeout(r, 300));
          const h = await this.scanFile(v, terms, f);
          hits.push(...h);
          job.scanned++;
          job.found = hits.length;
          if (Date.now() - lastSave > 5000) {
            this.saveJob(job, hits);
            lastSave = Date.now();
          }
        }
        job.state = job.cancel ? 'cancelled' : 'done';
      } catch (e) {
        job.state = 'failed';
        job.error = e.message;
      }
      job.finished = Date.now();
      hits.sort((a, b) => (a.ts < b.ts ? 1 : -1));
      if (!job.cancel) this.saveJob(job, hits);
      this.jobRunning = null;
    }
  }

  /** Every Markdown file under a scope, walking the disk (background jobs only). */
  async listMarkdown(scope, job) {
    const out = [];
    const starts = scope === '/' ? this.server.roots.list.map((r) => '/' + r.name) : [scope];
    const queue = [...starts];
    while (queue.length) {
      if (job.cancel) break;
      const v = queue.shift();
      let r;
      try {
        r = await resolveVirtual(this.server.roots, v);
      } catch {
        continue;
      }
      let st;
      try {
        st = await fs.promises.stat(r.abs);
      } catch {
        continue;
      }
      if (st.isFile()) {
        if (isMarkdownPath(r.abs)) out.push(v);
        continue;
      }
      let ents = [];
      try {
        ents = await fs.promises.readdir(r.abs, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of ents) {
        if (d.name.startsWith('.')) continue;
        if (d.isDirectory()) queue.push(v + '/' + d.name);
        else if (isMarkdownPath(d.name)) out.push(v + '/' + d.name);
      }
    }
    return out.sort().reverse();
  }
}
