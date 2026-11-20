// A folder in the reading pane, and non-Markdown files shown inside the app.
//
// FolderView lists a folder: thumbnails in a grid when it holds mostly pictures and
// videos, rows otherwise. Only the visible part is built, so a folder of a hundred
// thousand photos opens as fast as a small one; the listing is fetched in pages as
// the user scrolls. Pictures and videos open in the viewer, which steps through the
// folder; audio plays in its row, with the transcript of a same-named .txt beside it.
//
// FileView shows a text file as text and a web page with scripts, forms and plugins
// off (a sandboxed frame), both read-only.
import { h, fmtSize, rafThrottle, toast, caps } from './util.js';
import { decodeText } from './render-client.js';
import { basename, dirname, extname, mediaKind, isMarkdownPath, fileViewKind, toLocalResourceUrl, isVirtualPath, AUDIO_EXTS } from '../shared/paths.js';

let viewSeq = 100000; // apart from DocView ids
const GAP = 10;
const CELL_TARGET = 196; // grid cell width the column count aims for, px
const CAPTION_H = 24;
const ROW_H = 36;
const OVERSCAN = 600; // px built above and below the visible part
const MAX_TEXT = 8 * 1024 * 1024; // larger text files are offered to open elsewhere
const MAX_CHIPS = 200; // more subfolders than this are listed as rows instead of chips

/** What a listing entry is, for its icon and what a click does. */
export function entryKind(e) {
  if (e.isDir) return 'dir';
  if (e.isMd || isMarkdownPath(e.name)) return 'md';
  return mediaKind(e.name) || fileViewKind(e.name) || 'other';
}

const ICONS = { dir: '📁', md: '📄', image: '🖼', video: '🎬', audio: '🎵', text: '📃', html: '🌐', other: '📎' };

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const stem = (name) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
};

/** Shared parts of the two views: the scroll container in the reading pane. */
class PaneView {
  constructor(app, path, kind) {
    this.app = app;
    this.path = path;
    this.kind = kind;
    this.id = ++viewSeq;
    this.renderSeq = 0;
    this.meta = null;
    this.error = null;
    this.stale = false;
    this.mode = 'view';
    this.editor = null;
    this.dirty = false;
    this.editing = false;
    this.lastUsed = 0;
    this.banner = h('div.doc-banner');
    this.article = h('div.fv-article');
    this.el = h('div.doc-view.fv-scroll', { tabindex: '-1' }, this.article);
    this.root = h('div.doc-root', null, this.banner, h('div.doc-body', null, this.el));
    app.docsEl.append(this.root);
  }

  get title() {
    return basename(this.path);
  }

  setActive(on) {
    this.root.classList.toggle('active', on);
    this.el.classList.toggle('active', on);
  }

  applyViewSettings() {
    const wide = this.app.settings.readingWidth === 'wide';
    this.el.classList.toggle('wide', wide);
    this.root.classList.toggle('wide', wide);
  }

  async reload() {
    const top = this.el.scrollTop;
    const ok = await this.load();
    this.el.scrollTop = top;
    return ok;
  }

  capture() {
    return { scrollTop: this.el.scrollTop };
  }

  async restore(pos) {
    if (pos) this.el.scrollTop = pos.scrollTop;
  }

  async scrollToAnchor() {
    return false;
  }

  findAnchor() {
    return null;
  }

  stopPin() {}

  async setMode() {
    return false;
  }

  setDirty() {}

  renderError(code, message) {
    const msgs = { ENOENT: '不存在', EACCES: '没有读取权限', EPERM: '没有读取权限', ENOTDIR: '这不是一个文件夹', EISDIR: '这是一个文件夹' };
    this.article.replaceChildren(h('div.doc-error', null, h('h2', null, msgs[code] || '无法打开'), h('p', null, h('code', null, this.path)), message ? h('p.muted', null, message) : null));
  }

  destroy() {
    this.root.remove();
  }
}

