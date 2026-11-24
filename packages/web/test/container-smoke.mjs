#!/usr/bin/env node
// Container smoke test: runs a built image against the synthetic fixtures, mounted read-only,
// once with MDV_AUTH=off and once with MDV_AUTH=on. Needs Docker; the test media (an HEVC
// clip, a clip in a codec Chromium cannot decode, a damaged file, a 4,500-file folder) are
// generated into a throwaway folder with the image's own ffmpeg.
//   node packages/web/test/container-smoke.mjs [image]      (default mdview-web:test)
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { FIXTURES, makeDeployment, sleep } from './helpers.mjs';

const IMAGE = process.argv[2] || 'mdview-web:test';
const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
};
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8' }).trim();
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const q = (p) => encodeURIComponent(p);

const dep = makeDeployment();
const notes = path.join(dep.roots, 'notes');
const media = path.join(notes, 'media');
fs.mkdirSync(media);

function ffmpeg(out, ...args) {
  execFileSync('docker', ['run', '--rm', '--cpus', '2', '--entrypoint', 'ffmpeg', '-v', `${media}:/out`, IMAGE,
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '3', '-pix_fmt', 'yuv420p', '-threads', '2', ...args, '-c:a', 'aac', '-shortest', '/out/' + out], { stdio: 'pipe' });
}
ffmpeg('hevc.mp4', '-c:v', 'libx265', '-tag:v', 'hvc1', '-preset', 'ultrafast', '-x265-params', 'log-level=error:pools=2');
ffmpeg('mpeg4.mp4', '-c:v', 'mpeg4', '-q:v', '5');
fs.writeFileSync(path.join(media, 'broken.mp4'), crypto.randomBytes(4096));
fs.writeFileSync(path.join(notes, 'page.html'), '<!doctype html><p>attachment test</p>');
const big = path.join(dep.roots, 'archive', '01_个人私聊', '大量图片', '图片');
fs.mkdirSync(big, { recursive: true });
const png = fs.readFileSync(path.join(notes, 'assets', 'plain.png'));
for (let i = 1; i <= 4500; i++) fs.writeFileSync(path.join(big, `2026-09-01_${String(i).padStart(6, '0')}.png`), png);
const photos = path.join(dep.roots, 'archive', '01_个人私聊', '测试 联系人🍎', '图片');
await sharp({ create: { width: 2400, height: 1600, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 30 } } }).jpeg({ quality: 90 }).toFile(path.join(photos, 'large.jpg'));
// a report folder next to the archive, citing it with ../../聊天记录归档/…
const reports = path.join(path.dirname(dep.roots), 'reports');
fs.cpSync(path.join(FIXTURES, 'wechat', '聊天记录月报'), reports, { recursive: true });

function run(name, port, env, mounts = []) {
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  const args = ['run', '-d', '--name', name, '-p', `127.0.0.1:${port}:8080`, '--read-only', '--tmpfs', '/tmp',
    '--tmpfs', '/state:uid=1000,gid=1000', '--tmpfs', '/cache:uid=1000,gid=1000', '--cpus', '2',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '-v', `${path.join(dep.roots, 'archive')}:/roots/archive:ro`, '-v', `${notes}:/roots/notes:ro`];
  for (const m of mounts) args.push('-v', m);
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  docker(...args, IMAGE);
}

async function waitUp(base) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base + '/api/auth')).ok) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

// host ports: MDV_SMOKE_PORT, MDV_SMOKE_PORT + 1 and + 2 (default 18090) on 127.0.0.1
const PORT = Number(process.env.MDV_SMOKE_PORT) || 18090;

const CHAT = '/archive/01_个人私聊/测试 联系人🍎/聊天记录/2026-09_001.md';
const VOICE = '/archive/01_个人私聊/测试 联系人🍎/语音/2026-09-01_102000_语音_000004.mp3';
const BIG = '/archive/01_个人私聊/大量图片/图片';

