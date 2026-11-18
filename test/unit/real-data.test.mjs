// Checks against real (read-only) chat record files (MDV_ARCHIVE) and documents that
// reference them (MDV_REPORTS). Skipped when unset or missing. Nothing is copied or written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderDoc, isFile } from './helpers.mjs';
import { resolveHref } from '../../packages/core/src/shared/paths.js';
import { parseMessageHeading } from '../../packages/core/src/shared/chat.js';
import { pickChatFiles, listReports } from '../real-samples.mjs';

const ARCHIVE = process.env.MDV_ARCHIVE || '';
const REPORTS = process.env.MDV_REPORTS || '';
const hasArchive = !!ARCHIVE && fs.existsSync(ARCHIVE);

const reportFiles = () => listReports(REPORTS);

const textCache = new Map();
function read(p) {
  if (!textCache.has(p)) textCache.set(p, fs.readFileSync(p, 'utf8'));
  return textCache.get(p);
}

for (const report of reportFiles()) {
  test(`real report: every reference resolves to an existing message (${path.basename(path.dirname(report))}/${path.basename(report)})`, { skip: !hasArchive && 'archive missing' }, () => {
    const r = renderDoc(read(report), report);
    const refs = Array.from(r.root.querySelectorAll('a.mdv-ref'));
    assert.ok(refs.length > 0);
    const problems = [];
    for (const a of refs) {
      const res = resolveHref(a.getAttribute('href'), report);
      const c = res.candidates.find((x) => isFile(x.path));
      if (!c) {
        problems.push(['nofile', res.candidates[0].path]);
        continue;
      }
      if (!read(c.path).includes(`<a id="${c.anchor}"></a>`)) problems.push(['noanchor', c.path + '#' + c.anchor]);
    }
    if (problems.length) console.log(`${report}: ${problems.length}/${refs.length} unresolved`, problems.slice(0, 5));
    assert.equal(problems.length, 0, `${problems.length} of ${refs.length} references do not resolve`);
  });
}

test('real archive chats: messages, headings and media links survive rendering', { skip: !hasArchive && 'archive missing' }, () => {
  const files = pickChatFiles(ARCHIVE).map((x) => x.path);
  assert.ok(files.length >= 8, 'sample size ' + files.length);
  const stats = { files: 0, messages: 0, media: 0, missingMedia: [], badHeadings: [] };
  for (const p of files) {
    const text = read(p);
    const r = renderDoc(text, p);
    assert.equal(r.isChat, true, 'detected as chat: ' + p);
    const anchors = (text.match(/^<a id="msg-[0-9a-zA-Z]+"><\/a>$/gm) || []).length;
    const secs = r.root.querySelectorAll('section.mdv-msg');
    assert.equal(secs.length, anchors, 'one section per message: ' + p);
    for (const s of secs) {
      const h = s.querySelector('h3');
      if (!h || !parseMessageHeading(h.textContent)) stats.badHeadings.push(p + ' :: ' + (h ? h.textContent : '(none)'));
    }
    for (const m of r.root.querySelectorAll('.mdv-media')) {
      stats.media++;
      if (!isFile(m.dataset.path)) stats.missingMedia.push(m.dataset.path);
    }
    // every media link (image/video/voice) in the raw text produced a preview or was a duplicate 预览 link
    const mediaLinks = (text.match(/^\s*- \[(?:转发条目 \d+ · )?(?:image|video|voice) · m_/gm) || []).length;
    assert.ok(r.root.querySelectorAll('.mdv-media').length >= mediaLinks * 0.95 - 1, `media previews for ${p}`);
    assert.equal(r.root.querySelectorAll('script, iframe').length, 0);
    stats.files++;
    stats.messages += secs.length;
  }
  console.log(`real archive sample: ${stats.files} files, ${stats.messages} messages, ${stats.media} media, ${stats.missingMedia.length} missing media files, ${stats.badHeadings.length} unparsed headings`);
  if (stats.missingMedia.length) console.log('missing media examples:', stats.missingMedia.slice(0, 3));
  assert.equal(stats.badHeadings.length, 0, stats.badHeadings.slice(0, 3).join('\n'));
});
