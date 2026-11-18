import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseMessageHeading, parseSenderLine, extractMessageWindow, isChatMarkdown, isMessageAnchor } from '../../packages/core/src/shared/chat.js';
import { FIXTURES, ROOT, renderDoc } from './helpers.mjs';

const CHAT = path.join(FIXTURES, 'wechat', '聊天记录归档', '01_个人私聊', '测试 联系人🍎', '聊天记录', '2026-09_001.md');

test('heading parsing, including sender names that contain " · "', () => {
  assert.deepEqual(parseMessageHeading('2019-12-18 15:30:54 · 测试甲 · 文本'), { date: '2019-12-18', time: '15:30:54', sender: '测试甲', type: '文本' });
  assert.deepEqual(parseMessageHeading("2021-01-01 00:00:00 · 小 · 黒 '😀 · 文件/链接/卡片"), { date: '2021-01-01', time: '00:00:00', sender: "小 · 黒 '😀", type: '文件/链接/卡片' });
  assert.equal(parseMessageHeading('一页速览'), null);
  assert.equal(parseMessageHeading('2026 年 · 9 · 月'), null);
});

test('sender line parsing', () => {
  assert.deepEqual(parseSenderLine('发送者：wxid_test0001 · 消息：message\\message_6.db:35'),
    { senderId: 'wxid_test0001', source: 'message\\message_6.db:35', fields: { 消息: 'message\\message_6.db:35' } });
  assert.deepEqual(parseSenderLine('发送者：zhangsan_id · 引用：msg-1a2b · 提到：my_id,notify@all'),
    { senderId: 'zhangsan_id', source: '', fields: { 引用: 'msg-1a2b', 提到: 'my_id,notify@all' } });
  assert.deepEqual(parseSenderLine('发送者：zhangsan_id'), { senderId: 'zhangsan_id', source: '', fields: {} });
  assert.equal(parseSenderLine('普通段落'), null);
});

test('the header\'s 我： line names me, also in a group chat', () => {
  const doc = '# 群 · 2026-09\n\n会话：g@chatroom\n我：my_id\n群人数：3\n\n'
    + '<a id="msg-a1"></a>\n### 2026-09-01 10:00:00 · 张三 · 文本\n\n发送者：zs · 提到：my_id\n\n> 在吗\n\n'
    + '<a id="msg-a2"></a>\n### 2026-09-01 10:01:00 · 李四 · 文本\n\n发送者：ls\n\n> 在\n\n'
    + '<a id="msg-a3"></a>\n### 2026-09-01 10:02:00 · 我 · 文本\n\n发送者：my_id · 引用：msg-a1\n\n> 在\n';
  const r = renderDoc(doc, path.join(ROOT, 'test', 'output', '群', 'x.md'));
  assert.equal(r.pp.chat.selfCandidate, 'my_id');
  assert.deepEqual([...r.root.querySelectorAll('section.mdv-msg')].map((s) => s.getAttribute('data-sender-id')), ['zs', 'ls', 'my_id']);
});

test('chat document detection', () => {
  assert.ok(isChatMarkdown(fs.readFileSync(CHAT, 'utf8')));
  assert.ok(!isChatMarkdown('# 普通文档\n\n<a id="x"></a>\n### 标题\n'));
  assert.ok(isMessageAnchor('msg-b8945ac9b79f0220fceafb2d'));
  assert.ok(!isMessageAnchor('一页速览'));
});

test('message window around an anchor', () => {
  const text = fs.readFileSync(CHAT, 'utf8');
  const w = extractMessageWindow(text, 'msg-0000000000000000000000a5', 2, 2);
  assert.equal(w.found, true);
  assert.equal(w.count, 12);
  assert.equal(w.index, 4);
  assert.equal((w.markdown.match(/<a id="msg-/g) || []).length, 5);
  assert.ok(w.markdown.startsWith('<a id="msg-0000000000000000000000a3"'));
  assert.equal(w.title, '测试 联系人🍎 · 2026-09 · 001');
  assert.ok(w.hasBefore && w.hasAfter);

  const first = extractMessageWindow(text, 'msg-0000000000000000000000a1', 3, 1);
  assert.equal(first.index, 0);
  assert.equal(first.hasBefore, false);
  const last = extractMessageWindow(text, 'msg-0000000000000000000000b3', 1, 5);
  assert.equal(last.hasAfter, false);
  assert.ok(last.markdown.trimEnd().endsWith('不是标签&lt;/\\_wc\\_custom\\_link\\_&gt;'));

  assert.equal(extractMessageWindow(text, 'msg-ffff').found, false);
});
