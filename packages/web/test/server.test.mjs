import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import iconv from 'iconv-lite';
import { makeDeployment, startServer } from './helpers.mjs';
import { hashPassword } from '../src/server/auth.js';
import { confirmSentence } from '../src/server/write.js';

const CHAT = '/archive/01_个人私聊/测试 联系人🍎/聊天记录/2026-09_001.md';
const HASH_CHAT = '/archive/01_个人私聊/#/聊天记录/2026-09_001.md';
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

let dep;
let s;
before(async () => {
  dep = makeDeployment();
  fs.writeFileSync(path.join(dep.roots, 'notes', 'page.html'), '<script>alert(1)</script>');
  fs.writeFileSync(path.join(dep.roots, 'notes', 'gb.md'), iconv.encode('# 标题\r\n\r\n中文内容\r\n', 'gb18030'));
  s = await startServer(dep, { MDV_WRITABLE_ROOTS: 'notes' }, { search: false });
});
after(async () => {
  await s.server.close();
  fs.rmSync(dep.dir, { recursive: true, force: true });
});

test('state lists every mounted root with its write mode; login is off by default', async () => {
  const st = await (await s.f('/api/state')).json();
  assert.equal(st.auth, 'off');
  assert.deepEqual(
    st.roots.map((r) => [r.name, r.writable]),
    [
      ['archive', false],
      ['notes', true],
    ],
  );
  assert.equal(st.caps.overwrite, true);
  const top = await (await s.f('/api/list?path=/')).json();
  assert.deepEqual(
    top.entries.map((e) => e.path),
    ['/archive', '/notes'],
  );
});

test('every response carries the security headers', async () => {
  const r = await s.f('/api/state');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
});

test('a deep link serves the app page with root-relative asset URLs', async () => {
  const r = await s.f('/view' + enc(CHAT));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  const html = await r.text();
  const refs = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.some((u) => u.endsWith('app.js')) && refs.some((u) => u.endsWith('app.css')));
  for (const u of refs) assert.ok(u.startsWith('/'), `relative asset URL ${u} breaks under /view/…`);
});

test('previous / next file follows the tree order of the Markdown files in the same folder', async () => {
  const list = await (await s.f('/api/list?path=/notes')).json();
  const md = list.entries.filter((e) => e.isMd).map((e) => e.path);
  assert.ok(md.length >= 3);
  for (let i = 0; i < md.length; i++) {
    const n = await (await s.f('/api/neighbors?path=' + encodeURIComponent(md[i]))).json();
    assert.equal(n.prev, md[i - 1] || null, md[i]);
    assert.equal(n.next, md[i + 1] || null, md[i]);
  }
  const top = await (await s.f('/api/neighbors?path=/notes')).json();
  assert.deepEqual([top.prev, top.next], [null, null]);
});

test('hiding media folders keeps folders with documents or other files', async () => {
  const dir = encodeURIComponent('/archive/01_个人私聊/测试 联系人🍎');
  const names = async (hide) => (await (await s.f(`/api/list?path=${dir}&hideMedia=${hide}`)).json()).entries.map((e) => e.name);
  assert.deepEqual(await names(0), ['聊天记录', '视频', '图片', '文件', '语音'].sort((a, b) => new Intl.Collator('zh-CN', { numeric: true }).compare(a, b)));
  assert.deepEqual(await names(1), ['聊天记录', '文件'].sort((a, b) => new Intl.Collator('zh-CN', { numeric: true }).compare(a, b)));
});

function rawStatus(base, p) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: p, method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

test('paths that leave a root, or are not plain virtual paths, are refused', async () => {
  for (const p of ['/archive/../notes/other.md', '/archive/./x', '/archive//x', 'archive/x', '/archive/a\\b', '/archive/a\0b']) {
    const r = await s.f('/api/file?path=' + encodeURIComponent(p));
    assert.equal(r.status, 400, p);
  }
  assert.equal((await s.f('/api/file?path=' + encodeURIComponent('/nosuchroot/x.md'))).status, 404);
  // sent byte for byte: fetch() would normalise %2e%2e away before the server sees it
  assert.equal(await rawStatus(s.base, '/raw/archive/%2e%2e/notes/other.md'), 400);
  assert.equal(await rawStatus(s.base, '/raw/archive/../notes/other.md'), 400);
  assert.equal(await rawStatus(s.base, '/raw/archive/%252e%252e/notes/other.md'), 404); // a literal "%2e%2e" name, not traversal
  assert.equal(await rawStatus(s.base, '/raw/archive/..%2fnotes/other.md'), 400);
});

test('a symbolic link pointing outside its root is not followed', async (t) => {
  const link = path.join(dep.roots, 'archive', 'escape');
  try {
    fs.symlinkSync(path.join(dep.roots, 'notes'), link, 'junction');
  } catch {
    return t.skip('symbolic links not available here');
  }
  try {
    assert.equal((await s.f('/api/file?path=' + encodeURIComponent('/archive/escape/other.md'))).status, 403);
    const list = await (await s.f('/api/list?path=/archive')).json();
    assert.ok(!list.entries.some((e) => e.name === 'escape'));
  } finally {
    fs.rmSync(link, { force: true, recursive: false });
  }
});

