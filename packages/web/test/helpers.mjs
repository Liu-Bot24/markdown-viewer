// Test helpers: a throwaway deployment (roots, state, cache) built from the shared
// synthetic fixtures, and a server on a random local port.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { WebServer, makeLogger } from '../src/server/server.js';
import { createSearch } from '../src/search/search.js';

export const REPO = path.resolve(import.meta.dirname, '..', '..', '..');
export const FIXTURES = path.join(REPO, 'test', 'fixtures');

export function makeDeployment() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-web-'));
  const roots = path.join(dir, 'roots');
  fs.mkdirSync(roots);
  fs.cpSync(path.join(FIXTURES, 'wechat', '聊天记录归档'), path.join(roots, 'archive'), { recursive: true });
  fs.cpSync(path.join(FIXTURES, 'gfm'), path.join(roots, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'state'));
  fs.mkdirSync(path.join(dir, 'cache'));
  return { dir, roots, state: path.join(dir, 'state'), cache: path.join(dir, 'cache') };
}

export async function startServer(dep, env = {}, { search = true, indexOptions } = {}) {
  const cfg = loadConfig({
    MDV_PORT: '0',
    MDV_HOST: '127.0.0.1',
    MDV_ROOTS_DIR: dep.roots,
    MDV_STATE_DIR: dep.state,
    MDV_CACHE_DIR: dep.cache,
    MDV_TRANSCODE: 'off',
    MDV_STATIC_DIR: path.join(REPO, 'packages', 'web', 'dist', 'public'),
    ...env,
  });
  const logs = [];
  const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  const server = new WebServer(cfg, { log, searchFactory: search ? createSearch : null });
  server.indexOptions = { settleMs: 0, pauseMs: 0, busyMs: 0, ...(indexOptions || {}) };
  await server.init();
  const addr = await server.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  const f = (p, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (opts.method && opts.method !== 'GET' && !('Origin' in headers)) headers.Origin = base;
    if (opts.json) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.json);
    }
    return fetch(base + p, { redirect: 'manual', ...opts, headers });
  };
  return { server, base, f, logs, cfg };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, ms = 20000, step = 50) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await sleep(step);
  }
}

/** Wait until the index finished a check that started at or after `since` (any finished check by default). */
export async function indexIdle(f, since = 1) {
  return waitFor(async () => {
    const s = await (await f('/api/index')).json();
    return !s.checking && s.lastCheckEnd >= since && s.lastCheckStart >= since && s.lastCheckEnd >= s.lastCheckStart ? s : null;
  });
}

export async function searchAll(f, q, scope = '/', extra = {}) {
  const qs = new URLSearchParams({ q, scope, ...extra });
  const text = await (await f('/api/search?' + qs)).text();
  const lines = text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const hits = lines.filter((l) => l.t === 'hits').flatMap((l) => l.hits.map((h) => ({ ...h, source: l.source })));
  return { lines, hits, done: lines.find((l) => l.t === 'done') };
}
