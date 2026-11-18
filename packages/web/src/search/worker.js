// Index writer thread. Finds what changed in the content roots with metadata-only
// checks (stat of directories and Markdown files; media is never touched), then
// re-reads only the changed files. Low priority: one operation at a time, short
// pauses between batches, and it waits while the server is handling foreground requests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { decodeText } from '../../../core/src/shared/textformat.js';
import { isMarkdownPath } from '../../../core/src/shared/paths.js';
import { getMeta, openDb, prefixRange, setMeta } from './db.js';
import { parseMarkdown } from './parse.js';
import { indexText } from './tokenize.js';

const { dbFile, activity: activityBuf, settleMs = 5000, batch = 200, pauseMs = 30, busyMs = 2000 } = workerData;
const activity = new BigInt64Array(activityBuf);
const MAX_FILE = 64 * 1024 * 1024;

try {
  os.setPriority(0, 19); // this thread only, on Linux
} catch {
  /* not permitted: the yielding below still applies */
}

const db = openDb(dbFile);
let roots = workerData.roots; // [{ name, real }]
let checking = false;
let checkAgain = false;
let stopping = false;
const status = { checking: false, phase: '', checked: 0, total: 0, changed: 0, indexedNow: 0, lastCheckStart: getMeta(db, 'lastCheckStart', 0), lastCheckEnd: getMeta(db, 'lastCheckEnd', 0), built: getMeta(db, 'built', false), error: '' };
const priority = []; // reindex requests that jump the queue

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ops = 0;

/** Pause between batches, and while the server is busy with someone's request. */
async function yieldIO() {
  if (++ops % batch === 0) await sleep(pauseMs);
  while (!stopping && Date.now() - Number(Atomics.load(activity, 0)) < busyMs) await sleep(200);
  if (priority.length) await drainPriority();
}

function post(msg) {
  parentPort.postMessage(msg);
}

let statusTimer = null;
function sendStatus(now = false) {
  if (now) {
    clearTimeout(statusTimer);
    statusTimer = null;
    return post({ type: 'status', status: { ...status, files: countFiles() } });
  }
  if (!statusTimer) statusTimer = setTimeout(() => sendStatus(true), 500);
}

function countFiles() {
  return db.prepare('SELECT count(*) AS n FROM files').get().n;
}

const rootOf = (v) => roots.find((r) => v === '/' + r.name || v.startsWith('/' + r.name + '/'));
function absOf(v) {
  const r = rootOf(v);
  if (!r) return null;
  const rel = v.slice(r.name.length + 2);
  return rel ? path.join(r.real, ...rel.split('/')) : r.real;
}
const parentOf = (v) => v.slice(0, v.lastIndexOf('/')) || '/';

async function statOrNull(abs) {
  try {
    return await fs.promises.stat(abs);
  } catch {
    return null;
  }
}

