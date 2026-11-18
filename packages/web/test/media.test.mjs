import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { FIXTURES, makeDeployment, startServer, waitFor } from './helpers.mjs';
import { nextScheduled, parseSchedule } from '../src/server/config.js';
import { Thumbs } from '../src/server/media.js';

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const cleanup = [];
after(() => {
  for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
});

function noise(file, width, height, seed = 30) {
  return sharp({ create: { width, height, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: seed } } })
    .jpeg({ quality: 90 })
    .toFile(file);
}

// ---------- thumbnails ----------

test('chat previews get a WebP thumbnail with a 720 px long edge; small originals are served as they are', async () => {
  const dep = makeDeployment();
  cleanup.push(dep.dir);
  const imgDir = path.join(dep.roots, 'archive', '01_个人私聊', '测试 联系人🍎', '图片');
  await noise(path.join(imgDir, 'wide.jpg'), 1600, 1200);
  await noise(path.join(imgDir, 'tall.jpg'), 900, 2000);
  const s = await startServer(dep, {}, { search: false });
  try {
    const st = await (await s.f('/api/state')).json();
    assert.equal(st.caps.thumbs, true);
    const base = '/archive/01_个人私聊/测试 联系人🍎/图片/';
    for (const [name, w, h] of [['wide.jpg', 720, 540], ['tall.jpg', 324, 720]]) {
      const r = await s.f('/thumb' + enc(base + name));
      assert.equal(r.status, 200, name);
      assert.equal(r.headers.get('content-type'), 'image/webp');
      assert.match(r.headers.get('content-security-policy'), /sandbox/);
      const buf = Buffer.from(await r.arrayBuffer());
      const meta = await sharp(buf).metadata();
      assert.equal(meta.format, 'webp');
      assert.deepEqual([meta.width, meta.height], [w, h], name);
      assert.ok(buf.length < fs.statSync(path.join(imgDir, name)).size, 'smaller than the original');
    }
    // cached: one file per thumbnail under <cache>/thumbs, reused on the next view
    const files = () => fs.readdirSync(path.join(dep.cache, 'thumbs'), { recursive: true }).filter((n) => String(n).endsWith('.webp'));
    assert.equal(files().length, 2);
    await s.f('/thumb' + enc(base + 'wide.jpg'));
    assert.equal(files().length, 2);
    // a 320 x 240 original needs no thumbnail: the original bytes come back
    const small = await s.f('/thumb' + enc(base + '2026-09-01_100500_图片_000001.jpg'));
    assert.equal(small.headers.get('content-type'), 'image/jpeg');
    assert.equal(Buffer.from(await small.arrayBuffer()).length, fs.statSync(path.join(imgDir, '2026-09-01_100500_图片_000001.jpg')).size);
    assert.equal(files().length, 2);
    const after = await (await s.f('/api/state')).json();
    assert.equal(after.thumbCache.files, 2);
  } finally {
    await s.server.close();
  }
});

test('MDV_THUMB_CACHE_GB=0 turns thumbnails off: previews are the originals', async () => {
  const dep = makeDeployment();
  cleanup.push(dep.dir);
  const imgDir = path.join(dep.roots, 'archive', '01_个人私聊', '测试 联系人🍎', '图片');
  await noise(path.join(imgDir, 'wide.jpg'), 1600, 1200);
  const s = await startServer(dep, { MDV_THUMB_CACHE_GB: '0' }, { search: false });
  try {
    assert.equal((await (await s.f('/api/state')).json()).caps.thumbs, false);
    const r = await s.f('/thumb' + enc('/archive/01_个人私聊/测试 联系人🍎/图片/wide.jpg'));
    assert.equal(r.headers.get('content-type'), 'image/jpeg');
    await r.arrayBuffer();
    assert.equal(fs.existsSync(path.join(dep.cache, 'thumbs')), false);
  } finally {
    await s.server.close();
  }
});

