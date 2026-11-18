// Path and link helpers shared by the desktop app, the web edition and tests.
// Pure functions only: no fs access here. Callers that need to pick among
// ambiguous candidates (a '#' inside a directory name) check existence themselves.
//
// Two path styles exist: Windows paths (desktop: "D:\a\b.md", "\\host\share\x.md")
// and virtual paths (web: "/<root>/a/b.md", always '/'-separated and case-sensitive).

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const WIN_DRIVE_RE = /^[a-zA-Z]:[\\/]/;

export const LOCAL_SCHEME = 'mdvfile';
export const APP_SCHEME = 'mdvapp';

/** "/<root>/…" virtual path (web edition); "//host/…" is a UNC path, not virtual. */
export function isVirtualPath(p) {
  const s = String(p);
  return s.startsWith('/') && !s.startsWith('//');
}

/** Key for comparing paths: Windows paths ignore case, virtual paths do not. */
export function pathKey(p) {
  return isVirtualPath(p) ? String(p) : String(p).toLowerCase();
}

/** How resources (images, media) are loaded. The web edition replaces these. */
let hooks = null;
export function setPathHooks(h) {
  hooks = h;
}
export const hasPathHooks = () => !!hooks;

function encodeSegment(seg) {
  // encodeURIComponent leaves !'()* alone, which is fine for URLs we parse ourselves.
  return encodeURIComponent(seg);
}

/** Normalise any Windows path to forward-slash form without trailing slash noise. */
export function toSlash(p) {
  return String(p).replace(/\\/g, '/');
}

export function toWin(p) {
  return String(p).replace(/\//g, '\\');
}

/** Absolute Windows path (drive or UNC) -> file: URL with every segment percent-encoded. */
export function pathToFileHref(absPath) {
  const p = toSlash(absPath);
  if (p.startsWith('//')) {
    const [host, ...rest] = p.slice(2).split('/');
    return 'file://' + host + '/' + rest.map(encodeSegment).join('/');
  }
  const segs = p.split('/');
  const drive = segs.shift(); // "D:"
  return 'file:///' + drive + '/' + segs.map(encodeSegment).join('/');
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** file: URL (or URL object) -> Windows path. */
export function fileHrefToPath(href) {
  const u = typeof href === 'string' ? new URL(href) : href;
  const pathname = safeDecode(u.pathname);
  if (u.host) return '\\\\' + u.host + toWin(pathname);
  // "/D:/a/b" -> "D:\a\b"
  return toWin(pathname.replace(/^\/([a-zA-Z]:)/, '$1'));
}

/**
 * URL the renderer uses to load a file (images, media): the app protocol on the
 * desktop, the server's resource routes on the web. opts.preview: an inline preview,
 * which may be a reduced image; opts.full: the original file, never a reduced preview.
 */
export function toLocalResourceUrl(absPath, opts = {}) {
  if (hooks) return hooks.resourceUrl(absPath, opts) || 'about:blank#unavailable';
  const p = toSlash(absPath);
  if (p.startsWith('//')) {
    const [host, ...rest] = p.slice(2).split('/');
    return `${LOCAL_SCHEME}://unc/${encodeSegment(host)}/` + rest.map(encodeSegment).join('/');
  }
  const segs = p.split('/');
  const drive = segs.shift();
  return `${LOCAL_SCHEME}://local/${drive}/` + segs.map(encodeSegment).join('/');
}

/** Inverse of toLocalResourceUrl (used by the protocol handler). */
export function localResourceUrlToPath(url) {
  const u = new URL(url);
  const parts = u.pathname.split('/').slice(1).map(safeDecode);
  if (u.host === 'unc') return '\\\\' + parts.join('\\');
  return parts.join('\\');
}

/** Path of a loaded resource URL (an <img> src), or null when it is not a local file. */
export function resourceUrlToPath(url) {
  if (!url) return null;
  if (hooks) return hooks.resourcePath(url);
  if (!String(url).startsWith(LOCAL_SCHEME + ':')) return null;
  try {
    return localResourceUrlToPath(url);
  } catch {
    return null;
  }
}

export function isAbsoluteWinPath(p) {
  return WIN_DRIVE_RE.test(p) || /^\\\\[^\\]/.test(p) || /^\/\/[^/]/.test(p);
}

/** Separator of a path's style. */
export const sepOf = (p) => (isVirtualPath(p) ? '/' : '\\');

export function dirname(p) {
  if (isVirtualPath(p)) {
    const s = String(p).replace(/\/+$/, '');
    const i = s.lastIndexOf('/');
    return i <= 0 ? '/' : s.slice(0, i);
  }
  const s = toWin(p);
  const i = s.lastIndexOf('\\');
  return i <= 2 && /^[a-zA-Z]:/.test(s) ? s.slice(0, 3) : s.slice(0, i);
}

export function basename(p) {
  if (isVirtualPath(p)) {
    const s = String(p).replace(/\/+$/, '');
    return s.slice(s.lastIndexOf('/') + 1);
  }
  const s = toWin(p);
  return s.slice(s.lastIndexOf('\\') + 1);
}

/** Same file, compared the way the path's style compares names. */
export const sameFile = (a, b) => !!a && !!b && pathKey(a) === pathKey(b);

/** p lies inside dir (not dir itself). */
export function isUnder(p, dir) {
  if (!p || !dir) return false;
  if (isVirtualPath(dir) !== isVirtualPath(p)) return false;
  const sep = sepOf(dir);
  const d = pathKey(dir).replace(sep === '/' ? /\/+$/ : /\\+$/, '') + sep;
  return pathKey(p).startsWith(d);
}

export function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i).toLowerCase() : '';
}

