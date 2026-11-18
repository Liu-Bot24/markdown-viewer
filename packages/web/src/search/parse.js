// Split a Markdown file into searchable rows: one per chat message for chat
// documents (same recognition rules as the renderer), one per heading section otherwise.
import GithubSlugger from 'github-slugger';
import { isChatMarkdown, markdownTitle, parseMessageHeading, parseSenderLine } from '../../../core/src/shared/chat.js';

const ANCHOR_RE = /^<a id="(msg-[0-9a-zA-Z]+)"><\/a>\s*$/;
const LINK_ONLY_RE = /^\s*[-*+]\s+\[[^\]]*\]\([^)]*\)\s*(（[^）]*）)?\s*$/;

/** Visible text of Markdown body lines: quotes unwrapped, escapes removed, link targets dropped. */
export function plainText(lines) {
  const out = [];
  for (let line of lines) {
    if (LINK_ONLY_RE.test(line)) continue;
    line = line.replace(/^\s*>\s?/, '').replace(/^\s*[-*+]\s+/, '').trim();
    if (!line) continue;
    line = line
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/\\([\\`*_{}[\]()#+\-.!|~<>$&])/g, '$1');
    if (line) out.push(line);
  }
  return out.join('\n');
}

/**
 * Returns { kind: 'chat'|'doc', title, rows: [{ anchor, ts, sender, senderId, type, text }] }.
 */
export function parseMarkdown(text) {
  const title = markdownTitle(text);
  const lines = text.split(/\r?\n/);
  if (isChatMarkdown(text)) return { kind: 'chat', title, rows: chatRows(lines) };
  return { kind: 'doc', title, rows: docRows(lines, title) };
}

function chatRows(lines) {
  const rows = [];
  let cur = null;
  let body = [];
  const flush = () => {
    if (cur) {
      cur.text = plainText(body);
      rows.push(cur);
    }
    cur = null;
    body = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const a = ANCHOR_RE.exec(lines[i]);
    if (a && i + 1 < lines.length && lines[i + 1].startsWith('### ')) {
      const h = parseMessageHeading(lines[i + 1].slice(4));
      if (h) {
        flush();
        cur = { anchor: a[1], ts: `${h.date} ${h.time.length === 5 ? h.time + ':00' : h.time}`, sender: h.sender, senderId: '', type: h.type, text: '' };
        i++;
        continue;
      }
    }
    if (!cur) continue;
    if (/^#{1,2} /.test(lines[i])) {
      flush();
      continue;
    }
    if (!body.length && !lines[i].trim()) continue; // blank lines before the body
    if (!body.length && !cur.senderId) {
      const s = parseSenderLine(lines[i]);
      if (s) {
        cur.senderId = s.senderId;
        continue;
      }
    }
    body.push(lines[i]);
  }
  flush();
  return rows;
}

function docRows(lines, title) {
  const slugger = new GithubSlugger();
  const rows = [];
  let cur = { anchor: '', ts: '', sender: title, senderId: '', type: '文档', text: '' };
  let body = [];
  let fence = null;
  const flush = () => {
    cur.text = plainText(body);
    if (cur.text || cur.anchor) rows.push(cur);
    body = [];
  };
  for (const line of lines) {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      body.push(line.replace(/^\s*(```+|~~~+).*/, ''));
      continue;
    }
    const m = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      flush();
      const heading = m[2].replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '');
      cur = { anchor: slugger.slug(heading), ts: '', sender: heading, senderId: '', type: '文档', text: '' };
      body = [heading];
      continue;
    }
    body.push(line);
  }
  flush();
  return rows;
}