test('a cache folder inside the content folder is refused: nothing is generated there', async () => {
  const dep = makeDeployment();
  cleanup.push(dep.dir);
  const inside = path.join(dep.roots, 'notes', '.cache');
  const s = await startServer({ ...dep, cache: inside }, {}, { search: false });
  try {
    assert.equal((await (await s.f('/api/state')).json()).caps.thumbs, false);
    assert.ok(s.logs.some((l) => /缓存目录.*在内容目录.*里面/.test(l)));
    assert.equal(fs.existsSync(inside), false);
  } finally {
    await s.server.close();
  }
});

test('past its size limit the cache drops the least recently viewed thumbnails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-thumbs-'));
  cleanup.push(dir);
  const src = path.join(dir, 'src');
  fs.mkdirSync(src);
  const names = ['a.jpg', 'b.jpg', 'c.jpg'];
  for (const [i, n] of names.entries()) await noise(path.join(src, n), 1600, 1200, 28 + i);
  const log = { info() {}, warn() {}, error() {} };
  const make = async (cacheDir, bytes) => {
    const t = new Thumbs({ cacheDir, thumbCacheBytes: bytes }, log);
    await t.init();
    await t.scanning;
    return t;
  };
  const view = (t, n) => t.get(path.join(src, n), fs.statSync(path.join(src, n)));

  // learn the three thumbnail sizes with room to spare
  const probe = await make(path.join(dir, 'probe'), 1024 ** 3);
  const size = {};
  for (const n of names) size[n] = (await view(probe, n)).st.size;
  const sum = size['a.jpg'] + size['b.jpg'] + size['c.jpg'];

  // a limit just under all three: after a, b, a again, c, the oldest view (b) goes
  const t = await make(path.join(dir, 'cache'), sum - 1);
  await view(t, 'a.jpg');
  await view(t, 'b.jpg');
  await view(t, 'a.jpg');
  await view(t, 'c.jpg');
  await t.evicting;
  const left = fs.readdirSync(path.join(dir, 'cache', 'thumbs'), { recursive: true }).filter((n) => String(n).endsWith('.webp')).length;
  assert.equal(left, 2);
  assert.equal(t.total, size['a.jpg'] + size['c.jpg']);
  assert.ok(t.total <= (sum - 1) * 0.9);
  assert.ok(await view(t, 'a.jpg'));
  assert.ok(await view(t, 'c.jpg'));
  assert.equal(t.index.size, 2, 'a and c still cached, b was dropped');

  // a restart reads the cache back with its size
  const again = await make(path.join(dir, 'cache'), sum - 1);
  assert.equal(again.index.size, 2);
  assert.equal(again.total, t.total);
});

// ---------- scheduled index check ----------

test('MDV_INDEX_SCHEDULE accepts daily@HH:MM and every:<n>h; anything else is off', () => {
  assert.deepEqual(parseSchedule(undefined), { kind: 'off' });
  assert.deepEqual(parseSchedule('off'), { kind: 'off' });
  assert.deepEqual(parseSchedule('daily@03:30'), { kind: 'daily', hour: 3, minute: 30 });
  assert.deepEqual(parseSchedule('DAILY@4:05'), { kind: 'daily', hour: 4, minute: 5 });
  assert.deepEqual(parseSchedule('every:6h'), { kind: 'every', hours: 6 });
  assert.deepEqual(parseSchedule('every:0.5h'), { kind: 'every', hours: 0.5 });
  for (const bad of ['daily@24:00', 'daily@3:60', 'every:0h', 'every:-1h', 'hourly', '03:30']) assert.deepEqual(parseSchedule(bad), { kind: 'off' }, bad);

  const now = new Date(2026, 10, 17, 2, 0, 0).getTime();
  assert.equal(nextScheduled({ kind: 'daily', hour: 3, minute: 30 }, now), new Date(2026, 10, 17, 3, 30).getTime());
  assert.equal(nextScheduled({ kind: 'daily', hour: 1, minute: 0 }, now), new Date(2026, 10, 18, 1, 0).getTime());
  assert.equal(nextScheduled({ kind: 'every', hours: 6 }, now), now + 6 * 3600 * 1000);
  assert.equal(nextScheduled({ kind: 'off' }, now), null);
});