test('files with #, spaces and emoji in their paths are served', async () => {
  for (const p of [CHAT, HASH_CHAT, '/notes/sub#dir/inner file.md']) {
    const r = await s.f('/api/file?path=' + encodeURIComponent(p));
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('x-mdv-hash'), /^[0-9a-f]{64}$/);
  }
});

test('links resolve like the desktop edition: a file wins over a folder named #', async () => {
  const r = await (await s.f('/api/resolve', { method: 'POST', json: { base: CHAT, href: '../../%23/%E8%81%8A%E5%A4%A9%E8%AE%B0%E5%BD%95/2026-09_001.md#msg-1' } })).json();
  assert.equal(r.exists, true);
  assert.equal(r.path, HASH_CHAT);
  assert.equal(r.anchor, 'msg-1');
  const out = await (await s.f('/api/resolve', { method: 'POST', json: { base: CHAT, href: '../../../../../../etc/passwd' } })).json();
  assert.equal(out.exists, false);
  assert.equal(out.outside, true);
});

test('/raw serves byte ranges with sandboxing headers', async () => {
  const p = '/archive/01_个人私聊/测试 联系人🍎/语音/2026-09-01_102000_语音_000004.mp3';
  const full = await s.f('/raw' + enc(p));
  assert.equal(full.status, 200);
  const size = Number(full.headers.get('content-length'));
  const r = await s.f('/raw' + enc(p), { headers: { Range: 'bytes=10-19' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 10-19/${size}`);
  assert.equal((await r.arrayBuffer()).byteLength, 10);
  assert.match(r.headers.get('content-security-policy'), /sandbox/);
  const etag = full.headers.get('etag');
  assert.equal((await s.f('/raw' + enc(p), { headers: { 'If-None-Match': etag } })).status, 304);
});

test('html attachments are always downloaded, never rendered on this origin', async () => {
  const r = await s.f('/raw/notes/page.html');
  assert.match(r.headers.get('content-disposition'), /^attachment/);
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  const svg = await s.f('/raw' + enc('/notes/assets/plain.png'));
  assert.match(svg.headers.get('content-disposition'), /^inline/);
  const dl = await s.f('/raw' + enc('/notes/other.md') + '?download=1');
  assert.match(dl.headers.get('content-disposition'), /^attachment/);
});

test('writes from another origin, or without an origin, are refused', async () => {
  assert.equal((await s.f('/api/resolve', { method: 'POST', json: { base: CHAT, href: 'x' }, headers: { Origin: 'http://evil.example' } })).status, 403);
  const r = await fetch(s.base + '/api/resolve', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 403);
});

async function readForEdit(p) {
  const r = await s.f('/api/file?path=' + encodeURIComponent(p));
  return { hash: r.headers.get('x-mdv-hash'), bytes: Buffer.from(await r.arrayBuffer()) };
}

test('overwrite needs a writable root, the exact sentence and an unchanged file', async () => {
  const ro = await readForEdit(CHAT);
  let r = await (await s.f('/api/write', { method: 'POST', json: { path: CHAT, text: 'x', encoding: 'UTF-8', expectHash: ro.hash, confirm: confirmSentence('2026-09_001.md') } })).json();
  assert.equal(r.code, 'EREADONLY');

  const p = '/notes/other.md';
  const before = await readForEdit(p);
  r = await (await s.f('/api/write', { method: 'POST', json: { path: p, text: 'changed\n', encoding: 'UTF-8', expectHash: before.hash, confirm: '我确认' } })).json();
  assert.equal(r.code, 'ECONFIRM');
  r = await (await s.f('/api/write', { method: 'POST', json: { path: p, text: 'changed\n', encoding: 'UTF-8', expectHash: 'f'.repeat(64), confirm: confirmSentence('other.md') } })).json();
  assert.equal(r.code, 'ECONFLICT');
  assert.deepEqual(fs.readFileSync(path.join(dep.roots, 'notes', 'other.md')), before.bytes, 'refused writes leave the file alone');

  r = await (await s.f('/api/write', { method: 'POST', json: { path: p, text: 'changed\n', encoding: 'UTF-8', expectHash: before.hash, confirm: confirmSentence('other.md') } })).json();
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(dep.roots, 'notes', 'other.md'), 'utf8'), 'changed\n');
  const vdir = fs.readdirSync(path.join(dep.state, 'versions'));
  assert.equal(vdir.length, 1);
  const kept = fs.readdirSync(path.join(dep.state, 'versions', vdir[0])).filter((n) => n !== 'path.txt');
  assert.deepEqual(fs.readFileSync(path.join(dep.state, 'versions', vdir[0], kept[0])), before.bytes, 'the previous version is kept');
});

test('overwrite writes back in the original encoding and line endings', async () => {
  const p = '/notes/gb.md';
  const before = await readForEdit(p);
  const r = await (await s.f('/api/write', { method: 'POST', json: { path: p, text: '# 标题\r\n\r\n改过的中文\r\n', encoding: 'GB18030', expectHash: before.hash, confirm: confirmSentence('gb.md') } })).json();
  assert.equal(r.ok, true);
  assert.deepEqual(fs.readFileSync(path.join(dep.roots, 'notes', 'gb.md')), iconv.encode('# 标题\r\n\r\n改过的中文\r\n', 'gb18030'));
});

test('MDV_DISABLE_WRITE turns every overwrite off', async () => {
  const s2 = await startServer(dep, { MDV_WRITABLE_ROOTS: 'notes', MDV_DISABLE_WRITE: '1' }, { search: false });
  try {
    const st = await (await s2.f('/api/state')).json();
    assert.equal(st.caps.overwrite, false);
    const b = await (await s2.f('/api/file?path=/notes/other.md')).arrayBuffer();
    const hash = (await s2.f('/api/file?path=/notes/other.md')).headers.get('x-mdv-hash');
    const r = await (await s2.f('/api/write', { method: 'POST', json: { path: '/notes/other.md', text: 'x', encoding: 'UTF-8', expectHash: hash, confirm: confirmSentence('other.md') } })).json();
    assert.ok(['EWRITEOFF', 'EREADONLY'].includes(r.code));
    assert.ok(b.byteLength > 0);
  } finally {
    await s2.server.close();
  }
});

test('MDV_AUTH=on: nothing is reachable before logging in', async () => {
  const state2 = fs.mkdtempSync(path.join(dep.dir, 'st-'));
  const s2 = await startServer({ ...dep, state: state2 }, { MDV_AUTH: 'on', MDV_PASSWORD_HASH: hashPassword('correct horse') }, { search: false });
  try {
    for (const p of ['/api/state', '/api/list?path=/', '/raw' + enc(CHAT), '/video' + enc(CHAT), '/api/search?q=x']) assert.equal((await s2.f(p)).status, 401, p);
    const page = await s2.f('/');
    assert.equal(page.status, 302);
    assert.match(page.headers.get('location'), /^\/login/);
    let r = await s2.f('/api/login', { method: 'POST', json: { password: 'wrong password' } });
    assert.equal(r.status, 401);
    r = await s2.f('/api/login', { method: 'POST', json: { password: 'correct horse' } });
    assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const c = cookie.split(';')[0];
    assert.equal((await s2.f('/api/state', { headers: { Cookie: c } })).status, 200);
    await s2.f('/api/logout', { method: 'POST', headers: { Cookie: c } });
    assert.equal((await s2.f('/api/state', { headers: { Cookie: c } })).status, 401);
  } finally {
    await s2.server.close();
  }
});

test('MDV_AUTH=on without a password: a one-time setup code from the log sets it', async () => {
  const state2 = fs.mkdtempSync(path.join(dep.dir, 'st-'));
  const s2 = await startServer({ ...dep, state: state2 }, { MDV_AUTH: 'on' }, { search: false });
  try {
    const line = s2.logs.find((l) => l.includes('首次设置码'));
    const code = /首次设置码：(\w+)/.exec(line)[1];
    assert.equal((await s2.f('/api/setup', { method: 'POST', json: { code: 'WRONG', password: 'long enough' } })).status, 401);
    assert.equal((await s2.f('/api/setup', { method: 'POST', json: { code, password: 'short' } })).status, 400);
    const r = await s2.f('/api/setup', { method: 'POST', json: { code, password: 'long enough' } });
    assert.equal(r.status, 200);
    assert.equal((await s2.f('/api/setup', { method: 'POST', json: { code, password: 'another one' } })).status, 409, 'the code is spent');
    assert.ok(JSON.parse(fs.readFileSync(path.join(state2, 'auth.json'), 'utf8')).passwordHash.startsWith('scrypt:'));
  } finally {
    await s2.server.close();
  }
});

test('repeated wrong passwords slow every further attempt down', async () => {
  const state2 = fs.mkdtempSync(path.join(dep.dir, 'st-'));
  const s2 = await startServer({ ...dep, state: state2 }, { MDV_AUTH: 'on', MDV_PASSWORD_HASH: hashPassword('correct horse') }, { search: false });
  try {
    let last;
    for (let i = 0; i < 6; i++) last = await s2.f('/api/login', { method: 'POST', json: { password: 'nope nope' } });
    const r = await s2.f('/api/login', { method: 'POST', json: { password: 'correct horse' } });
    assert.equal(r.status, 429, 'even the right password waits');
    assert.ok(Number(r.headers.get('retry-after')) > 0);
    assert.ok(last);
  } finally {
    await s2.server.close();
  }
});