export class FolderView extends PaneView {
  constructor(app, path) {
    super(app, path, 'folder');
    this.entries = []; // the listing, filled page by page (sparse until fetched)
    this.total = 0;
    this.pageSize = 0;
    this.pages = new Map(); // page start -> Promise
    this.items = []; // indexes into entries shown in the body (or merged audio items)
    this.layout = 'list';
    this.cells = new Map(); // item index -> element
    this.transcripts = new Map(); // path -> text | Promise
    this.player = null; // the audio element playing in a row
    this.head = h('div.fv-head');
    this.body = h('div.fv-body');
    this.article.classList.add('fv');
    this.article.append(this.head, this.body);
    this.onScroll = rafThrottle(() => this.paint());
    this.el.addEventListener('scroll', this.onScroll, { passive: true });
    this.ro = new ResizeObserver(() => {
      if (this.el.clientWidth && this.el.clientWidth !== this.lastWidth) this.relayout();
    });
    this.ro.observe(this.el);
    this.body.addEventListener('click', (e) => this.onClick(e));
    this.body.addEventListener('auxclick', (e) => e.button === 1 && this.onClick(e, true));
    this.body.addEventListener('contextmenu', (e) => this.onContextMenu(e));
  }

  get title() {
    return basename(this.path) || this.path;
  }

  statusBits() {
    if (this.error) return ['无法打开'];
    if (!this.listed) return ['载入中…'];
    const bits = [];
    if (this.dirCount) bits.push(`${this.dirCount.toLocaleString()} 个文件夹`);
    bits.push(`${(this.total - this.dirCount).toLocaleString()} 个文件`);
    return bits;
  }