test('the scheduled check runs on time, alongside the startup check; off by default', async () => {
  const dep = makeDeployment();
  cleanup.push(dep.dir);
  const off = await startServer(dep, {});
  try {
    const st = await (await off.f('/api/index')).json();
    assert.equal(st.schedule.kind, 'off');
    assert.equal(st.nextScheduled, null);
  } finally {
    await off.server.close();
  }
  const s = await startServer({ ...dep, state: fs.mkdtempSync(path.join(dep.dir, 'st-')) }, { MDV_INDEX_SCHEDULE: 'every:0.0005h' }); // every 1.8 s
  try {
    const first = (await (await s.f('/api/index')).json()).nextScheduled;
    assert.ok(first > Date.now() - 1000);
    await waitFor(() => s.logs.some((l) => l.includes('索引检查开始（定时）')), 15000);
    assert.ok(s.logs.some((l) => l.includes('索引检查开始（启动）')));
    const st = await (await s.f('/api/index')).json();
    assert.equal(st.schedule.kind, 'every');
    assert.ok(st.nextScheduled > first, 'the next run is armed after each one');
  } finally {
    await s.server.close();
  }
});

// ---------- folders that cite each other with relative links ----------

const REPORT = '2026-09/月报_2026-09.md';

function citations() {
  const text = fs.readFileSync(path.join(FIXTURES, 'wechat', '聊天记录月报', ...REPORT.split('/')), 'utf8');
  return [...text.matchAll(/\]\(<([^>]+)>\)/g)].map((m) => m[1]).filter((h) => h.startsWith('../../聊天记录归档/'));
}

async function resolveAll(s, base) {
  const out = [];
  for (const href of [...new Set(citations())]) {
    const r = await (await s.f('/api/resolve', { method: 'POST', json: { base, href: encodeURI(href) } })).json();
    out.push({ href, ...r });
  }
  return out;
}

function deployment(layout) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-layout-'));
  cleanup.push(dir);
  const roots = path.join(dir, 'roots');
  for (const [root, from] of Object.entries(layout)) fs.cpSync(path.join(FIXTURES, ...from), path.join(roots, root), { recursive: true });
  for (const d of ['state', 'cache']) fs.mkdirSync(path.join(dir, d));
  return { dir, roots, state: path.join(dir, 'state'), cache: path.join(dir, 'cache') };
}

test('citation links work when the report folder and the archive sit side by side under their own names', async () => {
  const cases = [
    // two roots named exactly like the two folders
    { layout: { 聊天记录归档: ['wechat', '聊天记录归档'], 聊天记录月报: ['wechat', '聊天记录月报'] }, base: '/聊天记录月报/' + REPORT, prefix: '/聊天记录归档/' },
    // one root holding both folders
    { layout: { wechat: ['wechat'] }, base: '/wechat/聊天记录月报/' + REPORT, prefix: '/wechat/聊天记录归档/' },
  ];
  for (const c of cases) {
    const s = await startServer(deployment(c.layout), {}, { search: false });
    try {
      const rs = await resolveAll(s, c.base);
      assert.ok(rs.length >= 5, 'the fixture report cites the archive');
      for (const r of rs) {
        if (r.href.includes('/不存在/')) assert.equal(r.exists, false, r.href); // the fixture's deliberately broken link
        else {
          assert.equal(r.exists, true, r.href);
          assert.ok(r.path.startsWith(c.prefix), r.path);
        }
      }
      assert.ok(rs.some((r) => r.path.includes('/01_个人私聊/#/')), 'a folder named # resolves too');
    } finally {
      await s.server.close();
    }
  }
});

test('citation links break when the archive is mounted under another name', async () => {
  const s = await startServer(deployment({ archive: ['wechat', '聊天记录归档'], 聊天记录月报: ['wechat', '聊天记录月报'] }), {}, { search: false });
  try {
    const rs = await resolveAll(s, '/聊天记录月报/' + REPORT);
    assert.ok(rs.length >= 5);
    for (const r of rs) assert.equal(r.exists, false, r.href);
  } finally {
    await s.server.close();
  }
});
