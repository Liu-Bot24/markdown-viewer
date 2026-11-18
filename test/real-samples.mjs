// Pick sample files from the real archive without naming anyone: chat folders are
// discovered on disk, so no contact or group names are stored in the repository.
import fs from 'node:fs';
import path from 'node:path';

const CHAT_FILE = /^\d{4}-\d{2}.*_\d{3}\.md$/;

export function listReports(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const d of fs.readdirSync(dir).sort()) {
    const sub = path.join(dir, d);
    if (!fs.statSync(sub).isDirectory()) continue;
    for (const f of fs.readdirSync(sub).sort()) if (/^月报_.*\.md$/.test(f)) out.push(path.join(sub, f));
  }
  return out;
}

/** All "聊天记录" folders up to `depth` levels below the archive root. */
function chatDirs(dir, depth = 5, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (e.name === '聊天记录') out.push(p);
    else if (depth > 0) chatDirs(p, depth - 1, out);
  }
  return out;
}

/**
 * Deterministic sample: per top-level category, the two folders with the most data,
 * plus any contact folder named "#"; from each, the first, middle and latest file.
 * Returns [{ path, size, media, anchors }].
 */
export function pickChatFiles(archive) {
  if (!fs.existsSync(archive)) return [];
  const groups = new Map();
  for (const d of chatDirs(archive)) {
    const files = fs.readdirSync(d).filter((f) => CHAT_FILE.test(f)).sort();
    if (!files.length) continue;
    const size = files.reduce((s, f) => s + fs.statSync(path.join(d, f)).size, 0);
    const cat = path.relative(archive, d).split(path.sep)[0];
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push({ dir: d, files, size, hash: path.basename(path.dirname(d)) === '#' });
  }
  const dirs = [];
  for (const list of groups.values()) {
    list.sort((a, b) => b.size - a.size || a.dir.localeCompare(b.dir));
    dirs.push(...list.slice(0, 2), ...list.slice(2).filter((x) => x.hash));
  }
  const out = [];
  for (const d of dirs) {
    const f = d.files;
    for (const name of new Set([f[0], f[f.length >> 1], f[f.length - 1]])) {
      const p = path.join(d.dir, name);
      const text = fs.readFileSync(p, 'utf8');
      out.push({
        path: p,
        size: Buffer.byteLength(text),
        media: (text.match(/^\s*- \[(?:转发条目 \d+ · )?(?:image|video) · m_/gm) || []).length,
        anchors: (text.match(/^<a id="(msg-[0-9a-zA-Z]+)"><\/a>$/gm) || []).map((s) => s.slice(7, -6)),
      });
    }
  }
  return out;
}