  async load() {
    this.stopAudio();
    this.listed = false;
    this.pages.clear();
    this.transcripts.clear();
    const r = await window.mdv.listDir(this.path, { all: true, details: true, offset: 0 });
    if (!r.ok) {
      this.error = r.code || 'EIO';
      this.renderError(this.error);
      return false;
    }
    this.error = null;
    let ents = r.entries || [];
    if (!r.paged) {
      // a platform without paging returns everything, unsorted
      const cmp = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
      ents = ents.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : cmp.compare(a.name, b.name)));
    }
    this.total = r.paged ? r.total : ents.length;
    this.pageSize = ents.length || 1;
    this.entries = new Array(this.total);
    ents.forEach((e, i) => (this.entries[i] = e));
    this.pages.set(0, Promise.resolve());
    this.marks = r.marks || [];
    this.dirCount = 0;
    while (this.dirCount < ents.length && ents[this.dirCount].isDir) this.dirCount++;
    const complete = ents.length >= this.total;
    // subfolders as chips above the files, unless there are very many of them
    this.chips = this.dirCount && this.dirCount <= MAX_CHIPS && (complete || this.dirCount < ents.length);
    const first = this.chips ? this.dirCount : 0;
    const sample = ents.slice(this.dirCount).filter((e) => !e.isDir);
    const visual = sample.filter((e) => {
      const k = mediaKind(e.name);
      return k === 'image' || k === 'video';
    }).length;
    this.layout = sample.length && visual >= sample.length * 0.6 ? 'grid' : 'list';
    this.items = [];
    if (complete && this.layout === 'list') {
      // a .txt named like an audio file is its transcript: shown in the audio's row
      const audio = new Map();
      for (let i = first; i < this.total; i++) if (AUDIO_EXTS.has(extname(this.entries[i].name))) audio.set(stem(this.entries[i].name), i);
      this.pair = new Map();
      for (let i = first; i < this.total; i++) {
        const e = this.entries[i];
        const a = extname(e.name) === '.txt' ? audio.get(stem(e.name)) : undefined;
        if (a !== undefined) this.pair.set(a, e.path);
        else this.items.push(i);
      }
    } else {
      this.pair = new Map();
      for (let i = first; i < this.total; i++) this.items.push(i);
    }
    this.listed = true;
    this.renderSeq++;
    this.renderHead();
    this.cells.clear();
    this.body.replaceChildren();
    this.relayout();
    this.applyViewSettings();
    return true;
  }

  renderHead() {
    const parts = [h('h1.fv-title', { title: this.path }, this.title)];
    const counts = this.statusBits().join(' · ');
    parts.push(h('div.fv-counts.muted', null, counts));
    if (this.chips) {
      const chips = [];
      for (let i = 0; i < this.dirCount; i++) {
        const e = this.entries[i];
        chips.push(h('button.fv-chip', { title: e.path, 'data-dir': e.path, onclick: (ev) => this.openDir(e.path, ev.ctrlKey), onauxclick: (ev) => ev.button === 1 && this.openDir(e.path, true), oncontextmenu: (ev) => this.menuFor(ev, e) }, '📁 ' + e.name));
      }
      parts.push(h('div.fv-chips', null, chips));
    }
    if (this.marks && this.marks.length) {
      parts.push(
        h(
          'div.fv-years',
          null,
          h('span.muted', null, '跳到'),
          this.marks.map((m) => h('button.fv-year', { onclick: () => this.scrollToEntry(m.index) }, m.label)),
        ),
      );
    }
    if (!this.items.length) parts.push(h('p.muted.fv-empty', null, this.total ? '' : '（空文件夹）'));
    this.head.replaceChildren(...parts);
  }

  /** Geometry for the current width; rebuilds what is visible. */
  relayout() {
    if (!this.listed) return;
    this.body.classList.toggle('grid', this.layout === 'grid'); // before measuring: the list is narrower
    const inner = this.body.clientWidth || this.el.clientWidth - 64;
    this.lastWidth = this.el.clientWidth;
    if (this.layout === 'grid') {
      this.cols = Math.max(2, Math.floor((inner + GAP) / (CELL_TARGET + GAP)));
      this.cellW = Math.floor((inner - GAP * (this.cols - 1)) / this.cols);
      this.rowH = this.cellW + CAPTION_H + GAP;
    } else {
      this.cols = 1;
      this.cellW = inner;
      this.rowH = ROW_H;
    }
    const rows = Math.ceil(this.items.length / this.cols);
    this.body.style.height = rows * this.rowH + 'px';
    for (const c of this.cells.values()) c.remove();
    this.cells.clear();
    this.paint();
  }

  /** Build the cells in and near the visible part; drop the rest. */
  paint() {
    if (!this.listed || !this.items.length) return;
    const top = this.el.scrollTop - this.body.offsetTop - OVERSCAN;
    const bottom = this.el.scrollTop - this.body.offsetTop + this.el.clientHeight + OVERSCAN;
    const r0 = Math.max(0, Math.floor(top / this.rowH));
    const r1 = Math.min(Math.ceil(this.items.length / this.cols) - 1, Math.floor(bottom / this.rowH));
    const i0 = r0 * this.cols;
    const i1 = Math.min(this.items.length - 1, (r1 + 1) * this.cols - 1);
    for (const [i, c] of this.cells) {
      if (i < i0 || i > i1) {
        c.remove();
        this.cells.delete(i);
      }
    }
    const missing = new Set();
    const frag = document.createDocumentFragment();
    for (let i = i0; i <= i1; i++) {
      if (this.cells.has(i)) continue;
      const e = this.entries[this.items[i]];
      if (!e) missing.add(Math.floor(this.items[i] / this.pageSize) * this.pageSize);
      const c = this.makeCell(i, e);
      this.cells.set(i, c);
      frag.append(c);
    }
    this.body.append(frag);
    for (const start of missing) this.fetchPage(start);
  }

  fetchPage(start) {
    if (this.pages.has(start)) return this.pages.get(start);
    const seq = this.renderSeq;
    const p = window.mdv.listDir(this.path, { all: true, details: true, offset: start }).then((r) => {
      if (seq !== this.renderSeq || !r.ok) {
        this.pages.delete(start);
        return;
      }
      (r.entries || []).forEach((e, k) => (this.entries[start + k] = e));
      // rebuild the placeholders this page fills
      for (const [i, c] of this.cells) {
        const idx = this.items[i];
        if (idx >= start && idx < start + this.pageSize && c.classList.contains('pending')) {
          const n = this.makeCell(i, this.entries[idx]);
          c.replaceWith(n);
          this.cells.set(i, n);
        }
      }
    });
    this.pages.set(start, p);
    return p;
  }

  async entryAt(idx) {
    if (idx < 0 || idx >= this.total) return null;
    if (!this.entries[idx]) await this.fetchPage(Math.floor(idx / this.pageSize) * this.pageSize);
    return this.entries[idx] || null;
  }

  place(el, i) {
    const row = Math.floor(i / this.cols);
    const col = i % this.cols;
    el.style.top = row * this.rowH + 'px';
    el.style.left = col * (this.cellW + GAP) + 'px';
    el.style.width = this.cellW + 'px';
    el.style.height = (this.layout === 'grid' ? this.cellW + CAPTION_H : ROW_H) + 'px';
    el.dataset.i = String(i);
    return el;
  }

  makeCell(i, e) {
    if (!e) return this.place(h('div.fv-cell.pending'), i);
    const kind = entryKind(e);
    const tip = e.name + (e.size != null ? `\n${fmtSize(e.size)}` : '') + (e.mtimeMs ? ` · ${fmtDate(e.mtimeMs)}` : '');
    if (this.layout === 'grid') {
      let thumb;
      if (kind === 'image') {
        thumb = h('img', { src: toLocalResourceUrl(e.path, { preview: true }), alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
        thumb.addEventListener('error', () => thumb.replaceWith(h('span.fv-icon', null, ICONS.image)), { once: true });
      } else if (kind === 'video') {
        thumb = h('video', { src: toLocalResourceUrl(e.path) + '#t=0.5', preload: 'metadata', muted: true, playsInline: true, tabindex: '-1' });
        thumb.addEventListener('error', () => thumb.replaceWith(h('span.fv-icon', null, ICONS.video)), { once: true });
      } else thumb = h('span.fv-icon', null, ICONS[kind]);
      const box = h('div.fv-thumb', null, thumb, kind === 'video' ? h('span.fv-play', null, '▶') : null);
      return this.place(h('div.fv-cell.fv-tile', { title: tip, 'data-kind': kind }, box, h('div.fv-name', null, e.name)), i);
    }
    const idx = this.items[i];
    const transcript = this.pair.get(idx);
    const name = h('span.fv-name', null, e.name);
    const parts = [h('span.fv-icon', null, ICONS[kind]), name];
    if (kind === 'audio') {
      const play = h('button.fv-audio', { title: '播放', 'data-act': 'play' }, '▶');
      parts.unshift(play);
      if (this.player && this.player.dataset.path === e.path) play.textContent = '⏸';
    }
    if (transcript) {
      const t = h('span.fv-transcript.muted');
      parts.push(t);
      this.transcriptOf(transcript).then((text) => {
        t.textContent = text;
        t.title = text;
      });
    }
    parts.push(h('span.fv-size.muted', null, e.isDir ? '' : e.size != null ? fmtSize(e.size) : ''), h('span.fv-date.muted', null, fmtDate(e.mtimeMs)));
    return this.place(h('div.fv-cell.fv-row', { title: tip, 'data-kind': kind, 'data-path': e.path }, parts), i);
  }

  transcriptOf(p) {
    if (!this.transcripts.has(p)) {
      this.transcripts.set(
        p,
        window.mdv.readFile(p).then((r) => (r.ok ? decodeText(r.bytes).text.trim().replace(/\s+/g, ' ') : '')),
      );
    }
    return this.transcripts.get(p);
  }

  cellEntry(target) {
    const c = target.closest('.fv-cell');
    if (!c || c.classList.contains('pending')) return null;
    const i = Number(c.dataset.i);
    return { i, idx: this.items[i], e: this.entries[this.items[i]], cell: c };
  }

  onClick(ev, newTab = false) {
    const hit = this.cellEntry(ev.target);
    if (!hit || !hit.e) return;
    ev.preventDefault();
    const { e } = hit;
    const kind = entryKind(e);
    newTab = newTab || ev.ctrlKey;
    if (kind === 'audio' && (ev.target.closest('[data-act="play"]') || !newTab)) return this.toggleAudio(e, hit.cell);
    if (kind === 'image' || kind === 'video') return this.view(hit.idx);
    this.app.openEntry(e, { newTab });
  }

  openDir(p, newTab) {
    this.app.openFolder(p, { newTab });
  }

  menuFor(ev, e) {
    ev.preventDefault();
    ev.stopPropagation();
    this.app.treeContextMenu({ path: e.path, isDir: e.isDir, isMd: entryKind(e) === 'md' });
  }

  onContextMenu(ev) {
    const hit = this.cellEntry(ev.target);
    if (hit && hit.e) this.menuFor(ev, hit.e);
  }

  /** The viewer on entry idx, stepping through the pictures and videos of the folder. */
  view(idx) {
    const e = this.entries[idx];
    const seq = {
      count: this.total - (this.chips ? this.dirCount : 0),
      index: idx - (this.chips ? this.dirCount : 0),
      step: (dir) => this.nextMedia(seq, dir),
    };
    this.app.lightbox.open({ kind: mediaKind(e.name), path: e.path, seq });
  }

  /** The next picture or video after (dir 1) or before (dir -1) the one shown. */
  async nextMedia(seq, dir) {
    const base = this.chips ? this.dirCount : 0;
    for (let k = seq.index + dir, n = 0; k >= 0 && k < seq.count && n < 5000; k += dir, n++) {
      const e = await this.entryAt(base + k);
      if (!e) return null;
      const kind = mediaKind(e.name);
      if (kind === 'image' || kind === 'video') {
        seq.index = k;
        this.revealEntry(base + k);
        return { kind, path: e.path };
      }
    }
    return null;
  }

  /** Scroll so entry idx is in view (after stepping in the viewer). */
  revealEntry(idx) {
    const i = this.items.indexOf(idx);
    if (i < 0) return;
    const y = this.body.offsetTop + Math.floor(i / this.cols) * this.rowH;
    if (y < this.el.scrollTop || y + this.rowH > this.el.scrollTop + this.el.clientHeight) this.el.scrollTop = y - this.el.clientHeight / 3;
  }

  scrollToEntry(idx) {
    let i = this.items.indexOf(idx);
    if (i < 0) i = this.items.findIndex((x) => x >= idx);
    if (i < 0) return;
    this.el.scrollTop = this.body.offsetTop + Math.floor(i / this.cols) * this.rowH - 8;
  }

  toggleAudio(e, cell) {
    const same = this.player && this.player.dataset.path === e.path;
    this.stopAudio();
    if (same) return;
    const a = h('audio', { src: toLocalResourceUrl(e.path), autoplay: true });
    a.dataset.path = e.path;
    a.addEventListener('ended', () => this.stopAudio());
    a.addEventListener('error', () => {
      toast('这个音频无法播放：' + e.name, 'warn');
      this.stopAudio();
    });
    this.player = a;
    this.article.append(a);
    const btn = cell.querySelector('.fv-audio');
    if (btn) btn.textContent = '⏸';
  }

  stopAudio() {
    if (!this.player) return;
    const p = this.player.dataset.path;
    this.player.pause();
    this.player.remove();
    this.player = null;
    for (const c of this.cells.values()) {
      const b = c.dataset.path === p && c.querySelector('.fv-audio');
      if (b) b.textContent = '▶';
    }
  }

  setActive(on) {
    super.setActive(on);
    if (!on) this.stopAudio();
    else if (this.listed && this.el.clientWidth !== this.lastWidth) this.relayout();
  }

  destroy() {
    this.stopAudio();
    this.ro.disconnect();
    super.destroy();
  }
}

export class FileView extends PaneView {
  constructor(app, path) {
    super(app, path, 'file');
    this.article.classList.add('fv-file');
  }

  statusBits() {
    if (this.error) return ['无法打开'];
    if (!this.info) return ['载入中…'];
    return [this.info.encoding, fmtSize(this.info.size), this.info.kind === 'html' ? '网页（只读，不运行脚本）' : `${this.info.lines.toLocaleString()} 行`].filter(Boolean);
  }

  async load() {
    const kind = fileViewKind(this.path);
    const st = await window.mdv.stat(this.path);
    if (!st.ok || !st.isFile) {
      this.error = st.ok ? 'EISDIR' : st.code || 'ENOENT';
      this.renderError(this.error);
      return false;
    }
    if (!kind || st.size > MAX_TEXT) return this.renderOther(st, kind ? `文件较大（${fmtSize(st.size)}），没有在这里显示。` : '这类文件不能在这里显示。');
    const r = await window.mdv.readFile(this.path);
    if (!r.ok) {
      this.error = r.code || 'EIO';
      this.renderError(this.error, r.message);
      return false;
    }
    this.error = null;
    const { text, encoding } = decodeText(r.bytes);
    let lines = 1;
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lines++;
    this.info = { kind, encoding, size: r.size, lines };
    // enough for the outline (none) and Ctrl+F over the shown text
    this.meta = { size: r.size, encoding, lines, headings: [], isChat: false, timing: { total: 0 } };
    if (kind === 'html') this.renderHtml(text);
    else this.article.replaceChildren(h('pre.fv-text', null, text));
    this.renderSeq++;
    this.applyViewSettings();
    return true;
  }

  /** The page in a frame with no scripts, forms, popups or plugins; pictures from beside the file still load. */
  renderHtml(text) {
    const dir = dirname(this.path);
    const baseHref = toLocalResourceUrl(dir + (isVirtualPath(dir) ? '/' : '\\') + 'x').replace(/x$/, '');
    let origin = '';
    try {
      origin = new URL(baseHref, location.href).origin;
    } catch {
      /* no pictures then */
    }
    const src = origin && origin !== 'null' ? ' ' + origin : '';
    const csp = `default-src 'none'; img-src data:${src}; media-src${src || " 'none'"}; style-src 'unsafe-inline'; font-src data:`;
    const headExtra = `<meta http-equiv="Content-Security-Policy" content="${csp}"><base href="${baseHref.replace(/"/g, '&quot;')}">`;
    const doc = /<head[^>]*>/i.test(text) ? text.replace(/<head[^>]*>/i, (m) => m + headExtra) : headExtra + text;
    const frame = h('iframe.fv-html', { sandbox: '', referrerpolicy: 'no-referrer', title: this.title });
    frame.srcdoc = doc;
    this.article.replaceChildren(frame);
  }

  renderOther(st, why) {
    this.error = null;
    this.info = { kind: 'other', encoding: '', size: st.size, lines: 0 };
    const can = caps();
    const actions = [];
    if (can.fileManager) {
      actions.push(h('button.btn', { onclick: () => window.mdv.openPath(this.path) }, '用默认程序打开'));
      actions.push(h('button.btn', { onclick: () => window.mdv.reveal(this.path) }, '在资源管理器中显示'));
    } else if (can.download) actions.push(h('button.btn', { onclick: () => window.mdv.downloadPath(this.path) }, '下载原文件'));
    this.article.replaceChildren(h('div.doc-error', null, h('h2', null, this.title), h('p.muted', null, why), h('div.fv-actions', null, actions)));
    this.renderSeq++;
    return true;
  }
}