async function offMode() {
  const base = 'http://127.0.0.1:' + PORT;
  // the scheduled check every 1.8 s, so the run can see it fire
  run('mdv-smoke-off', PORT, { MDV_AUTH: 'off', MDV_INDEX_SCHEDULE: 'every:0.0005h', TZ: 'Asia/Shanghai' });
  check('off: container starts', await waitUp(base));
  const uid = docker('exec', 'mdv-smoke-off', 'id', '-u');
  check('off: runs as non-root', uid !== '0', 'uid ' + uid);
  const page = await (await fetch(base + '/view' + enc(CHAT))).text();
  check('off: deep link serves the app, no login', page.includes('<html') && !/\/login/.test(page));
  const roots = (await (await fetch(base + '/api/list?path=/')).json()).entries.map((e) => e.name).sort();
  check('off: both roots listed', roots.join(',') === 'archive,notes', roots.join(','));
  const st = await (await fetch(base + '/api/state')).json();
  check('off: roots read-only', st.roots.length === 2 && st.roots.every((r) => !r.writable));
  check('off: chat file opens', (await fetch(base + '/api/file?path=' + q(CHAT))).ok);

  const pages = [];
  for (let offset = 0, more = true; more && pages.length < 5; ) {
    const r = await (await fetch(base + `/api/list?all=1&offset=${offset}&path=` + q(BIG))).json();
    pages.push(r);
    offset += r.entries.length;
    more = r.more;
  }
  const seen = new Set(pages.flatMap((p) => p.entries.map((e) => e.name)));
  check('off: large folder is paged', pages.length > 1 && pages[0].total === 4500 && seen.size === 4500, pages.map((p) => p.entries.length).join('/'));

  const nb = await (await fetch(base + '/api/neighbors?path=' + q('/notes/02-gfm.md'))).json();
  check('off: previous / next file in tree order', nb.prev === '/notes/01-commonmark.md' && nb.next === '/notes/03-code-math-mermaid.md', `${nb.prev} | ${nb.next}`);
  const first = await (await fetch(base + '/api/neighbors?path=' + q('/notes/01-commonmark.md'))).json();
  check('off: first file has no previous', first.prev === null && !!first.next);

  const dir = '/archive/01_个人私聊/测试 联系人🍎';
  const names = async (extra) => (await (await fetch(base + `/api/list?${extra}path=` + q(dir))).json()).entries.map((e) => e.name);
  const shown = await names('');
  const hidden = await names('hideMedia=1&');
  check('off: hide-media toggle', shown.includes('图片') && !hidden.includes('图片') && !hidden.includes('视频') && !hidden.includes('语音') && hidden.includes('聊天记录') && hidden.includes('文件'), hidden.join(','));
  const bigParent = (await (await fetch(base + '/api/list?hideMedia=1&path=' + q('/archive/01_个人私聊/大量图片'))).json()).entries.map((e) => e.name);
  check('off: large media folder hidden too', !bigParent.includes('图片'));

  const v = await fetch(base + '/raw' + enc(VOICE), { headers: { Range: 'bytes=0-99' } });
  check('off: voice range returns 206', v.status === 206, String(v.status));
  const h = await fetch(base + '/raw/notes/page.html');
  check('off: html forced to download', /attachment/.test(h.headers.get('content-disposition') || ''));
  check('off: nosniff on raw', h.headers.get('x-content-type-options') === 'nosniff');

  let hits = [];
  for (let i = 0; i < 60 && !hits.length; i++) {
    const lines = (await (await fetch(base + '/api/search?scope=/&q=' + q('第一条消息'))).text()).trim().split('\n').map((l) => JSON.parse(l));
    hits = lines.filter((l) => l.t === 'hits').flatMap((l) => l.hits);
    if (!hits.length) await sleep(1000);
  }
  check('off: search finds the message', hits.some((x) => x.path === CHAT), hits.length + ' hit(s)');

  for (const name of ['hevc.mp4', 'mpeg4.mp4']) {
    const r = await fetch(base + '/video/notes/media/' + name);
    const body = r.ok ? Buffer.from(await r.arrayBuffer()) : Buffer.alloc(0);
    let codecs = '';
    if (r.ok) {
      fs.writeFileSync(path.join(media, 'out-' + name), body);
      codecs = docker('run', '--rm', '--entrypoint', 'ffprobe', '-v', `${media}:/out:ro`, IMAGE, '-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', '/out/out-' + name).replace(/\s+/g, ' ');
    }
    check(`off: ${name} converts to H.264 + AAC`, r.ok && /h264/.test(codecs) && /aac/.test(codecs), `${r.status} ${codecs}`);
  }
  const again = Date.now();
  const cached = await fetch(base + '/video/notes/media/mpeg4.mp4', { headers: { Range: 'bytes=0-99' } });
  check('off: converted video is cached and seekable', cached.status === 206 && Date.now() - again < 2000, `${cached.status} in ${Date.now() - again} ms`);
  const bad = await fetch(base + '/video/notes/media/broken.mp4');
  check('off: damaged video reports 422', bad.status === 422, String(bad.status));
  const PHOTO = '/archive/01_个人私聊/测试 联系人🍎/图片/';
  const th = await fetch(base + '/thumb' + enc(PHOTO + 'large.jpg'));
  const tbuf = th.ok ? Buffer.from(await th.arrayBuffer()) : Buffer.alloc(0);
  const tmeta = th.ok ? await sharp(tbuf).metadata() : {};
  check('off: large photo gets a 720 px WebP thumbnail', th.headers.get('content-type') === 'image/webp' && tmeta.width === 720 && tmeta.height === 480, `${th.headers.get('content-type')} ${tmeta.width}x${tmeta.height} ${tbuf.length} B`);
  const small = await fetch(base + '/thumb' + enc(PHOTO + '2026-09-01_100500_图片_000001.jpg'));
  await small.arrayBuffer();
  check('off: small photo served as the original', small.headers.get('content-type') === 'image/jpeg');
  const tc = (await (await fetch(base + '/api/state')).json()).thumbCache;
  check('off: thumbnail cached under /cache', tc && tc.files === 1 && tc.maxBytes === 10 * 1024 ** 3, JSON.stringify(tc));

  let sched = '';
  for (let i = 0; i < 20 && !/定时/.test(sched); i++) {
    await sleep(500);
    const l = spawnSync('docker', ['logs', 'mdv-smoke-off'], { encoding: 'utf8' });
    sched = l.stdout + l.stderr;
  }
  const idx = await (await fetch(base + '/api/index')).json();
  check('off: scheduled index check fires', /索引检查开始（定时）/.test(sched) && idx.schedule.kind === 'every' && idx.nextScheduled > Date.now() - 2000);
  check('off: log says login is off', /MDV_AUTH=off/.test(sched));
  docker('rm', '-f', 'mdv-smoke-off');
}

