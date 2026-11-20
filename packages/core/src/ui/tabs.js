// Tabs, each with its own back/forward history. Recently visited documents of a
// tab stay rendered (hidden) so going back is instant and keeps the exact position.
import { h, toast } from './util.js';
import { DocView } from './docview.js';
import { FolderView, FileView } from './folderview.js';
import { pathKey } from '../shared/paths.js';

/** target.view: 'folder' (the folder page), 'file' (a text file or web page as it is), else a Markdown document. */
const VIEWS = { folder: FolderView, file: FileView };
const keyOf = (target) => (VIEWS[target.view] ? target.view + ':' : '') + pathKey(target.path);

const MAX_VIEWS_PER_TAB = 5;
let tabSeq = 0;

export class Tabs {
  constructor(app, stripEl) {
    this.app = app;
    this.strip = stripEl;
    this.tabs = [];
    this.active = null;
    this.closed = [];
  }

  findByPath(path, view) {
    const k = keyOf({ path, view });
    return this.tabs.find((t) => t.view && keyOf({ path: t.view.path, view: t.view.kind }) === k) || null;
  }

  async open(target, { background = false } = {}) {
    const tab = { id: ++tabSeq, entries: [], index: -1, views: new Map(), view: null, nav: 0, el: null };
    const idx = this.active ? this.tabs.indexOf(this.active) + 1 : this.tabs.length;
    this.tabs.splice(idx, 0, tab);
    if (!background || !this.active) this.activate(tab);
    this.renderStrip();
    await this.go(tab, target);
    return tab;
  }

  activate(tab) {
    if (this.active === tab) return;
    this.active = tab;
    for (const t of this.tabs) for (const v of t.views.values()) v.setActive(t === tab && v === t.view);
    this.renderStrip();
    if (tab && tab.view && tab.view.stale) tab.view.reload().then(() => this.app.onViewChanged(tab));
    this.app.onViewChanged(tab);
  }

  /** Close a tab; a document with unsaved edits asks first. Resolves false when the user keeps it. */
  async close(tab) {
    if (tab.view && tab.view.dirty && !(await this.app.confirmDiscard(tab.view))) return false;
    const i = this.tabs.indexOf(tab);
    if (i === -1) return true;
    if (tab.view) this.closed.push({ path: tab.view.path, anchor: '', view: tab.view.kind });
    this.closed = this.closed.slice(-20);
    for (const v of tab.views.values()) v.destroy();
    this.tabs.splice(i, 1);
    if (this.active === tab) {
      this.active = null;
      const next = this.tabs[Math.min(i, this.tabs.length - 1)] || null;
      if (next) this.activate(next);
      else this.app.onViewChanged(null);
    }
    this.renderStrip();
    this.app.saveSession();
    return true;
  }

  /** Leaving the tab's current document for `path`: deal with unsaved edits first. */
  async canLeave(tab, path) {
    const v = tab.view;
    if (!v || !v.dirty || pathKey(v.path) === pathKey(path)) return true;
    return this.app.confirmDiscard(v);
  }

  reopenClosed() {
    const t = this.closed.pop();
    if (t) this.open(t);
  }

  cycle(dir) {
    if (this.tabs.length < 2 || !this.active) return;
    const i = this.tabs.indexOf(this.active);
    this.activate(this.tabs[(i + dir + this.tabs.length) % this.tabs.length]);
  }

  trimViews(tab) {
    if (tab.views.size <= MAX_VIEWS_PER_TAB) return;
    const keep = new Set(tab.entries.slice(Math.max(0, tab.index - 2), tab.index + 2).map((e) => keyOf(e)));
    for (const [k, v] of [...tab.views.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)) {
      if (tab.views.size <= MAX_VIEWS_PER_TAB) break;
      if (v === tab.view || v.dirty || keep.has(k)) continue;
      v.destroy();
      tab.views.delete(k);
    }
  }

