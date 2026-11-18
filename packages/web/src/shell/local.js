// Files and folders from the visitor's own computer, read in the browser with the
// File API. Nothing is uploaded. Paths look like "/@local/<id>/<name>[/<rel>]".
import { isMarkdownPath, resolveHref, mediaKind } from '../../../core/src/shared/paths.js';

export const LOCAL_PREFIX = '/@local/';
let seq = 0;
const sources = new Map(); // id -> { id, name, kind: 'file'|'files'|'handle', file?, files?: Map(rel->File), handle? }
const blobUrls = new Map(); // path -> object URL

export const isLocalPath = (p) => typeof p === 'string' && p.startsWith(LOCAL_PREFIX);

function split(p) {
  const rest = p.slice(LOCAL_PREFIX.length).split('/');
  const src = sources.get(rest[0]);
  return { src, rel: rest.slice(1) };
}

export function localSources() {
  return [...sources.values()].filter((s) => s.kind !== 'file');
}

/** Single files picked or dropped. Returns their paths. */
export function addFiles(fileList) {
  const out = [];
  for (const f of fileList) {
    const id = 'f' + ++seq;
    sources.set(id, { id, name: f.name, kind: 'file', file: f });
    out.push(LOCAL_PREFIX + id + '/' + f.name);
  }
  return out;
}

/** A folder from <input webkitdirectory>: every file with its relative path. */
export function addFileTree(fileList) {
  const files = new Map();
  let name = '';
  for (const f of fileList) {
    const rel = (f.webkitRelativePath || f.name).split('/');
    name = name || rel[0];
    files.set(rel.slice(1).join('/'), f);
  }
  const id = 'd' + ++seq;
  sources.set(id, { id, name: name || '本机文件夹', kind: 'files', files });
  return LOCAL_PREFIX + id;
}

/** A folder from showDirectoryPicker (Chromium, secure context only). */
export function addHandle(handle) {
  const id = 'h' + ++seq;
  sources.set(id, { id, name: handle.name, kind: 'handle', handle });
  return LOCAL_PREFIX + id;
}

export function sourceName(p) {
  const { src } = split(p);
  return src ? src.name : '';
}

/** True for a file picked on its own (no folder around it to browse). */
export function isLoneLocalFile(p) {
  const { src } = split(p);
  return !!src && src.kind === 'file';
}

async function handleAt(src, rel, { dir = false } = {}) {
  let h = src.handle;
  for (let i = 0; i < rel.length; i++) {
    const last = i === rel.length - 1;
    h = last && !dir ? await h.getFileHandle(rel[i]) : await h.getDirectoryHandle(rel[i]);
  }
  return h;
}

async function fileAt(p) {
  const { src, rel } = split(p);
  if (!src) return null;
  if (src.kind === 'file') return rel.join('/') === src.name ? src.file : null;
  if (src.kind === 'files') return src.files.get(rel.join('/')) || null;
  try {
    return await (await handleAt(src, rel)).getFile();
  } catch {
    return null;
  }
}

export async function localStat(p) {
  const { src, rel } = split(p);
  if (!src) return { ok: false, code: 'ENOENT' };
  if (src.kind !== 'file' && rel.length === 0) return { ok: true, isFile: false, isDir: true, size: 0, mtimeMs: 0 };
  if (src.kind === 'files') {
    const key = rel.join('/');
    if (src.files.has(key)) {
      const f = src.files.get(key);
      return { ok: true, isFile: true, isDir: false, size: f.size, mtimeMs: f.lastModified };
    }
    for (const k of src.files.keys()) if (k.startsWith(key + '/')) return { ok: true, isFile: false, isDir: true, size: 0, mtimeMs: 0 };
    return { ok: false, code: 'ENOENT' };
  }
  if (src.kind === 'handle') {
    try {
      const f = await (await handleAt(src, rel)).getFile();
      return { ok: true, isFile: true, isDir: false, size: f.size, mtimeMs: f.lastModified };
    } catch {
      try {
        await handleAt(src, rel, { dir: true });
        return { ok: true, isFile: false, isDir: true, size: 0, mtimeMs: 0 };
      } catch {
        return { ok: false, code: 'ENOENT' };
      }
    }
  }
  const f = await fileAt(p);
  return f ? { ok: true, isFile: true, isDir: false, size: f.size, mtimeMs: f.lastModified } : { ok: false, code: 'ENOENT' };
}

export async function localRead(p, hashBytes) {
  const f = await fileAt(p);
  if (!f) return { ok: false, code: 'ENOENT' };
  if (f.size > 64 * 1024 * 1024) return { ok: false, code: 'ETOOBIG', size: f.size };
  const bytes = new Uint8Array(await f.arrayBuffer());
  await prepareResources(p, bytes);
  return { ok: true, bytes, mtimeMs: f.lastModified, size: f.size, hash: await hashBytes(bytes), local: true };
}