async function layoutMode() {
  const base = 'http://127.0.0.1:' + (PORT + 2);
  // the archive and the report folder as two roots, each under its own name
  run('mdv-smoke-layout', PORT + 2, { MDV_AUTH: 'off', MDV_NO_INDEX: '1' }, [`${path.join(dep.roots, 'archive')}:/roots/聊天记录归档:ro`, `${reports}:/roots/聊天记录月报:ro`]);
  check('layout: container starts', await waitUp(base));
  const report = '/聊天记录月报/2026-09/月报_2026-09.md';
  const text = fs.readFileSync(path.join(reports, '2026-09', '月报_2026-09.md'), 'utf8');
  const hrefs = [...new Set([...text.matchAll(/\]\(<(\.\.\/\.\.\/聊天记录归档\/[^>]+)>\)/g)].map((m) => m[1]))].filter((h) => !h.includes('/不存在/'));
  let ok = 0;
  for (const href of hrefs) {
    const r = await (await fetch(base + '/api/resolve', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ base: report, href: encodeURI(href) }) })).json();
    if (r.exists && r.path.startsWith('/聊天记录归档/')) ok++;
  }
  check('layout: report citations open in the archive root', hrefs.length >= 5 && ok === hrefs.length, `${ok}/${hrefs.length}`);
  docker('rm', '-f', 'mdv-smoke-layout');
}

async function onMode() {
  const base = 'http://127.0.0.1:' + (PORT + 1);
  const pw = crypto.randomBytes(12).toString('base64url');
  const hash = execFileSync('docker', ['run', '--rm', '-i', IMAGE, 'node', 'packages/web/src/server/hash-password.js'], { input: pw + '\n', encoding: 'utf8' }).trim();
  check('on: hash helper prints a hash', hash.length > 40);
  run('mdv-smoke-on', PORT + 1, { MDV_AUTH: 'on', MDV_PASSWORD_HASH: hash });
  check('on: container starts', await waitUp(base));
  check('on: API 401 without login', (await fetch(base + '/api/state')).status === 401);
  check('on: raw 401 without login', (await fetch(base + '/raw' + enc(VOICE))).status === 401);
  check('on: video 401 without login', (await fetch(base + '/video/notes/media/hevc.mp4')).status === 401);
  check('on: thumbnail 401 without login', (await fetch(base + '/thumb' + enc('/archive/01_个人私聊/测试 联系人🍎/图片/large.jpg'))).status === 401);
  const p = await fetch(base + '/view' + enc(CHAT), { redirect: 'manual' });
  check('on: page redirects to login', p.status === 302 && /^\/login/.test(p.headers.get('location') || ''));
  const login = (password) => fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ password }) });
  check('on: wrong password rejected', !(await login(pw + 'x')).ok);
  await sleep(2500);
  const ok = await login(pw);
  const cookie = (ok.headers.get('set-cookie') || '').split(';')[0];
  check('on: right password logs in', ok.ok && !!cookie);
  check('on: file opens after login', (await fetch(base + '/api/file?path=' + q(CHAT), { headers: { cookie } })).ok);
  docker('rm', '-f', 'mdv-smoke-on');
}

try {
  await offMode();
  await layoutMode();
  await onMode();
} finally {
  spawnSync('docker', ['rm', '-f', 'mdv-smoke-off', 'mdv-smoke-layout', 'mdv-smoke-on'], { stdio: 'ignore' });
  fs.rmSync(dep.dir, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