export const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdwn']);
export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.jfif', '.gif', '.webp', '.bmp', '.svg', '.avif', '.ico']);
export const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.webm', '.mov', '.ogv']);
export const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac']);

export function isMarkdownPath(p) {
  return MARKDOWN_EXTS.has(extname(p));
}

export function mediaKind(p) {
  const e = extname(p);
  if (IMAGE_EXTS.has(e)) return 'image';
  if (VIDEO_EXTS.has(e)) return 'video';
  if (AUDIO_EXTS.has(e)) return 'audio';
  return null;
}

/**
 * Split "path#anchor" where the path itself may contain '#'.
 * Returns candidates in preference order: the first '#' as separator (standard URL
 * semantics), then later '#' positions, then "no anchor at all".
 */
export function hashSplitCandidates(s) {
  const out = [];
  const positions = [];
  for (let i = s.indexOf('#'); i !== -1; i = s.indexOf('#', i + 1)) positions.push(i);
  for (const pos of positions) out.push({ path: s.slice(0, pos), anchor: s.slice(pos + 1) });
  out.push({ path: s, anchor: '' });
  return out;
}

/**
 * Resolve an href found in a document located at baseFilePath.
 * Result kinds:
 *  - { kind: 'anchor', anchor }                    same-document fragment
 *  - { kind: 'external', url }                     http(s), mailto, ...
 *  - { kind: 'local', candidates: [{path, anchor}] } local file; caller picks the first existing
 *  - { kind: 'invalid' }
 */
export function resolveHref(href, baseFilePath) {
  if (href == null) return { kind: 'invalid' };
  let h = String(href).trim();
  if (h.startsWith('<') && h.endsWith('>')) h = h.slice(1, -1);
  if (h === '') return { kind: 'invalid' };
  if (h.startsWith('#')) return { kind: 'anchor', anchor: safeDecode(h.slice(1)) };

  // Absolute Windows path written directly in the link ("D:\a\b.md"); markdown-it
  // percent-encodes it ("D:%5Ca%5Cb.md"), so look at the decoded form.
  const dec = safeDecode(h);
  if (WIN_DRIVE_RE.test(dec) || dec.startsWith('\\\\')) {
    return {
      kind: 'local',
      candidates: hashSplitCandidates(dec).map((c) => ({ path: toWin(c.path), anchor: c.anchor })),
    };
  }

  const scheme = SCHEME_RE.exec(h);
  if (scheme && !WIN_DRIVE_RE.test(h)) {
    const s = scheme[1].toLowerCase();
    if (s === 'file') {
      return { kind: 'local', candidates: fileUrlCandidates(h) };
    }
    if (s === LOCAL_SCHEME) {
      return { kind: 'local', candidates: [{ path: localResourceUrlToPath(h.split('#')[0]), anchor: '' }] };
    }
    return { kind: 'external', url: h };
  }

  if (!baseFilePath) return { kind: 'invalid' };
  const virtual = isVirtualPath(baseFilePath);
  const base = virtual ? 'file://' + String(baseFilePath).split('/').map(encodeSegment).join('/') : pathToFileHref(baseFilePath);
  const toPath = virtual ? (u) => u.pathname.split('/').map(safeDecode).join('/') : fileHrefToPath;
  const candidates = [];
  for (const c of hashSplitCandidates(h)) {
    // Earlier '#' characters belong to the path in this candidate: escape them.
    const pathPart = c.path.replace(/#/g, '%23').replace(/\?/g, '%3F');
    let u;
    try {
      u = new URL(pathPart, base);
    } catch {
      continue;
    }
    if (u.protocol !== 'file:') continue;
    candidates.push({ path: toPath(u), anchor: safeDecode(c.anchor) });
  }
  if (!candidates.length) return { kind: 'invalid' };
  return { kind: 'local', candidates };
}

function fileUrlCandidates(h) {
  const out = [];
  for (const c of hashSplitCandidates(h)) {
    try {
      const u = new URL(c.path.replace(/#/g, '%23'));
      out.push({ path: fileHrefToPath(u), anchor: safeDecode(c.anchor) });
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Resolve an image/media src for rendering. Returns a loadable URL or null to keep as-is. */
export function resolveResourceSrc(src, baseFilePath) {
  if (!src) return null;
  const s = String(src).trim();
  if (/^(https?:|data:|blob:)/i.test(s)) return s;
  if (s.startsWith(LOCAL_SCHEME + ':')) return s;
  const r = resolveHref(s, baseFilePath);
  if (r.kind !== 'local') return null;
  // For resources the standard split (first '#') is what browsers do; '#' in a
  // file name must be written as %23 in Markdown anyway.
  return toLocalResourceUrl(r.candidates[0].path);
}
