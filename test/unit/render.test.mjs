// Render the sample set through the real pipeline and check the hard cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderFile, renderDoc, FIXTURES, isFile } from './helpers.mjs';
import { localResourceUrlToPath, resolveHref } from '../../packages/core/src/shared/paths.js';

const $$ = (root, sel) => Array.from(root.querySelectorAll(sel));
const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();

test('CommonMark basics', () => {
  const { root, headings } = renderFile('gfm/01-commonmark.md');
  assert.equal(root.querySelector('h1').textContent, 'Setext 一级标题');
  assert.equal(root.querySelectorAll('h2')[0].textContent, 'Setext 二级标题');
  // duplicate headings get GitHub-style suffixes
  const ids = headings.filter((h) => h.text === '重复标题').map((h) => h.id);
  assert.deepEqual(ids, ['重复标题', '重复标题-1']);
  assert.ok(root.querySelector('#中文-标题带标点'));
  assert.ok(!root.innerHTML.includes('<em>case</em>'), 'snake_case must not become emphasis');
  assert.match(root.innerHTML, /\*not em\*/);
  assert.match(text(root), /& © © 中/);
  assert.equal($$(root, 'br').length, 2);
  assert.ok(root.querySelector('pre code').textContent.includes('<b>not html</b>'));
  assert.equal(root.querySelector('ol[start="7"]') !== null, true);
  assert.equal(root.querySelector('a[href="https://example.com/ref1"]').title, 'Ref Title');
  assert.ok(root.querySelector('a[href="https://example.com/shortcut"]'));
  assert.ok(root.querySelector('blockquote blockquote'));
  assert.ok(root.querySelector('div[align="center"] strong'));
  assert.ok(root.querySelector('kbd') && root.querySelector('sub') && root.querySelector('sup'));
  assert.equal(root.querySelector('span[style]').getAttribute('style'), 'color: #c00');
});

test('emphasis closes next to CJK punctuation', () => {
  const strong = (s) => $$(renderDoc(s, 'D:\\x.md').root, 'strong').map((e) => e.textContent);
  assert.deepEqual(strong('- **11月先保住健康与交付安排。**你计划11月初抽血'), ['11月先保住健康与交付安排。']);
  assert.deepEqual(strong('**★ 落实11月复查。**确认预约'), ['★ 落实11月复查。']);
  assert.deepEqual(strong('他说**“先停用”**然后'), ['“先停用”']);
  assert.deepEqual(strong('**结论**。正文'), ['结论']);
  // non-CJK text keeps the CommonMark rule, and unpaired markers stay literal
  assert.deepEqual(strong('**Note.**Then'), []);
  assert.deepEqual(strong('**未闭合的星号。正文'), []);
  assert.ok(!renderDoc('snake_case_name', 'D:\\x.md').html.includes('<em>'));
});

test('GFM: tables, task lists, strikethrough, autolinks, footnotes, alerts', () => {
  const { root } = renderFile('gfm/02-gfm.md');
  const tables = $$(root, 'table');
  assert.equal(tables.length, 2, 'the pipe lines without a delimiter row are not a table');
  assert.ok(tables.every((t) => t.parentElement.classList.contains('mdv-table-wrap')));
  const aligns = $$(tables[0], 'th').map((th) => th.getAttribute('style'));
  assert.deepEqual(aligns, ['text-align:left', 'text-align:center', 'text-align:right', null]);
  assert.equal(tables[0].querySelector('code').textContent, 'x | y');
  assert.ok(tables[0].querySelector('s'));

  const boxes = $$(root, 'input.task-list-item-checkbox');
  assert.equal(boxes.length, 6);
  assert.ok(boxes.every((b) => b.hasAttribute('disabled')));
  assert.equal(boxes.filter((b) => b.hasAttribute('checked')).length, 3);
  assert.ok(text(root).includes('[ ]不是任务'));

  assert.equal($$(root, 's').length >= 3, true);
  const hrefs = $$(root, 'a').map((a) => a.getAttribute('href'));
  assert.ok(hrefs.includes('http://www.example.com'));
  assert.ok(hrefs.includes('https://example.com/path_(with)_parens'));
  assert.ok(hrefs.includes('mailto:foo@bar.example.com'));
  assert.ok(!hrefs.some((h) => /readme\.md|archive\.tar|图片\.png|%E6%9C%88%E6%8A%A5/.test(h || '')), 'file names must stay text');
  assert.ok(hrefs.includes('https://example.com/a'), 'trailing CJK punctuation is not part of the URL');

  assert.equal($$(root, 'sup.footnote-ref').length, 3);
  assert.equal($$(root, '.footnotes li').length, 2);
  assert.equal($$(root, '.markdown-alert').length, 3);
  assert.ok(root.querySelector('.markdown-alert-warning .markdown-alert-title svg'));
});

