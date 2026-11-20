// From an attachment in a chat folder back to the message that sent it.
import { decodeText } from './render-client.js';
import { basename, dirname, sepOf, isVirtualPath } from '../shared/paths.js';
import { monthOf, volumesFor, attachmentRefs } from '../shared/attachments.js';

const CHAT_DIR = '聊天记录';
const MAX_UP = 2; // the conversation is at most this many levels above the attachment's folder (图片/预览/…)

/**
 * The conversation that folder dir belongs to: { chatDir, prefix }, where prefix is
 * dir relative to the volumes ("../图片/预览"), or null when dir is not in a chat folder.
 */
export async function chatHomeOf(dir) {
  const sep = sepOf(dir);
  const segs = [];
  let d = dir;
  for (let i = 0; i <= MAX_UP; i++) {
    if (basename(d) !== CHAT_DIR) {
      const st = await window.mdv.stat(d + sep + CHAT_DIR);
      if (st && st.ok && st.isDir) return segs.length ? { chatDir: d + sep + CHAT_DIR, prefix: '../' + segs.join('/') } : null;
    }
    const up = dirname(d);
    if (!up || up === d) break;
    segs.unshift(basename(d));
    d = up;
  }
  return null;
}

/** Messages linking the file named name in a folder whose home is home: [{ volume, anchor, date, sender }]. */
export async function findMessages(home, name) {
  const names = [];
  for (let offset = 0; ; ) {
    const r = await window.mdv.listDir(home.chatDir, { all: true, offset });
    if (!r || !r.ok) return [];
    const ents = r.entries || [];
    for (const e of ents) if (!e.isDir) names.push(e.name);
    if (!r.more || !ents.length) break;
    offset += ents.length;
  }
  const month = monthOf(name);
  let vols = volumesFor(names, month);
  if (month && !vols.length) vols = volumesFor(names, null);
  const rel = home.prefix + '/' + name;
  const fold = !isVirtualPath(home.chatDir);
  const sep = sepOf(home.chatDir);
  const out = [];
  for (const v of vols) {
    const f = await window.mdv.readFile(home.chatDir + sep + v);
    if (!f || !f.ok) continue;
    for (const hit of attachmentRefs(decodeText(f.bytes).text, rel, { fold })) out.push({ volume: home.chatDir + sep + v, ...hit });
  }
  return out;
}
