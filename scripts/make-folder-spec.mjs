// Generate test/selftest/folder.json: the folder page and files shown in the app, at a
// large window size, with real mouse and key input. Synthetic files only.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');

function png(w, h, rgb) {
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgb, y * (w * 3 + 1) + 1 + x * 3);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Half a second of a quiet tone, 8 kHz mono 16-bit. */
function wav() {
  const n = 4000;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(800 * Math.sin((i / 8000) * 2 * Math.PI * 440)), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(8000, 24);
  head.writeUInt32LE(16000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const D = '${tmp}\\fv';
const LINK = (n) => `.doc-root.active article a:nth-of-type(${n})`;
const colors = [[200, 60, 60], [220, 160, 40], [70, 160, 80], [50, 120, 200], [120, 80, 180], [90, 90, 90]];
const pics = ['2019-02-12_142201_图片_000004.png', '2019-05-01_080000_图片_000010.png', '2020-11-29_204017_图片_005227.png', '2020-12-06_212106_图片_005439.png', '2021-03-07_122724_图片_010313.png', '2021-03-07_122749_图片_010314.png'];
const PLAIN = '${tmp}\\fv-plain'; // outside the test chat: no message to find
const writeAt = (p, data) => (Buffer.isBuffer(data) ? { name: 'write ' + p, do: 'writeFile', path: p, base64: data.toString('base64') } : { name: 'write ' + p, do: 'writeFile', path: p, content: data });
const write = (rel, data) => (Buffer.isBuffer(data) ? { name: 'write ' + rel, do: 'writeFile', path: `${D}\\${rel}`, base64: data.toString('base64') } : { name: 'write ' + rel, do: 'writeFile', path: `${D}\\${rel}`, content: data });

// chat volumes in the archive's layout: each attachment linked under its message's anchor
const A1 = 'msg-' + 'a1'.repeat(12);
const A2 = 'msg-' + 'b2'.repeat(12);
const A3 = 'msg-' + 'c3'.repeat(12);
const enc = (rel) => rel.split('/').map((s) => (s === '..' ? s : encodeURIComponent(s))).join('/');
const msg = (anchor, time, name, type, rel) => `<a id="${anchor}"></a>\n### ${time} · ${name} · ${type}\n\n发送者：u_${name} · 消息：t:1\n\n> 看这个\n\n- [image · m_1](${enc(rel)})\n`;
const volume = (month, msgs) => `# 测试会话 · ${month} · 001\n\n会话：c_test\n我：u_me\n\n${msgs.join('\n')}`;

const steps = [
  { name: 'theme-light', do: 'setTheme', theme: 'light', expect: { dark: false } },
  { name: 'wide-window', do: 'windowSize', width: 2400, height: 1300, expect: { cssWidth: { min: 2300 } } },
  write('索引.md', '# 测试会话\n\n[图片](图片/) · [语音](语音/) · [文件](文件/)\n'),
  write('图片\\预览\\p.png', png(40, 30, [0, 0, 0])),
  ...pics.map((n, i) => write('图片\\' + n, png(320, 240, colors[i]))),
  write('语音\\2019-03-12_224515_语音_000124.wav', wav()),
  write('语音\\2019-03-12_224515_语音_000124.txt', '测试转写内容\n'),
  write('语音\\2019-03-30_123049_语音_000125.wav', wav()),
  write('文件\\说明.txt', '第一行\n第二行\n'),
  write('文件\\page.html', '<html><head><title>x</title></head><body><p>网页正文</p><script>parent.document.title = "SCRIPT RAN"</script></body></html>'),
  write('文件\\data.bin', Buffer.from([0, 1, 2, 3])),
  { name: 'open-index', do: 'open', path: `${D}\\索引.md`, expect: { 'view.error': null } },

  // a link to a folder opens the folder page in place: thumbnails, subfolder, year jumps
  { name: 'click-pictures-link', do: 'mouse', selector: LINK(1), settle: 300 },
  {
    name: 'picture-folder',
    do: 'fvWait',
    kind: 'folder',
    settle: 1500,
    expect: { layout: 'grid', total: 7, items: 6, chips: '📁 预览', years: '2019,2020,2021', imgsLoaded: 6, cols: { min: 7 }, status: '1 个文件夹 · 6 个文件', bodyWidth: { min: 1500 } },
    screenshot: true,
  },
  // a thumbnail opens the viewer, which steps through the folder by key and by button
  { name: 'click-thumbnail', do: 'mouse', selector: '.doc-root.active .fv-tile', settle: 800, probe: true, expect: { open: true, fits: true } },
  { name: 'viewer-first', do: 'fvState', expect: { 'lb.count': '1 / 6', 'lb.caption': pics[0] } },
  { name: 'arrow-right', do: 'keys', keys: ['Right'], settle: 600 },
  { name: 'viewer-second', do: 'fvState', expect: { 'lb.count': '2 / 6', 'lb.caption': pics[1] } },
  { name: 'next-button', do: 'mouse', selector: '.lb-side.next', settle: 600 },
  { name: 'viewer-third', do: 'fvState', expect: { 'lb.count': '3 / 6', 'lb.caption': pics[2] }, screenshot: true },
  { name: 'arrow-left', do: 'keys', keys: ['Left'], settle: 600 },
  { name: 'viewer-back-to-second', do: 'fvState', expect: { 'lb.count': '2 / 6' } },
  { name: 'esc', do: 'keys', keys: ['Escape'] },
  { name: 'viewer-closed', do: 'fvState', expect: { 'lb.open': false, kind: 'folder' } },
  { name: 'back-to-index', do: 'back', expect: { 'view.path': `${D}\\索引.md` } },

  // audio plays in its row; a same-named .txt is shown as its transcript, not as a row of its own
  { name: 'click-voice-link', do: 'mouse', selector: LINK(2), settle: 300 },
  { name: 'voice-folder', do: 'fvWait', kind: 'folder', settle: 800, expect: { layout: 'list', total: 3, items: 2, transcripts: '测试转写内容', names: '2019-03-12_224515_语音_000124.wav|2019-03-30_123049_语音_000125.wav' }, screenshot: true },
  { name: 'play-row', do: 'mouse', selector: '.doc-root.active .fv-audio', settle: 300 },
  { name: 'playing', do: 'fvState', expect: { playing: true } },
  { name: 'back-to-index-2', do: 'back', expect: { 'view.path': `${D}\\索引.md` } },

  // text files and web pages open read-only in the app; a page's scripts do not run
  { name: 'click-files-link', do: 'mouse', selector: LINK(3), settle: 300 },
  { name: 'file-folder', do: 'fvWait', kind: 'folder', expect: { layout: 'list', items: 3 } },
  { name: 'click-text', do: 'mouse', selector: '.doc-root.active .fv-row[data-kind="text"]', settle: 300 },
  { name: 'text-view', do: 'fvWait', kind: 'file', expect: { text: '第一行\n第二行\n', frame: false, modeSeg: 'none', status: 'UTF-8 · 20 B · 3 行' } },
  { name: 'back-to-files', do: 'back' },
  { name: 'files-again', do: 'fvWait', kind: 'folder', expect: { items: 3 } },
  { name: 'click-page', do: 'mouse', selector: '.doc-root.active .fv-row[data-kind="html"]', settle: 300 },
  { name: 'page-view', do: 'fvWait', kind: 'file', settle: 1000, expect: { frame: true, sandbox: '', title: 'page.html - MD Viewer' }, screenshot: true },

  // the message that sent a picture: from the viewer, and from the folder page's menu
  write('聊天记录\\2019-02_001.md', volume('2019-02', [msg(A1, '2019-02-12 14:22:01', '张三', '图片', '../图片/' + pics[0])])),
  write('聊天记录\\2021-03_001.md', volume('2021-03', [msg(A2, '2021-03-07 12:27:49', '李四', '图片', '../图片/' + pics[5]), msg(A3, '2021-03-08 09:00:00', '王五', '文本', '../图片/' + pics[5])])),
  { name: 'open-index-again', do: 'open', path: `${D}\\索引.md`, expect: { 'view.error': null } },
  { name: 'click-pictures-again', do: 'mouse', selector: LINK(1), settle: 300 },
  { name: 'pictures-again', do: 'fvWait', kind: 'folder', settle: 1200, expect: { total: 7 } },
  { name: 'open-first-picture', do: 'mouse', selector: '.doc-root.active .fv-tile', settle: 800 },
  { name: 'viewer-offers-locate', do: 'fvState', expect: { 'lb.count': '1 / 6', 'lb.locate': true }, screenshot: true },
  { name: 'click-locate', do: 'mouse', selector: '.lb-locate', settle: 300 },
  { name: 'message-shown', do: 'waitTarget', path: `${D}\\聊天记录\\2019-02_001.md`, anchor: A1, expect: { found: true, anchorVisible: true } },
  { name: 'viewer-closed-after-locate', do: 'fvState', expect: { 'lb.open': false, kind: 'doc', target: A1 }, screenshot: true },
  { name: 'back-to-pictures', do: 'back' },
  { name: 'pictures-after-back', do: 'fvWait', kind: 'folder', expect: { total: 7 } },
  // two messages sent the same picture: the user picks one
  { name: 'script-menus', do: 'menuPick', labels: ['找到原消息', '2021-03-08 09:00:00 · 王五'] },
  { name: 'right-click-sixth', do: 'mouse', selector: `.doc-root.active .fv-tile[data-path$="${pics[5]}"]`, button: 'right', settle: 300 },
  { name: 'second-message-shown', do: 'waitTarget', path: `${D}\\聊天记录\\2021-03_001.md`, anchor: A3, expect: { found: true, anchorVisible: true } },
  { name: 'menus-offered', do: 'menusShown', expect: { 'shown.0': { includes: '找到原消息' }, 'shown.1': '2021-03-07 12:27:49 · 李四|2021-03-08 09:00:00 · 王五', pending: 0 } },
  { name: 'back-to-pictures-2', do: 'back' },
  { name: 'pictures-after-back-2', do: 'fvWait', kind: 'folder', expect: { total: 7 } },
  // a picture no message links: said so, nothing opens
  { name: 'script-menu-unlinked', do: 'menuPick', labels: ['找到原消息'] },
  { name: 'right-click-fifth', do: 'mouse', selector: `.doc-root.active .fv-tile[data-path$="${pics[4]}"]`, button: 'right', settle: 600 },
  { name: 'not-found-said', do: 'fvState', expect: { kind: 'folder', toast: '没有找到发送这个文件的消息' } },
  // a folder outside any chat: no such item, no such button
  writeAt(`${PLAIN}\\看图.md`, '# 图\n\n[图片](图片/)\n'),
  writeAt(`${PLAIN}\\图片\\2020-01-01_000000_a.png`, png(320, 240, [10, 120, 160])),
  { name: 'open-plain', do: 'open', path: `${PLAIN}\\看图.md`, expect: { 'view.error': null } },
  { name: 'click-plain-pictures', do: 'mouse', selector: LINK(1), settle: 300 },
  { name: 'plain-folder', do: 'fvWait', kind: 'folder', settle: 800, expect: { total: 1 } },
  { name: 'script-menu-plain', do: 'menuPick', labels: ['nothing'] },
  { name: 'right-click-plain', do: 'mouse', selector: '.doc-root.active .fv-tile', button: 'right', settle: 300 },
  { name: 'plain-menu-without-locate', do: 'menusShown', expect: { 'shown.0': { includes: '复制路径', excludes: '找到原消息' } } },
  { name: 'open-plain-picture', do: 'mouse', selector: '.doc-root.active .fv-tile', settle: 800 },
  { name: 'plain-viewer-without-locate', do: 'fvState', expect: { 'lb.open': true, 'lb.locate': false } },
  { name: 'esc-plain', do: 'keys', keys: ['Escape'] },

  // a folder clicked in the tree opens in the reading pane and expands; its arrow only toggles
  { name: 'open-index-for-tree', do: 'open', path: `${D}\\索引.md`, expect: { 'view.error': null } },
  { name: 'tree-click-voice', do: 'mouse', selector: '.tree-item[title$="语音"] .tree-label', settle: 300 },
  { name: 'tree-voice-opened', do: 'fvWait', kind: 'folder', expect: { path: `${D}\\语音`, layout: 'list', items: 2, 'tree.open': { includes: '语音' }, 'tree.current': '语音' }, screenshot: true },
  { name: 'tree-click-voice-again', do: 'mouse', selector: '.tree-item[title$="语音"] .tree-label', settle: 400 },
  { name: 'tree-voice-collapsed', do: 'fvState', expect: { kind: 'folder', path: `${D}\\语音`, 'tree.open': { excludes: '语音' } } },
  { name: 'tree-arrow-pictures', do: 'mouse', selector: '.tree-item[title$="图片"] .twisty', settle: 400 },
  { name: 'tree-arrow-only-expands', do: 'fvState', expect: { kind: 'folder', path: `${D}\\语音`, 'tree.open': { includes: '图片' } } },
  { name: 'tree-click-pictures', do: 'mouse', selector: '.tree-item[title$="图片"] .tree-label', settle: 300 },
  { name: 'tree-pictures-opened', do: 'fvWait', kind: 'folder', settle: 800, expect: { path: `${D}\\图片`, total: 7, 'tree.open': { includes: '图片' }, 'tree.current': '图片' } },
  { name: 'tree-back', do: 'back', expect: { 'view.path': `${D}\\语音` } },

  // a narrow reading pane drops a row's date, then its size; the file name always keeps room
  { name: 'voice-wide-rows', do: 'fvWait', kind: 'folder', expect: { path: `${D}\\语音`, datesShown: 2, sizesShown: 2, nameMinWidth: { min: 150 } } },
  { name: 'window-medium', do: 'windowSize', width: 1000, height: 900 },
  { name: 'medium-rows-drop-date', do: 'fvState', expect: { datesShown: 0, sizesShown: 2, nameMinWidth: { min: 100 }, bodyWidth: { min: 361, max: 540 } } },
  { name: 'window-narrow', do: 'windowSize', width: 780, height: 900 },
  { name: 'narrow-rows-keep-names', do: 'fvState', expect: { datesShown: 0, sizesShown: 0, nameMinWidth: { min: 60 }, bodyWidth: { max: 360 } }, screenshot: true },
  // the smallest window, sidebar and outline still open: the name still shows its start
  { name: 'window-smallest', do: 'windowSize', width: 640, height: 900 },
  { name: 'smallest-rows-keep-names', do: 'fvState', expect: { datesShown: 0, sizesShown: 0, nameMinWidth: { min: 30 } }, screenshot: true },
  { name: 'window-wide-again', do: 'windowSize', width: 2400, height: 1300, settle: 600 },
  { name: 'wide-rows-again', do: 'fvState', expect: { datesShown: 2, sizesShown: 2 } },
];
const spec = { outDir: 'test/output/selftest-folder', steps };
fs.writeFileSync(path.join(root, 'test', 'selftest', 'folder.json'), JSON.stringify(spec, null, 1) + '\n');
console.log(`folder spec: ${steps.length} steps`);
