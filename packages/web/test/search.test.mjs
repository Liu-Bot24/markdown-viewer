import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { indexIdle, makeDeployment, searchAll, sleep, startServer } from './helpers.mjs';
import { ftsQuery, matchesText, parseQuery, tokensOf } from '../src/search/tokenize.js';
import { parseMarkdown } from '../src/search/parse.js';

let dep;
let s;
before(async () => {
  dep = makeDeployment();
  s = await startServer(dep, {});
  await indexIdle(s.f);
});
after(async () => {
  await s.server.close();
  fs.rmSync(dep.dir, { recursive: true, force: true });
});

test('two-character CJK tokens, the run tail on its own, Latin words folded', () => {
  assert.deepEqual(tokensOf('下午三点 Meet', true), ['下午', '午三', '三点', '点', 'meet']);
  assert.deepEqual(tokensOf('下午', false), ['下午']);
  assert.deepEqual(tokensOf('下午abc', false), ['下午', '午', 'abc']);
  const q = parseQuery('"下午 三点" 开会 a');
  assert.equal(q.length, 3);
  assert.match(ftsQuery(q), /AND/);
});

test('the same match rules apply to text the index has not seen', () => {
  const terms = parseQuery('第一条');
  assert.ok(matchesText('你好，这是第一条消息', terms));
  assert.ok(!matchesText('第一 条', terms));
  assert.ok(matchesText('下', parseQuery('下')));
  assert.ok(matchesText('上下', parseQuery('下')), 'a lone character matches at the end of a run too');
});

test('chat files split into one row per message, with sender and type', () => {
  const text = fs.readFileSync(path.join(dep.roots, 'archive', '01_个人私聊', '测试 联系人🍎', '聊天记录', '2026-09_001.md'), 'utf8');
  const p = parseMarkdown(text);
  assert.equal(p.kind, 'chat');
  const first = p.rows[0];
  assert.equal(first.anchor, 'msg-0000000000000000000000a1');
  assert.equal(first.ts, '2026-09-01 10:00:00');
  assert.equal(first.senderId, 'wxid_testpeer001');
  assert.match(first.text, /这是第一条消息/);
  assert.ok(!/发送者/.test(first.text));
});

/** Every message in the deployment, matched directly: the reference for the index. */
function scanAll(q) {
  const terms = parseQuery(q);
  const out = [];
  const walk = (dir, v) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, v + '/' + e.name);
      else if (e.name.endsWith('.md')) {
        for (const r of parseMarkdown(fs.readFileSync(p, 'utf8')).rows) if (matchesText(r.text, terms)) out.push(v + '/' + e.name + '#' + r.anchor);
      }
    }
  };
  walk(dep.roots, '');
  return out.sort();
}

test('index results equal a direct scan of every file', async () => {
  for (const q of ['消息', '第一条', '图片', '你好', '多行', 'wechat', '下', '"第二行"', '星号 下划线']) {
    const { hits } = await searchAll(s.f, q);
    const got = hits.map((h) => h.path + '#' + h.anchor).sort();
    assert.deepEqual(got, scanAll(q), q);
  }
});

test('scopes and filters narrow the results', async () => {
  const all = await searchAll(s.f, '消息');
  assert.ok(all.hits.length > 0);
  const notes = await searchAll(s.f, '消息', '/notes');
  assert.ok(notes.hits.length < all.hits.length && notes.hits.every((h) => h.path.startsWith('/notes/')), 'one root');
  assert.equal((await searchAll(s.f, '消息', '/archive/01_个人私聊/#')).hits.length, 0, 'a folder without it');
  const scoped = await searchAll(s.f, '跳转', '/archive/01_个人私聊/#');
  assert.deepEqual(
    scoped.hits.map((h) => h.anchor),
    ['msg-00000000000000000000hash1'],
    'a folder named #',
  );
  const sender = all.hits[0].sender;
  const bySender = await searchAll(s.f, '消息', '/', { sender });
  assert.ok(bySender.hits.every((h) => h.sender === sender));
  const none = await searchAll(s.f, '消息', '/', { from: '2030-01' });
  assert.equal(none.hits.length, 0);
});

test('results stream as NDJSON and a search can be cancelled', async () => {
  const ctrl = new AbortController();
  const r = await s.f('/api/search?q=' + encodeURIComponent('消息'), { signal: ctrl.signal });
  const reader = r.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /"t":"meta"/);
  ctrl.abort();
  await assert.rejects(reader.read());
});

