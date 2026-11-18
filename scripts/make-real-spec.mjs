// Generate test/output/real.json: an end-to-end spec over the real (read-only) monthly
// reports and archive on this machine. The spec names real contacts, so it is written
// to the git-ignored output folder instead of being committed.
//
// usage: set MDV_REPORTS / MDV_ARCHIVE, then node scripts/make-real-spec.mjs (unset: empty spec)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickChatFiles, listReports } from '../test/real-samples.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORTS = process.env.MDV_REPORTS || '';
const ARCHIVE = process.env.MDV_ARCHIVE || '';
const out = path.join(root, 'test', 'output', 'real.json');

const steps = [];
const add = (s) => steps.push({ requires: s.path, ...s });

const reports = listReports(REPORTS);
reports.forEach((r, i) => {
  const tag = path.basename(r, '.md');
  add({ name: `${tag}-open`, do: 'open', path: r, expect: { 'view.error': null, openMs: { max: 3000 }, 'view.meta.refs': { min: 1 } }, screenshot: i === 0 });
  for (const index of [0, 'mid', -1]) {
    steps.push({ name: `${tag}-peek-${index}`, do: 'clickRef', index: index === 'mid' ? 'mid' : index, requires: r, expect: { peekOpen: true, targetShown: true, targetVisible: true }, screenshot: i === 0 && index === 0 });
  }
  if (i === 0) {
    steps.push({ name: `${tag}-open-here`, do: 'peekOpenHere', requires: r, expect: { anchorVisible: true, highlighted: true, historyLength: 2 }, screenshot: true });
    steps.push({ name: `${tag}-target-media`, do: 'media', requires: r, expect: { 'probe.missing.length': 0, 'visibleImages.broken.length': 0 } });
    steps.push({ name: `${tag}-back`, do: 'back', requires: r, expect: { historyIndex: 0, refVisible: true, refOffsetDelta: { max: 24 } }, screenshot: true });
  }
  steps.push({ name: `${tag}-close-peek`, do: 'closePeek' });
});

const chats = pickChatFiles(ARCHIVE);
const byMedia = [...chats].sort((a, b) => b.media - a.media)[0];
const bySize = [...chats].sort((a, b) => b.size - a.size)[0];
if (byMedia) {
  add({ name: 'chat-media-open', do: 'open', path: byMedia.path, expect: { 'view.error': null, 'view.chatView': true } });
  add({ name: 'chat-media-probe', do: 'media', path: byMedia.path, expect: { 'probe.missing.length': 0, 'visibleImages.broken.length': 0 } });
  steps.push({ name: 'chat-media-scroll-mid', do: 'scrollTo', fraction: 0.5, requires: byMedia.path });
  steps.push({ name: 'chat-media-mid-images', do: 'visibleImages', requires: byMedia.path, expect: { 'broken.length': 0 }, screenshot: true });
  steps.push({ name: 'chat-media-raw', do: 'setChatView', on: false, requires: byMedia.path, expect: { chatView: false }, screenshot: true });
  steps.push({ name: 'chat-view-on', do: 'setChatView', on: true });
}
if (bySize) {
  const anchor = bySize.anchors[Math.floor(bySize.anchors.length * 0.8)];
  add({ name: 'chat-largest-anchor', do: 'open', path: bySize.path, anchor, expect: { openMs: { max: 2500 }, anchorFound: true, anchorVisible: true, anchorHighlighted: true, 'view.meta.messages': bySize.anchors.length }, screenshot: true });
  add({ name: 'chat-largest-scroll', do: 'scrollPerf', steps: 30, path: bySize.path, expect: { p95Ms: { max: 120 } } });
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ outDir: 'test/output/selftest-real', steps }, null, 2));
console.log(`wrote ${out}: ${steps.length} steps (${reports.length} reports, ${chats.length} sampled chat files)`);
