// The chat format documented in README.md is a contract for third-party exporters:
// its example must keep rendering as a chat with the behaviour the README describes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderDoc, ROOT } from './helpers.mjs';

const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const section = readme.slice(readme.indexOf('## 聊天记录格式'));
const example = /```markdown\r?\n([\s\S]*?)```/.exec(section)[1];
const file = path.join(ROOT, 'test', 'output', '会话', '聊天记录', 'example.md');

test('the README chat example renders as a chat', () => {
  const r = renderDoc(example, file);
  assert.equal(r.isChat, true);
  assert.equal(r.pp.chat.messages, 5);
  assert.deepEqual(r.pp.chat.days.map((d) => [d.date, d.count]), [['2026-09-01', 3], ['2026-09-02', 2]]);
  assert.equal(r.pp.chat.selfCandidate, 'lisi'); // the sender who is not the session named in the h1

  const msgs = [...r.root.querySelectorAll('section.mdv-msg')];
  assert.equal(msgs[0].querySelector('.mdv-msg-body').textContent.trim(), '早上好\n今天开会吗？');
  assert.equal(msgs[2].querySelector('.mdv-media-image img') !== null, true);
  const video = msgs[3].querySelector('video');
  assert.ok(video && video.getAttribute('poster'));
  assert.ok(msgs[4].classList.contains('mdv-msg-system'));
  assert.equal(r.root.querySelector('.mdv-msg-type').textContent, '图片'); // 文本 carries no type label
});

test('the README rule: a blank line between anchor and heading is not a chat', () => {
  const broken = example.replace(/(<a id="msg-[^"]+"><\/a>)\r?\n/g, '$1\n\n');
  assert.equal(renderDoc(broken, file).isChat, false);
});
