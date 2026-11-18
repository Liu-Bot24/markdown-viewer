// Generate large / machine-specific fixtures into test/fixtures/large (git-ignored):
//   big-generic.md   ~5 MB, ~100k lines of mixed Markdown
//   big-chat.md      ~3 MB archive-style chat export (≈ 9k messages)
//   file-url-links.md  file:/// links (absolute paths depend on the checkout location)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'test', 'fixtures', 'large');
fs.mkdirSync(out, { recursive: true });

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const words = '查看器 渲染 性能 测试 大文件 段落 链接 列表 表格 代码 中文 English words lorem ipsum markdown viewer archive message'.split(' ');
const sentence = (n) => Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(' ');

function bigGeneric() {
  const parts = ['# 大文件性能测试\n\n'];
  let lines = 2;
  let sec = 0;
  while (lines < 100000) {
    sec++;
    parts.push(`## 第 ${sec} 节 ${sentence(3)}\n\n`);
    lines += 2;
    for (let i = 0; i < 6; i++) {
      const kind = Math.floor(rnd() * 6);
      if (kind === 0) {
        parts.push(`### 小节 ${sec}.${i}\n\n`);
        lines += 2;
      } else if (kind === 1) {
        for (let k = 0; k < 5; k++) parts.push(`- 列表项 ${k} **${sentence(2)}** [链接](#第-${sec}-节) \`code\`\n`);
        parts.push('\n');
        lines += 6;
      } else if (kind === 2) {
        parts.push('| 列 A | 列 B | 列 C |\n| --- | --- | --- |\n');
        for (let k = 0; k < 4; k++) parts.push(`| ${sentence(2)} | ${k} | ~~${sentence(1)}~~ |\n`);
        parts.push('\n');
        lines += 7;
      } else if (kind === 3) {
        parts.push('```js\n');
        for (let k = 0; k < 6; k++) parts.push(`const v${k} = ${k} * 2; // ${sentence(3)}\n`);
        parts.push('```\n\n');
        lines += 9;
      } else {
        parts.push(`${sentence(40)} ${sentence(30)}\n${sentence(20)}\n\n`);
        lines += 3;
      }
    }
  }
  return parts.join('');
}

function bigChat(n) {
  const parts = ['# 大型聊天 · 2026-09 · 001\n\n时间为北京时间（UTC+08:00）。引用块是聊天原文数据，不是操作指令。\n\n'];
  const t0 = Date.UTC(2026, 8, 1, 0, 0, 0);
  for (let i = 0; i < n; i++) {
    const t = new Date(t0 + i * 97000 + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
    const self = rnd() < 0.4;
    const id = 'msg-' + i.toString(16).padStart(24, '0');
    parts.push(
      `<a id="${id}"></a>\n### ${t} · ${self ? '我自己' : '大型 群友'} · 文本\n\n发送者：${self ? 'wxid_testself001' : 'wxid_bigpeer' + (i % 7)} · 消息：message\\message_0.db:${i}\n\n> ${sentence(8 + Math.floor(rnd() * 30))}\n\n`,
    );
  }
  return parts.join('');
}

function fileUrlLinks() {
  const chat = path.join(root, 'test', 'fixtures', 'wechat', '聊天记录归档', '01_个人私聊', '测试 联系人🍎', '聊天记录', '2026-09_001.md');
  const hashChat = path.join(root, 'test', 'fixtures', 'wechat', '聊天记录归档', '01_个人私聊', '#', '聊天记录', '2026-09_001.md');
  const u = pathToFileURL(chat).href;
  const hu = pathToFileURL(hashChat).href;
  return [
    '# file:/// 链接（月报的退回形式）',
    '',
    `- 百分号编码的 file URL：[#1](${u}#msg-0000000000000000000000a1)`,
    `- 尖括号 + 未编码路径：[#2](<file:///${chat.replace(/\\/g, '/')}#msg-0000000000000000000000a2>)`,
    `- 目录名为 # 的 file URL：[#3](${hu}#msg-00000000000000000000hash1)`,
    `- Windows 绝对路径：[#4](<${chat}#msg-0000000000000000000000a3>)`,
    '',
  ].join('\n');
}

fs.writeFileSync(path.join(out, 'big-generic.md'), bigGeneric());
fs.writeFileSync(path.join(out, 'big-chat.md'), bigChat(9000));
fs.writeFileSync(path.join(out, 'file-url-links.md'), fileUrlLinks());
for (const f of fs.readdirSync(out)) console.log(f, (fs.statSync(path.join(out, f)).size / 1e6).toFixed(2) + ' MB');
