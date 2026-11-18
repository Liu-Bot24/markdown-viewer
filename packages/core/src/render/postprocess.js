// DOM post-processing of sanitized document HTML. Pure DOM work (no Electron),
// so it runs unchanged under jsdom in tests.
//
// Class conventions:
//   .mdv-ui      UI we add (buttons): never searched, never copied
//   .mdv-chrome  chat-view decorations: shown only in chat view, searched only there

import { resolveHref, resolveResourceSrc, mediaKind, toLocalResourceUrl, isMarkdownPath, pathKey } from '../shared/paths.js';
import { parseMessageHeading, parseSenderLine, headerSelfId, isMessageAnchor } from '../shared/chat.js';

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const CHUNK_MIN_CHILDREN = 300;

function el(doc, tag, cls, text) {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function hashHue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

export function weekday(date) {
  const d = new Date(date + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? '' : WEEKDAYS[d.getDay()];
}

function resolveResources(root, filePath) {
  for (const img of root.querySelectorAll('img[src]')) {
    const orig = img.getAttribute('src');
    const r = resolveResourceSrc(orig, filePath);
    if (r && r !== orig) {
      img.setAttribute('data-mdv-orig', orig);
      img.setAttribute('src', r);
    }
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
  }
  for (const m of root.querySelectorAll('video[src], audio[src], source[src], video[poster]')) {
    for (const attr of ['src', 'poster']) {
      const v = m.getAttribute(attr);
      if (!v) continue;
      const r = resolveResourceSrc(v, filePath);
      if (r && r !== v) m.setAttribute(attr, r);
    }
  }
}

function classifyLinks(root, filePath) {
  let refs = 0;
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    const r = resolveHref(href, filePath);
    a.setAttribute('data-mdv-kind', r.kind);
    if (r.kind === 'external' && !a.title) a.title = href;
    if (r.kind !== 'local') continue;
    const c = r.candidates[0];
    const media = mediaKind(c.path);
    if (media) a.setAttribute('data-mdv-media', media);
    if (isMarkdownPath(c.path) || r.candidates.some((x) => isMarkdownPath(x.path))) a.setAttribute('data-mdv-md', '1');
    const anchor = r.candidates.find((x) => isMessageAnchor(x.anchor));
    if (anchor) {
      a.classList.add('mdv-ref');
      refs++;
    }
    if (!a.title) a.title = c.path + (c.anchor ? '#' + c.anchor : '');
  }
  return refs;
}

/** Turn local media links into inline previews (images, video with poster, audio). */
function inlineMedia(root, filePath) {
  const doc = root.ownerDocument;
  const shown = new Map(); // scope element -> Set of lower-case paths
  let count = 0;
  for (const a of root.querySelectorAll('a[data-mdv-media]')) {
    if (a.closest('h1,h2,h3,h4,h5,h6,.mdv-media') || a.hasAttribute('data-mdv-consumed')) continue;
    const r = resolveHref(a.getAttribute('href'), filePath);
    const p = r.candidates[0].path;
    const kind = a.getAttribute('data-mdv-media');
    const url = toLocalResourceUrl(p, { preview: kind === 'image' });
    const li = a.closest('li');
    // "预览" sub-links repeat or complement the main media link; use them as posters.
    let poster = null;
    if (li) {
      for (const sub of li.querySelectorAll(':scope > ul > li > a[data-mdv-media="image"]')) {
        if (sub.textContent.trim() === '预览') {
          const sp = resolveHref(sub.getAttribute('href'), filePath).candidates[0].path;
          if (kind === 'video' && !poster) poster = toLocalResourceUrl(sp, { preview: true });
          if (kind === 'video' || pathKey(sp) === pathKey(p)) sub.setAttribute('data-mdv-consumed', '1');
        }
      }
    }
    // De-duplicate within one list item tree (a message's attachment list), not
    // across the document: the same file can legitimately appear in many messages.
    let scope = li || a.parentElement;
    for (let up = scope && scope.parentElement && scope.parentElement.closest('li'); up; up = up.parentElement && up.parentElement.closest('li')) scope = up;
    if (!shown.has(scope)) shown.set(scope, new Set());
    const seen = shown.get(scope);
    const key = pathKey(p);
    if (seen.has(key)) continue;
    seen.add(key);

    const box = el(doc, 'span', 'mdv-media mdv-media-' + kind);
    box.setAttribute('data-path', p);
    if (kind === 'image') {
      const img = el(doc, 'img', 'mdv-inline-img');
      img.setAttribute('src', url);
      img.setAttribute('alt', a.textContent);
      img.setAttribute('loading', 'lazy');
      img.setAttribute('decoding', 'async');
      box.appendChild(img);
    } else if (kind === 'video') {
      const v = el(doc, 'video', 'mdv-inline-video');
      v.setAttribute('controls', '');
      v.setAttribute('preload', poster ? 'none' : 'metadata');
      if (poster) v.setAttribute('poster', poster);
      v.setAttribute('src', url);
      box.appendChild(v);
    } else {
      const au = el(doc, 'audio', 'mdv-inline-audio');
      au.setAttribute('controls', '');
      au.setAttribute('preload', 'none');
      au.setAttribute('src', url);
      box.appendChild(au);
    }
    a.after(box);
    count++;
  }
  return count;
}

function decorateCode(root) {
  const doc = root.ownerDocument;
  for (const pre of root.querySelectorAll('pre.hljs')) {
    const b = el(doc, 'span', 'mdv-ui mdv-copy', '复制');
    b.setAttribute('role', 'button');
    b.title = '复制代码';
    pre.prepend(b);
  }
}

function wrapTables(root) {
  const doc = root.ownerDocument;
  for (const t of root.querySelectorAll('table')) {
    if (t.parentElement && t.parentElement.classList.contains('mdv-table-wrap')) continue;
    const w = el(doc, 'div', 'mdv-table-wrap');
    t.before(w);
    w.appendChild(t);
  }
}

function isMessageStart(node) {
  if (node.tagName !== 'P' || node.childElementCount !== 1) return false;
  const a = node.firstElementChild;
  return a.tagName === 'A' && isMessageAnchor(a.id) && node.textContent.trim() === '';
}

/**
 * Wrap each archive message into <section class="mdv-msg"> and add chat-view
 * decorations. Returns { days, messages, selfCandidate }.
 */
function groupChat(root, selfIds, sessionName) {
  const doc = root.ownerDocument;
  const sections = [];
  let cur = null;
  for (const node of Array.from(root.children)) {
    if (isMessageStart(node)) {
      cur = el(doc, 'section', 'mdv-msg');
      cur.setAttribute('data-msg-id', node.firstElementChild.id);
      node.classList.add('mdv-msg-anchor');
      node.before(cur);
      cur.appendChild(node);
      sections.push(cur);
      continue;
    }
    if (cur && !/^(H1|H2|HR)$/.test(node.tagName) && !node.classList.contains('footnotes')) {
      cur.appendChild(node);
      continue;
    }
    cur = null;
  }

  const days = [];
  const idNames = new Map();
  let lastDate = null;
  for (const s of sections) {
    const h = s.querySelector(':scope > h3');
    const info = h ? parseMessageHeading(h.textContent) : null;
    if (!info) continue;
    s.setAttribute('data-date', info.date);
    s.setAttribute('data-type', info.type);
    h.classList.add('mdv-msg-h');
    let senderId = '';
    const meta = h.nextElementSibling;
    if (meta && meta.tagName === 'P' && meta.textContent.startsWith('发送者：')) {
      meta.classList.add('mdv-msg-meta');
      const sl = parseSenderLine(meta.textContent);
      if (sl) senderId = sl.senderId;
    }
    s.setAttribute('data-sender-id', senderId);
    if (senderId && !idNames.has(senderId)) idNames.set(senderId, info.sender);
    const body = s.querySelector(':scope > blockquote');
    if (body) body.classList.add('mdv-msg-body');
    for (const ul of s.querySelectorAll(':scope > ul')) ul.classList.add('mdv-msg-attach');
    if (info.type === '系统消息') s.classList.add('mdv-msg-system');
    if (senderId && selfIds.has(senderId)) s.classList.add('mdv-self');

    const head = el(doc, 'div', 'mdv-chrome mdv-msg-head');
    const av = el(doc, 'span', 'mdv-avatar', Array.from(info.sender)[0] || '?');
    av.style.setProperty('--hue', String(hashHue(senderId || info.sender)));
    head.append(av, el(doc, 'span', 'mdv-msg-sender', info.sender), el(doc, 'span', 'mdv-msg-time', info.time));
    if (info.type !== '文本') head.append(el(doc, 'span', 'mdv-msg-type', info.type));
    h.before(head);

    if (info.date !== lastDate) {
      const sep = el(doc, 'div', 'mdv-chrome mdv-day', `${info.date} ${weekday(info.date)}`);
      sep.setAttribute('data-date', info.date);
      s.before(sep);
      days.push({ date: info.date, count: 0, first: s });
      lastDate = info.date;
    }
    days[days.length - 1].count++;
  }

  // Learn which id is "me": the header's "我：" line when there is one; otherwise, in a
  // one-to-one chat, the other party's display name matches the session name in the title.
  let selfCandidate = null;
  for (const node of root.children) {
    if (node.tagName === 'SECTION') break;
    if (node.tagName === 'P' && (selfCandidate = headerSelfId(node.textContent) || null)) break;
  }
  if (!selfCandidate && idNames.size === 2) {
    const h1 = root.querySelector('h1');
    const session = sessionName || (h1 ? h1.textContent.split(' · ')[0].trim() : '');
    const ids = [...idNames.keys()];
    const names = ids.map((i) => idNames.get(i));
    if (session && names[0] === session && names[1] !== session) selfCandidate = ids[1];
    else if (session && names[1] === session && names[0] !== session) selfCandidate = ids[0];
  }
  return { days, messages: sections.length, selfCandidate };
}

/** Group top-level children into content-visibility chunks so huge documents lay out lazily. */
function chunkify(root, size) {
  const kids = Array.from(root.children);
  if (kids.length < CHUNK_MIN_CHILDREN) return 0;
  const doc = root.ownerDocument;
  let chunk = null;
  let n = 0;
  let chunks = 0;
  for (const k of kids) {
    if (!chunk || n >= size) {
      chunk = el(doc, 'div', 'mdv-chunk');
      k.before(chunk);
      n = 0;
      chunks++;
    }
    chunk.appendChild(k);
    n++;
  }
  return chunks;
}

/**
 * Apply all transforms. ctx: { filePath, isChat, inlineMedia, selfIds:Set, chunk:boolean, sessionName? }
 */
export function postprocess(root, ctx) {
  const t0 = Date.now();
  const stages = {};
  let ts = t0;
  const lap = (k) => {
    const now = Date.now();
    stages[k] = now - ts;
    ts = now;
  };
  resolveResources(root, ctx.filePath);
  lap('resources');
  const refs = classifyLinks(root, ctx.filePath);
  lap('links');
  const media = ctx.inlineMedia !== false ? inlineMedia(root, ctx.filePath) : 0;
  lap('media');
  decorateCode(root);
  wrapTables(root);
  lap('code');
  const chat = ctx.isChat ? groupChat(root, ctx.selfIds || new Set(), ctx.sessionName) : null;
  lap('chat');
  const chunks = ctx.chunk === false ? 0 : chunkify(root, ctx.isChat ? 40 : 60);
  lap('chunks');
  return {
    stages,
    refs,
    media,
    chunks,
    chat,
    mermaid: Array.from(root.querySelectorAll('pre.mdv-mermaid')),
    ms: Date.now() - t0,
  };
}

/** Mark a learned self id on an already processed document. */
export function applySelfId(root, id) {
  for (const s of root.querySelectorAll(`section.mdv-msg[data-sender-id="${id.replace(/"/g, '\\"')}"]`)) s.classList.add('mdv-self');
}
