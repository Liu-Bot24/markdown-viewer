import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveHref,
  pathToFileHref,
  fileHrefToPath,
  toLocalResourceUrl,
  localResourceUrlToPath,
  hashSplitCandidates,
  resolveResourceSrc,
  mediaKind,
  isMarkdownPath,
} from '../../packages/core/src/shared/paths.js';

const REPORT = 'X:\\示例月报\\2026-09\\月报_2026-09.md';

test('angle-bracket relative link with Chinese, spaces, emoji and anchor (as rendered by markdown-it)', () => {
  // markdown-it percent-encodes the destination; emulate with encodeURI.
  const raw = '../../示例归档/04_业务群聊/示例业务群 0001/聊天记录/2026-09_001.md#msg-0123456789abcdef01234567';
  const r = resolveHref(encodeURI(raw), REPORT);
  assert.equal(r.kind, 'local');
  assert.equal(r.candidates[0].path, 'X:\\示例归档\\04_业务群聊\\示例业务群 0001\\聊天记录\\2026-09_001.md');
  assert.equal(r.candidates[0].anchor, 'msg-0123456789abcdef01234567');
  const emoji = resolveHref(encodeURI('../../示例归档/05_普通群聊/示例1️⃣群（原测试群）/聊天记录/2026-09_001.md#msg-1'), REPORT);
  assert.equal(emoji.candidates[0].path, 'X:\\示例归档\\05_普通群聊\\示例1️⃣群（原测试群）\\聊天记录\\2026-09_001.md');
});

test("'#' inside a directory name yields a later candidate", () => {
  const r = resolveHref(encodeURI('../../示例归档/01_个人私聊/#/聊天记录/2026-09_001.md#msg-abc'), REPORT);
  assert.equal(r.kind, 'local');
  const want = { path: 'X:\\示例归档\\01_个人私聊\\#\\聊天记录\\2026-09_001.md', anchor: 'msg-abc' };
  assert.deepEqual(r.candidates[1], want);
  assert.equal(r.candidates[0].path, 'X:\\示例归档\\01_个人私聊\\');
});

test('file:/// fallback links, encoded and raw', () => {
  const p = 'X:\\示例归档\\01_个人私聊\\🔴 测试联系人\\聊天记录\\2026-10_abcdef012345_001.md';
  const enc = pathToFileHref(p) + '#msg-1';
  const r = resolveHref(enc, REPORT);
  assert.deepEqual(r.candidates[0], { path: p, anchor: 'msg-1' });
  const raw = resolveHref('file:///X:/示例归档/01_个人私聊/🔴 测试联系人/聊天记录/2026-10_abcdef012345_001.md#msg-2', REPORT);
  assert.deepEqual(raw.candidates[0], { path: p, anchor: 'msg-2' });
});

test('Windows absolute paths in links, plain or percent-encoded backslashes', () => {
  const r = resolveHref('D:%5Ca%20b%5Cc.md#x', REPORT);
  assert.deepEqual(r.candidates[0], { path: 'D:\\a b\\c.md', anchor: 'x' });
  const r2 = resolveHref('D:/a/c.md', REPORT);
  assert.equal(r2.candidates[0].path, 'D:\\a\\c.md');
});

test('archive media links stay relative to the chat file', () => {
  const base = 'X:\\示例归档\\01_个人私聊\\测试甲\\聊天记录\\2024-03_001.md';
  const src = '../%E5%9B%BE%E7%89%87/%E4%BB%85%E9%A2%84%E8%A7%88/2024-04-11_141630_%E5%9B%BE%E7%89%87_000076_%E4%BB%85%E9%A2%84%E8%A7%88.jpg';
  const r = resolveHref(src, base);
  assert.equal(r.candidates[0].path, 'X:\\示例归档\\01_个人私聊\\测试甲\\图片\\仅预览\\2024-04-11_141630_图片_000076_仅预览.jpg');
  assert.equal(mediaKind(r.candidates[0].path), 'image');
  assert.equal(mediaKind('x.MP4'), 'video');
  assert.equal(mediaKind('x.mp3'), 'audio');
  assert.equal(mediaKind('x.pdf'), null);
});

test('anchor, external and invalid hrefs', () => {
  assert.deepEqual(resolveHref('#%E4%B8%80%E9%A1%B5%E9%80%9F%E8%A7%88', REPORT), { kind: 'anchor', anchor: '一页速览' });
  assert.equal(resolveHref('https://example.com/a?b#c', REPORT).kind, 'external');
  assert.equal(resolveHref('mailto:a@b.c', REPORT).kind, 'external');
  assert.equal(resolveHref('', REPORT).kind, 'invalid');
  assert.equal(resolveHref('rel.md', null).kind, 'invalid');
});

