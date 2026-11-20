// Finding the chat message an attachment belongs to. Pure functions only.
//
// A chat volume lives in "<conversation>/聊天记录/" and links each attachment by a
// URL-encoded path relative to that folder ("../图片/2026-08-09_…png"), under the
// message's anchor (<a id="msg-…">) and its "### date · name · type" heading.

const LINK_RE = /\]\(([^)\s]+)\)/g;
const ANCHOR_OPEN = '<a id="';

/** "2026-08" for a name that starts with a date ("2026-08-09_081211_图片_….png"), else null. */
export function monthOf(name) {
  const m = /^((?:19|20)\d\d-(?:0[1-9]|1[0-2]))-[0-3]\d/.exec(String(name));
  return m ? m[1] : null;
}

/** Volumes of month (or all volumes when month is null), in name order. */
export function volumesFor(names, month) {
  const md = names.filter((n) => /\.md$/i.test(n));
  const pick = month ? md.filter((n) => n.startsWith(month + '_')) : md;
  return pick.sort();
}

/**
 * Messages in a volume's text that link rel ("../图片/x.png", decoded, '/'-separated).
 * fold: compare ignoring case (Windows paths). Returns [{ anchor, date, sender }].
 */
export function attachmentRefs(text, rel, { fold = false } = {}) {
  const norm = (s) => (fold ? s.toLowerCase() : s);
  const want = norm(rel);
  const out = [];
  const seen = new Set();
  for (const m of text.matchAll(LINK_RE)) {
    let href;
    try {
      href = decodeURIComponent(m[1]);
    } catch {
      continue;
    }
    if (norm(href.replace(/\\/g, '/')) !== want) continue;
    const at = text.lastIndexOf(ANCHOR_OPEN + 'msg-', m.index);
    if (at < 0) continue;
    const end = text.indexOf('"', at + ANCHOR_OPEN.length);
    const anchor = text.slice(at + ANCHOR_OPEN.length, end);
    if (seen.has(anchor)) continue;
    seen.add(anchor);
    let date = '';
    let sender = '';
    const hd = text.indexOf('\n### ', end);
    if (hd >= 0 && hd < m.index) {
      const line = text.slice(hd + 5, text.indexOf('\n', hd + 5)).trim();
      const parts = line.split(' · ');
      date = parts[0] || '';
      sender = parts.length > 2 ? parts.slice(1, -1).join(' · ') : '';
    }
    out.push({ anchor, date, sender });
  }
  return out;
}