test('code highlighting, KaTeX, Mermaid placeholders', () => {
  const { root } = renderFile('gfm/03-code-math-mermaid.md');
  assert.ok(root.querySelector('pre[data-lang="js"] .hljs-keyword'));
  assert.ok(root.querySelector('pre[data-lang="python"] .hljs-title'));
  assert.ok(root.querySelector('pre[data-lang="unknownlang"] code').textContent.includes('<b>not bold</b>'));
  assert.ok($$(root, 'pre.hljs').every((p) => p.querySelector('.mdv-copy.mdv-ui')));
  assert.ok($$(root, '.katex').length >= 4);
  assert.ok(root.querySelector('.katex-display'));
  assert.ok(root.querySelector('.mdv-math-block .katex-display'), '```math fences render as display math');
  assert.match(text(root), /价格 \$5 到 \$10 之间/);
  assert.equal($$(root, 'pre.mdv-mermaid').length, 3);
});

test('raw HTML is sanitised', () => {
  const { root, html } = renderFile('gfm/04-html-security.md');
  assert.ok(root.querySelector('details > summary b'));
  assert.ok(root.querySelector('details strong'));
  assert.ok(root.querySelector('p[align="right"]'));
  assert.equal($$(root, 'script, iframe, style, form, object, embed, button, textarea').length, 0);
  assert.ok(!/\son\w+=|(href|src)="javascript:/i.test(html), 'no event handlers or javascript: URLs');
  assert.ok(text(root).includes('[markdown javascript 链接](javascript:window.__pwned=4)'), 'rejected link stays literal text');
  assert.ok(root.querySelector('svg circle'));
  assert.ok(root.querySelector('div[style]'));
  const inputs = $$(root, 'input');
  assert.ok(inputs.every((i) => i.type === 'checkbox' && i.hasAttribute('disabled')));
  assert.ok(root.querySelector('math mi'));
  assert.ok(text(root).includes('正常文本结束'));
});

test('front matter becomes metadata, not content', () => {
  const { root, headings } = renderFile('gfm/05-front-matter.md');
  const fm = root.querySelector('details.mdv-frontmatter');
  assert.ok(fm && fm.textContent.includes('title: 带 Front Matter 的文档'));
  assert.equal(headings[0].text, '正文标题');
  assert.equal($$(root, 'hr').length, 1);
});

test('images and links: relative, Chinese, spaces, angle brackets, emoji, encoded', () => {
  const r = renderFile('gfm/06-images-links.md');
  const imgs = $$(r.root, 'img:not(.mdv-inline-img)');
  const local = imgs.filter((i) => i.getAttribute('src').startsWith('mdvfile:'));
  assert.equal(local.length, 7);
  for (const i of local) {
    const p = localResourceUrlToPath(i.getAttribute('src'));
    if (i.getAttribute('alt') === 'missing') assert.ok(!isFile(p));
    else assert.ok(isFile(p), 'image should resolve to an existing file: ' + p);
    assert.equal(i.getAttribute('loading'), 'lazy');
  }
  assert.ok(imgs.some((i) => i.getAttribute('src').startsWith('https://')));
  const links = Object.fromEntries($$(r.root, 'li > a').map((a) => [a.textContent, a]));
  const resolveFirstFile = (a) => {
    const res = resolveHref(a.getAttribute('href'), r.path);
    return res.candidates.find((c) => isFile(c.path)) || null;
  };
  assert.equal(links['同目录文档'].dataset.mdvKind, 'local');
  assert.equal(resolveFirstFile(links['文档加锚点']).anchor, '第二节');
  const hashDir = resolveFirstFile(links['尖括号带空格和锚点']);
  assert.ok(hashDir.path.endsWith('sub#dir\\inner file.md'));
  assert.equal(hashDir.anchor, '目标-标题');
  assert.equal(links['本文锚点'].dataset.mdvKind, 'anchor');
  assert.equal(resolveFirstFile(links['不存在的文件']), null);
  assert.equal(links['外部链接'].dataset.mdvKind, 'external');
  assert.equal(links['媒体链接：图片'].dataset.mdvMedia, 'image');
  assert.ok(links['媒体链接：图片'].nextElementSibling.classList.contains('mdv-media'));

  // heading anchors used by the links exist in the targets
  const other = renderFile('gfm/other.md');
  assert.ok(other.root.querySelector('#第二节'));
  const inner = renderFile('gfm/sub#dir/inner file.md');
  assert.ok(inner.root.querySelector('#目标-标题'));
});

test('archive chat document: message grouping, media, chat-view decorations', () => {
  const rel = 'wechat/聊天记录归档/01_个人私聊/测试 联系人🍎/聊天记录/2026-09_001.md';
  const r = renderFile(rel);
  assert.equal(r.isChat, true);
  const secs = $$(r.root, 'section.mdv-msg');
  assert.equal(secs.length, 12);
  assert.ok(secs.every((s) => s.querySelector('a[id^="msg-"]') && s.querySelector('h3')));
  assert.equal(r.pp.chat.days.length, 2);
  assert.deepEqual(r.pp.chat.days.map((d) => d.count), [8, 4]);
  assert.equal(r.pp.chat.selfCandidate, 'wxid_testself001');
  // original rendering is intact: heading text, sender line, quote body
  const s2 = secs[1];
  assert.equal(s2.querySelector('h3').textContent, '2026-09-01 10:01:05 · 我自己 · 文本');
  assert.ok(s2.querySelector('.mdv-msg-meta').textContent.startsWith('发送者：wxid_testself001'));
  assert.ok(s2.querySelector('blockquote').textContent.includes('第二行，带 *星号* 和 _下划线_ 和 [方括号]'));
  assert.equal(s2.querySelectorAll('.katex').length, 0, 'no math in chat archives');
  assert.ok(s2.querySelector('blockquote p').textContent.includes('\n'), 'soft breaks preserved for chat view');
  // media
  const kinds = secs.map((s) => [...s.querySelectorAll('.mdv-media')].map((m) => m.className.replace('mdv-media mdv-media-', '')).join(','));
  assert.deepEqual(kinds.slice(2, 8), ['image', 'image', 'video', 'audio', '', 'video']);
  const video = secs[4].querySelector('video');
  assert.ok(video.getAttribute('poster').includes('%E9%A2%84%E8%A7%88'), 'video uses its 预览 image as poster');
  assert.ok(secs[3].querySelector('a[data-mdv-consumed]'), 'duplicate 预览 link of a preview-only image is folded');
  for (const m of $$(r.root, '.mdv-media')) {
    const p = m.dataset.path;
    if (p.includes('缺失')) assert.ok(!isFile(p));
    else assert.ok(isFile(p), 'media file should exist: ' + p);
  }
  assert.ok(secs[8].classList.contains('mdv-msg-system'));
  // entities and escapes in archive text
  assert.ok(text(secs[11]).includes('utm_term=a&utm_user=b'));
  assert.ok(text(secs[11]).includes('<_wc_custom_link_ href="x">不是标签</_wc_custom_link_>'));
  assert.equal(secs[11].querySelectorAll('a[href^="https://item.example.com"]').length, 1);
});

test('monthly report: every reference link resolves (or fails as intended)', () => {
  const r = renderFile('wechat/聊天记录月报/2026-09/月报_2026-09.md');
  const refs = $$(r.root, 'a.mdv-ref');
  assert.ok(refs.length >= 12);
  const outcomes = refs.map((a) => {
    const res = resolveHref(a.getAttribute('href'), r.path);
    const c = res.candidates.find((x) => isFile(x.path));
    if (!c) return [a.textContent, 'nofile'];
    const target = fs.readFileSync(c.path, 'utf8');
    return [a.textContent, target.includes(`<a id="${c.anchor}"></a>`) ? 'ok' : 'noanchor'];
  });
  const bad = outcomes.filter(([, o]) => o !== 'ok');
  assert.deepEqual(bad, [
    ['#9', 'nofile'],
    ['#10', 'noanchor'],
  ]);
  assert.equal($$(r.root, 'input.task-list-item-checkbox').length, 2);
  assert.ok(r.root.querySelector('.mdv-table-wrap table a.mdv-ref'));
});

test('file:/// fallback links (generated fixture)', { skip: !fs.existsSync(path.join(FIXTURES, 'large', 'file-url-links.md')) && 'run npm run fixtures:large' }, () => {
  const r = renderFile('large/file-url-links.md');
  const links = $$(r.root, 'a.mdv-ref');
  assert.equal(links.length, 4);
  for (const a of links) {
    const res = resolveHref(a.getAttribute('href'), r.path);
    const c = res.candidates.find((x) => isFile(x.path));
    assert.ok(c, 'resolves: ' + a.getAttribute('href'));
    assert.match(c.anchor, /^msg-/);
  }
});

test('large documents parse quickly and get chunked', { skip: !fs.existsSync(path.join(FIXTURES, 'large', 'big-generic.md')) && 'run npm run fixtures:large' }, () => {
  const g = renderFile('large/big-generic.md');
  assert.ok(g.pp.chunks > 50, 'chunked: ' + g.pp.chunks);
  assert.ok(g.parseMs < 5000, 'parse ms ' + g.parseMs);
  const c = renderFile('large/big-chat.md');
  assert.equal(c.pp.chat.messages, 9000);
  assert.ok(c.pp.chunks > 100);
});

test('empty and odd inputs do not crash', () => {
  for (const s of ['', '\uFEFF# BOM 标题', '\r\n\r\n# CRLF\r\n\r\ntext\r\n', '<a id="msg-1"></a>', '[x](<>)', '![](<>)', '| a |\n| - |', '```\nunclosed fence']) {
    const r = renderDoc(s, 'D:\\x\\y.md');
    assert.ok(typeof r.html === 'string');
  }
  assert.equal(renderDoc('\uFEFF# BOM 标题', 'D:\\x.md').headings[0].text, 'BOM 标题');
});