/** Same rule as the server: no Markdown and mostly media among the folder's first files. */
async function isLocalMediaDir(src, relParts) {
  let media = 0;
  let other = 0;
  let seen = 0;
  const count = (name) => {
    if (name.startsWith('.')) return true;
    if (isMarkdownPath(name)) return false;
    if (mediaKind(name)) media++;
    else other++;
    return ++seen < 300;
  };
  if (src.kind === 'files') {
    const prefix = relParts.join('/') + '/';
    for (const k of src.files.keys()) {
      if (!k.startsWith(prefix) || k.slice(prefix.length).includes('/')) continue;
      if (isMarkdownPath(k)) return false;
      if (!count(k.slice(prefix.length))) break;
    }
  } else {
    try {
      const h = await handleAt(src, relParts, { dir: true });
      for await (const [name, child] of h.entries()) {
        if (child.kind === 'directory') continue;
        if (isMarkdownPath(name)) return false;
        if (!count(name)) break;
      }
    } catch {
      return false;
    }
  }
  return media > 0 && media >= other;
}

export async function localList(dir, { all = false, hideMedia = false } = {}) {
  const { src, rel } = split(dir.replace(/\/+$/, ''));
  if (!src || src.kind === 'file') return { ok: false, code: 'ENOENT', entries: [] };
  const base = dir.replace(/\/+$/, '');
  const out = [];
  const add = (name, isDir) => {
    if (name.startsWith('.')) return;
    const isMd = !isDir && isMarkdownPath(name);
    if (!isDir && !isMd && !all) return;
    out.push({ name, path: base + '/' + name, isDir, isMd });
  };
  if (src.kind === 'files') {
    const prefix = rel.length ? rel.join('/') + '/' : '';
    const seen = new Set();
    for (const k of src.files.keys()) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length).split('/');
      const name = rest[0];
      if (seen.has(name)) continue;
      seen.add(name);
      add(name, rest.length > 1);
    }
  } else {
    try {
      const h = await handleAt(src, rel, { dir: true });
      for await (const [name, child] of h.entries()) add(name, child.kind === 'directory');
    } catch {
      return { ok: false, code: 'ENOENT', entries: [] };
    }
  }
  if (hideMedia) {
    const keep = [];
    for (const e of out) if (!e.isDir || !(await isLocalMediaDir(src, [...rel, e.name]))) keep.push(e);
    return { ok: true, entries: keep };
  }
  return { ok: true, entries: out };
}

/** Same link rules as everywhere else, checked against the local folder. */
export async function localResolve(base, href) {
  const r = resolveHref(href, base);
  if (r.kind !== 'local') return r;
  const cands = r.candidates.filter((c) => isLocalPath(c.path));
  if (!cands.length) return null; // not local: let the server try (path map)
  for (const c of cands) {
    const st = await localStat(c.path);
    if (st.ok && st.isFile) return { kind: 'local', path: c.path, anchor: c.anchor, exists: true, isDir: false };
  }
  for (const c of [...cands].reverse()) {
    const st = await localStat(c.path);
    if (st.ok && st.isDir) return { kind: 'local', path: c.path, anchor: c.anchor, exists: true, isDir: true };
  }
  return { kind: 'local', path: cands[0].path, anchor: cands[0].anchor, exists: false, isDir: false };
}

/** Synchronous lookup used while rendering (prepared by localRead). */
export function localResourceUrl(p) {
  return blobUrls.get(p) || null;
}

export async function localBlobUrl(p) {
  if (blobUrls.has(p)) return blobUrls.get(p);
  const f = await fileAt(p);
  if (!f) return null;
  const u = URL.createObjectURL(f);
  blobUrls.set(p, u);
  return u;
}

const LINK_RE = /\]\(\s*<([^>]+)>|\]\(\s*([^)\s]+)|\bsrc\s*=\s*"([^"]+)"|\bsrc\s*=\s*'([^']+)'|\bposter\s*=\s*"([^"]+)"/g;

/** Make object URLs for the media a local document refers to, before it renders. */
async function prepareResources(p, bytes) {
  if (!isMarkdownPath(p)) return;
  const { src } = split(p);
  if (!src || src.kind === 'file') return;
  const text = new TextDecoder().decode(bytes);
  const wanted = new Set();
  for (const m of text.matchAll(LINK_RE)) {
    const href = m[1] || m[2] || m[3] || m[4] || m[5];
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) continue;
    const r = resolveHref(href, p);
    if (r.kind !== 'local') continue;
    const c = r.candidates[0];
    if (isLocalPath(c.path) && mediaKind(c.path)) wanted.add(c.path);
    if (wanted.size > 5000) break;
  }
  for (const w of wanted) await localBlobUrl(w);
}
