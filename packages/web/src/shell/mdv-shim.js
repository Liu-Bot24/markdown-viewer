// window.mdv for the browser: the same interface the desktop preload exposes,
// implemented with fetch against the web server, plus HTML menus and dialogs.
import { setPathHooks } from '../../../core/src/shared/paths.js';
import { basename, dirname, isMarkdownPath, mediaKind } from '../../../core/src/shared/paths.js';
import { naturalCompare, toast } from '../../../core/src/ui/util.js';
import { addFiles, addFileTree, addHandle, isLocalPath, isLoneLocalFile, localList, localRead, localResolve, localResourceUrl, localSources, localStat, LOCAL_PREFIX, sourceName } from './local.js';
import { copyText, download, downloadUrl, showDialog, showMenu } from './ui.js';

const DEFAULT_SETTINGS = {
  sidebar: true,
  outline: true,
  sidebarWidth: 280,
  outlineWidth: 240,
  peekWidth: 440,
  readingWidth: 'normal',
  inlineMedia: true,
  chatView: true,
  refClick: 'peek',
  peekContext: 4,
  showAllFiles: false,
  hideMediaFolders: false,
  selfIds: [],
  editLayout: 'split',
  editSplit: 0.5,
};

const LS_SETTINGS = 'mdv.settings';
const LS_RECENT = 'mdv.recent';
const POLL_MS = 10000;

function lsGet(k, def) {
  try {
    const v = localStorage.getItem(k);
    return v ? JSON.parse(v) : def;
  } catch {
    return def;
  }
}
function lsSet(k, v) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* private mode */
  }
}

export const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
export const rawUrl = (p) => '/raw' + encPath(p);
export const viewUrl = (p, anchor) => '/view' + encPath(p) + (anchor ? '#' + encodeURIComponent(anchor) : '');

export function pathFromLocation(loc = location) {
  if (!loc.pathname.startsWith('/view/')) return null;
  try {
    const path = loc.pathname
      .slice(5)
      .split('/')
      .map((s) => decodeURIComponent(s))
      .join('/');
    const anchor = loc.hash ? decodeURIComponent(loc.hash.slice(1)) : '';
    return { path, anchor };
  } catch {
    return null;
  }
}

async function api(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(path, {
    method,
    signal,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401) {
    location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash);
    throw new Error('login required');
  }
  return res;
}

async function apiJson(path, opts) {
  const res = await api(path, opts);
  try {
    return await res.json();
  } catch {
    return { ok: false, code: 'EHTTP' + res.status };
  }
}

/** FNV-1a over the bytes: change detection for local files (crypto.subtle needs HTTPS). */
async function localHash(bytes) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193);
    h2 = Math.imul(h2 ^ bytes[i], 0x811c9dc5);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0') + bytes.length.toString(16);
}