// ---------- writing ----------
const q = {
  fileByPath: db.prepare('SELECT id, size, mtime FROM files WHERE vpath = ?'),
  delFts: db.prepare('DELETE FROM msgs_fts WHERE rowid IN (SELECT id FROM msgs WHERE file_id = ?)'),
  delMsgs: db.prepare('DELETE FROM msgs WHERE file_id = ?'),
  delFile: db.prepare('DELETE FROM files WHERE id = ?'),
  upFile: db.prepare('INSERT INTO files (vpath, dir, size, mtime, kind, title, rows) VALUES (@vpath, @dir, @size, @mtime, @kind, @title, @rows) ON CONFLICT(vpath) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, kind = excluded.kind, title = excluded.title, rows = excluded.rows RETURNING id'),
  insMsg: db.prepare('INSERT INTO msgs (file_id, anchor, ts, sender, sender_id, type, text) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  insFts: db.prepare('INSERT INTO msgs_fts (rowid, body) VALUES (?, ?)'),
  upDir: db.prepare('INSERT INTO dirs (vpath, parent, mtime) VALUES (?, ?, ?) ON CONFLICT(vpath) DO UPDATE SET mtime = excluded.mtime, parent = excluded.parent'),
  delDir: db.prepare('DELETE FROM dirs WHERE vpath = ?'),
};

const removeFile = db.transaction((v) => {
  const f = q.fileByPath.get(v);
  if (!f) return;
  q.delFts.run(f.id);
  q.delMsgs.run(f.id);
  q.delFile.run(f.id);
});

const writeFile = db.transaction((v, st, parsed) => {
  const old = q.fileByPath.get(v);
  if (old) {
    q.delFts.run(old.id);
    q.delMsgs.run(old.id);
  }
  const { id } = q.upFile.get({ vpath: v, dir: parentOf(v), size: st.size, mtime: st.mtimeMs, kind: parsed.kind, title: parsed.title, rows: parsed.rows.length });
  for (const r of parsed.rows) {
    const info = q.insMsg.run(id, r.anchor, r.ts, r.sender, r.senderId, r.type, r.text);
    q.insFts.run(info.lastInsertRowid, indexText(r.text));
  }
});

/** Read, parse and store one file. Returns 'indexed' | 'removed' | 'deferred' | 'skipped'. */
async function indexFile(v, { force = false } = {}) {
  const abs = absOf(v);
  if (!abs) return 'skipped';
  const st = await statOrNull(abs);
  if (!st || !st.isFile()) {
    removeFile(v);
    post({ type: 'pending', remove: [v] });
    return 'removed';
  }
  if (!force && Date.now() - st.mtimeMs < settleMs) return 'deferred'; // may still be being written
  if (st.size > MAX_FILE) {
    writeFile(v, st, { kind: 'doc', title: '', rows: [] });
    post({ type: 'pending', remove: [v] });
    return 'indexed';
  }
  let bytes;
  try {
    bytes = await fs.promises.readFile(abs);
  } catch {
    return 'skipped';
  }
  const { text } = decodeText(bytes);
  const parsed = parseMarkdown(text);
  writeFile(v, st, parsed);
  status.indexedNow++;
  post({ type: 'pending', remove: [v] });
  return 'indexed';
}

async function drainPriority() {
  while (priority.length) {
    const job = priority.shift();
    let r = 'skipped';
    try {
      r = await indexFile(job.vpath, { force: true });
    } catch (e) {
      post({ type: 'log', level: 'warn', msg: `索引 ${job.vpath} 失败：${e.message}` });
    }
    if (job.id) post({ type: 'done', id: job.id, result: r });
  }
}

// ---------- checking ----------
async function checkRoot(root) {
  const rootV = '/' + root.name;
  const [lo, hi] = prefixRange(rootV);
  const dirRows = db.prepare('SELECT vpath, parent, mtime FROM dirs WHERE vpath = ? OR (vpath >= ? AND vpath < ?)').all(rootV, lo, hi);
  const knownDirs = new Map(dirRows.map((r) => [r.vpath, r.mtime]));
  const children = new Map();
  for (const r of dirRows) {
    if (r.vpath === rootV) continue;
    if (!children.has(r.parent)) children.set(r.parent, []);
    children.get(r.parent).push(r.vpath);
  }
  const fileRows = db.prepare('SELECT vpath, dir, size, mtime FROM files WHERE vpath >= ? AND vpath < ?').all(lo, hi);
  const knownFiles = new Map(fileRows.map((r) => [r.vpath, r]));
  status.total += knownDirs.size + knownFiles.size;
  sendStatus();

  const seen = new Set();
  const listed = new Map(); // dir vpath -> { mtime, files: Set }
  const queue = [rootV];
  status.phase = '检查目录';
  while (queue.length && !stopping) {
    const v = queue.shift();
    const abs = absOf(v);
    await yieldIO();
    const st = await statOrNull(abs);
    status.checked++;
    sendStatus();
    if (!st || !st.isDirectory()) continue;
    seen.add(v);
    const known = knownDirs.get(v);
    if (known !== undefined && known === st.mtimeMs) {
      for (const c of children.get(v) || []) queue.push(c);
      continue;
    }
    // new or changed directory: list it
    let ents;
    try {
      ents = await fs.promises.readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    const files = new Set();
    for (const d of ents) {
      if (d.name.startsWith('.')) continue;
      const cv = v + '/' + d.name;
      let isDir = d.isDirectory();
      if (d.isSymbolicLink()) {
        try {
          const real = await fs.promises.realpath(path.join(abs, d.name));
          if (real !== root.real && !real.startsWith(root.real + path.sep)) continue;
          isDir = (await fs.promises.stat(real)).isDirectory();
        } catch {
          continue;
        }
      }
      if (isDir) {
        queue.push(cv);
        if (!knownDirs.has(cv)) status.total++;
      } else if (isMarkdownPath(d.name)) files.add(cv);
    }
    listed.set(v, { mtime: st.mtimeMs, files });
  }
  if (stopping) return;

  // work out the file changes
  const toIndex = [];
  const toRemove = [];
  for (const [v, f] of knownFiles) {
    if (!seen.has(f.dir)) toRemove.push(v);
    else if (listed.has(f.dir) && !listed.get(f.dir).files.has(v)) toRemove.push(v);
  }
  for (const [, l] of listed) for (const v of l.files) if (!knownFiles.has(v)) toIndex.push(v);
  status.total += toIndex.length;
  if (toIndex.length) post({ type: 'pending', add: toIndex });

  // in-place edits do not change the directory: stat every known file that is still there
  status.phase = '检查文件';
  const removing = new Set(toRemove);
  for (const [v, f] of knownFiles) {
    if (stopping) return;
    if (removing.has(v)) continue;
    await yieldIO();
    const st = await statOrNull(absOf(v));
    status.checked++;
    sendStatus();
    if (!st) toRemove.push(v);
    else if (st.size !== f.size || st.mtimeMs !== f.mtime) {
      toIndex.push(v);
      post({ type: 'pending', add: [v] });
    }
  }

  for (const v of toRemove) removeFile(v);
  if (toRemove.length) post({ type: 'pending', remove: toRemove });
  for (const v of knownDirs.keys()) if (!seen.has(v)) q.delDir.run(v);
  status.changed += toIndex.length + toRemove.length;

  status.phase = '重建索引';
  const deferredDirs = new Set();
  for (const v of toIndex) {
    if (stopping) return;
    await yieldIO();
    let r = 'skipped';
    try {
      r = await indexFile(v);
    } catch (e) {
      post({ type: 'log', level: 'warn', msg: `索引 ${v} 失败：${e.message}` });
      deferredDirs.add(parentOf(v));
    }
    if (r === 'deferred') deferredDirs.add(parentOf(v));
    status.checked++;
    sendStatus();
  }
  // A directory's time is recorded only once its new files are in: an interrupted
  // check lists it again next time instead of missing what was added.
  const save = db.transaction(() => {
    for (const [v, l] of listed) if (!deferredDirs.has(v)) q.upDir.run(v, v === rootV ? '/' : parentOf(v), l.mtime);
  });
  save();
}

async function runCheck() {
  if (checking) {
    checkAgain = true;
    return;
  }
  checking = true;
  try {
    do {
      checkAgain = false;
      Object.assign(status, { checking: true, phase: '开始', checked: 0, total: 0, changed: 0, indexedNow: 0, error: '', lastCheckStart: Date.now() });
      setMeta(db, 'lastCheckStart', status.lastCheckStart);
      sendStatus(true);
      // roots that are no longer mounted leave the index
      const names = new Set(roots.map((r) => '/' + r.name));
      for (const { vpath } of db.prepare("SELECT vpath FROM dirs WHERE parent = '/'").all()) {
        if (names.has(vpath)) continue;
        const [lo, hi] = prefixRange(vpath);
        const gone = db.prepare('SELECT vpath FROM files WHERE vpath >= ? AND vpath < ?').all(lo, hi).map((r) => r.vpath);
        for (const v of gone) removeFile(v);
        db.prepare('DELETE FROM dirs WHERE vpath = ? OR (vpath >= ? AND vpath < ?)').run(vpath, lo, hi);
      }
      for (const r of roots) {
        if (stopping) break;
        try {
          await checkRoot(r);
        } catch (e) {
          status.error = e.message;
          post({ type: 'log', level: 'warn', msg: `检查根「${r.name}」失败：${e.message}` });
        }
      }
      if (stopping) break;
      status.lastCheckEnd = Date.now();
      status.built = true;
      setMeta(db, 'lastCheckEnd', status.lastCheckEnd);
      setMeta(db, 'built', true);
      Object.assign(status, { checking: false, phase: '' });
      db.pragma('wal_checkpoint(PASSIVE)');
      post({ type: 'log', level: 'info', msg: `索引检查完成：发现 ${status.changed} 处改动，重建 ${status.indexedNow} 个文件` });
      sendStatus(true);
    } while (checkAgain && !stopping);
  } finally {
    checking = false;
    status.checking = false;
    sendStatus(true);
  }
}

function rebuild() {
  db.exec('DELETE FROM msgs_fts; DELETE FROM msgs; DELETE FROM files; DELETE FROM dirs;');
  setMeta(db, 'built', false);
  status.built = false;
  return runCheck();
}

parentPort.on('message', (m) => {
  switch (m.cmd) {
    case 'check':
      runCheck();
      break;
    case 'rebuild':
      if (checking) {
        stopping = true;
        const wait = setInterval(() => {
          if (!checking) {
            clearInterval(wait);
            stopping = false;
            rebuild();
          }
        }, 100);
      } else rebuild();
      break;
    case 'reindex':
      priority.push({ id: m.id, vpath: m.vpath });
      if (!checking) drainPriority();
      break;
    case 'roots':
      roots = m.roots;
      break;
    case 'stop':
      stopping = true;
      setTimeout(() => {
        db.close();
        process.exit(0);
      }, checking ? 300 : 0);
      break;
  }
});

post({ type: 'ready' });
sendStatus(true);
