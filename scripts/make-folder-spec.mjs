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
const write = (rel, data) => (Buffer.isBuffer(data) ? { name: 'write ' + rel, do: 'writeFile', path: `${D}\\${rel}`, base64: data.toString('base64') } : { name: 'write ' + rel, do: 'writeFile', path: `${D}\\${rel}`, content: data });

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
];
const spec = { outDir: 'test/output/selftest-folder', steps };
fs.writeFileSync(path.join(root, 'test', 'selftest', 'folder.json'), JSON.stringify(spec, null, 1) + '\n');
console.log(`folder spec: ${steps.length} steps`);
