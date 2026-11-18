// Helpers for WeChat archive chat documents:
//   <a id="msg-…"></a>
//   ### 2019-12-18 15:30:54 · 测试甲 · 文本
//   发送者：wxid_… · 消息：message\message_6.db:35
//   > body
// Sender names may themselves contain " · ", so the type is the last field and
// the time the first; everything between is the sender.

export const MSG_ANCHOR_PREFIX = '<a id="msg-';
const CHAT_PROBE_RE = /^<a id="msg-[0-9a-zA-Z]+"><\/a>\r?\n### \d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})? · /m;
const TIME_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/;

/** Cheap check on raw Markdown: does this look like an archive chat export? */
export function isChatMarkdown(text) {
  return CHAT_PROBE_RE.test(text.length > 200000 ? text.slice(0, 200000) : text);
}

export function isMessageAnchor(id) {
  return /^msg-[0-9a-zA-Z]+$/.test(id || '');
}

/** Parse "time · sender · type" heading text. Returns null when it does not match. */
export function parseMessageHeading(text) {
  const parts = String(text).split(' · ');
  if (parts.length < 3) return null;
  const m = TIME_RE.exec(parts[0].trim());
  if (!m) return null;
  return {
    date: m[1],
    time: m[2],
    sender: parts.slice(1, -1).join(' · ').trim(),
    type: parts[parts.length - 1].trim(),
  };
}

/**
 * Parse the "发送者：wxid · 引用：msg-… · 提到：wxid,… · 消息：db:row" meta line.
 * The id is the first field; the rest are optional "名称：值" fields in any order.
 */
export function parseSenderLine(text) {
  const m = /^发送者：(.*)$/.exec(String(text).trim());
  if (!m) return null;
  const [id, ...rest] = m[1].split(' · ');
  const fields = {};
  for (const f of rest) {
    const i = f.indexOf('：');
    if (i > 0) fields[f.slice(0, i).trim()] = f.slice(i + 1).trim();
  }
  return { senderId: id.trim(), source: fields['消息'] || '', fields };
}

/** The "我：wxid" line from a chat document's header text, or ''. */
export function headerSelfId(text) {
  const m = /(?:^|\n)我：(\S+)/.exec(String(text));
  return m ? m[1] : '';
}

/** Document title (first ATX h1) of a Markdown text, or ''. */
export function markdownTitle(text) {
  const m = /^# (.+)$/m.exec(text.length > 4000 ? text.slice(0, 4000) : text);
  return m ? m[1].trim() : '';
}

/**
 * Cut the Markdown for `before` messages, the target message and `after` messages
 * around anchor id `msg-…`. Returns { found, markdown, title, index, count, hasBefore, hasAfter }.
 */
export function extractMessageWindow(text, anchorId, before = 4, after = 4) {
  const title = markdownTitle(text);
  const target = text.indexOf(`<a id="${anchorId}"`);
  if (target === -1) return { found: false, title, markdown: '', index: -1, count: 0 };
  const starts = [];
  for (let i = text.indexOf(MSG_ANCHOR_PREFIX); i !== -1; i = text.indexOf(MSG_ANCHOR_PREFIX, i + 1)) {
    if (i === 0 || text[i - 1] === '\n') starts.push(i);
  }
  let k = starts.indexOf(target);
  if (k === -1) {
    // Anchor exists but not at a line start (unusual): show just its surroundings.
    starts.push(target);
    starts.sort((a, b) => a - b);
    k = starts.indexOf(target);
  }
  const from = starts[Math.max(0, k - before)];
  let to;
  if (k + after + 1 < starts.length) to = starts[k + after + 1];
  else {
    // Last messages of the file: stop at the next h1/h2 section, if any.
    const tail = text.slice(starts[starts.length - 1]);
    const sec = /\n#{1,2} /.exec(tail);
    to = sec ? starts[starts.length - 1] + sec.index : text.length;
  }
  return {
    found: true,
    title,
    markdown: text.slice(from, to),
    index: k,
    count: starts.length,
    hasBefore: k - before > 0,
    hasAfter: k + after + 1 < starts.length,
  };
}