function write(rel, text, mtime) {
  const p = path.join(dep.roots, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  if (mtime) fs.utimesSync(p, mtime, mtime);
  return p;
}

const chatDoc = (word, id = 'b1') => `# 新会话 · 2026-10 · 001\n\n<a id="msg-0000000000000000000000${id}"></a>\n### 2026-10-02 09:00:00 · 新人 · 文本\n\n发送者：wxid_new · 消息：m:1\n\n> ${word}\n`;

async function recheck() {
  const t = Date.now();
  await s.f('/api/index/recheck', { method: 'POST' });
  await indexIdle(s.f, t);
}

test('a re-check finds new, edited in place, renamed and deleted files', async () => {
  // new file in a new folder
  write('archive/01_个人私聊/新人/聊天记录/2026-10_001.md', chatDoc('独角兽新消息'));
  await recheck();
  assert.equal((await searchAll(s.f, '独角兽')).hits.length, 1, 'new file');

  // edited in place: same folder, so its directory time does not have to change
  const p = path.join(dep.roots, 'archive', '01_个人私聊', '新人', '聊天记录', '2026-10_001.md');
  const dirTime = fs.statSync(path.dirname(p)).mtime;
  fs.writeFileSync(p, chatDoc('麒麟改过了'));
  fs.utimesSync(path.dirname(p), dirTime, dirTime);
  await recheck();
  assert.equal((await searchAll(s.f, '独角兽')).hits.length, 0, 'old text gone');
  assert.equal((await searchAll(s.f, '麒麟')).hits.length, 1, 'edited in place');

  // renamed
  const q = path.join(path.dirname(p), '2026-10_002.md');
  fs.renameSync(p, q);
  await recheck();
  const renamed = await searchAll(s.f, '麒麟');
  assert.deepEqual(
    renamed.hits.map((h) => h.path),
    ['/archive/01_个人私聊/新人/聊天记录/2026-10_002.md'],
  );

  // deleted, folder and all
  fs.rmSync(path.join(dep.roots, 'archive', '01_个人私聊', '新人'), { recursive: true });
  await recheck();
  assert.equal((await searchAll(s.f, '麒麟')).hits.length, 0, 'deleted');
});

test('nothing runs while nobody uses it: no check starts by itself', async () => {
  const a = await (await s.f('/api/index')).json();
  await sleep(1500);
  const b = await (await s.f('/api/index')).json();
  assert.equal(b.lastCheckStart, a.lastCheckStart);
  assert.equal(b.checking, false);
});

test('a file the index has not caught up with is scanned and marked', async () => {
  const p = write('notes/fresh.md', '# 新笔记\n\n凤凰出现在这里\n');
  // opening it notices the difference and refreshes it; before that a search scans it
  s.server.search.pending.add('/notes/fresh.md');
  const r = await searchAll(s.f, '凤凰');
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].scan, true);
  await s.f('/api/file?path=' + encodeURIComponent('/notes/fresh.md'));
  await sleep(300);
  const again = await searchAll(s.f, '凤凰');
  assert.equal(again.hits.length, 1);
  assert.ok(!again.hits[0].scan, 'indexed after it was opened');
  fs.rmSync(p);
});

test('a background job scans the whole scope from disk and keeps its result', async () => {
  const r = await (await s.f('/api/jobs', { method: 'POST', json: { q: '消息', scope: '/archive' } })).json();
  assert.ok(r.ok);
  let job;
  for (let i = 0; i < 100; i++) {
    job = await (await s.f('/api/jobs/' + r.id)).json();
    if (job.job.state === 'done') break;
    await sleep(100);
  }
  assert.equal(job.job.state, 'done');
  const idx = await searchAll(s.f, '消息', '/archive');
  assert.equal(job.hits.length, idx.hits.length);
  assert.ok(fs.existsSync(path.join(dep.state, 'jobs', r.id + '.json')));
});

test('an in-app overwrite is searchable as soon as the request returns', async () => {
  const s2dep = { ...dep };
  const s2 = await startServer(s2dep, { MDV_WRITABLE_ROOTS: 'notes', MDV_STATE_DIR: fs.mkdtempSync(path.join(dep.dir, 'st-')) }, {});
  try {
    await indexIdle(s2.f);
    const p = '/notes/other.md';
    const hash = (await s2.f('/api/file?path=' + encodeURIComponent(p))).headers.get('x-mdv-hash');
    const { confirmSentence } = await import('../src/server/write.js');
    const w = await (await s2.f('/api/write', { method: 'POST', json: { path: p, text: '# 其他\n\n貔貅写进来了\n', encoding: 'UTF-8', expectHash: hash, confirm: confirmSentence('other.md') } })).json();
    assert.equal(w.ok, true);
    const r = await searchAll(s2.f, '貔貅');
    assert.equal(r.hits.length, 1);
    assert.ok(!r.hits[0].scan);
  } finally {
    await s2.server.close();
  }
});
