import test from 'node:test';
import assert from 'node:assert/strict';
import { monthOf, volumesFor, attachmentRefs } from '../../packages/core/src/shared/attachments.js';

const enc = (rel) => rel.split('/').map((s) => (s === '..' ? s : encodeURIComponent(s).replace(/\(/g, '%28').replace(/\)/g, '%29'))).join('/');

const vol = [
  '# 测试群 · 2026-08 · 001',
  '',
  '<a id="msg-aaaaaaaaaaaaaaaaaaaaaaaa"></a>',
  '### 2026-08-09 08:12:11 · 张 · 三 · 图片',
  '',
  '发送者：u1 · 消息：a:1',
  '',
  `- [image · m_1](${enc('../图片/2026-08-09_081211_图片_003314.png')})`,
  '',
  '<a id="msg-bbbbbbbbbbbbbbbbbbbbbbbb"></a>',
  '### 2026-08-09 09:00:00 · 李四 · 文件',
  '',
  '发送者：u2 · 消息：a:2',
  '',
  `- [file · m_2](${enc('../文件/2026-08-09_090000_报告(终版)+附录_000001.pdf')})`,
  '',
  '<a id="msg-cccccccccccccccccccccccc"></a>',
  '### 2026-08-10 10:00:00 · 王五 · 文本',
  '',
  '发送者：u3 · 消息：a:3',
  '',
  `> 转发 ${enc('../图片/2026-08-09_081211_图片_003314.png')} 不是链接`,
  `- [image · m_3](${enc('../图片/2026-08-09_081211_图片_003314.png')})`,
  `- [image · m_4](${enc('../图片/预览/2026-08-09_081211_图片_003315_预览.jpg')})（仅预览）`,
].join('\n');

test('monthOf: dated attachment names only', () => {
  assert.equal(monthOf('2026-08-09_081211_图片_003314.png'), '2026-08');
  assert.equal(monthOf('说明.txt'), null);
  assert.equal(monthOf('2026-13-09_x.png'), null);
});

test('volumesFor: the month first, every volume without one', () => {
  const names = ['2026-07_001.md', '2026-08_002.md', '2026-08_0123456789ab_001.md', '2026-08_001.md', 'notes.txt'];
  assert.deepEqual(volumesFor(names, '2026-08'), ['2026-08_001.md', '2026-08_002.md', '2026-08_0123456789ab_001.md']);
  assert.deepEqual(volumesFor(names, null), ['2026-07_001.md', '2026-08_001.md', '2026-08_002.md', '2026-08_0123456789ab_001.md']);
});

test('attachmentRefs: every message linking the file, with date and sender', () => {
  const hits = attachmentRefs(vol, '../图片/2026-08-09_081211_图片_003314.png');
  assert.deepEqual(hits, [
    { anchor: 'msg-aaaaaaaaaaaaaaaaaaaaaaaa', date: '2026-08-09 08:12:11', sender: '张 · 三' },
    { anchor: 'msg-cccccccccccccccccccccccc', date: '2026-08-10 10:00:00', sender: '王五' },
  ]);
});

test('attachmentRefs: encoded parentheses and plus, preview subfolder, case folding', () => {
  assert.equal(attachmentRefs(vol, '../文件/2026-08-09_090000_报告(终版)+附录_000001.pdf')[0].anchor, 'msg-bbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(attachmentRefs(vol, '../图片/预览/2026-08-09_081211_图片_003315_预览.jpg')[0].anchor, 'msg-cccccccccccccccccccccccc');
  assert.equal(attachmentRefs(vol, '../图片/2026-08-09_081211_图片_003314.PNG').length, 0);
  assert.equal(attachmentRefs(vol, '../图片/2026-08-09_081211_图片_003314.PNG', { fold: true }).length, 2);
  assert.equal(attachmentRefs(vol, '../图片/2026-08-09_081211_图片_009999.png').length, 0);
});