function encodeAs(text, encoding) {
  const utf8 = new TextEncoder().encode(text);
  switch (encoding) {
    case 'UTF-8 BOM':
      return concat([new Uint8Array([0xef, 0xbb, 0xbf]), utf8]);
    case 'UTF-16 LE':
    case 'UTF-16 BE': {
      const le = encoding === 'UTF-16 LE';
      const out = new Uint8Array(2 + text.length * 2);
      out[0] = le ? 0xff : 0xfe;
      out[1] = le ? 0xfe : 0xff;
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        out[2 + i * 2] = le ? c & 0xff : c >> 8;
        out[3 + i * 2] = le ? c >> 8 : c & 0xff;
      }
      return out;
    }
    default:
      return utf8;
  }
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** 「原名（编辑 2026-11-17 1530）.md」 */
export function exportName(path) {
  const name = basename(path);
  const i = name.lastIndexOf('.');
  const stem = i > 0 ? name.slice(0, i) : name;
  const ext = i > 0 ? name.slice(i) : '.md';
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${stem}（编辑 ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}）${ext}`;
}

export function createShim(serverState) {
  const handlers = { open: [], menu: [], changed: [] };
  const watched = new Map(); // path -> { mtimeMs, size } | null
  const saved = lsGet(LS_SETTINGS, {});
  const settings = { ...DEFAULT_SETTINGS, ...saved, selfIds: serverState.settings.selfIds || [] };
  let recent = lsGet(LS_RECENT, []).filter((p) => typeof p === 'string');
  const initial = pathFromLocation();

  // Resources (images, media) load through /raw; local folders through object URLs.
  // A Windows path is outside every root: null shows it as unavailable.
  const hooks = {
    resourceUrl: (p, opts = {}) => {
      if (isLocalPath(p)) return localResourceUrl(p) || 'about:blank#missing';
      if (!p.startsWith('/') || p.startsWith('//')) return null;
      // chat previews use the small thumbnail; the lightbox (opts.full) always the original
      if (opts.preview && !opts.full && serverState.caps.thumbs && mediaKind(p) === 'image') return '/thumb' + encPath(p);
      return rawUrl(p);
    },
    resourcePath: (url) => {
      try {
        const u = new URL(url, location.href);
        if (u.origin !== location.origin) return null;
        const m = /^\/(raw|thumb|video)(\/.*)$/.exec(u.pathname);
        if (!m) return null;
        return m[2]
          .split('/')
          .map((s) => decodeURIComponent(s))
          .join('/');
      } catch {
        return null;
      }
    },
  };
  setPathHooks(hooks);

  function emitOpen(msg) {
    for (const h of handlers.open) h(msg);
  }

  // ---------- change polling (only while the page is visible) ----------
  async function poll() {
    const paths = [...watched.keys()].filter((p) => !isLocalPath(p));
    if (!paths.length || document.visibilityState !== 'visible') return;
    let r;
    try {
      r = await apiJson('/api/stats', { method: 'POST', body: { paths } });
    } catch {
      return;
    }
    if (!r.ok) return;
    for (const p of paths) {
      const now = r.results[p];
      const before = watched.get(p);
      if (!watched.has(p) || !now) continue;
      if (!now.ok) {
        if (before && !before.gone) {
          watched.set(p, { gone: true });
          for (const h of handlers.changed) h({ path: p, type: 'unlink' });
        }
        continue;
      }
      if (!before || before.gone || before.mtimeMs !== now.mtimeMs || before.size !== now.size) {
        const had = !!before;
        watched.set(p, { mtimeMs: now.mtimeMs, size: now.size });
        if (had) for (const h of handlers.changed) h({ path: p, type: 'change' });
      }
    }
  }
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && poll());

  // ---------- local files ----------
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.accept = '.md,.markdown,.mdown,.mkd,.mkdn,.mdwn,text/markdown';
  fileInput.style.display = 'none';
  const dirInput = document.createElement('input');
  dirInput.type = 'file';
  dirInput.webkitdirectory = true;
  dirInput.style.display = 'none';
  document.addEventListener('DOMContentLoaded', () => document.body.append(fileInput, dirInput));
  if (document.body) document.body.append(fileInput, dirInput);

  fileInput.onchange = () => {
    const paths = addFiles(fileInput.files);
    fileInput.value = '';
    if (paths.length) emitOpen({ targets: paths.map((p) => ({ path: p, anchor: '' })) });
  };
  dirInput.onchange = () => {
    if (!dirInput.files.length) return;
    const root = addFileTree(dirInput.files);
    dirInput.value = '';
    emitOpen({ targets: [], folder: root });
  };

  async function openLocalFolder() {
    if (window.showDirectoryPicker && window.isSecureContext) {
      try {
        const handle = await window.showDirectoryPicker({ mode: 'read' });
        emitOpen({ targets: [], folder: addHandle(handle) });
      } catch {
        /* cancelled */
      }
      return;
    }
    dirInput.click();
  }

  const shim = {
    caps: {
      edition: 'web',
      appTabs: false,
      fileManager: false,
      download: true,
      copyLink: true,
      exportOnSave: true,
      forceOverwrite: false,
      nativeCloseGuard: true,
      overwrite: !!serverState.caps.overwrite,
      search: !!serverState.caps.search,
      transcode: !!serverState.caps.transcode,
      treeRootLabel: '全部目录',
    },

    async getState() {
      return {
        settings,
        recent,
        rootFolder: '/',
        session: [],
        version: serverState.version,
        isSelftest: false,
        hasInitialTargets: !!initial,
      };
    },
    async patchState(partial) {
      if (partial.settings) {
        Object.assign(settings, partial.settings);
        const { selfIds, ...rest } = settings;
        lsSet(LS_SETTINGS, rest);
        if (partial.settings.selfIds) api('/api/state', { method: 'POST', body: { settings: { selfIds: partial.settings.selfIds } } }).catch(() => {});
      }
      return true;
    },
    async addRecent(p) {
      if (isLocalPath(p)) return recent;
      recent = [p, ...recent.filter((r) => r !== p)].slice(0, 30);
      lsSet(LS_RECENT, recent);
      return recent;
    },
    async removeRecent(p) {
      recent = recent.filter((r) => r !== p);
      lsSet(LS_RECENT, recent);
      return recent;
    },
    ready() {
      if (initial) setTimeout(() => emitOpen({ targets: [initial] }), 0);
    },

    async readFile(p) {
      if (isLocalPath(p)) return localRead(p, localHash);
      let res;
      try {
        res = await api('/api/file?path=' + encodeURIComponent(p), {});
      } catch (e) {
        return { ok: false, code: 'ENET', message: String(e.message || e) };
      }
      if (!res.ok) {
        let j = {};
        try {
          j = await res.json();
        } catch {
          /* not json */
        }
        return { ok: false, code: j.code || 'EHTTP' + res.status, size: j.size };
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const mtimeMs = Number(res.headers.get('X-Mdv-Mtime'));
      const size = Number(res.headers.get('X-Mdv-Size'));
      if (watched.has(p)) watched.set(p, { mtimeMs, size });
      return { ok: true, bytes, mtimeMs, size, hash: res.headers.get('X-Mdv-Hash'), writable: res.headers.get('X-Mdv-Writable') === '1' };
    },

    /** Saving on the web: export a copy by default; overwrite only through the confirmed flow. */
    async writeFile(p, opts) {
      if (opts.overwrite && !isLocalPath(p)) {
        try {
          return await apiJson('/api/write', { method: 'POST', body: { path: p, text: opts.text, encoding: opts.encoding, expectHash: opts.expectHash, allowLossy: !!opts.allowLossy, confirm: opts.confirm } });
        } catch (e) {
          return { ok: false, code: 'ENET', message: String(e.message || e) };
        }
      }
      let encoding = opts.encoding;
      if (encoding === 'GB18030') {
        const a = await showDialog({ type: 'question', message: '原文件是 GB18030 编码，导出的副本会用 UTF-8 保存。', detail: '内容不变，只是编码不同。', buttons: ['导出', '取消'], cancelId: 1 });
        if (a !== 0) return { ok: false, code: 'ECANCEL' };
        encoding = 'UTF-8';
      }
      const name = exportName(p);
      download(name, encodeAs(opts.text, encoding), 'text/markdown');
      return { ok: true, exported: true, name, encoding };
    },

    async stat(p) {
      if (isLocalPath(p)) return localStat(p);
      try {
        return await apiJson('/api/stat?path=' + encodeURIComponent(p));
      } catch {
        return { ok: false, code: 'ENET' };
      }
    },

    async listDir(dir, opts = {}) {
      const hideMedia = !!settings.hideMediaFolders;
      if (isLocalPath(dir)) return localList(dir, { ...opts, hideMedia });
      const qs = new URLSearchParams({ path: dir, all: opts.all ? '1' : '0', offset: String(opts.offset || 0), hideMedia: hideMedia ? '1' : '0' });
      let r;
      try {
        r = await apiJson('/api/list?' + qs);
      } catch {
        return { ok: false, entries: [] };
      }
      if (!r.ok) return { ok: false, code: r.code, entries: [] };
      if (dir === '/' && !opts.offset) {
        for (const s of localSources()) r.entries.push({ name: '本机：' + s.name, path: LOCAL_PREFIX + s.id, isDir: true, isMd: false, local: true });
      }
      return r;
    },

    /** The previous and next Markdown file in p's folder, in the tree's order. */
    async neighbors(p) {
      if (isLoneLocalFile(p)) return { prev: null, next: null };
      if (isLocalPath(p)) {
        const r = await localList(dirname(p));
        const files = (r.entries || []).filter((e) => e.isMd).sort((a, b) => naturalCompare(a.name, b.name));
        const i = files.findIndex((e) => e.path === p);
        return i === -1 ? { prev: null, next: null } : { prev: files[i - 1]?.path || null, next: files[i + 1]?.path || null };
      }
      try {
        const r = await apiJson('/api/neighbors?path=' + encodeURIComponent(p));
        return r.ok ? { prev: r.prev, next: r.next } : { prev: null, next: null };
      } catch {
        return { prev: null, next: null };
      }
    },

    async resolveLink(base, href) {
      if (isLocalPath(base)) {
        const r = await localResolve(base, href);
        if (r) return r;
      }
      try {
        return await apiJson('/api/resolve', { method: 'POST', body: { base: isLocalPath(base) ? '/' : base, href } });
      } catch {
        return { kind: 'invalid' };
      }
    },

    async watch(p) {
      if (!watched.has(p)) watched.set(p, null);
      return true;
    },
    async unwatch(p) {
      watched.delete(p);
      return true;
    },

    openExternal(url) {
      if (/^(https?:|mailto:)/i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
      return true;
    },
    reveal() {
      return false;
    },
    /** Non-Markdown files: PDFs open in a new browser tab, everything else downloads. */
    async openPath(p) {
      if (isLocalPath(p)) {
        toast('本机文件夹里的这类文件无法在这里打开', 'warn');
        return '';
      }
      if (/\.pdf$/i.test(p)) window.open(rawUrl(p), '_blank', 'noopener');
      else downloadUrl(rawUrl(p) + '?download=1');
      return '';
    },
    openWith() {
      return false;
    },
    async copyText(t) {
      return copyText(t);
    },
    async openDialog(kind) {
      if (kind === 'folder') return openLocalFolder();
      fileInput.click();
      return true;
    },
    contextMenu(items) {
      return showMenu(items);
    },
    ask(opts) {
      return showDialog(opts);
    },
    closeWindow() {
      return true;
    },
    editNative(cmd) {
      if (cmd === 'paste') {
        toast('请用 Ctrl+V 粘贴', 'info');
        return true;
      }
      try {
        document.execCommand(cmd);
      } catch {
        /* unsupported */
      }
      return true;
    },
    zoomStep() {
      return 1;
    },
    getZoom() {
      return 1;
    },
    pathForFile(file) {
      return addFiles([file])[0];
    },

    onOpenTargets(h) {
      handlers.open.push(h);
      return () => {};
    },
    onMenu(h) {
      handlers.menu.push(h);
      return () => {};
    },
    onFileChanged(h) {
      handlers.changed.push(h);
      return () => {};
    },

    // ---------- web-only extras used through capabilities ----------
    linkFor(p, anchor) {
      if (isLocalPath(p)) return null;
      return location.origin + viewUrl(p, anchor);
    },
    openInNewWindow(target) {
      if (isLocalPath(target.path)) return false;
      window.open(viewUrl(target.path, target.anchor), '_blank');
      return true;
    },
    rootLabel(p) {
      if (p === LOCAL_PREFIX.slice(0, -1)) return '本机';
      return isLocalPath(p) && p.split('/').length === 3 ? '本机：' + sourceName(p) : null;
    },
    /** Breadcrumb: a local folder's '/@local/<id>' prefix is one part named after it. */
    crumbs(p) {
      if (isLoneLocalFile(p)) return [{ label: '本机：' + sourceName(p), dir: null }];
      const segs = p.split('/').filter(Boolean);
      const out = [];
      let acc = '';
      segs.forEach((s, i) => {
        acc += '/' + s;
        if (isLocalPath(p) && i === 0) return;
        out.push({ label: isLocalPath(p) && i === 1 ? '本机：' + sourceName(p) : s, dir: acc });
      });
      return out;
    },
    downloadPath(p) {
      if (isLocalPath(p)) return false;
      downloadUrl(rawUrl(p) + '?download=1');
      return true;
    },
    menu(cmd, arg) {
      for (const h of handlers.menu) h(cmd, arg);
    },
    open(msg) {
      emitOpen(msg);
    },
    isMarkdownPath,
    resourcePathOf: (u) => hooks.resourcePath(u),
  };
  return shim;
}
