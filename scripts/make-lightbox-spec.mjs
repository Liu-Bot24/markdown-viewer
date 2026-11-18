// Generate test/selftest/lightbox.json: the image viewer at the large window size.
// Real mouse input: backdrop click closes, image click zooms around the cursor, the
// zoomed image reaches every edge, drag pans without closing or zooming.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');

// A photo-sized PNG (4000 x 3000) in horizontal colour bands; small once compressed.
function bandsPng(w, h) {
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
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1);
    const band = Math.floor((y / h) * 6);
    const rgb = [[200, 60, 60], [220, 160, 40], [70, 160, 80], [50, 120, 200], [120, 80, 180], [90, 90, 90]][band];
    for (let x = 0; x < w; x++) raw.set(x < w / 10 ? [250, 250, 250] : rgb, o + 1 + x * 3); // a light strip on the left edge
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const IMG = '.lb-stage img';
const STAGE = '.lb-stage';
const near = (v, d = 0.01) => ({ min: v - d, max: v + d });
// optional: a chat record with a tall photo on this machine, named at run time (never in the repo):
// MDV_LIGHTBOX_MD = the chat file, MDV_LIGHTBOX_IMG = part of the photo's file name
const REAL_MD = '${env:MDV_LIGHTBOX_MD}';
const REAL_IMG = 'img[src*="${env:MDV_LIGHTBOX_IMG}"]';

const steps = [
  { name: 'theme-dark', do: 'setTheme', theme: 'dark', expect: { dark: true } },
  { name: 'wide-window', do: 'windowSize', width: 2400, height: 1300, expect: { cssWidth: { min: 2300 } } },
  { name: 'write-png', do: 'writeFile', path: '${tmp}\\lb\\big.png', base64: bandsPng(4000, 3000).toString('base64') },
  { name: 'write-doc', do: 'writeFile', path: '${tmp}\\lb\\doc.md', content: '# 图片查看\n\n![大图](big.png)\n' },
  { name: 'open-doc', do: 'open', path: '${tmp}\\lb\\doc.md', expect: { 'view.error': null } },
  { name: 'doc-image-loaded', do: 'wait', ms: 1000 },

  // open from the document, then click the dark area left of the fitted image
  { name: 'click-image-in-doc', do: 'mouse', selector: '.doc-root.active article img', probe: true, settle: 800, expect: { open: true, zoomed: false, fits: true } },
  { name: 'fit-screenshot', do: 'wait', ms: 100, screenshot: true },
  { name: 'backdrop-closes', do: 'mouse', selector: STAGE, frac: [0.03, 0.5], probe: true, expect: { open: false } },

  // the bar's empty area closes too; a drag that starts on the backdrop does not
  { name: 'reopen-1', do: 'mouse', selector: '.doc-root.active article img', probe: true, settle: 800, expect: { open: true } },
  { name: 'backdrop-drag-keeps', do: 'mouse', selector: STAGE, frac: [0.03, 0.5], drag: [200, 0], probe: true, expect: { open: true } },
  { name: 'bar-closes', do: 'mouse', selector: '.lb-caption', frac: [0.6, 0.5], probe: true, expect: { open: false } },

  // zoom in: the clicked image point stays under the cursor
  { name: 'reopen-2', do: 'mouse', selector: '.doc-root.active article img', probe: true, settle: 800, expect: { open: true } },
  { name: 'zoom-in', do: 'mouse', selector: IMG, frac: [0.3, 0.25], probe: true, expect: { open: true, zoomed: true, imgWidth: 4000, imgHeight: 3000, fx: near(0.3), fy: near(0.25) } },
  { name: 'zoom-in-screenshot', do: 'wait', ms: 100, screenshot: true },
  { name: 'all-edges-reachable', do: 'lbReach', expect: { topLeft: true, bottomRight: true, scrollable: true } },
  { name: 'scrollbar-click-keeps', do: 'mouse', selector: STAGE, frac: [0.998, 0.5], probe: true, expect: { open: true, zoomed: true } },

  // drag pans by the dragged distance; the release is not a click
  { name: 'drag-pans', do: 'mouse', selector: STAGE, frac: [0.6, 0.6], drag: [-300, -200], probe: true, expect: { open: true, zoomed: true, dScrollLeft: near(300, 2), dScrollTop: near(200, 2) } },
  { name: 'drag-screenshot', do: 'wait', ms: 100, screenshot: true },
  { name: 'click-zooms-out', do: 'mouse', selector: STAGE, frac: [0.5, 0.5], probe: true, expect: { open: true, zoomed: false, fits: true, scrollLeft: 0, scrollTop: 0 } },

  // near a corner the point cannot stay put; the view stops at the image's edge instead
  { name: 'zoom-lower-right', do: 'mouse', selector: IMG, frac: [0.7, 0.75], probe: true, expect: { zoomed: true, fx: near(0.7), fy: near(0.75) } },
  { name: 'zoom-out-2', do: 'mouse', selector: STAGE, frac: [0.5, 0.5], probe: true, expect: { zoomed: false } },
  { name: 'zoom-top-left-corner', do: 'mouse', selector: IMG, frac: [0.02, 0.02], probe: true, expect: { zoomed: true, scrollLeft: 0, fy: near(0.02) } },
  // then Esc
  { name: 'esc-closes', do: 'keys', keys: ['Escape'] },
  { name: 'esc-closed', do: 'lbState', expect: { open: false } },

  // the user's photo from a chat record
  { name: 'real-open', do: 'open', path: REAL_MD, requires: REAL_MD, expect: { 'view.error': null } },
  { name: 'real-scroll', do: 'scrollTo', selector: REAL_IMG, requires: REAL_MD },
  { name: 'real-wait', do: 'wait', ms: 800, requires: REAL_MD },
  { name: 'real-click', do: 'mouse', selector: `.doc-root.active ${REAL_IMG}`, probe: true, settle: 1500, requires: REAL_MD, expect: { open: true, fits: true } },
  { name: 'real-zoom-head', do: 'mouse', selector: IMG, frac: [0.5, 0.08], probe: true, requires: REAL_MD, expect: { zoomed: true, fx: near(0.5), fy: near(0.08) }, screenshot: true },
  { name: 'real-edges', do: 'lbReach', requires: REAL_MD, expect: { topLeft: true, bottomRight: true } },
  { name: 'real-zoom-out', do: 'mouse', selector: STAGE, frac: [0.5, 0.5], probe: true, requires: REAL_MD, expect: { zoomed: false, fits: true } },
  { name: 'real-backdrop-closes', do: 'mouse', selector: STAGE, frac: [0.02, 0.5], probe: true, requires: REAL_MD, expect: { open: false } },
];

const spec = { outDir: 'test/output/selftest-lightbox', steps };
fs.writeFileSync(path.join(root, 'test', 'selftest', 'lightbox.json'), JSON.stringify(spec, null, 1) + '\n');
console.log(`lightbox spec: ${steps.length} steps`);
