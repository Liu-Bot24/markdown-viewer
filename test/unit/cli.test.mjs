import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, resolveTarget, userArgs } from '../../src/shared/cli.js';

const files = new Set(
  [
    'X:\\示例月报\\2026-09\\月报_2026-09.md',
    'X:\\示例归档\\01_个人私聊\\#\\聊天记录\\2021-11_001.md',
    'D:\\notes\\a#b.md',
    'X:\\proj\\rel dir\\doc.md',
  ].map((s) => s.toLowerCase()),
);
const exists = (p) => files.has(p.toLowerCase());

test('path#anchor splits off the anchor', () => {
  const r = resolveTarget('X:\\示例月报\\2026-09\\月报_2026-09.md#msg-abc', 'C:\\', exists);
  assert.deepEqual(r, { path: 'X:\\示例月报\\2026-09\\月报_2026-09.md', anchor: 'msg-abc' });
});

test("a folder named '#' keeps working, with and without anchor", () => {
  const p = 'X:\\示例归档\\01_个人私聊\\#\\聊天记录\\2021-11_001.md';
  assert.deepEqual(resolveTarget(p, 'C:\\', exists), { path: p, anchor: '' });
  assert.deepEqual(resolveTarget(p + '#msg-1', 'C:\\', exists), { path: p, anchor: 'msg-1' });
});

test("a file name containing '#'", () => {
  assert.deepEqual(resolveTarget('D:\\notes\\a#b.md', 'C:\\', exists), { path: 'D:\\notes\\a#b.md', anchor: '' });
  assert.deepEqual(resolveTarget('D:\\notes\\a#b.md#sec', 'C:\\', exists), { path: 'D:\\notes\\a#b.md', anchor: 'sec' });
});

test('relative paths resolve against the caller cwd', () => {
  assert.deepEqual(resolveTarget('rel dir\\doc.md#x', 'X:\\proj', exists), { path: 'X:\\proj\\rel dir\\doc.md', anchor: 'x' });
  assert.deepEqual(resolveTarget('..\\rel dir\\doc.md', 'X:\\proj\\other', exists), { path: 'X:\\proj\\rel dir\\doc.md', anchor: '' });
  assert.deepEqual(resolveTarget('"X:\\proj\\rel dir\\doc.md"', 'C:\\', exists), { path: 'X:\\proj\\rel dir\\doc.md', anchor: '' });
});

test('file:/// URLs and encoded anchors', () => {
  const u = 'file:///X:/%E7%A4%BA%E4%BE%8B%E6%9C%88%E6%8A%A5/2026-09/%E6%9C%88%E6%8A%A5_2026-09.md#%E4%B8%80%E9%A1%B5';
  assert.deepEqual(resolveTarget(u, 'C:\\', exists), { path: 'X:\\示例月报\\2026-09\\月报_2026-09.md', anchor: '一页' });
});

test('missing files are reported, not dropped', () => {
  const r = resolveTarget('D:\\nope\\x.md#msg-1', 'C:\\', exists);
  assert.equal(r.missing, true);
  assert.equal(r.path, 'D:\\nope\\x.md');
  assert.equal(r.anchor, 'msg-1');
});

test('parseArgs: --anchor, --new-tab, unknown switches', () => {
  const r = parseArgs(
    ['--allow-file-access-from-files', 'D:\\notes\\a#b.md', '--anchor', '#sec-2', '--new-tab', 'X:\\proj\\rel dir\\doc.md'],
    'C:\\',
    exists,
  );
  assert.equal(r.newTab, true);
  assert.deepEqual(r.targets, [
    { path: 'D:\\notes\\a#b.md', anchor: 'sec-2' },
    { path: 'X:\\proj\\rel dir\\doc.md', anchor: '' },
  ]);
});

test('userArgs strips the executable and, in development, the app path', () => {
  assert.deepEqual(userArgs(['mdview.exe', 'a.md'], false), ['a.md']);
  assert.deepEqual(userArgs(['electron.exe', '--inspect', '.', 'a.md#x'], true), ['a.md#x']);
});