test('file URL and local resource URL round trips (drive, UNC, special chars)', () => {
  for (const p of ['X:\\示例归档\\01_个人私聊\\#\\a b%c.md', 'C:\\x\\🍎 y\\z.png', '\\\\nas\\share\\图片\\a.jpg']) {
    assert.equal(fileHrefToPath(pathToFileHref(p)), p);
    assert.equal(localResourceUrlToPath(toLocalResourceUrl(p)), p);
  }
});

test('resource src resolution keeps remote/data URLs', () => {
  assert.equal(resolveResourceSrc('https://a/b.png', REPORT), 'https://a/b.png');
  assert.equal(resolveResourceSrc('data:image/png;base64,AA', REPORT), 'data:image/png;base64,AA');
  assert.match(resolveResourceSrc('img/a%20b.png', REPORT), /^mdvfile:\/\/local\/X:\//);
});

test('hash split candidates', () => {
  assert.deepEqual(hashSplitCandidates('a#b#c'), [
    { path: 'a', anchor: 'b#c' },
    { path: 'a#b', anchor: 'c' },
    { path: 'a#b#c', anchor: '' },
  ]);
});

test('markdown path detection', () => {
  assert.ok(isMarkdownPath('a.md'));
  assert.ok(isMarkdownPath('A.MARKDOWN'));
  assert.ok(!isMarkdownPath('a.txt'));
  assert.ok(!isMarkdownPath('md'));
});

// ---------- virtual paths (web edition) ----------
import { dirname, basename, isUnder, sameFile, pathKey, isVirtualPath, setPathHooks, resourceUrlToPath } from '../../packages/core/src/shared/paths.js';

test('virtual paths: "/" separators, case kept, "//host" is still UNC', () => {
  assert.equal(isVirtualPath('/archive/a.md'), true);
  assert.equal(isVirtualPath('//host/share/a.md'), false);
  assert.equal(isVirtualPath('D:\\a.md'), false);
  assert.equal(dirname('/archive/a/b.md'), '/archive/a');
  assert.equal(dirname('/archive'), '/');
  assert.equal(dirname('/'), '/');
  assert.equal(basename('/archive/a/b.md'), 'b.md');
  assert.equal(basename('/'), '');
  assert.ok(isUnder('/archive/a/b.md', '/archive'));
  assert.ok(isUnder('/archive/a/b.md', '/'));
  assert.ok(!isUnder('/archive2/b.md', '/archive'));
  assert.ok(!isUnder('/Archive/b.md', '/archive'), 'case matters on the server');
  assert.ok(sameFile('D:\\A\\b.md', 'd:\\a\\B.MD'), 'Windows paths still ignore case');
  assert.ok(!sameFile('/a/B.md', '/a/b.md'));
  assert.equal(pathKey('D:\\A'), 'd:\\a');
  assert.ok(!isUnder('D:\\a\\b.md', '/'), 'styles never mix');
});

test('links in a virtual document resolve to virtual paths; absolute Windows links stay Windows paths', () => {
  const base = '/archive/01_个人私聊/#/聊天记录/2026-09_001.md';
  const r = resolveHref(encodeURI('../../测试 联系人🍎/聊天记录/2026-09_001.md#msg-1'), base);
  assert.equal(r.kind, 'local');
  assert.deepEqual(r.candidates[0], { path: '/archive/01_个人私聊/测试 联系人🍎/聊天记录/2026-09_001.md', anchor: 'msg-1' });
  assert.equal(resolveHref('/notes/x.md', base).candidates[0].path, '/notes/x.md');
  assert.equal(resolveHref('../../../../../../x.md', base).candidates[0].path, '/x.md', 'never above the top');
  assert.equal(resolveHref('D:\\data\\x.md', base).candidates[0].path, 'D:\\data\\x.md');
});

test('resource URLs go through the platform hooks when set', () => {
  try {
    setPathHooks({ resourceUrl: (p, o) => (o.full ? '/raw' : '/thumb') + p, resourcePath: (u) => (u.startsWith('/raw') ? u.slice(4) : null) });
    assert.equal(toLocalResourceUrl('/a/b.png'), '/thumb/a/b.png');
    assert.equal(toLocalResourceUrl('/a/b.png', { full: true }), '/raw/a/b.png');
    assert.equal(resourceUrlToPath('/raw/a/b.png'), '/a/b.png');
    setPathHooks({ resourceUrl: () => null, resourcePath: () => null });
    assert.equal(toLocalResourceUrl('D:\\x.png'), 'about:blank#unavailable', 'an unmapped path loads as missing');
  } finally {
    setPathHooks(null);
  }
  assert.match(toLocalResourceUrl('D:\\x.png'), /^mdvfile:/);
  assert.equal(resourceUrlToPath(toLocalResourceUrl('D:\\a b\\x.png')), 'D:\\a b\\x.png');
});