  /**
   * Show target {path, anchor} in tab. opts.push: add a history entry;
   * opts.pos: position to restore (history navigation).
   */
  async go(tab, target, { push = true, pos = null, checked = false } = {}) {
    if (!checked && !(await this.canLeave(tab, target.path))) return;
    const token = ++tab.nav;
    const key = keyOf(target);
    if (tab.view && tab.index >= 0) tab.entries[tab.index].pos = tab.view.capture();
    let view = tab.views.get(key);
    let fresh = false;
    if (!view) {
      view = new (VIEWS[target.view] || DocView)(this.app, target.path);
      tab.views.set(key, view);
      fresh = true;
    }
    view.lastUsed = Date.now();
    if (push) {
      tab.entries = tab.entries.slice(0, tab.index + 1);
      tab.entries.push({ path: target.path, anchor: target.anchor || '', view: VIEWS[target.view] ? target.view : undefined, pos: null });
      tab.index = tab.entries.length - 1;
    }
    const prev = tab.view;
    tab.view = view;
    if (this.active === tab) {
      if (prev && prev !== view) prev.setActive(false);
      view.setActive(true);
    }
    this.renderStrip();
    this.app.onViewChanged(tab);
    if (fresh || view.stale) {
      await view.load();
      if (token !== tab.nav) return;
    }
    this.trimViews(tab);
    if (target.anchor) {
      const ok = await view.scrollToAnchor(target.anchor);
      if (!ok && view.meta) toast(`未找到锚点 #${target.anchor}`, 'warn');
    } else if (pos) await view.restore(pos);
    else if (fresh) view.el.scrollTop = 0;
    if (token !== tab.nav) return;
    this.renderStrip();
    this.app.onViewChanged(tab);
    if (view.meta && view.kind === 'doc') this.app.noteRecent(view.path);
    this.app.saveSession();
  }

  async back(tab = this.active) {
    if (!tab || tab.index <= 0) return;
    if (!(await this.canLeave(tab, tab.entries[tab.index - 1].path))) return;
    if (tab.view) tab.entries[tab.index].pos = tab.view.capture();
    tab.index--;
    const e = tab.entries[tab.index];
    return this.go(tab, { path: e.path, view: e.view }, { push: false, pos: e.pos, checked: true });
  }

  async forward(tab = this.active) {
    if (!tab || tab.index >= tab.entries.length - 1) return;
    if (!(await this.canLeave(tab, tab.entries[tab.index + 1].path))) return;
    if (tab.view) tab.entries[tab.index].pos = tab.view.capture();
    tab.index++;
    const e = tab.entries[tab.index];
    return this.go(tab, { path: e.path, anchor: e.pos ? '' : e.anchor, view: e.view }, { push: false, pos: e.pos, checked: true });
  }

  canBack(tab = this.active) {
    return !!tab && tab.index > 0;
  }

  canForward(tab = this.active) {
    return !!tab && tab.index < tab.entries.length - 1;
  }

  allViews() {
    const out = [];
    for (const t of this.tabs) for (const v of t.views.values()) out.push({ tab: t, view: v });
    return out;
  }

  renderStrip() {
    const items = this.tabs.map((t) => {
      const title = t.view ? t.view.title : '…';
      const el = h(
        'div.tab',
        {
          title: t.view ? t.view.path : '',
          onmousedown: (e) => {
            if (e.button === 1) {
              e.preventDefault();
              this.close(t);
            }
          },
          onclick: () => this.activate(t),
          oncontextmenu: (e) => {
            e.preventDefault();
            this.app.tabContextMenu(t);
          },
        },
        h('span.tab-title', null, title),
        h(
          'span.tab-close',
          {
            title: t.view && t.view.dirty ? '未保存 · 关闭 (Ctrl+W)' : '关闭 (Ctrl+W)',
            onclick: (e) => {
              e.stopPropagation();
              this.close(t);
            },
          },
          '×',
        ),
      );
      if (t === this.active) el.classList.add('active');
      if (t.view && t.view.error) el.classList.add('error');
      if (t.view && t.view.dirty) el.classList.add('dirty');
      t.el = el;
      return el;
    });
    this.strip.replaceChildren(...items);
    if (this.active && this.active.el) this.active.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}
